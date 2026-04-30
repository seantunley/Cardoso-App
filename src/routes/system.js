import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createRequire } from 'module';
import bcrypt from 'bcryptjs';
import db from '../db/index.js';
import { getVersionStatus } from '../services/versionCheck.js';
import { logError } from '../lib/errorLog.js';

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
  const request = createAbortSignal(600000); // 10 min — installer is ~100MB, allow for slow site connections
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

function dedupeCustomers({ dryRun = true } = {}) {
  const dupGroups = db.prepare(`
    SELECT TRIM(customer_number) AS customer_number, COUNT(*) AS cnt
    FROM datarecord
    WHERE TRIM(COALESCE(customer_number, '')) != ''
    GROUP BY TRIM(customer_number)
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC, customer_number ASC
  `).all();

  const keepers = db.prepare(`
    SELECT id
    FROM datarecord
    WHERE TRIM(customer_number) = ?
    ORDER BY
      CASE WHEN updated_date IS NULL THEN 1 ELSE 0 END,
      COALESCE(updated_date, created_date, synced_at, '') DESC,
      id DESC
    LIMIT 1
  `);

  const deleteDupes = db.prepare(`DELETE FROM datarecord WHERE id = ?`);

  const tx = db.transaction(() => {
    const report = [];
    for (const group of dupGroups) {
      const keeper = keepers.get(group.customer_number)?.id;
      const rows = db.prepare(`
        SELECT id, customer_name, updated_date, created_date, synced_at, flag_color, flag_reason
        FROM datarecord
        WHERE TRIM(customer_number) = ?
        ORDER BY
          CASE WHEN updated_date IS NULL THEN 1 ELSE 0 END,
          COALESCE(updated_date, created_date, synced_at, '') DESC,
          id DESC
      `).all(group.customer_number);

      const removed = [];
      for (const row of rows) {
        if (row.id === keeper) continue;
        removed.push({
          id: row.id,
          name: row.customer_name,
          updated_date: row.updated_date,
          created_date: row.created_date,
          synced_at: row.synced_at,
          flag_color: row.flag_color,
          flag_reason: row.flag_reason,
        });
        if (!dryRun) deleteDupes.run(row.id);
      }

      report.push({ customer_number: group.customer_number, kept_id: keeper, removed_count: removed.length, removed });
    }
    return report;
  });

  const report = tx();
  return {
    ok: true,
    dryRun,
    groups: report.length,
    totalRemoved: report.reduce((sum, group) => sum + group.removed_count, 0),
    report,
  };
}

