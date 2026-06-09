import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import { promises as fsp, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createRequire } from 'module';
import bcrypt from 'bcryptjs';
import db from '../db/index.js';
import { getVersionStatus } from '../services/versionCheck.js';
import { logError } from '../lib/errorLog.js';
import { logAudit } from '../lib/audit.js';
import { getSecuritySignals } from '../lib/securitySignals.js';
import { recomputeReconTotals } from '../services/bat/reconTotals.js';

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

// Run a PowerShell script truly outside the Cardoso process tree.
//
// Why: when our auto-updater's spawned PowerShell runs `Stop-Service
// CardosoCigarettes`, the service stop kills its parent (node.exe), and
// NSSM's "kill process tree" behaviour kills every descendant — including
// the PowerShell process that's about to install the new version. The
// installer never runs, the service stays stopped (or gets restarted by
// the operator at the OLD version), and the UI hangs at "Restarting
// service" forever because `currentVersion` never flips.
//
// `detached: true` on Node's `spawn` is not enough on Windows in this
// scenario. The standard fix is Task Scheduler: ask the OS to run the
// script as a one-shot SYSTEM task in N seconds. The Task Scheduler is
// not a child of our service, so when the service stops it has no
// effect on the running task. The task script also cleans up after
// itself (deletes both the task definition and the .ps1 file).
//
// Returns the absolute path of the .ps1 file written, for use by callers
// that need to log it.
// Exported so other routers (e.g. routes/hub.js receive-restore
// handler) can hand off long-running, service-restarting work to
// the OS scheduler with the same survives-NSSM-kill-tree semantics
// the in-app updater needs.
export async function launchViaTaskScheduler(taskName, scriptContent) {
  const tempDir = process.env.TEMP || 'C:\\Windows\\Temp';
  const scriptPath = path.join(tempDir, `${taskName}.ps1`);

  // Append self-cleanup. Run as the very last step so anything before it
  // — including process exit — leaves no scheduled-task or temp-script
  // residue. Unconditional via `try/finally` so a failed install still
  // deletes the task.
  const wrappedScript = `
$ErrorActionPreference = 'Continue'
try {
${scriptContent}
} finally {
  try { schtasks.exe /Delete /F /TN '${taskName}' | Out-Null } catch {}
  try { Remove-Item -LiteralPath '${scriptPath}' -Force -ErrorAction SilentlyContinue } catch {}
}
`.trim();

  // Prepend a UTF-8 BOM so PowerShell 5.1 reads the file as UTF-8 instead
  // of the default cp1252. Without the BOM, any multi-byte UTF-8 character
  // anywhere in the script (em-dashes, smart quotes, etc.) gets mis-decoded
  // mid-string and breaks the parser. We've been bitten by this twice now
  // (install-hub-caddy.ps1 + this file's installerScript with the em-dash
  // in "timed out — process killed"). The BOM is 3 bytes; cheap insurance.
  // Written as the explicit Buffer-prefixed bytes \xEF\xBB\xBF so editor
  // round-trips, copy/paste, or stray normalisation can't silently strip
  // a literal U+FEFF character.
  const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);
  const body = Buffer.from(wrappedScript, 'utf8');
  await fsp.writeFile(scriptPath, Buffer.concat([BOM, body]));

  // Create a one-shot task that's scheduled at a dummy time and triggered
  // immediately via /Run. SYSTEM context, highest run-level — the same
  // privilege the service has, so all of Stop-Service / Start-Process
  // installer / Start-Service work without elevation prompts.
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn('schtasks.exe', args, { stdio: 'pipe', windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`schtasks ${args[0]} failed (code ${code}): ${stderr.trim()}`));
    });
  });

  // /Create the task. /F overwrites any leftover from a prior failed
  // attempt with the same name (we name with a timestamp so collisions
  // are unlikely, but defensive).
  await run([
    '/Create', '/F',
    '/TN', taskName,
    '/TR', `powershell.exe -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${scriptPath}"`,
    '/SC', 'ONCE',
    '/ST', '23:59',
    '/RL', 'HIGHEST',
    '/RU', 'SYSTEM',
  ]);
  // /Run fires it immediately (the /ST is just a required-by-syntax
  // placeholder for ONCE schedules).
  await run(['/Run', '/TN', taskName]);

  return scriptPath;
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
    // ?prefixes=bat.ocr.,bat-ocr. — narrow rows AND the sources dropdown
    // to topics matching ANY of the given prefixes. The OCR ops panel
    // needs this so it doesn't fetch 300 unrelated rows and client-side
    // filter to leftovers (Codex P2 on PR #226: when System Log is
    // dominated by other sources, the 300-row server cap fills up
    // before enough OCR entries reach the client and the operator sees
    // a shorter window than they think).
    //
    // Capped at 5 prefixes to keep the SQL clause bounded; each prefix
    // sanitised to ≤ 60 chars. SQLite LIKE-escape isn't needed here
    // because our topic names are dot-/dash-separated identifiers — no
    // % or _ in any topic — but we strip those defensively anyway so a
    // future topic naming choice can't accidentally widen the filter.
    // ?exclude_prefixes=bat.ocr.,bat-ocr. — symmetric inverse of prefixes.
    // Used by the System Log panel to hide topics that already have a
    // dedicated tab (today: OCR), so the operator doesn't see the same
    // entry on two screens. Same parsing/safety bounds as prefixes.
    const parsePrefixList = (raw) => {
      if (typeof raw !== 'string' || !raw.trim()) return null;
      const list = raw
        .split(',')
        .map(p => p.trim().slice(0, 60))
        .filter(Boolean)
        .map(p => p.replace(/[%_]/g, ''))
        .slice(0, 5);
      return list.length === 0 ? null : list;
    };
    const prefixes = parsePrefixList(req.query.prefixes);
    const excludePrefixes = parsePrefixList(req.query.exclude_prefixes);
    try {
      const where = ["occurred_at >= datetime('now', ?)"];
      const args = [`-${sinceHours} hours`];
      // Build the prefix clauses once and reuse for both the rows query
      // (whose limit Codex was worried about) and the sources aggregate
      // (so the dropdown counts match what's actually visible).
      let prefixClause = '';
      const prefixArgs = [];
      if (prefixes) {
        prefixClause = `(${prefixes.map(() => 'source LIKE ?').join(' OR ')})`;
        for (const p of prefixes) prefixArgs.push(`${p}%`);
      }
      let excludeClause = '';
      const excludeArgs = [];
      if (excludePrefixes) {
        excludeClause = `(${excludePrefixes.map(() => 'source NOT LIKE ?').join(' AND ')})`;
        for (const p of excludePrefixes) excludeArgs.push(`${p}%`);
      }
      if (source) {
        // Explicit single-source filter wins over both prefix lists —
        // used when the operator picks a specific topic from the
        // dropdown. We honour their choice even if it would have been
        // hidden by exclude_prefixes.
        where.push('source = ?');
        args.push(source);
      } else {
        if (prefixClause) {
          where.push(prefixClause);
          args.push(...prefixArgs);
        }
        if (excludeClause) {
          where.push(excludeClause);
          args.push(...excludeArgs);
        }
      }
      const rows = db.prepare(`
        SELECT id, source, level, message, stack, context, occurred_at
        FROM error_log
        WHERE ${where.join(' AND ')}
        ORDER BY occurred_at DESC
        LIMIT ?
      `).all(...args, limit);
      const sourceWhere = ["occurred_at >= datetime('now', ?)"];
      const sourceArgs = [`-${sinceHours} hours`];
      if (prefixClause) {
        sourceWhere.push(prefixClause);
        sourceArgs.push(...prefixArgs);
      }
      if (excludeClause) {
        sourceWhere.push(excludeClause);
        sourceArgs.push(...excludeArgs);
      }
      const sources = db.prepare(`
        SELECT source, COUNT(*) AS n
        FROM error_log
        WHERE ${sourceWhere.join(' AND ')}
        GROUP BY source
        ORDER BY n DESC
      `).all(...sourceArgs);
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
  // GET /api/system/jobs[?since=ISO_DATE]
  //
  // Returns the latest run of every scheduled background job + a failure
  // count in the time window (default 24h). Backs the Operations page's
  // Job Runs tab.
  //
  // (This endpoint was meant to ship with PR #178 but got dropped in the
  // #178 ↔ #180 merge collision — same merge that ate the recordJob
  // imports fixed in PR #182. Adding it back here so the Operations
  // page actually has data to render.)
  //
  // Lazy-import jobRunner so the route file doesn't pull better-sqlite3
  // into anything that loads system.js standalone.
  router.get('/api/system/jobs', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { getJobsSummary } = await import('../lib/jobRunner.js');
      const since = typeof req.query.since === 'string' ? req.query.since : undefined;
      res.json({ jobs: getJobsSummary({ since }) });
    } catch (err) {
      console.error('[system.jobs] failed:', err.message);
      res.status(500).json({ error: 'Failed to load job summary' });
    }
  });

  // GET /api/system/scheduled-jobs
  //
  // Returns the in-memory registry of every cron / interval / one-shot
  // job that scheduler.js registered at boot, with computed next-fire
  // times for cron jobs (via node-cron's task.getNextRun()). Backs the
  // Operations page's Schedule tab so the operator can see WHAT is
  // scheduled to run and WHEN, not just what HAS run (which is the
  // existing /api/system/jobs view).
  router.get('/api/system/scheduled-jobs', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { listScheduledJobs } = await import('../lib/scheduledJobs.js');
      const jobs = listScheduledJobs();
      // Attach each job's most recent run (from job_runs) so the Schedule tab
      // can show last-run + status beside next-run. This reads the same source
      // the alert engine uses, so the operator sees the exact data behind a
      // "stale sync" alert (e.g. last run 3d ago against a daily schedule) —
      // no parallel staleness calculation, just the latest run fact.
      const lastRunStmt = db.prepare(
        `SELECT status, started_at, ended_at, duration_ms, error_message
         FROM job_runs WHERE name = ? ORDER BY started_at DESC LIMIT 1`,
      );
      for (const j of jobs) {
        j.lastRun = lastRunStmt.get(j.name) || null;
      }
      res.json({ jobs, serverTime: new Date().toISOString() });
    } catch (err) {
      console.error('[system.scheduled-jobs] failed:', err.message);
      res.status(500).json({ error: 'Failed to load scheduled jobs' });
    }
  });

  // GET /api/system/alerts?status=active|all
  //
  // Active alerts (resolved_at IS NULL) drive the admin banner; the
  // 'all' view is for the history modal. Admin-only since the messages
  // include diagnostic detail and the underlying conditions are
  // operational, not user-facing.
  router.get('/api/system/alerts', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { getActiveAlerts, getAllAlerts } = await import('../lib/alertEngine.js');
      const status = req.query.status === 'all' ? 'all' : 'active';
      const alerts = status === 'all' ? getAllAlerts() : getActiveAlerts();
      res.json({ status, count: alerts.length, alerts });
    } catch (err) {
      console.error('[system.alerts] failed:', err.message);
      res.status(500).json({ error: 'Failed to load alerts' });
    }
  });

  // POST /api/system/alerts/:id/acknowledge
  //
  // Manual resolution. Records who acknowledged so the audit trail
  // shows operator action vs. auto-resolution by the engine.
  router.post('/api/system/alerts/:id/acknowledge', requireAuth, requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid alert id' });
    try {
      const { acknowledgeAlert } = await import('../lib/alertEngine.js');
      const changes = acknowledgeAlert(id, `admin:${req.currentUser?.email || req.currentUser?.id || 'unknown'}`);
      if (changes === 0) {
        return res.status(404).json({ error: 'Alert not found or already resolved' });
      }
      res.json({ ok: true, id });
    } catch (err) {
      console.error('[system.alerts.ack] failed:', err.message);
      res.status(500).json({ error: 'Failed to acknowledge alert' });
    }
  });

  // GET /api/system/security-signals
  //
  // Admin-only. Returns the rolled-up totals over the last 60 minutes
  // (per-status counts, login failures, latency, upload volume) plus
  // the live threshold-alert strings. Backs the Operations → Security
  // tab. The persistent record of any threshold breach lives in the
  // alerts table via src/lib/alertRules.js.
  router.get('/api/system/security-signals', requireAuth, requireAdmin, (req, res) => {
    try {
      res.json(getSecuritySignals());
    } catch (err) {
      console.error('[system.security-signals] failed:', err.message);
      try { logError('system.security_signals', err); } catch {} // eslint-disable-line no-empty -- logError wrapper; we still return 500 below
      res.status(500).json({ error: 'Failed to load security signals' });
    }
  });

  // GET /api/system/sage-health
  //
  // Consolidated "is the data current and healthy?" snapshot for site mode.
  // Composes the signals that already exist but are scattered across BAT,
  // the sync services, the error log, alerts and job_runs into one payload
  // with a single overall status. Backs the SageHealthPanel shown on the
  // Reporting dashboard and Operations page.
  //
  // requireAuth (not requireAdmin) so non-admin reporting users can still
  // see whether the numbers they're looking at are fresh. Heavy modules
  // (mssql via batReconciliation, alertEngine) are lazy-imported so loading
  // system.js standalone doesn't drag them in.
  router.get('/api/system/sage-health', requireAuth, async (req, res) => {
    try {
      const [{ getSageHealth }, { getSyncMeta: getCreditorMeta }, { getSyncMeta: getInventoryMeta }, { getSyncMeta: getReceiptMeta }] =
        await Promise.all([
          import('../services/batReconciliation.js'),
          import('../services/creditorSync.js'),
          import('../services/inventoryMovement.js'),
          import('../services/stockReceipts.js'),
        ]);

      const sage = getSageHealth();

      // Age (in hours) of a local-time timestamp string, computed in SQLite
      // against now_local() so it stays consistent with how timestamps are
      // stored (local UTC+2), never bare datetime('now').
      const ageStmt = db.prepare("SELECT (julianday(now_local()) - julianday(?)) * 24.0 AS hours");
      const ageHours = (ts) => {
        if (!ts) return null;
        try {
          const row = ageStmt.get(ts);
          return row && Number.isFinite(row.hours) ? row.hours : null;
        } catch {
          return null;
        }
      };

      // Sync freshness per source. All three sync nightly, so >24h since the
      // last successful sync = stale. null last_synced_at = never synced.
      const STALE_HOURS = 24;
      // These sync jobs only run on site installs; the hub receives this data
      // via ETL, not local Sage sync. On the hub their meta stays null, which
      // would falsely mark every source stale, so omit them in hub mode.
      const rawSources = process.env.HUB_MODE === 'true' ? [] : [
        { key: 'creditors', label: 'Creditors', last_synced_at: getCreditorMeta()?.last_synced_at || null },
        { key: 'inventory', label: 'Inventory sales', last_synced_at: getInventoryMeta()?.last_synced_at || null },
        { key: 'receipts', label: 'Stock receipts', last_synced_at: getReceiptMeta()?.last_synced_at || null },
      ];
      const sources = rawSources.map((s) => {
        const hours = ageHours(s.last_synced_at);
        const stale = s.last_synced_at === null || (hours !== null && hours > STALE_HOURS);
        return { ...s, age_hours: hours, stale };
      });

      // Configured database connections and their last sync outcome.
      let connections = [];
      try {
        connections = db
          .prepare('SELECT name, status, last_sync, last_error, record_count FROM databaseconnection ORDER BY name')
          .all();
      } catch {
        connections = [];
      }

      // Errors logged in the last 24h (count + a few most-recent).
      let errors24h = 0;
      let recentErrors = [];
      try {
        errors24h = db
          .prepare("SELECT COUNT(*) AS c FROM error_log WHERE level = 'error' AND occurred_at >= datetime(now_local(), '-24 hours')")
          .get().c;
        recentErrors = db
          .prepare("SELECT source, message, occurred_at FROM error_log WHERE level = 'error' AND occurred_at >= datetime(now_local(), '-24 hours') ORDER BY occurred_at DESC LIMIT 5")
          .all();
      } catch {
        errors24h = 0;
      }

      // Background job failures in the last 24h.
      let jobFailures24h = 0;
      try {
        jobFailures24h = db
          .prepare("SELECT COUNT(*) AS c FROM job_runs WHERE status = 'failed' AND started_at >= datetime(now_local(), '-24 hours')")
          .get().c;
      } catch {
        jobFailures24h = 0;
      }

      // Active (unresolved) alerts.
      let activeAlerts = 0;
      let criticalAlerts = 0;
      try {
        const { getActiveAlerts } = await import('../lib/alertEngine.js');
        const alerts = getActiveAlerts();
        activeAlerts = alerts.length;
        criticalAlerts = alerts.filter((a) => a.severity === 'critical').length;
      } catch {
        activeAlerts = 0;
      }

      // Roll up an overall status. Critical wins over warn wins over ok.
      const anyStale = sources.some((s) => s.stale);
      const sageDown = sage.ok === false;
      let status = 'ok';
      if ((sageDown && sage.downForMinutes > 5) || criticalAlerts > 0) {
        status = 'critical';
      } else if (sageDown || anyStale || jobFailures24h > 0 || errors24h > 0 || activeAlerts > 0) {
        status = 'warn';
      }

      res.json({
        status,
        generated_at: new Date().toISOString(),
        sage,
        sources,
        connections,
        errors24h,
        recentErrors,
        jobFailures24h,
        activeAlerts,
        criticalAlerts,
      });
    } catch (err) {
      console.error('[system.sage-health] failed:', err.message);
      try { logError('system.sage_health', err); } catch {} // eslint-disable-line no-empty -- logError wrapper; we still return 500 below
      res.status(500).json({ error: 'Failed to load Sage health' });
    }
  });

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
        setTimeout(() => { try { child.kill(); } catch (e) { console.warn('[system.tls_status.kill_sc_query]', e.message); } resolve(out); }, 5000);
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
      try { logError('system.tls_renew', err, { hostname }); } catch {} // eslint-disable-line no-empty -- logError wrapper; failure already mirrored to audit log below
      logAudit({
        req, action: 'tls_cert_renew', resourceType: 'system',
        resourceName: hostname || 'unknown',
        details: err.message,
        status: 'failure',
      });
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/system/hub-url — show what's in the DB override + .env seed,
  // and the live "effective" URL hub-bound fetches will use. Lets the
  // operator see config drift without RDP'ing to read .env.
  router.get('/api/system/hub-url', requireAuth, requireAdmin, async (req, res) => {
    try {
      const dbRow = db.prepare(`SELECT value, updated_at FROM bat_settings WHERE key = 'hub_sync_url'`).get();
      const envValue = process.env.HUB_SYNC_URL || process.env.HUB_REDIRECT_URL || null;
      const effective = (dbRow?.value || envValue || '').replace(/\/$/, '') || null;
      res.json({
        configured: dbRow?.value || null,
        configuredUpdatedAt: dbRow?.updated_at || null,
        envSeed: envValue,
        effective,
        hubMode: process.env.HUB_MODE === 'true',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/system/hub-url { url } — set the override. Empty string clears
  // the override (sync falls back to .env). Probes the URL after saving and
  // returns the probe result so the UI can show ✓/✗ inline.
  router.put('/api/system/hub-url', requireAuth, requireAdmin, async (req, res) => {
    if (process.env.HUB_MODE === 'true') {
      return res.status(400).json({ error: 'Hub URL is configured on sites only — this instance is the hub.' });
    }
    const raw = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    // Sanity: require https?:// scheme to avoid storing bare hostnames or
    // accidentally setting it to a path. Empty string is allowed (clears override).
    if (raw && !/^https?:\/\/[^/\s]+/.test(raw)) {
      return res.status(400).json({ error: 'URL must include scheme (http:// or https://) and a host.' });
    }
    try {
      const before = db.prepare(`SELECT value FROM bat_settings WHERE key = 'hub_sync_url'`).get()?.value || null;
      if (raw) {
        const cleaned = raw.replace(/\/$/, '');
        db.prepare(`INSERT INTO bat_settings (key, value, updated_at) VALUES ('hub_sync_url', ?, now_local())
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
          .run(cleaned);
      } else {
        db.prepare(`DELETE FROM bat_settings WHERE key = 'hub_sync_url'`).run();
      }
      logAudit({
        req, action: 'hub_url_update', resourceType: 'system',
        resourceName: 'hub_sync_url',
        details: `Hub sync URL ${raw ? `set to ${raw}` : 'cleared'}`,
        changes: { before: { hub_sync_url: before }, after: { hub_sync_url: raw || null } },
      });

      // Probe immediately so the UI can show whether the new URL works.
      const { probeHubUrl } = await import('../services/creditLogic.js');
      const probe = await probeHubUrl();
      res.json({ ok: true, probe });
    } catch (err) {
      try { logError('system.hub_url_update', err); } catch {} // eslint-disable-line no-empty -- logError wrapper; we still return 500 below
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/system/hub-probe — manual probe trigger (used by Settings UI
  // refresh button). Same as the auto-boot probe but on demand.
  router.post('/api/system/hub-probe', requireAuth, requireAdmin, async (req, res) => {
    try {
      const { probeHubUrl } = await import('../services/creditLogic.js');
      res.json(await probeHubUrl());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Read the .last-update-status.json marker that apply-app-update.ps1
  // writes on every exit (success AND failure). This is the only way
  // the Node side can tell whether the in-app update actually landed —
  // the script runs detached via Task Scheduler, so its exit code is
  // unreachable. Returns null if the marker is missing or unreadable.
  function readLastUpdateStatus() {
    try {
      const installDir = process.env.APP_DIR || 'C:\\Cardoso Customer App';
      const statusPath = path.join(installDir, '.last-update-status.json');
      if (!fs.existsSync(statusPath)) return null;
      const raw = fs.readFileSync(statusPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // Compare two YYYY.M.P version strings. Returns positive if a > b,
  // negative if a < b, 0 if equal. Used to decide whether a recorded
  // failed-update marker is still operationally relevant: if the
  // current installed version is already AT or PAST the version the
  // failed attempt was targeting (operator manually installed a newer
  // build to recover, etc.), the banner is just historical noise and
  // shouldn't dominate the UI forever. Tolerant of missing / malformed
  // inputs — returns 0 so the gate "expected > current" defaults to
  // FALSE (banner hides) when we can't tell.
  function compareVersions(a, b) {
    if (!a || !b) return 0;
    const pa = String(a).split('.').map((s) => parseInt(s, 10));
    const pb = String(b).split('.').map((s) => parseInt(s, 10));
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const ai = Number.isFinite(pa[i]) ? pa[i] : 0;
      const bi = Number.isFinite(pb[i]) ? pb[i] : 0;
      if (ai !== bi) return ai - bi;
    }
    return 0;
  }

  // GET /api/app-version-status
  router.get('/api/app-version-status', requireAuth, async (req, res) => {
    try {
      const versionStatus = await getVersionStatus();
      // Tack on the live update-progress state so the UI can show the
      // current phase + elapsed time instead of an indefinite spinner.
      // Stale phase/timestamp left over from the previous run is fine —
      // updateRunning is the gate the UI uses to decide whether to read
      // these fields.
      //
      // Also surface the last-update-status marker so the UI can warn
      // when the previous update partially failed (e.g. file lock during
      // file swap → rollback → service restarted at the OLD version,
      // which previously showed "Update successful" because the script's
      // exit code was unreachable from here).
      const lastUpdate = readLastUpdateStatus();
      const lastUpdateFailed = !!(
        lastUpdate &&
        lastUpdate.state &&
        lastUpdate.state !== 'ok' &&
        // Only flag if the failed attempt was targeting a version we
        // still HAVEN'T installed. The previous check used !== which
        // kept the banner alive forever after a manual reinstall of a
        // newer build — if an operator caught up past the attempted
        // version some other way, the failure is historical and not
        // actionable. Switch to strict-NEWER: only nag while the box
        // is still behind the version the failed attempt was for.
        lastUpdate.expected_version &&
        versionStatus.currentVersion &&
        compareVersions(lastUpdate.expected_version, versionStatus.currentVersion) > 0
      );
      res.json({
        ...versionStatus,
        updateRunning: autoUpdateRunning,
        updatePhase: autoUpdatePhase,
        updateStartedAt: autoUpdateStartedAt,
        lastUpdateFailed,
        lastUpdateState: lastUpdate?.state ?? null,
        lastUpdateError: lastUpdateFailed ? (lastUpdate?.error ?? null) : null,
        lastUpdateAt: lastUpdate?.finished_at ?? null,
        lastUpdateExpectedVersion: lastUpdate?.expected_version ?? null,
      });
    } catch (error) {
      console.error('Version status error:', error);
      res.status(500).json({ error: 'Failed to check app version' });
    }
  });

  // GET /api/app-update-log
  // Returns the tail of update.log so an operator can see WHY an update
  // failed without RDP'ing into the box. Only the last ~100 lines so we
  // don't dump megabytes. Admin-only since update logs can contain paths
  // and details about the install layout.
  router.get('/api/app-update-log', requireAuth, requireAdmin, (req, res) => {
    try {
      const installDir = process.env.APP_DIR || 'C:\\Cardoso Customer App';
      const logPath = path.join(installDir, 'logs', 'update.log');
      if (!fs.existsSync(logPath)) {
        return res.json({ ok: true, lines: [], note: 'no update log on disk yet' });
      }
      const raw = fs.readFileSync(logPath, 'utf8');
      const lines = raw.split(/\r?\n/).filter(Boolean);
      const tail = lines.slice(-100);
      res.json({ ok: true, lines: tail, status: readLastUpdateStatus() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
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
      try { fs.unlinkSync(tmpZip); } catch (e) { console.warn('[system.autoUpdate.sha_mismatch_cleanup]', { tmpZip }, e.message); }
      return { ok: false, reason: 'app_zip_sha_mismatch' };
    }
    console.log('[AutoUpdate-delta] SHA-256 verified. Launching apply-app-update.ps1 via Task Scheduler.');
    autoUpdatePhase = 'installing';

    // Run the apply script via Task Scheduler so the runner survives the
    // service stop. Previously this was a `spawn(..., { detached: true })`
    // call, but on a service-managed Cardoso install the spawned PS is
    // still in node's process tree — when apply-app-update.ps1 stops the
    // service, NSSM kills the tree, the apply script dies before
    // installing anything, and the operator sees "Restarting service"
    // forever in the UI.
    const taskName = `CardosoUpdater-delta-${Date.now()}`;
    // Quote each argument for PowerShell so paths with spaces survive
    // re-parsing inside the wrapper script.
    const psArgs = [
      ['-ZipPath', tmpZip],
      ['-ExpectedSha256', manifest.app_zip_sha256],
      ['-AppDir', installDir],
      ['-NewLockHash', manifest.lock_hash],
      ['-NewVersion', String(manifest.version || '')],
    ].map(([k, v]) => `${k} '${String(v).replace(/'/g, "''")}'`).join(' ');
    const wrapper = `& '${applyScript.replace(/'/g, "''")}' ${psArgs}`;
    try {
      await launchViaTaskScheduler(taskName, wrapper);
    } catch (err) {
      console.error('[AutoUpdate-delta] Task Scheduler launch failed:', err.message);
      try { logError('app.update.delta', err, { phase: 'task_scheduler_launch' }); } catch (e) { console.error('[system.task_scheduler]', { phase: 'delta_launch_log' }, e.message); }
      return { ok: false, reason: `task_scheduler_launch_failed:${err.message}` };
    }
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
      console.log('[AutoUpdate] SHA-256 verified. Launching silent installer via Task Scheduler.');
      autoUpdatePhase = 'installing';

      // Run the installer via Task Scheduler so the runner is not a child
      // of the Cardoso service process tree. Without this the script dies
      // with the service it just stopped (NSSM kill-tree), so NSIS never
      // executes, the operator sees "Restarting service" forever, and a
      // manual restart brings the service back at the OLD version.
      //
      // The installer also runs with a 5-minute hard timeout. NSIS
      // occasionally wedges (UAC prompt nobody can click, MSI lock
      // contention, etc.) and the previous version waited forever.
      // WaitForExit returns false on timeout; we then force-kill so the
      // service restart still happens and the operator gets a clear
      // failure instead of a perpetual spinner.
      const installerScript = [
        `Stop-Service -Name 'CardosoCigarettes' -Force -ErrorAction SilentlyContinue`,
        `Start-Sleep -Seconds 3`,
        `$proc = Start-Process -FilePath '${tmpPath.replace(/'/g, "''")}' -ArgumentList '/S' -PassThru`,
        `$completed = $proc.WaitForExit(300000)`,
        `if (-not $completed) {`,
        `  try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}`,
        `  Write-Error "Installer timed out after 5 minutes - process killed"`,
        `}`,
        `Start-Sleep -Seconds 5`,
        `# Installer should have restarted service; start it if not running`,
        `$svc = Get-Service -Name 'CardosoCigarettes' -ErrorAction SilentlyContinue`,
        `if ($svc -and $svc.Status -ne 'Running') { Start-Service -Name 'CardosoCigarettes' -ErrorAction SilentlyContinue }`,
      ].join('\n');

      const taskName = `CardosoUpdater-full-${Date.now()}`;
      try {
        await launchViaTaskScheduler(taskName, installerScript);
      } catch (err) {
        console.error('[AutoUpdate] Task Scheduler launch failed:', err.message);
        try { logError('app.update.full', err, { phase: 'task_scheduler_launch' }); } catch (e) { console.error('[system.task_scheduler]', { phase: 'full_launch_log' }, e.message); }
        autoUpdateRunning = false;
        autoUpdatePhase = null;
        autoUpdateStartedAt = null;
        return { ok: false, reason: `task_scheduler_launch_failed:${err.message}` };
      }

      console.log('[AutoUpdate] Updater scheduled — installer will run independent of the Cardoso process tree.');
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
        try { fs.unlinkSync(tmpPath); } catch (e) { console.warn('[system.autoUpdate.error_cleanup]', { tmpPath }, e.message); }
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

  // POST /api/maintenance/recompute-recon-totals
  // Body: { dryRun: boolean }  — defaults to true.
  //
  // Thin route layer over services/bat/reconTotals.js — that module
  // owns the SQL, bucketing rules, and txn semantics. Why the heavy
  // background lives there now: this is real business logic (drift
  // detection, null-aware skip rules, BEGIN-IMMEDIATE write-locking)
  // and it's already accumulating layers from PRs #275, #277, plus
  // the supplier_total foot-gun chain we worked through during the
  // W11 incident. Keeping the route slim makes it testable in
  // isolation and lets future callers (auto-heal cron, programmatic
  // fix-one-recon endpoint) reuse the same primitives.
  router.post('/api/maintenance/recompute-recon-totals', requireAuth, requireAdmin, (req, res) => {
    try {
      if (process.env.HUB_MODE === 'true') {
        return res.status(400).json({ error: 'BAT recon-total recompute is site-only.' });
      }
      const dryRun = req.body?.dryRun !== false;
      const result = recomputeReconTotals({ db, dryRun });

      logAudit({
        req,
        action: dryRun ? 'bat_recompute_recon_totals_dryrun' : 'bat_recompute_recon_totals',
        resourceType: 'system',
        resourceName: 'BAT recon supplier_total recompute',
        details: dryRun
          ? `Dry-run: ${result.mismatches.length} recon(s) need recompute, ${result.skippedIncomplete.length} skipped (incomplete order_amount)`
          : `Updated ${result.updated} recon(s); skipped ${result.skippedIncomplete.length} (incomplete order_amount); derived from non-exception order_amount sums`,
        changes: {
          mismatches: result.mismatches.map((m) => ({ id: m.id, week: m.week_number, year: m.year, before: m.current_total, after: m.derived_total })),
          skipped: result.skippedIncomplete.map((s) => ({ id: s.id, week: s.week_number, year: s.year, missing_amount_count: s.missing_amount_count })),
        },
      });

      res.json(result);
    } catch (error) {
      console.error('[maintenance] recompute-recon-totals failed:', error.message);
      res.status(500).json({ error: error.message || 'Failed to recompute recon totals' });
    }
  });

  // POST /api/maintenance/backup-now — admin-only, password-confirmed.
  // Creates a fresh backup snapshot in database/backups/ and (best-
  // effort) notifies the hub so it pulls the new file immediately
  // instead of waiting for the next 03:00 cron.
  //
  // Backup itself is purely additive (new file, never overwrites or
  // deletes the live DB), but we keep the password confirm to match
  // the rest of the maintenance UX and so the audit row reflects an
  // explicit operator action.
  //
  // The hub-notify step is best-effort: a notify failure (HUB_URL
  // unset, hub unreachable, hub returns 4xx/5xx) still reports the
  // local backup as successful. The hub's daily cron will pick the
  // file up at 03:00 regardless. Operator sees the notify-failure
  // reason in the response so they know whether to chase it.
  router.post('/api/maintenance/backup-now', requireAuth, requireAdmin, async (req, res) => {
    try {
      if (process.env.HUB_MODE === 'true') {
        return res.status(400).json({
          error: 'Backup-now is site-only. The hub does not maintain its own database backup via this endpoint.',
        });
      }

      const { password } = req.body || {};
      if (!password) {
        return res.status(400).json({ error: 'Password is required.' });
      }
      const user = db.prepare('SELECT * FROM "user" WHERE id = ?').get(req.currentUser.id);
      if (!user || !user.password_hash) {
        return res.status(401).json({ error: 'Unable to verify user.' });
      }
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Incorrect password.' });
      }

      // Inline backup using the same shape as scheduler.runLocalBackup
      // (which we don't import to avoid a circular routes↔scheduler
      // dependency). Async backup() is safe with concurrent writes.
      const dbPath = process.env.DB_PATH || './database/cardoso.db';
      const resolvedDbPath = path.resolve(dbPath);
      const backupDir = path.resolve(path.dirname(resolvedDbPath), 'backups');
      try { fs.mkdirSync(backupDir, { recursive: true }); } catch (e) { console.warn('[system.backup.mkdir]', { backupDir }, e.message); }
      const siteId = process.env.SITE_ID || 'site';
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const destPath = path.join(backupDir, `cardoso-${siteId}-${ts}.db`);
      const t0 = Date.now();
      await db.backup(destPath);
      const elapsedMs = Date.now() - t0;
      const sizeBytes = fs.statSync(destPath).size;

      // Best-effort hub notify. HUB_URL must be configured and the
      // site must have its own REPORTING_TOKEN to authenticate (the
      // hub matches inbound tokens against HUB_SITES[].token).
      let hubNotified = false;
      let hubError = null;
      const hubUrl = process.env.HUB_URL;
      const reportingToken = process.env.REPORTING_TOKEN;
      if (!hubUrl) {
        hubError = 'HUB_URL not configured on this site — hub will pick up the backup on its next scheduled cron tick (default 03:00 daily).';
      } else if (!reportingToken) {
        hubError = 'REPORTING_TOKEN not configured on this site — cannot authenticate to the hub. Backup is on disk locally; hub will pick it up on its next scheduled cron tick.';
      } else {
        try {
          const ctrl = new AbortController();
          // 12 min total. The hub-side pullBackupForSite has TWO
          // sequential long phases now: /api/backup/download (5 min
          // cap) followed by /api/backup/bat-previews (5 min cap),
          // so the worst-case round-trip is ~10 min plus normal RTT
          // and integrity-check overhead. The original 6-min cap
          // covered only the DB phase and now under-fits — Codex
          // catch: large sites finish the DB pull then time out
          // mid-previews, the site reports hub_notified:false, and
          // the operator sees a false "hub didn't pull" signal even
          // though the hub completed seconds after the abort. New
          // 12-min cap covers both phases + buffer.
          //
          // If hub pulls grow past this in the future, the right
          // architectural answer is: hub responds immediately after
          // accepting the notify and runs pullBackupForSite async,
          // with the site polling a follow-up status endpoint. For
          // now the timeout bump keeps the simple call+wait shape.
          const timeout = setTimeout(() => ctrl.abort(), 12 * 60 * 1000);
          const r = await fetch(`${hubUrl.replace(/\/$/, '')}/api/hub/notify-backup-ready`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-reporting-token': reportingToken,
            },
            body: JSON.stringify({ filename: path.basename(destPath), size_bytes: sizeBytes }),
            signal: ctrl.signal,
          });
          clearTimeout(timeout);
          if (r.ok) {
            hubNotified = true;
          } else {
            const body = await r.json().catch(() => ({}));
            hubError = `Hub responded ${r.status}: ${body.error || 'unknown'}. The local backup succeeded; hub will retry on its next cron tick.`;
          }
        } catch (notifyErr) {
          hubError = `Hub notification failed: ${notifyErr.message}. The local backup succeeded; hub will pick it up on its next cron tick.`;
        }
      }

      logAudit({
        req,
        action: 'backup_now',
        resourceType: 'system',
        resourceName: 'Manual database backup',
        details:
          `Backup created: ${path.basename(destPath)} (${(sizeBytes / 1024 / 1024).toFixed(1)} MB) in ${(elapsedMs / 1000).toFixed(1)}s. ` +
          `Hub notified: ${hubNotified}${hubError ? ` (${hubError})` : ''}.`,
        changes: {
          backup_filename: path.basename(destPath),
          size_bytes: sizeBytes,
          elapsed_ms: elapsedMs,
          hub_notified: hubNotified,
        },
      });

      res.json({
        ok: true,
        backup_filename: path.basename(destPath),
        size_mb: Math.round((sizeBytes / 1024 / 1024) * 10) / 10,
        elapsed_ms: elapsedMs,
        hub_notified: hubNotified,
        hub_error: hubError,
      });
    } catch (error) {
      console.error('[maintenance] backup-now failed:', error.message);
      try { logError('maintenance.backup_now', error); } catch (e) { console.error('[system.maintenance_backup_log]', { op: 'backup_now' }, e.message); }
      res.status(500).json({ error: error.message || 'Failed to create backup' });
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
