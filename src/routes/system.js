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
import { logAudit } from '../lib/audit.js';

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

  // Optional: delta update artifacts. If present, the updater will prefer the
  // small app zip over re-downloading the full ~100MB installer.
  const manifestAsset = release.assets.find((asset) =>
    asset.name.startsWith('manifest-v') && asset.name.endsWith('.json'),
  );
  const appZipAsset = release.assets.find((asset) =>
    asset.name.startsWith('app-v') && asset.name.endsWith('.zip'),
  );

  return { ok: true, release, installerAsset, checksumAsset, manifestAsset, appZipAsset };
}

// Read the lock-hash marker the installer writes at install time. Returns
// `null` if the file doesn't exist (older install, or never wrote one). That
// missing-marker case forces the updater into the full-installer fallback.
function readInstalledLockHash() {
  const installDir = process.env.APP_DIR || 'C:\\Cardoso Customer App';
  try {
    const raw = fs.readFileSync(path.join(installDir, '.lock-hash'), 'utf8');
    return raw.trim().toLowerCase() || null;
  } catch {
    return null;
  }
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

  // GET /api/error-log — recent rows from the error_log table (admin only).
  // Powers the System Log page so off-site operators can see what failed
  // without needing terminal/file access.
  router.get('/api/error-log', requireAuth, requireAdmin, (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
    const source = typeof req.query.source === 'string' && req.query.source.trim() ? req.query.source.trim() : null;
    const sinceHours = Math.min(Math.max(parseInt(req.query.sinceHours, 10) || 24 * 7, 1), 24 * 90);
    try {
      const where = ["occurred_at >= datetime('now', ?)"];
      const args = [`-${sinceHours} hours`];
      if (source) { where.push('source = ?'); args.push(source); }
      const rows = db.prepare(`
        SELECT id, source, level, message, stack, context, occurred_at
        FROM error_log
        WHERE ${where.join(' AND ')}
        ORDER BY occurred_at DESC
        LIMIT ?
      `).all(...args, limit);
      const sources = db.prepare(`
        SELECT source, COUNT(*) AS n
        FROM error_log
        WHERE occurred_at >= datetime('now', ?)
        GROUP BY source
        ORDER BY n DESC
      `).all(`-${sinceHours} hours`);
      res.json({ rows, sources, limit, sinceHours });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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

  // ── TLS / reverse-proxy status ─────────────────────────────────────────────
  // Surfaces the current TLS deployment posture so an admin can see at a
  // glance whether the Hub is fronted by Caddy and whether helmet's
  // HTTPS-only protections are active. Read-only — actually flipping the
  // env vars or installing Caddy still requires shell access (running
  // scripts/install-hub-caddy.ps1 on the Hub server).
  //
  // See docs/ops/hub-tls.md.
  router.get('/api/system/tls-status', requireAuth, requireAdmin, async (req, res) => {
    const isWindows = process.platform === 'win32';
    const caddyDir = process.env.CADDY_DIR || 'C:\\Caddy';

    // Always-known runtime state
    const status = {
      platform: process.platform,
      tls_fronting: process.env.TLS_FRONTING === 'true',
      bind_address: process.env.BIND_ADDRESS || '0.0.0.0',
      port: parseInt(process.env.PORT || '3001', 10),
      hub_mode: process.env.HUB_MODE === 'true',
      caddy: null,        // populated on Windows when caddy.exe exists
      caddyfile: null,
      cert: null,
      service: null,
      docs: {
        runbook: 'docs/ops/hub-tls.md',
        local_test: 'docs/ops/hub-tls-local-test.md',
      },
    };

    // Posture summary for the UI badge — derived, kept here so the frontend
    // doesn't have to repeat the rules.
    const lanOnly = status.bind_address === '0.0.0.0' && !status.tls_fronting;
    const fullyFronted = status.bind_address === '127.0.0.1' && status.tls_fronting;
    status.posture = lanOnly ? 'http_lan_only' : fullyFronted ? 'tls_fronted' : 'partial';

    if (!isWindows) {
      // Phase 1 install scripts are Windows-only. On Linux/macOS dev boxes
      // we still report the env state so the UI works in dev — just no
      // Caddy filesystem inspection.
      return res.json(status);
    }

    // Caddy install detection
    try {
      const caddyExe = path.join(caddyDir, 'caddy.exe');
      status.caddy = {
        installed: fs.existsSync(caddyExe),
        dir: caddyDir,
        exe: caddyExe,
      };
    } catch { /* fs noise — safe to ignore */ }

    // Caddyfile inspection (parses out the hostname + backend port via
    // simple regex — the file is generated by our installer so the shape
    // is predictable. Skips full caddy parsing to avoid invoking the
    // binary on every status check).
    try {
      const caddyfilePath = path.join(caddyDir, 'Caddyfile');
      if (fs.existsSync(caddyfilePath)) {
        const text = fs.readFileSync(caddyfilePath, 'utf8');
        // Hostname is the first non-comment block opener
        const hostMatch = text.match(/^([A-Za-z0-9.-]+\.ts\.net)\s*\{/m);
        const backendMatch = text.match(/reverse_proxy\s+http:\/\/127\.0\.0\.1:(\d+)/);
        status.caddyfile = {
          path: caddyfilePath,
          hostname: hostMatch ? hostMatch[1] : null,
          backend_port: backendMatch ? parseInt(backendMatch[1], 10) : null,
        };
      }
    } catch { /* unparseable Caddyfile — leave null */ }

    // Cert inspection — read the .crt file and pull notBefore/notAfter
    // out via Node's X509Certificate. Doesn't touch the .key file.
    try {
      if (status.caddyfile?.hostname) {
        const certPath = path.join(caddyDir, `${status.caddyfile.hostname}.crt`);
        if (fs.existsSync(certPath)) {
          const certPem = fs.readFileSync(certPath, 'utf8');
          const cert = new crypto.X509Certificate(certPem);
          const notAfter = new Date(cert.validTo);
          const daysUntilExpiry = Math.floor((notAfter.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
          status.cert = {
            path: certPath,
            subject: cert.subject,
            issuer: cert.issuer,
            valid_from: cert.validFrom,
            valid_to: cert.validTo,
            days_until_expiry: daysUntilExpiry,
            warning: daysUntilExpiry < 14 ? 'expiring_soon' : (daysUntilExpiry < 0 ? 'expired' : null),
          };
        }
      }
    } catch (err) {
      status.cert = { error: `Failed to parse cert: ${err.message}` };
    }

    // Windows service status. Use 'sc query' via child_process (already
    // imported via spawn) — async-safe and doesn't depend on PowerShell.
    try {
      const serviceName = 'CardosoCaddy';
      const queryOutput = await new Promise((resolve, reject) => {
        const child = spawn('sc.exe', ['query', serviceName], { windowsHide: true });
        let out = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { out += d.toString(); });
        child.on('close', () => resolve(out));
        child.on('error', reject);
        setTimeout(() => { try { child.kill(); } catch {} resolve(out); }, 5000);
      });
      let serviceStatus = 'not_installed';
      if (/STATE\s*:\s*\d+\s+RUNNING/i.test(queryOutput)) serviceStatus = 'running';
      else if (/STATE\s*:\s*\d+\s+STOPPED/i.test(queryOutput)) serviceStatus = 'stopped';
      else if (/STATE\s*:\s*\d+\s+(START_PENDING|STOP_PENDING)/i.test(queryOutput)) serviceStatus = 'transitioning';
      status.service = { name: serviceName, status: serviceStatus };
    } catch {
      status.service = { name: 'CardosoCaddy', status: 'unknown' };
    }

    res.json(status);
  });

  // POST /api/system/tls-renew-cert — admin-triggered cert renewal.
  // Re-runs `tailscale cert <hostname>` and restarts the CardosoCaddy
  // service so Caddy picks up the new files. Useful when the cert is
  // close to expiry and you don't want to wait for Tailscale's auto-
  // renewal window.
  router.post('/api/system/tls-renew-cert', requireAuth, requireAdmin, async (req, res) => {
    if (process.platform !== 'win32') {
      return res.status(400).json({ error: 'TLS cert management is Windows-only.' });
    }
    const caddyDir = process.env.CADDY_DIR || 'C:\\Caddy';
    const appDir = process.env.APP_DIR || 'C:\\Cardoso Customer App';
    const nssmPath = path.join(appDir, 'nssm', 'nssm.exe');

    // Read hostname from Caddyfile so we don't accept it as user input
    // (avoids a command-injection surface — the hostname goes straight
    // into a child_process spawn call).
    let hostname = null;
    try {
      const caddyfile = fs.readFileSync(path.join(caddyDir, 'Caddyfile'), 'utf8');
      const m = caddyfile.match(/^([A-Za-z0-9.-]+\.ts\.net)\s*\{/m);
      if (m) hostname = m[1];
    } catch { /* will fail below */ }

    if (!hostname) {
      return res.status(400).json({ error: 'No Caddyfile found at expected location, or no .ts.net hostname in it. Run scripts/install-hub-caddy.ps1 first.' });
    }
    if (!/^[A-Za-z0-9.-]+\.ts\.net$/.test(hostname)) {
      return res.status(400).json({ error: 'Refusing to use suspicious hostname.' });
    }

    try {
      const runStep = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { windowsHide: true, cwd: caddyDir, ...opts });
        let out = '';
        child.stdout?.on('data', (d) => { out += d.toString(); });
        child.stderr?.on('data', (d) => { out += d.toString(); });
        child.on('close', (code) => {
          if (code === 0) resolve(out);
          else reject(new Error(`${cmd} exited ${code}: ${out.slice(-500)}`));
        });
        child.on('error', reject);
      });

      // Step 1: re-issue cert
      await runStep('tailscale.exe', ['cert', hostname]);

      // Step 2: restart Caddy so it loads the new cert
      if (fs.existsSync(nssmPath)) {
        await runStep(nssmPath, ['restart', 'CardosoCaddy']);
      }

      logAudit({
        req, action: 'tls_cert_renew', resourceType: 'system',
        resourceName: hostname,
        details: `Re-issued TLS cert for ${hostname} and restarted CardosoCaddy`,
      });

      res.json({ ok: true, hostname, message: 'Cert re-issued and Caddy restarted.' });
    } catch (err) {
      try { logError('system.tls_renew', err, { hostname }); } catch {}
      logAudit({
        req, action: 'tls_cert_renew', resourceType: 'system',
        resourceName: hostname || 'unknown',
        details: err.message,
        status: 'failure',
      });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/app-version-status
  router.get('/api/app-version-status', requireAuth, async (req, res) => {
    try {
      const versionStatus = await getVersionStatus();
      // Tack on the live update-progress state so the UI can show the
      // current phase + elapsed time instead of an indefinite spinner.
      // Stale phase/timestamp left over from the previous run is fine —
      // updateRunning is the gate the UI uses to decide whether to read
      // these fields.
      res.json({
        ...versionStatus,
        updateRunning: autoUpdateRunning,
        updatePhase: autoUpdatePhase,
        updateStartedAt: autoUpdateStartedAt,
      });
    } catch (error) {
      console.error('Version status error:', error);
      res.status(500).json({ error: 'Failed to check app version' });
    }
  });

  // ==================== AUTO-UPDATE (WINDOWS SERVICE) ====================
  let autoUpdateRunning = false;
  // Coarse-grained phase so the UI can render "Installing (2m 18s)…"
  // instead of a perpetual "Downloading update". Values:
  //   'downloading' | 'verifying' | 'installing' | 'restarting' | null
  let autoUpdatePhase = null;
  let autoUpdateStartedAt = null;

  // Try the lightweight delta-zip update path. Returns:
  //   { ok: true, mode: 'delta' }  → app zip downloaded + apply script spawned
  //   { ok: false, reason: ... }   → caller should fall back to the full EXE
  async function tryDeltaUpdate(releaseMeta) {
    const { release, manifestAsset, appZipAsset } = releaseMeta;
    if (!manifestAsset || !appZipAsset) {
      return { ok: false, reason: 'no_delta_artifacts' };
    }

    // Pull manifest.json from the release. Tiny file (~200 bytes).
    let manifest;
    try {
      assertTrustedAssetUrl(manifestAsset.browser_download_url);
      const r = await fetch(manifestAsset.browser_download_url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      manifest = await r.json();
    } catch (err) {
      return { ok: false, reason: `manifest_fetch_failed:${err.message}` };
    }

    if (!manifest?.lock_hash || !manifest?.app_zip || !manifest?.app_zip_sha256) {
      return { ok: false, reason: 'manifest_malformed' };
    }

    // Compare installed lock-hash against what this release was built with.
    // If they differ, package-lock.json changed → node_modules need to update,
    // which only the full installer can do.
    const installedLockHash = readInstalledLockHash();
    if (!installedLockHash) {
      return { ok: false, reason: 'no_lock_marker' };
    }
    if (installedLockHash !== manifest.lock_hash.toLowerCase()) {
      return { ok: false, reason: 'lock_changed', installed: installedLockHash, target: manifest.lock_hash };
    }

    // Confirm the apply script is on disk. It ships with the *current* install,
    // so a brand-new site upgrading from a pre-delta version won't have it.
    const installDir = process.env.APP_DIR || 'C:\\Cardoso Customer App';
    const applyScript = path.join(installDir, 'scripts', 'apply-app-update.ps1');
    if (!fs.existsSync(applyScript)) {
      return { ok: false, reason: 'apply_script_missing' };
    }

    // Download the app zip (small — typically <10MB)
    const tmpZip = path.join(process.env.TEMP || 'C:\\Windows\\Temp', manifest.app_zip);
    console.log(`[AutoUpdate-delta] Downloading ${manifest.app_zip} (${(appZipAsset.size / 1024 / 1024).toFixed(1)} MB)...`);
    autoUpdatePhase = 'downloading';
    try {
      await downloadReleaseAsset(appZipAsset.browser_download_url, tmpZip);
    } catch (err) {
      return { ok: false, reason: `app_zip_download_failed:${err.message}` };
    }

    autoUpdatePhase = 'verifying';
    const actual = await sha256File(tmpZip);
    if (actual !== manifest.app_zip_sha256.toLowerCase()) {
      try { fs.unlinkSync(tmpZip); } catch {}
      return { ok: false, reason: 'app_zip_sha_mismatch' };
    }
    console.log('[AutoUpdate-delta] SHA-256 verified. Launching apply-app-update.ps1.');
    autoUpdatePhase = 'installing';

    // Detached PowerShell — the apply script stops the service, swaps files,
    // restarts the service, and rolls back on any failure.
    const child = spawn('powershell.exe', [
      '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
      '-File', applyScript,
      '-ZipPath', tmpZip,
      '-ExpectedSha256', manifest.app_zip_sha256,
      '-AppDir', installDir,
      '-NewLockHash', manifest.lock_hash,
      '-NewVersion', String(manifest.version || ''),
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return { ok: true, mode: 'delta' };
  }

  async function triggerWindowsUpdate() {
    if (autoUpdateRunning) {
      console.log('[AutoUpdate] Update already in progress, skipping.');
      return { ok: false, reason: 'already_running' };
    }
    autoUpdateRunning = true;
    autoUpdateStartedAt = Date.now();
    autoUpdatePhase = 'downloading';

    let tmpPath = null;
    try {
      const releaseMeta = await fetchReleaseMetadata();
      if (!releaseMeta.ok) {
        autoUpdateRunning = false;
        autoUpdatePhase = null;
        autoUpdateStartedAt = null;
        console.warn(`[AutoUpdate] GitHub API rate limited (${releaseMeta.reason.split(':')[1]}). Skipping this cycle.`);
        return { ok: false, reason: 'rate_limited' };
      }

      // 1) Try the small delta zip first. Falls back to the EXE on any
      //    "can't do delta" condition (lock changed, no marker, no manifest,
      //    apply script missing, etc.).
      const delta = await tryDeltaUpdate(releaseMeta);
      if (delta.ok) {
        console.log('[AutoUpdate] Delta update launched (app zip).');
        // tryDeltaUpdate has set autoUpdatePhase to 'installing'. Once the
        // detached apply-app-update.ps1 finishes its work, the service
        // restart will reset all this state via process exit.
        return { ok: true, mode: 'delta' };
      }
      console.log(`[AutoUpdate] Delta path skipped (${delta.reason}). Falling back to full installer.`);

      const { installerAsset, checksumAsset } = releaseMeta;
      console.log(`[AutoUpdate] Downloading ${installerAsset.name} (${(installerAsset.size / 1024 / 1024).toFixed(1)} MB)...`);

      autoUpdatePhase = 'downloading';
      tmpPath = path.join(process.env.TEMP || 'C:\\Windows\\Temp', 'CardosoSetup-update.exe');
      await downloadReleaseAsset(installerAsset.browser_download_url, tmpPath);
      console.log(`[AutoUpdate] Downloaded to ${tmpPath}`);

      autoUpdatePhase = 'verifying';
      const expectedChecksum = await fetchChecksum(checksumAsset.browser_download_url, installerAsset.name);
      const actualChecksum = await sha256File(tmpPath);
      if (actualChecksum !== expectedChecksum) {
        throw new Error(`Installer checksum mismatch for ${installerAsset.name}`);
      }
      console.log('[AutoUpdate] SHA-256 verified. Launching silent installer.');
      autoUpdatePhase = 'installing';

      // Stop the Cardoso service before launching the installer so it can
      // overwrite locked files. The installer (NSIS) will restart the service
      // after installation completes.
      //
      // We run the installer with a 5-minute hard timeout. NSIS occasionally
      // wedges (UAC prompt nobody can click, MSI lock contention, etc.) and
      // the previous version waited forever. WaitForExit returns false on
      // timeout; we then force-kill so the service restart still happens
      // and the operator gets a clear failure instead of a perpetual
      // "Downloading update" spinner.
      const psScript = [
        `Stop-Service -Name 'CardosoCigarettes' -Force -ErrorAction SilentlyContinue`,
        `Start-Sleep -Seconds 3`,
        `$proc = Start-Process -FilePath '${tmpPath.replace(/'/g, "''")}' -ArgumentList '/S' -PassThru`,
        `$completed = $proc.WaitForExit(300000)`,
        `if (-not $completed) {`,
        `  try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}`,
        `  Write-Error "Installer timed out after 5 minutes — process killed"`,
        `}`,
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
      // Once the spawned PS hands off to the installer, the service will be
      // stopped and this Node process won't see the next state change. Mark
      // 'restarting' so the UI shows the right phase right up until the
      // service comes back on the new version.
      autoUpdatePhase = 'restarting';
      return { ok: true };
    } catch (err) {
      console.error('[AutoUpdate] Error:', err.message);
      autoUpdateRunning = false;
      autoUpdatePhase = null;
      autoUpdateStartedAt = null;
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
    logAudit({
      req, action: 'app_update_trigger', resourceType: 'system',
      resourceName: 'App update',
      details: result.ok ? 'Update started; service will restart' : `Update failed: ${result.reason}`,
      status: result.ok ? 'success' : 'failure',
    });
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
      logAudit({
        req, action: dryRun ? 'dedupe_customers_dryrun' : 'dedupe_customers',
        resourceType: 'system', resourceName: 'Customer deduplication',
        details: dryRun ? `Dry-run found ${result.duplicates_found || 0} duplicate group(s)` : `Removed ${result.removed || 0} duplicate(s)`,
        changes: result,
      });
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
      logAudit({
        req, action: 'clear_imported_data', resourceType: 'system',
        resourceName: 'Imported customer data',
        details: `Cleared imported customer data; password-confirmed by ${req.currentUser.email}`,
        changes: result,
      });
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