function clearImportedSqlData() {
  const counts = {
    datarecord: db.prepare(`SELECT COUNT(*) AS count FROM datarecord`).get()?.count || 0,
    inventoryrecord: db.prepare(`SELECT COUNT(*) AS count FROM inventoryrecord`).get()?.count || 0,
    syncrun: db.prepare(`SELECT COUNT(*) AS count FROM syncrun`).get()?.count || 0,
  };

  // Snapshot all flagged records so flags survive reimport
  const flaggedRecords = db.prepare(`
    SELECT customer_number, source_table, flag_color, flag_reason, flag_created_by, flag_source, auto_flagged, note
    FROM datarecord
    WHERE (flag_color IS NOT NULL AND flag_color != '' AND flag_color != 'none')
       OR (note IS NOT NULL AND note != '')
  `).all();

  const tx = db.transaction(() => {
    // Clear old snapshots and save current flags
    db.prepare(`DELETE FROM flag_snapshots`).run();
    if (flaggedRecords.length > 0) {
      const insertSnapshot = db.prepare(`
        INSERT INTO flag_snapshots (customer_number, source_table, flag_color, flag_reason, flag_created_by, flag_source, auto_flagged, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of flaggedRecords) {
        insertSnapshot.run(
          r.customer_number, r.source_table,
          r.flag_color, r.flag_reason, r.flag_created_by, r.flag_source, r.auto_flagged || 0, r.note
        );
      }
    }

    db.prepare(`DELETE FROM datarecord`).run();
    db.prepare(`DELETE FROM inventoryrecord`).run();
    db.prepare(`DELETE FROM syncrun`).run();
    db.prepare(`
      UPDATE databaseconnection
      SET record_count = 0,
          last_sync = NULL,
          last_error = NULL,
          updated_date = CURRENT_TIMESTAMP
    `).run();
  });

  tx();

  return {
    ok: true,
    removed: counts,
    totalRemoved: counts.datarecord + counts.inventoryrecord + counts.syncrun,
    flagsPreserved: flaggedRecords.length,
  };
}

export function createSystemRouter({ requireAuth, requireAdmin }) {
  const router = express.Router();

  // GET /api/health — unauthenticated health check
  router.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // POST /api/log/client-error — capture frontend errors to logs/errors.log
  // Unauthenticated so the login page can also report failures, but field sizes are capped.
  router.post('/api/log/client-error', (req, res) => {
    const { scope, message, stack, meta } = req.body || {};
    const truncate = (s, n) => (typeof s === 'string' ? s.slice(0, n) : undefined);
    logError(`client:${truncate(scope, 60) || 'unknown'}`, { message: truncate(message, 500), stack: truncate(stack, 2000) }, {
      user: req.currentUser?.email,
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress,
      ua: truncate(req.headers['user-agent'], 200),
      meta: meta && typeof meta === 'object' ? Object.fromEntries(Object.entries(meta).slice(0, 10)) : undefined,
    });
    res.json({ ok: true });
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

      // Stop the Cardoso service before launching the installer so it can
      // overwrite locked files. The installer (NSIS) will restart the service
      // after installation completes.
      const psScript = [
        `Stop-Service -Name 'CardosoCigarettes' -Force -ErrorAction SilentlyContinue`,
        `Start-Sleep -Seconds 3`,
        `Start-Process -FilePath '${tmpPath.replace(/'/g, "''")}' -ArgumentList '/S' -Wait`,
        `Start-Sleep -Seconds 5`,
        `# Installer should have restarted service; start it if not running`,
        `$svc = Get-Service -Name 'CardosoCigarettes' -ErrorAction SilentlyContinue`,
        `if ($svc -and $svc.Status -ne 'Running') { Start-Service -Name 'CardosoCigarettes' -ErrorAction SilentlyContinue }`,
      ].join('\n');

      const child = spawn('powershell.exe', [
        '-NonInteractive',
        '-WindowStyle', 'Hidden',
        '-Command', psScript,
      ], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();

      console.log('[AutoUpdate] PowerShell updater launched: stopping service, running installer, restarting.');
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

  router.post('/api/maintenance/dedupe-customers', requireAuth, requireAdmin, (req, res) => {
    try {
      if (process.env.HUB_MODE === 'true') {
        return res.status(400).json({ error: 'Customer dedupe is site-only and cannot be run from the Hub.' });
      }
      const dryRun = req.body?.dryRun !== false;
      const result = dedupeCustomers({ dryRun });
      res.json(result);
    } catch (error) {
      console.error('[maintenance] dedupe customers failed:', error.message);
      res.status(500).json({ error: error.message || 'Failed to dedupe customers' });
    }
  });

  router.post('/api/maintenance/clear-imported-data', requireAuth, requireAdmin, async (req, res) => {
    try {
      if (process.env.HUB_MODE === 'true') {
        return res.status(400).json({ error: 'Clear imported data is site-only and cannot be run from the Hub.' });
      }

      // Require password confirmation
      const { password } = req.body || {};
      if (!password) {
        return res.status(400).json({ error: 'Password is required to clear imported data.' });
      }
      const user = db.prepare('SELECT * FROM "user" WHERE id = ?').get(req.currentUser.id);
      if (!user || !user.password_hash) {
        return res.status(401).json({ error: 'Unable to verify user.' });
      }
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Incorrect password.' });
      }

      const result = clearImportedSqlData();
      res.json(result);
    } catch (error) {
      console.error('[maintenance] clear imported data failed:', error.message);
      res.status(500).json({ error: error.message || 'Failed to clear imported data' });
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
