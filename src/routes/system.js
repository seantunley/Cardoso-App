import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createRequire } from 'module';
import { getVersionStatus } from '../services/versionCheck.js';

const require = createRequire(import.meta.url);

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const GITHUB_RELEASES_API = 'https://api.github.com/repos/seantunley/Cardoso-App/releases/latest';
const RELEASE_ASSET_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);

function createAbortSignal(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

function parseChecksumAsset(text, installerName) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (!match) continue;
    const [, digest, assetName] = match;
    if (assetName.trim() === installerName) {
      return digest.toLowerCase();
    }
  }
  return null;
}

function assertTrustedAssetUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error(`Refusing non-HTTPS release asset URL: ${url}`);
  }
  if (!RELEASE_ASSET_HOSTS.has(parsed.hostname)) {
    throw new Error(`Refusing untrusted release asset host: ${parsed.hostname}`);
  }
}

async function fetchJson(url) {
  const request = createAbortSignal(10000);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'cardoso-app-auto-update' },
      signal: request.signal,
    });
    return response;
  } finally {
    request.clear();
  }
}

async function fetchReleaseMetadata() {
  const releaseResp = await fetchJson(GITHUB_RELEASES_API);
  if (releaseResp.status === 429 || releaseResp.status === 403) {
    return { ok: false, reason: `rate_limited:${releaseResp.status}` };
  }
  if (!releaseResp.ok) {
    throw new Error(`GitHub API error: ${releaseResp.status}`);
  }

  const release = await releaseResp.json();
  const installerAsset = release.assets.find((asset) => asset.name.startsWith('CardosoSetup-') && asset.name.endsWith('.exe'));
  if (!installerAsset) {
    throw new Error('Installer asset not found in latest release');
  }

  const checksumAsset = release.assets.find((asset) =>
    asset.name === `${installerAsset.name}.sha256` ||
    asset.name === `${installerAsset.name}.sha256.txt`
  );
  if (!checksumAsset) {
    throw new Error(`Checksum asset missing for ${installerAsset.name}`);
  }

  return { ok: true, release, installerAsset, checksumAsset };
}

async function downloadReleaseAsset(url, destPath) {
  assertTrustedAssetUrl(url);
  const request = createAbortSignal(60000);
  try {
    const response = await fetch(url, { signal: request.signal });
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    await pipeline(response.body, createWriteStream(destPath));
  } finally {
    request.clear();
  }
}

async function fetchChecksum(url, installerName) {
  assertTrustedAssetUrl(url);
  const request = createAbortSignal(15000);
  try {
    const response = await fetch(url, { signal: request.signal });
    if (!response.ok) throw new Error(`Checksum download failed: ${response.status}`);
    const checksumText = await response.text();
    const checksum = parseChecksumAsset(checksumText, installerName);
    if (!checksum) throw new Error(`Checksum file did not contain a SHA-256 for ${installerName}`);
    return checksum;
  } finally {
    request.clear();
  }
}

async function sha256File(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function createSystemRouter({ requireAuth, requireAdmin }) {
  const router = express.Router();

  // GET /api/health — unauthenticated health check
  router.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // GET /api/app-info
  router.get('/api/app-info', (req, res) => {
    res.json({
      hub_mode: process.env.HUB_MODE === 'true',
      version: require('../../package.json').version,
    });
  });

  // GET /api/app-version-status
  router.get('/api/app-version-status', requireAuth, async (req, res) => {
    try {
      const versionStatus = await getVersionStatus();
      res.json(versionStatus);
    } catch (error) {
      console.error('Version status error:', error);
      res.status(500).json({ error: 'Failed to check app version' });
    }
  });

  // ==================== AUTO-UPDATE (WINDOWS SERVICE) ====================
  let autoUpdateRunning = false;

  async function triggerWindowsUpdate() {
    if (autoUpdateRunning) {
      console.log('[AutoUpdate] Update already in progress, skipping.');
      return { ok: false, reason: 'already_running' };
    }
    autoUpdateRunning = true;

    let tmpPath = null;
    try {
      const releaseMeta = await fetchReleaseMetadata();
      if (!releaseMeta.ok) {
        autoUpdateRunning = false;
        console.warn(`[AutoUpdate] GitHub API rate limited (${releaseMeta.reason.split(':')[1]}). Skipping this cycle.`);
        return { ok: false, reason: 'rate_limited' };
      }

      const { installerAsset, checksumAsset } = releaseMeta;
      console.log(`[AutoUpdate] Downloading ${installerAsset.name} (${(installerAsset.size / 1024 / 1024).toFixed(1)} MB)...`);

      tmpPath = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'CardosoSetup-update.exe');
      await downloadReleaseAsset(installerAsset.browser_download_url, tmpPath);
      console.log(`[AutoUpdate] Downloaded to ${tmpPath}`);

      const expectedChecksum = await fetchChecksum(checksumAsset.browser_download_url, installerAsset.name);
      const actualChecksum = await sha256File(tmpPath);
      if (actualChecksum !== expectedChecksum) {
        throw new Error(`Installer checksum mismatch for ${installerAsset.name}`);
      }
      console.log('[AutoUpdate] SHA-256 verified. Launching silent installer.');

      const child = spawn(tmpPath, ['/S'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();

      console.log('[AutoUpdate] Silent installer launched. Service will restart momentarily.');
      return { ok: true };
    } catch (err) {
      console.error('[AutoUpdate] Error:', err.message);
      autoUpdateRunning = false;
      if (tmpPath) {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
      return { ok: false, reason: err.message };
    }
    // Note: autoUpdateRunning stays true until service restarts — intentional
  }

  // Admin-triggered update endpoint
  router.post('/api/app-update-trigger', requireAuth, requireAdmin, async (req, res) => {
    if (process.platform !== 'win32') {
      return res.status(400).json({ error: 'Auto-update only supported on Windows.' });
    }
    const result = await triggerWindowsUpdate();
    if (result.ok) {
      res.json({ ok: true, message: 'Update started. Service will restart automatically.' });
    } else {
      res.status(500).json({ ok: false, error: result.reason });
    }
  });

  // Background hourly check — auto-triggers update if new version available (Windows only)
  if (process.platform === 'win32' && IS_PRODUCTION) {
    const AUTO_UPDATE_INTERVAL_MS = 1000 * 60 * 60; // 1 hour
    setInterval(async () => {
      try {
        const status = await getVersionStatus();
        if (status.updateAvailable) {
          console.log(`[AutoUpdate] New version ${status.latestVersion} available (current: ${status.currentVersion}). Triggering update.`);
          await triggerWindowsUpdate();
        } else {
          console.log(`[AutoUpdate] Version check: up to date (${status.currentVersion}).`);
        }
      } catch (err) {
        console.error('[AutoUpdate] Hourly check error:', err.message);
      }
    }, AUTO_UPDATE_INTERVAL_MS);
    console.log('[AutoUpdate] Hourly auto-update check enabled.');
  }

  return router;
}
