import express from 'express';
import path from 'path';
import { exec as execChild } from 'child_process';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createRequire } from 'module';
import { getVersionStatus } from '../services/versionCheck.js';

const require = createRequire(import.meta.url);

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

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

    try {
      // Get download URL for latest release asset
      const _controller = new AbortController();
      const _timeout = setTimeout(() => _controller.abort(), 10000);
      let releaseResp;
      try {
        releaseResp = await fetch('https://api.github.com/repos/seantunley/Cardoso-App/releases/latest', {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'cardoso-app-auto-update' },
          signal: _controller.signal,
        });
      } finally {
        clearTimeout(_timeout);
      }
      if (releaseResp.status === 429 || releaseResp.status === 403) {
        console.warn(`[AutoUpdate] GitHub API rate limited (${releaseResp.status}). Skipping this cycle.`);
        autoUpdateRunning = false;
        return { ok: false, reason: 'rate_limited' };
      }
      if (!releaseResp.ok) throw new Error(`GitHub API error: ${releaseResp.status}`);
      const release = await releaseResp.json();
      const asset = release.assets.find(a => a.name.startsWith('CardosoSetup-') && a.name.endsWith('.exe'));
      if (!asset) throw new Error('CardosoSetup.exe not found in latest release');

      console.log(`[AutoUpdate] Downloading ${asset.name} (${(asset.size/1024/1024).toFixed(1)} MB)...`);

      // Download to temp file
      const tmpPath = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'CardosoSetup-update.exe');
      const dlResp = await fetch(asset.browser_download_url);
      if (!dlResp.ok) throw new Error(`Download failed: ${dlResp.status}`);
      await pipeline(dlResp.body, createWriteStream(tmpPath));
      console.log(`[AutoUpdate] Downloaded to ${tmpPath}`);

      // Run installer silently — NSIS /S flag, detached so service can be replaced
      const child = execChild(`"${tmpPath}" /S`, { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      console.log('[AutoUpdate] Silent installer launched. Service will restart momentarily.');
      return { ok: true };
    } catch (err) {
      console.error('[AutoUpdate] Error:', err.message);
      autoUpdateRunning = false;
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
