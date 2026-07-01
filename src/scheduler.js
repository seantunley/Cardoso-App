import cron from 'node-cron';
import path from 'path';
import { mkdirSync, linkSync, readdirSync as readdirSyncTop, rmSync, copyFileSync } from 'fs';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import db, { dbPath } from './db/index.js';
import { runConnectionImport } from './services/syncEngine.js';
// networkDevices service removed (replaced by ntopng integration)
import { syncCreditLogicFromHub, probeHubUrl } from './services/creditLogic.js';
import { logError } from './lib/errorLog.js';
import { refreshSageWeekTotalsCache, probeSageHealth } from './services/batReconciliation.js';
import { checkReconciliationIntegrity } from './services/bat/integrity.js';
import { recordJob, pruneOldJobRuns } from './lib/jobRunner.js';
import { evaluateAllRules } from './lib/alertRules.js';
import { pruneResolvedAlerts } from './lib/alertEngine.js';
import { pruneOldRows, vacuumDb } from './lib/retention.js';
import { runScheduledMonthlyJob, runBootCatchUp } from './services/jti/jtiScheduler.js';
import { getJtiSagePool } from './services/jti/jtiPool.js';
import { pushPendingArchives } from './services/jti/jtiHubPush.js';
import {
  runScheduledMonthlyCommissionJob,
  runCommissionBootCatchUp,
} from './services/commission/commissionScheduler.js';
import { pushPendingCommissionArchives } from './services/commission/commissionHubPush.js';
import { registerJob } from './lib/scheduledJobs.js';
import { trackOp } from './lib/mainThreadWatch.js';
import { syncSalesFromSage, syncItemVendors } from './services/inventoryMovement.js';
import { computeAllForecasts } from './services/inventoryForecast.js';
import { refreshInsights, invalidateInsightsCache } from './services/insights.js';
import { syncCreditorsFromSage } from './services/creditorSync.js';
import { syncDebtorsFromSage } from './services/debtorSync.js';

let scheduledSyncInProgress = false;
let autoSyncRunning = false;
let shuttingDown = false;
let serverRef = null;
const cronTasks = [];
const intervals = [];

export function isShuttingDown() {
  return shuttingDown;
}

export function setServer(s) {
  serverRef = s;
}

async function runScheduledSyncCycle() {
  if (shuttingDown) return;
  if (scheduledSyncInProgress) return;

  scheduledSyncInProgress = true;

  try {
    // Skip BAT-only connections — those are accessed live by the BAT module
    // and must NOT be swept into the local datarecord table.
    const connections = db
      .prepare(`SELECT id, name FROM databaseconnection WHERE status = 'active' AND COALESCE(is_bat_only, 0) = 0`)
      .all();

    for (const connection of connections) {
      try {
        await runConnectionImport(connection.id, { isShuttingDown: () => shuttingDown });
      } catch (error) {
        console.error(`Scheduled sync failed for connection ${connection.id}:`, error.message);
      }
    }
    // Customer/debtor data just changed — drop the insights cache so the next
    // load recomputes against fresh balances (the nightly job warms it).
    try { invalidateInsightsCache(); } catch { /* non-fatal */ }
  } catch (error) {
    console.error('Scheduled sync job failed:', error);
  } finally {
    scheduledSyncInProgress = false;
  }
}

// Resolved path to the one-shot worker that runs the read-only backup
// integrity_check + critical-table counts off the main thread.
const BACKUP_VERIFY_WORKER = fileURLToPath(new URL('./lib/backupVerifyWorker.js', import.meta.url));

// Spawn the backup-verify worker, await its single result message, and clean
// up. The worker always posts exactly one message then exits; the exit/error
// guards mean this rejects (rather than hanging forever) if it dies first.
function runBackupVerifyWorker(filePath, criticalTables) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
    let worker;
    try {
      worker = new Worker(BACKUP_VERIFY_WORKER, { workerData: { filePath, criticalTables } });
    } catch (err) {
      reject(err);
      return;
    }
    worker.once('message', (msg) => { finish(resolve, msg); worker.terminate(); });
    worker.once('error', (err) => finish(reject, err));
    worker.once('exit', (code) => {
      finish(reject, new Error(`backup-verify worker exited (code ${code}) before posting a result`));
    });
  });
}

// --- Backup verification ---
//
// Daily backup creation alone is not enough — we've seen backup files
// land on disk that were corrupt/truncated and would have been useless
// in a real recovery. This routine opens the most recent backup file
// in read-only mode, runs SQLite's PRAGMA integrity_check, and counts
// rows in critical tables. It logs loud and writes an audit row when
// anything fails so an operator can spot a backup corruption window
// instead of finding out the day they need to restore.
//
// Runs at 03:30 — 90 minutes after the 02:00 backup so even a slow
// backup on a busy site has finished, and well before the 06:30
// morning sync window.
export async function verifyLatestBackup() {
  const resolvedDbPath = path.resolve(dbPath);
  const backupDir = path.resolve(path.dirname(resolvedDbPath), 'backups');

  let backupFiles = [];
  try {
    const { readdirSync, statSync } = await import('fs');
    backupFiles = readdirSync(backupDir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => ({ name: f, full: path.join(backupDir, f), mtime: statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch (err) {
    console.error('[backup-verify] Cannot read backup dir:', err.message);
    return { ok: false, reason: 'backup_dir_unreadable', error: err.message };
  }

  if (backupFiles.length === 0) {
    console.error('[backup-verify] No backup files found — no backup has run yet, or all were pruned.');
    return { ok: false, reason: 'no_backups_found' };
  }

  const latest = backupFiles[0];
  const ageHours = (Date.now() - latest.mtime) / (1000 * 60 * 60);

  // The latest backup should be < 26 hours old (24h cron + buffer). Anything
  // older means yesterday's run failed or the cron stopped firing.
  if (ageHours > 26) {
    console.error(`[backup-verify] Latest backup is ${ageHours.toFixed(1)}h old (${latest.name}) — backup cron may have stopped.`);
    return { ok: false, reason: 'stale_latest', ageHours, file: latest.name };
  }

  // The heavy part — PRAGMA integrity_check scans the entire file (2.4s on a
  // 600MB DB, 14-30s on a multi-GB one) plus the critical-table counts — runs
  // on a worker thread so it can't freeze the event loop / every API request
  // for its whole duration. The backup is opened strictly read-only there, so
  // the live DB is never touched or locked. See lib/backupVerifyWorker.js.
  //
  // Critical tables: if any is present in the live DB but missing/empty in the
  // backup, the backup is structurally suspect. The worker wraps each in its
  // own try so a single missing table (fresh install) doesn't fail the check.
  const criticalTables = ['datarecord', 'user', 'databaseconnection'];
  let verifyResult;
  try {
    verifyResult = await runBackupVerifyWorker(latest.full, criticalTables);
  } catch (err) {
    // Worker failed to spawn or died before posting. Surface it as a
    // verification failure (recordJob's successCheck records the run as failed)
    // rather than a silent skip — and deliberately NOT a main-thread fallback,
    // which would reintroduce the very freeze this offload removes.
    console.error(`[backup-verify] verification worker failed for ${latest.name}: ${err.message}`);
    return { ok: false, reason: 'verify_worker_error', file: latest.name, error: err.message };
  }

  if (!verifyResult.ok) {
    if (verifyResult.reason === 'cannot_open') {
      console.error(`[backup-verify] Cannot open ${latest.name}: ${verifyResult.error}`);
      return { ok: false, reason: 'cannot_open', file: latest.name, error: verifyResult.error };
    }
    if (verifyResult.reason === 'integrity_check_failed') {
      console.error(`[backup-verify] integrity_check FAILED on ${latest.name}: ${verifyResult.issues}`);
      return { ok: false, reason: 'integrity_check_failed', file: latest.name, issues: verifyResult.issues };
    }
    console.error(`[backup-verify] verification failed on ${latest.name}: ${verifyResult.reason} ${verifyResult.error || ''}`.trim());
    return { ok: false, reason: verifyResult.reason || 'verify_failed', file: latest.name, error: verifyResult.error };
  }

  console.log(`[backup-verify] ${latest.name} OK (${ageHours.toFixed(1)}h old, ${JSON.stringify(verifyResult.counts)})`);
  return { ok: true, file: latest.name, ageHours, counts: verifyResult.counts };
}

// --- Local DB backup (site-side, replaces backup.ps1 dependency) ---
export async function runLocalBackup() {
  try {
    const resolvedDbPath = path.resolve(dbPath);
    const backupDir = path.resolve(path.dirname(resolvedDbPath), 'backups');
    mkdirSync(backupDir, { recursive: true });

    const siteId = process.env.SITE_ID || 'site';
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const destPath = path.join(backupDir, `cardoso-${siteId}-${ts}.db`);

    // better-sqlite3 async backup — safe with live writes
    await db.backup(destPath);

    // Sanity-check the artifact actually landed. db.backup() resolving is
    // not proof a usable file exists — a disk-full / AV-quarantine / perms
    // edge can leave a missing or 0-byte file. Treat either as a HARD
    // failure so the run goes red instead of logging "Saved" for nothing.
    // (This is part of the same fix as the rethrow below: the old code
    // swallowed every error here, which is how a 12-day backup outage still
    // reported green.)
    const { statSync: statBackup } = await import('fs');
    let backupSize = 0;
    try {
      backupSize = statBackup(destPath).size;
    } catch (statErr) {
      throw new Error(`backup file missing after db.backup(): ${statErr.message}`);
    }
    if (!(backupSize > 0)) {
      throw new Error(`backup file is ${backupSize} bytes after db.backup() — unusable`);
    }
    console.log(`[backup] Saved to ${destPath} (${backupSize} bytes)`);

    // BAT preview snapshot. The .db backup above only restores OCR text
    // (extracted_invoice, status, etc.) — the actual JPEG previews live
    // on disk under uploads/bat-previews/<extractionId>.jpg, so a restore
    // without them leaves the UI showing "Open PDF" only and forces a
    // full re-OCR to regenerate thumbnails.
    //
    // Strategy: hardlink each preview into a sibling directory next to
    // the .db. Hardlinks share the underlying inode, so disk cost is one
    // copy total no matter how many snapshots we keep — previews are
    // append-only (named by extractionId, never overwritten or deleted),
    // so the inodes stay valid as long as the original or any snapshot
    // still references them. NTFS supports hardlinks via fs.linkSync on
    // the same volume; cross-volume hardlinks fail with EXDEV (caller
    // would see it in the error log; not a concern here since uploads/
    // and database/backups/ are both under cwd).
    const previewSrc = path.join(process.cwd(), 'uploads', 'bat-previews');
    const snapshotDir = destPath.replace(/\.db$/, '.previews');
    let linkedCount = 0;
    let skippedCount = 0;
    try {
      const previewFiles = readdirSyncTop(previewSrc).filter((f) => f.toLowerCase().endsWith('.jpg'));
      if (previewFiles.length > 0) {
        mkdirSync(snapshotDir, { recursive: true });
        for (const f of previewFiles) {
          try {
            linkSync(path.join(previewSrc, f), path.join(snapshotDir, f));
            linkedCount += 1;
          } catch (linkErr) {
            // EEXIST shouldn't happen (fresh dir), EXDEV means the
            // uploads/ folder is on a different volume than database/ —
            // fall back to a copy in that case so we still snapshot
            // *something* rather than silently skipping.
            if (linkErr.code === 'EXDEV') {
              try {
                copyFileSync(path.join(previewSrc, f), path.join(snapshotDir, f));
                linkedCount += 1;
              } catch (copyErr) {
                skippedCount += 1;
                try { logError('backup.preview_snapshot_copy', copyErr, { file: f }); }
                catch (logErr) { console.error('[backup] logError failed (preview_snapshot_copy):', logErr.message, '— original:', copyErr.message); }
              }
            } else if (linkErr.code === 'ENOENT') {
              // OCR worker deleted the file between readdir and linkSync —
              // benign race, the next backup will pick it up.
              skippedCount += 1;
            } else {
              skippedCount += 1;
              try { logError('backup.preview_snapshot_link', linkErr, { file: f }); }
              catch (logErr) { console.error('[backup] logError failed (preview_snapshot_link):', logErr.message, '— original:', linkErr.message); }
            }
          }
        }
        console.log(`[backup] Preview snapshot: ${linkedCount} linked, ${skippedCount} skipped → ${snapshotDir}`);
      } else {
        console.log('[backup] No previews to snapshot (uploads/bat-previews/ is empty)');
      }
    } catch (previewErr) {
      // ENOENT is normal on a fresh install with no OCR runs yet.
      if (previewErr.code !== 'ENOENT') {
        console.error(`[backup] Preview snapshot failed: ${previewErr.message}`);
        try { logError('backup.preview_snapshot', previewErr, { src: previewSrc, dest: snapshotDir }); }
        catch (logErr) { console.error('[backup] logError failed (preview_snapshot):', logErr.message); }
      }
    }

    // Prune: keep last 6 by default (one week of daily backups). Override
    // via BACKUP_KEEP_COUNT env. Was 30 originally — but on a site that
    // hits multi-GB cardoso.db (the production case that prompted PR #245),
    // 30 daily backups = 30× the live DB size in idle storage, which adds
    // up fast. The hub-side mirror in hub-backups/ provides the long-tail
    // archive (its own retention controlled by HUB_BACKUP_KEEP_COUNT —
    // see runHubBackupPull in services/hubEtl.js); the site itself only
    // needs enough to recover from "yesterday looked weird, restore last
    // week's snapshot" scenarios.
    //
    // NaN-guard: parseInt('abc', 10) returns NaN; default if so. 0 is
    // honored (= prune all, including the just-created backup) so an
    // operator who explicitly sets 0 doesn't get a silent fallback to 6.
    // Negative values are nonsensical and fall back to default.
    //
    // Filter: ONLY canonical backup filenames `cardoso-<id>-YYYY-MM-DD-HH-MM-SS.db`
    // get pruned. A forensic file like `cardoso.db.corrupt.db` (manually
    // saved off when investigating a bad live DB) ALSO ends in `.db` and
    // would otherwise be silently deleted by retention. The regex matches
    // the timestamp suffix this code itself writes at line 156.
    const { readdirSync, statSync, unlinkSync } = await import('fs');
    const CANONICAL_BACKUP_RE = /^cardoso-.+-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.db$/;
    const files = readdirSync(backupDir)
      .filter((f) => CANONICAL_BACKUP_RE.test(f))
      .map((f) => ({ name: f, mtime: statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    const parsedKeep = parseInt(process.env.BACKUP_KEEP_COUNT, 10);
    const keep = Number.isFinite(parsedKeep) && parsedKeep >= 0 ? parsedKeep : 6;
    files.slice(keep).forEach((f) => {
      try { unlinkSync(path.join(backupDir, f.name)); } catch (e) { console.warn('[scheduler.backup.prune_db]', { file: f.name }, e.message); }
      // Also drop the sibling .previews/ snapshot directory if present.
      // Hardlinked files keep the underlying inode alive as long as any
      // other snapshot (or the live previews dir) still references them,
      // so this rm only frees disk if every other reference is also gone.
      const siblingPreviews = path.join(backupDir, f.name.replace(/\.db$/, '.previews'));
      try { rmSync(siblingPreviews, { recursive: true, force: true }); } catch (e) { console.warn('[scheduler.backup.prune_previews]', { siblingPreviews }, e.message); }
    });
    const prunedCount = files.length > keep ? files.length - keep : 0;
    if (prunedCount > 0) {
      console.log(`[backup] Pruned ${prunedCount} old backup(s) and sibling preview snapshots, keeping ${keep}`);
    }

    // Return a summary so recordJob attaches it as the run's context — the
    // Job Runs panel and backup health can read "what was made" without a
    // log scrape.
    return {
      ok: true,
      file: path.basename(destPath),
      bytes: backupSize,
      previews_linked: linkedCount,
      previews_skipped: skippedCount,
      pruned: prunedCount,
      kept: keep,
    };
  } catch (err) {
    console.error('[backup] Failed:', err.message);
    try { logError('backup.local', err, { dbPath }); }
    catch (logErr) { console.error('[backup] logError failed (local):', logErr.message, '— original:', err.message); }
    // Rethrow so recordJob persists this run as 'failed' (it was previously
    // swallowed here, which is exactly why a 12-day backup outage still
    // reported green — the job ledger never saw a failure). track() mirrors
    // the throw to the System Log; node-cron tolerates the rejected promise.
    throw err;
  }
}

// Daily BAT integrity sweep — runs every per-recon invariant (see
// services/bat/integrity.js) across every non-marked-zero recon and
// writes a bat.integrity.drift entry to the System Log for each
// failure. Operator gets a single nightly digest without having to
// open each recon page — same source-of-truth the per-recon banner
// and the dashboard panel use.
//
// Site-only: the Hub has no bat_invoice_extractions / bat_overview_orders
// tables locally, and integrity is a per-site reconciliation concern.
//
// Returns an aggregate object so recordJob can attach the summary as
// the run's context (operator can read it from /api/operations/job-runs
// without scraping logs).
async function runBatIntegritySweep() {
  const recons = db.prepare(
    "SELECT id, week_number, year, marked_zero FROM bat_reconciliations WHERE COALESCE(marked_zero, 0) = 0"
  ).all();
  let passing = 0;
  let failing = 0;
  let skipped = 0;
  const failures = [];
  for (const r of recons) {
    try {
      const integrity = checkReconciliationIntegrity({ db, reconId: r.id });
      const failedChecks = integrity.checks.filter((c) => !c.passed && !c.skipped);
      const skippedChecks = integrity.checks.filter((c) => c.skipped);
      if (failedChecks.length > 0) {
        failing++;
        failures.push({
          reconciliation_id: r.id,
          week_number: r.week_number,
          year: r.year,
          failed_check_ids: failedChecks.map((c) => c.id),
        });
        // Per-recon System Log entry. Severity 'warn' because drift is
        // operator-actionable (investigate the recon page's banner)
        // but not a system-level failure.
        try {
          logError(
            'bat.integrity.drift',
            new Error(`Recon ${r.id} (W${r.week_number}/${r.year}) failed ${failedChecks.length} integrity check(s) on nightly sweep: ${failedChecks.map((c) => c.id).join(', ')}`),
            {
              reconciliation_id: r.id,
              week_number: r.week_number,
              year: r.year,
              failed_check_ids: failedChecks.map((c) => c.id),
              failed_details: failedChecks.map((c) => ({
                id: c.id,
                expected: c.expected,
                actual: c.actual,
                drift: c.drift,
                detail: c.detail,
              })),
              source: 'nightly_sweep',
            },
            'warn',
          );
        } catch { /* logging is best-effort */ }
      } else if (skippedChecks.length > 0) {
        // Any skipped check counts the whole recon as skipped, not
        // passing. supplier_total still runs on pre-v72 recons even
        // when Overview-dependent checks (I2/I3/I4/I5/I6/I7) skip,
        // so the previous "skippedChecks.length === checks.length"
        // test was deterministically false for those recons and they
        // got bucketed as passing — under-reporting the operator
        // action of "re-upload to enable Overview verification".
        skipped++;
      } else {
        passing++;
      }
    } catch (err) {
      // Per-recon checker crash shouldn't kill the sweep — record
      // and move on so the rest of the recons still get checked.
      failing++;
      failures.push({
        reconciliation_id: r.id,
        week_number: r.week_number,
        year: r.year,
        failed_check_ids: ['integrity_check_crashed'],
        error: err?.message || String(err),
      });
      try { logError('bat.integrity.crash', err, { reconciliation_id: r.id }); } catch {} // eslint-disable-line no-empty -- logError wrapper; failure already pushed to failures[] above
    }
  }
  const summary = { total: recons.length, passing, failing, skipped, failures };
  console.log(`[bat-integrity-sweep] ${recons.length} recon(s) scanned: ${passing} passing, ${failing} failing, ${skipped} skipped (no Overview data)`);
  return summary;
}

// Helper: wrap a scheduled job in recordJob + a swallowed-error trailer so
// the lifecycle row gets written but a thrown error doesn't escape into
// node-cron / setInterval (which would crash the next tick). Each call
// site previously had its own .catch — this centralises the pattern.
// `opts` is forwarded to recordJob — most importantly `successCheck`,
// for jobs (like verifyLatestBackup) that signal failure by returning
// `{ ok: false }` rather than throwing.
// Wrap a scheduled job's function so the main-thread freeze watchdog can name
// it. Until this wiring existed, the scheduler — which runs the heaviest
// synchronous main-thread work in the app (local-backup, backup-verify's
// PRAGMA integrity_check, the monthly VACUUM, the Sage syncs) — never called
// trackOp(), so EVERY hard-freeze marker recorded its active operations as
// "(none registered — blocker not yet instrumented with trackOp)". The
// forensics could see the loop froze for 20-30s but never which job did it.
//
// trackOp keeps the name active across the whole run, awaits included. For an
// async job that means the name is "active" while it's merely waiting on Sage
// I/O too — that's fine: active_operations is a best-effort list of SUSPECTS
// shown next to a freeze, and an idle await cannot itself block the loop. The
// value is that a freeze during a job's synchronous section (the DB write, the
// integrity_check, the VACUUM) now names that job instead of "(none)".
function withFreezeTracking(name, fn) {
  return async (...args) => {
    const done = trackOp(`scheduled:${name}`);
    try {
      return await fn(...args);
    } finally {
      done();
    }
  };
}

function track(name, fn, contextFn, opts) {
  return () => recordJob(name, withFreezeTracking(name, fn), contextFn, opts).catch((err) => {
    // Hard failures (thrown errors) already land in job_runs.error_message
    // via recordJob. Mirror them to error_log so they also show up in
    // System Log — without this, the operator had to flip between
    // Operations → Job Runs and Operations → System Log to triage. The
    // mirror only fires for HARD failures (thrown); soft failures (where
    // the function returned ok:false) live in job_runs only by design,
    // since those usually have their own dedicated logging upstream
    // (e.g. credit-logic-sync writes to credit_logic_state.last_error).
    console.error(`[${name}] failed:`, err.message);
    try { logError(`scheduler.${name}`, err); } catch {} // eslint-disable-line no-empty -- logError wrapper inside scheduler tracker; mirror failure already logged to console above
  });
}

// ── Nightly sync retry ladder ────────────────────────────────────────────
//
// The nightly Sage syncs run once per day; a 4am failure used to wait a
// whole day for the next attempt (operator report: data going 29h+ stale
// and reports reading it becoming inconsistent). A failed nightly attempt
// now retries up to NIGHTLY_RETRIES more times, NIGHTLY_RETRY_DELAY_MS
// apart — a transient 4am hiccup (Sage maintenance window, network blip)
// heals by ~05:30 instead of tomorrow. Every attempt gets its own
// job_runs row, so Job Runs shows the whole ladder.
//
// "Failed" includes PARTIAL nights: syncCreditorsFromSage /
// syncDebtorsFromSage deliberately swallow per-source errors into
// summary.sources[*].error (one bad table must not kill the rest), so
// without the successCheck a night where e.g. AP invoices failed would be
// recorded as a clean success and never retried.
const NIGHTLY_RETRIES = 2;
const NIGHTLY_RETRY_DELAY_MS = 30 * 60 * 1000;

function nightlySummaryOk(result) {
  if (!result || typeof result !== 'object' || !result.sources) return true;
  return !Object.values(result.sources).some((s) => s && s.error);
}

// Nightly Sage syncs whose retry ladder is currently in flight — RUNNING or
// WAITING between retries. A pending retry is just a setTimeout with no job_runs
// row, so the daytime/boot catch-up (runNightlyCatchUp) can't detect it from
// job_runs; it consults this set instead so it never starts a SECOND ladder for
// a job whose 4am ladder is still active (which would overlap Sage pulls and
// duplicate the delete/refresh passes). An entry lives from the first attempt
// until the ladder terminates — success or retries exhausted.
const activeNightlyLadders = new Set();

function nightlyWithRetry(name, fn) {
  const attempt = (n) => {
    const scheduleRetry = (why) => {
      if (n >= NIGHTLY_RETRIES) {
        activeNightlyLadders.delete(name);
        console.error(`[${name}] still failing after ${n + 1} attempts (${why}) — giving up until the next scheduled night. The nightly-sync-stale alert will flag the data once it passes 26 hours old.`);
        return;
      }
      console.warn(`[${name}] attempt ${n + 1} failed (${why}) — retrying in ${NIGHTLY_RETRY_DELAY_MS / 60_000} minutes (retry ${n + 1} of ${NIGHTLY_RETRIES}).`);
      const t = setTimeout(() => attempt(n + 1), NIGHTLY_RETRY_DELAY_MS);
      if (typeof t.unref === 'function') t.unref();
    };
    recordJob(name, withFreezeTracking(name, fn), null, { successCheck: nightlySummaryOk })
      .then((result) => {
        if (nightlySummaryOk(result)) {
          activeNightlyLadders.delete(name);
          if (n > 0) console.log(`[${name}] retry ${n} of ${NIGHTLY_RETRIES} succeeded — data is current again.`);
          return;
        }
        scheduleRetry('one or more Sage sources failed — see System Log for the per-source error');
      })
      .catch((err) => {
        console.error(`[${name}] failed:`, err.message);
        try { logError(`scheduler.${name}`, err); } catch {} // eslint-disable-line no-empty -- mirror failure already logged to console above
        scheduleRetry(err.message);
      });
  };
  // Mark the ladder active BEFORE the first attempt so a catch-up firing moments
  // later sees it. Cleared on terminal success or when retries are exhausted.
  return () => { activeNightlyLadders.add(name); attempt(0); };
}

// ── Local backup retry ladder + catch-up ─────────────────────────────────
//
// The daily 02:00 local backup used to be a single fire-and-forget cron: a
// transient failure (disk busy, AV lock, brief I/O hiccup) waited a FULL DAY
// for the next attempt — and you'd only discover the stale backup the moment
// you needed to restore. Now a failed attempt retries NIGHTLY_RETRIES more
// times, NIGHTLY_RETRY_DELAY_MS apart, and runBackupCatchUp re-runs it on the
// DATA signal (newest backup file age) so a fully-missed night self-heals
// within the day. Reuses activeNightlyLadders so a catch-up never starts a
// second ladder over a run that's still retrying.
function backupWithRetry() {
  const name = 'local-backup';
  const attempt = (n) => {
    const scheduleRetry = (why) => {
      if (n >= NIGHTLY_RETRIES) {
        activeNightlyLadders.delete(name);
        console.error(`[local-backup] still failing after ${n + 1} attempts (${why}) — the daytime catch-up will keep retrying; backup-artifact-stale flags it once past 26h.`);
        return;
      }
      console.warn(`[local-backup] attempt ${n + 1} failed (${why}) — retrying in ${NIGHTLY_RETRY_DELAY_MS / 60_000} minutes (retry ${n + 1} of ${NIGHTLY_RETRIES}).`);
      const t = setTimeout(() => attempt(n + 1), NIGHTLY_RETRY_DELAY_MS);
      if (typeof t.unref === 'function') t.unref();
    };
    // runLocalBackup resolves with a summary on success and THROWS on failure,
    // so recordJob's rethrow (the .catch) is the failure signal — no successCheck.
    recordJob(name, withFreezeTracking(name, runLocalBackup), (r) => r)
      .then(() => {
        activeNightlyLadders.delete(name);
        if (n > 0) console.log(`[local-backup] retry ${n} of ${NIGHTLY_RETRIES} succeeded — a fresh backup exists again.`);
      })
      .catch((err) => {
        console.error('[local-backup] failed:', err.message);
        try { logError('scheduler.local-backup', err); } catch {} // eslint-disable-line no-empty -- already recorded in job_runs by recordJob
        scheduleRetry(err.message);
      });
  };
  return () => { activeNightlyLadders.add(name); attempt(0); };
}

// Re-run the local backup when the newest backup FILE is stale/missing — the
// data-age signal (computeBackupHealth), not the job ledger. So a failed/missed
// 02:00 run heals within the day instead of waiting for tomorrow.
async function runBackupCatchUp(trigger) {
  if (process.env.HUB_MODE === 'true') return;
  if (activeNightlyLadders.has('local-backup')) return; // a ladder is already in flight
  let health;
  try {
    const { computeBackupHealth } = await import('./lib/backupHealth.js');
    health = computeBackupHealth();
  } catch (err) {
    console.error(`[${trigger}] backup catch-up could not read health: ${err.message}`);
    return;
  }
  const STALE_REASONS = new Set(['no_backups', 'stale', 'stale_critical', 'latest_empty', 'backup_dir_unreadable']);
  if (!STALE_REASONS.has(health.reason)) return; // fresh enough — nothing to do
  console.warn(`[${trigger}] newest local backup is ${health.reason} (age=${health.age_hours}h) — running local-backup now.`);
  backupWithRetry()();
}

export function startSchedulers() {
  {
    const t = cron.schedule('0,30 6-16 * * 1-5', track('scheduled-sync', runScheduledSyncCycle));
    cronTasks.push(t);
    registerJob({ name: 'scheduled-sync', type: 'cron', cronExpression: '0,30 6-16 * * 1-5', taskRef: t, mode: 'all', description: 'Site sync cycle — every 30 min during business hours (Mon-Fri)' });
  }
  {
    const t = cron.schedule('0 17 * * 1-5', track('scheduled-sync', runScheduledSyncCycle));
    cronTasks.push(t);
    registerJob({ name: 'scheduled-sync', type: 'cron', cronExpression: '0 17 * * 1-5', taskRef: t, mode: 'all', description: 'Site sync cycle — end-of-day catch-up' });
  }

  // BAT Sage week-totals cache — refresh every 3h on weekdays at 7/10/13/16.
  // Site-only: the Hub doesn't have a Sage connection (it aggregates data
  // pulled from sites via /api/reporting/bat-summary, not by querying Sage
  // directly). Without this gate the Hub fired refreshSageWeekTotalsCache
  // on every cron tick and on every boot, each call throwing "No Sage
  // connection configured" into the System Log.
  if (process.env.HUB_MODE !== 'true') {
    {
      const t = cron.schedule('0 7,10,13,16 * * 1-5', track('sage-cache-refresh', refreshSageWeekTotalsCache));
      cronTasks.push(t);
      registerJob({ name: 'sage-cache-refresh', type: 'cron', cronExpression: '0 7,10,13,16 * * 1-5', taskRef: t, mode: 'site', description: 'BAT Sage week-totals cache refresh' });
    }

    // Sage health probe — every 60s. Cheap SELECT 1 that lets the admin
    // banner warn when Sage has been unreachable for more than 5 minutes,
    // before someone starts debugging a "missing credit notes" report
    // that's actually just a dead pool. Not tracked in job_runs because
    // it fires every minute — would dominate the table without adding
    // value (its state is already exposed via /api/bat/sage-health).
    intervals.push(setInterval(() => {
      probeSageHealth().catch(() => { /* probeSageHealth handles its own errors */ });
    }, 60_000));
    // Initial probe shortly after boot so the UI doesn't show a stale
    // "never probed" state.
    setTimeout(() => { probeSageHealth().catch(() => {}); }, 8000);
    // Initial boot refresh (delayed so DB migrations and Sage pool init can settle)
    setTimeout(track('sage-cache-refresh', refreshSageWeekTotalsCache), 15000);
    registerJob({ name: 'sage-cache-refresh', type: 'one-shot', delayMs: 15000, mode: 'site', description: 'BAT Sage cache — boot refresh' });

    // Inventory movement — nightly sync of sales aggregates from Sage
    // OESHDT into the local inventory_sales_cache table. Runs at 04:00
    // so the data is fresh by the time operators check in the morning.
    // The three nightly Sage pulls share the retry ladder (see
    // nightlyWithRetry above) and the boot catch-up below. Runners are
    // named so the catch-up can invoke the exact same code path.
    const inventorySalesRunner = nightlyWithRetry('inventory-sales-sync', async () => {
      const summary = await syncSalesFromSage();
      computeAllForecasts();
      // Warm the insights cache off the fresh data so the first morning load
      // is instant. Guarded — a warm failure must not fail the sync job.
      try { refreshInsights(); } catch (e) { console.warn('[insights.warm] failed:', e.message); }
      return summary;
    });
    const creditorsRunner = nightlyWithRetry('creditors-sync', () => syncCreditorsFromSage());
    const debtorsRunner = nightlyWithRetry('debtors-sync', () => syncDebtorsFromSage());

    {
      const t = cron.schedule('0 4 * * *', inventorySalesRunner);
      cronTasks.push(t);
      registerJob({ name: 'inventory-sales-sync', type: 'cron', cronExpression: '0 4 * * *', taskRef: t, mode: 'site', description: 'Nightly inventory sales cache sync from Sage OESHDT + forecast recompute (retries twice on failure)' });
    }

    // Creditors — nightly Sage pull of APVEN + APOBL + APTCR + POPORH1
    // into local creditor_* tables. Runs at 04:30, after inventory sync
    // but before backup-verify (03:30) — wait, backup-verify is earlier
    // so we just need a free slot before the morning workday. 04:30 is it.
    {
      const t = cron.schedule('30 4 * * *', creditorsRunner);
      cronTasks.push(t);
      registerJob({ name: 'creditors-sync', type: 'cron', cronExpression: '30 4 * * *', taskRef: t, mode: 'site', description: 'Nightly creditors sync from Sage APVEN/APOBL/APTCR/POPORH1 (retries twice on failure)' });
    }

    // Debtors — nightly Sage pull of AROBL open AR documents into
    // debtor_ar_invoice, so the Aged Debtors report ages per-document by due
    // date. 04:45, 15 min after the creditors pull.
    {
      const t = cron.schedule('45 4 * * *', debtorsRunner);
      cronTasks.push(t);
      registerJob({ name: 'debtors-sync', type: 'cron', cronExpression: '45 4 * * *', taskRef: t, mode: 'site', description: 'Nightly debtors AR open-item sync from Sage AROBL (retries twice on failure)' });
    }

    // Boot catch-up — the other half of the stale-data problem: if the
    // machine is off or asleep at the 4am window, node-cron simply never
    // fires. No failed run is recorded, nothing retries, and the data ages
    // silently (operator report: 29h+ stale syncs). On boot, any nightly
    // sync whose last SUCCESS is older than 24h runs immediately, through
    // the same retry ladder. 90s delay so boot-time Sage pool init and the
    // BAT cache refresh (15s one-shot) aren't competing for the connection.
    {
      const NIGHTLY_CATCH_UP = [
        ['inventory-sales-sync', inventorySalesRunner],
        ['creditors-sync', creditorsRunner],
        ['debtors-sync', debtorsRunner],
      ];
      // Re-run any nightly Sage sync whose last SUCCESS is older than 24h, through
      // the same retry ladder. Driven from BOTH the boot one-shot (machine off at
      // 4am) AND the hourly daytime cron below — a sync that failed its 4am window
      // keeps retrying through the day until it succeeds, instead of staying stale
      // until the next night or a reboot. No-op once today's run has succeeded.
      const runNightlyCatchUp = (trigger) => {
        for (const [name, runner] of NIGHTLY_CATCH_UP) {
          try {
            // Skip if this job's retry ladder is already running or waiting
            // between retries — relaunching runner() would start a SECOND ladder
            // alongside the first, overlapping the Sage pulls and duplicating the
            // delete/refresh passes. The 4am cron's ladder marks itself active.
            if (activeNightlyLadders.has(name)) {
              console.log(`[${trigger}] ${name} already has a retry ladder in flight — skipping to avoid a second overlapping run.`);
              continue;
            }
            const last = db.prepare(`
              SELECT started_at FROM job_runs
              WHERE name = ? AND status = 'succeeded'
              ORDER BY started_at DESC LIMIT 1
            `).get(name);
            if (!last) {
              // Never succeeded. If it has never even been ATTEMPTED this is
              // a fresh install waiting for its first scheduled night — skip.
              const anyRun = db.prepare('SELECT 1 FROM job_runs WHERE name = ? LIMIT 1').get(name);
              if (!anyRun) continue;
            }
            const ageHours = last ? (Date.now() - new Date(last.started_at).getTime()) / 3_600_000 : null;
            if (last && ageHours <= 24) continue;
            console.warn(`[${trigger}] ${name} last succeeded ${last ? `${ageHours.toFixed(1)}h ago` : 'never'} — running it now instead of waiting for tonight's 4am window.`);
            runner();
          } catch (err) {
            console.error(`[${trigger}] ${name} staleness check failed: ${err.message} — leaving it to the next attempt.`);
          }
        }
      };
      // Boot catch-up — covers the machine-off-at-4am case. 90s delay so boot-time
      // Sage pool init + the BAT cache refresh (15s one-shot) aren't competing.
      const t = setTimeout(() => runNightlyCatchUp('nightly-catch-up'), 90_000);
      if (typeof t.unref === 'function') t.unref();
      registerJob({ name: 'nightly-catch-up', type: 'one-shot', delayMs: 90_000, mode: 'site', description: 'Boot catch-up — immediately run any nightly Sage sync whose last success is >24h old (covers the machine-off-at-4am case)' });
      // Daytime catch-up — hourly 05:00–23:00. A nightly sync that FAILED its 4am
      // window (Sage briefly down, network glitch) used to stay stale until the
      // next night; now it's re-attempted every hour through the day until it
      // succeeds. No-op once today's run has succeeded (last success <= 24h).
      const dc = cron.schedule('0 5-23 * * *', () => runNightlyCatchUp('daytime-catch-up'));
      cronTasks.push(dc);
      registerJob({ name: 'daytime-catch-up', type: 'cron', cronExpression: '0 5-23 * * *', taskRef: dc, mode: 'site', description: 'Hourly (05:00–23:00) retry of any nightly Sage sync whose last success is >24h old — recovers a failed 4am window without waiting for the next night' });
    }

    // item->vendor boot self-heal. v106 creates item_vendor EMPTY and only the
    // sales sync fills it (via syncItemVendors). The >24h catch-up above won't
    // re-run a recently-synced site, so a fresh upgrade leaves Sales-by-Vendor
    // showing "(No vendor)" until 4am. If the map is empty, fill it now — cheap
    // (~2.4k rows, one Sage query). Runs after the catch-up so we don't double up.
    {
      const t = setTimeout(async () => {
        try {
          const n = db.prepare('SELECT COUNT(*) AS c FROM item_vendor').get().c;
          if (n > 0) return;
          console.warn('[item-vendor-boot-fill] item_vendor is empty — populating the item->vendor map now so Sales-by-Vendor is not blank.');
          const r = await syncItemVendors();
          console.log(`[item-vendor-boot-fill] populated ${r.synced} item->vendor rows.`);
        } catch (err) {
          console.error('[item-vendor-boot-fill] failed:', err.message);
        }
      }, 110_000);
      if (typeof t.unref === 'function') t.unref();
      registerJob({ name: 'item-vendor-boot-fill', type: 'one-shot', delayMs: 110_000, mode: 'site', description: 'On boot, populate the item->vendor map (Sage ICITMV) if empty — fresh-upgrade self-heal so Sales-by-Vendor is not blank' });
    }
  }

  if (process.env.HUB_MODE !== 'true') {
    {
      // 02:00 daily — with a retry ladder (see backupWithRetry) so a transient
      // failure self-heals in ~1h instead of waiting a day.
      const t = cron.schedule('0 2 * * *', backupWithRetry());
      cronTasks.push(t);
      registerJob({ name: 'local-backup', type: 'cron', cronExpression: '0 2 * * *', taskRef: t, mode: 'site', description: 'Daily SQLite backup (with retry ladder)' });
    }
    // Backup catch-up — boot (130s) + hourly daytime — re-runs the backup if the
    // newest backup file is stale/missing, so a failed/missed 02:00 run heals
    // within the day. Offset from the Sage daytime catch-up (:00) to :15.
    {
      const t = setTimeout(() => runBackupCatchUp('backup-boot-catch-up'), 130_000);
      if (typeof t.unref === 'function') t.unref();
      registerJob({ name: 'backup-boot-catch-up', type: 'one-shot', delayMs: 130_000, mode: 'site', description: 'On boot, run the local backup if the newest backup file is stale/missing' });
    }
    {
      const t = cron.schedule('15 5-23 * * *', () => runBackupCatchUp('backup-daytime-catch-up'));
      cronTasks.push(t);
      registerJob({ name: 'backup-daytime-catch-up', type: 'cron', cronExpression: '15 5-23 * * *', taskRef: t, mode: 'site', description: 'Hourly (05:15–23:15) re-run of the local backup if the newest backup file is stale/missing' });
    }
    // Daily backup verification at 03:30 — 90 min after the backup, well
    // before the 06:30 morning sync window. Catches corrupt/truncated/stale
    // backups so an operator finds out before the day they need to restore.
    {
      const t = cron.schedule('30 3 * * *', track(
        'backup-verify',
        verifyLatestBackup,
        // Attach the verification result as the run's context so the
        // dashboard can show "ok / which file / how stale / row counts"
        // without an extra log scrape.
        (result) => result,
        // verifyLatestBackup signals failure by returning { ok: false, ... }
        // instead of throwing. Without this hook, recordJob would persist
        // the row as 'succeeded' and the dashboard / alerts would miss
        // real backup failures (stale, corrupt, missing). The hook tells
        // recordJob to record 'failed' when ok===false; the failure
        // reason from the result is captured in error_message.
        { successCheck: (r) => r?.ok !== false },
      ));
      cronTasks.push(t);
      registerJob({ name: 'backup-verify', type: 'cron', cronExpression: '30 3 * * *', taskRef: t, mode: 'site', description: 'Verify latest backup integrity (PRAGMA integrity_check + row counts)' });
    }

    // BAT integrity sweep — 04:00 daily, after backup (02:00) and
    // backup-verify (03:30), before morning sync window (06:30).
    // Writes a bat.integrity.drift System Log entry per failing recon
    // so the operator sees nightly drift without opening each page.
    // The per-recon banner + dashboard panel already surface drift on
    // page load; this is the "nobody opened the page" safety net.
    {
      const t = cron.schedule('0 4 * * *', track(
        'bat-integrity-sweep',
        runBatIntegritySweep,
        (result) => result,
      ));
      cronTasks.push(t);
      registerJob({
        name: 'bat-integrity-sweep',
        type: 'cron',
        cronExpression: '0 4 * * *',
        taskRef: t,
        mode: 'site',
        description: 'Nightly BAT reconciliation integrity sweep — writes bat.integrity.drift per failing recon',
      });
    }

    // ntopng integration: no local scheduled scan needed (ntopng pulls flows continuously)

    // Boot-time hub-URL probe. Hits ${HUB_URL}/api/health once a few seconds
    // after startup and logs LOUD if it fails. The first credit-logic-sync
    // attempt below would also catch the failure, but that runs at +12s and
    // is one of dozens of scheduled jobs — the dedicated probe surfaces
    // hub-connectivity issues at the top of the System Log so an operator
    // immediately sees "Hub unreachable" instead of having to dig for a
    // credit-logic-sync failure.
    setTimeout(async () => {
      try {
        const probe = await probeHubUrl();
        if (probe.ok) {
          console.log(`[hub-probe] OK: ${probe.url} (HTTP ${probe.status})`);
        } else {
          console.warn(`[hub-probe] FAILED: ${probe.error}`);
          try {
            logError(
              'hub.probe',
              new Error(probe.error || 'Hub unreachable'),
              { url: probe.url, status: probe.status },
              'warn',
            );
          } catch {} // eslint-disable-line no-empty -- logError wrapper; probe failure already recorded via probe.error/status
        }
      } catch (err) {
        try { logError('hub.probe', err, { phase: 'unhandled' }); } catch {} // eslint-disable-line no-empty -- logError wrapper inside scheduler boot; cannot recurse
      }
    }, 5000);

    // syncCreditLogicFromHub catches its own fetch errors and returns
    // { ok: false, error, status } rather than throwing. Without
    // successCheck, recordJob would persist these soft failures as
    // 'succeeded' and the Job Runs panel + alert rules would never see
    // them. successCheck flips them to 'failed' so the readable error
    // description (URL + cause from describeFetchError) lands in
    // job_runs.error_message and feeds the credit-logic-sync alert rule.
    setTimeout(
      track(
        'credit-logic-sync',
        () => syncCreditLogicFromHub({ triggeredBy: 'startup' }),
        null,
        { successCheck: (r) => r?.ok !== false },
      ),
      12000,
    );
    registerJob({ name: 'credit-logic-sync', type: 'one-shot', delayMs: 12000, mode: 'site', description: 'Pull credit-logic config from hub on startup' });
    intervals.push(setInterval(
      track(
        'credit-logic-sync',
        () => syncCreditLogicFromHub({ triggeredBy: 'scheduler' }),
        null,
        { successCheck: (r) => r?.ok !== false },
      ),
      10 * 60 * 1000,
    ));
    registerJob({ name: 'credit-logic-sync', type: 'interval', intervalMs: 10 * 60 * 1000, mode: 'site', description: 'Pull credit-logic config from hub every 10 min' });

    // JTI monthly export — fires at 02:00 site-local on the 1st of
    // every month, generating + archiving the export for the
    // PREVIOUS calendar month. Site-only: HUB_MODE installs don't
    // have a Sage pool and receive these archives via the push/pull
    // bridge instead of producing them.
    {
      const t = cron.schedule('0 2 1 * *', track(
        'jti-monthly-export',
        () => runScheduledMonthlyJob({ db, getSagePool: getJtiSagePool }),
        (result) => result,
        // Skipped runs (already_archived, pool_unavailable) are normal
        // outcomes for this job, not failures — successCheck only flags
        // actual thrown errors.
        { successCheck: (r) => true },
      ));
      cronTasks.push(t);
      registerJob({ name: 'jti-monthly-export', type: 'cron', cronExpression: '0 2 1 * *', taskRef: t, mode: 'site', description: 'JTI Sales export — generate + archive last calendar month' });
    }

    // JTI boot-time catch-up — backfills up to 12 missed months on
    // app startup. Delayed 45s so migrations + pool init have settled
    // (the catch-up may run dozens of Sage queries back-to-back if
    // the site has been offline for months; better to start cleanly).
    setTimeout(track(
      'jti-boot-catchup',
      () => runBootCatchUp({ db, getSagePool: getJtiSagePool, monthsBack: 12 }),
      (result) => ({
        archived: result.archived?.length || 0,
        skipped: result.skipped?.length || 0,
        failed: result.failed || null,
      }),
      { successCheck: (r) => !r?.failed },
    ), 45_000);
    registerJob({ name: 'jti-boot-catchup', type: 'one-shot', delayMs: 45_000, mode: 'site', description: 'JTI catch-up — backfill up to 12 missed months on boot' });

    // JTI daily self-heal — re-attempt last month's export every day until it
    // lands. The 02:00-on-the-1st cron only fires if the app is running at that
    // exact minute and Sage is reachable; a miss (app closed, Sage briefly
    // down) otherwise stays unarchived until the next app restart. This daily
    // run targets the SAME previous month all month long, so a missed window
    // heals on its own the next day — and a pool_unavailable simply retries
    // tomorrow. Cheap on normal days (one already-archived check). Runs at
    // 09:00, when the app is most likely running and Sage reachable.
    {
      const t = cron.schedule('0 9 * * *', track(
        'jti-daily-ensure',
        () => runScheduledMonthlyJob({ db, getSagePool: getJtiSagePool }),
        (result) => result,
        { successCheck: () => true },
      ));
      cronTasks.push(t);
      registerJob({ name: 'jti-daily-ensure', type: 'cron', cronExpression: '0 9 * * *', taskRef: t, mode: 'site', description: 'JTI self-heal — ensure last month is archived if the 1st-of-month run was missed' });
    }

    // JTI generation retry — every 60 minutes, re-run a short catch-up
    // (previous + the month before). This is the reliability net the two
    // CRON paths above can't be: node-cron matches a wall-clock minute, but
    // this app reliably freezes the main thread for ~15-20s at 02:00 nightly
    // (synchronous inventory rollup rebuild + the 02:00 SQLite backup of a
    // large DB — see the .main-thread-freeze markers next to the database).
    // The jti-monthly-export cron fires at 02:00-on-the-1st, dead centre of
    // that freeze, so its tick is silently dropped on sites whose freeze
    // straddles the minute boundary — the app is fully up, but the fire is
    // lost and node-cron never replays it. A setInterval can't be dropped
    // that way: a freeze only makes it fire LATE (on the next free loop
    // turn), never never. So a missed month heals within the hour regardless
    // of when the loop was blocked. hasScheduledArchive makes this a cheap DB
    // no-op once the period is archived; only a genuinely missing month
    // re-hits Sage. Mirrors commission-generation-retry.
    intervals.push(setInterval(track(
      'jti-generation-retry',
      () => runBootCatchUp({ db, getSagePool: getJtiSagePool, monthsBack: 2 }),
      (result) => ({
        archived: result.archived?.length || 0,
        skipped: result.skipped?.length || 0,
        failed: result.failed || null,
      }),
      { successCheck: (r) => !r?.failed },
    ), 60 * 60 * 1000));
    registerJob({ name: 'jti-generation-retry', type: 'interval', intervalMs: 60 * 60 * 1000, mode: 'site', description: 'JTI generation retry — re-attempt missed/failed monthly archives hourly (freeze-proof: an interval fires late after a main-thread freeze, unlike the wall-clock cron which drops the tick)' });

    // JTI hub-push retry tick — every 15 minutes, scan for archives
    // in pending/failed state and try to send them. The post-archive
    // push trigger in handleExport / generateAndArchivePeriod handles
    // the happy path; this tick is the safety net for transient hub
    // outages (network blip, hub restarting, hub disk full). batchSize
    // = 10 so a stuck site that's accumulated 50+ unpushed archives
    // doesn't block the tick for too long.
    intervals.push(setInterval(track(
      'jti-hub-push-retry',
      () => pushPendingArchives({ db, batchSize: 10 }),
      (result) => result,
      { successCheck: () => true }, // failed-to-push is normal, not a job failure
    ), 15 * 60 * 1000));
    registerJob({ name: 'jti-hub-push-retry', type: 'interval', intervalMs: 15 * 60 * 1000, mode: 'site', description: 'JTI hub push retry — re-attempt any pending/failed pushes' });

    // Commission monthly archive — fires at 03:00 site-local on the 24th
    // of every month. The commission cycle is "24th of prev month → 23rd
    // of current month", so running on the 24th means the previous-day
    // window has just closed and a complete period is ready to archive.
    // Site-only (HUB_MODE installs receive these archives via push).
    {
      const t = cron.schedule('0 3 24 * *', track(
        'commission-monthly-archive',
        () => runScheduledMonthlyCommissionJob({ db }),
        (result) => result,
        // already_archived (skipped) is a normal outcome; a transient Sage/
        // PDF/unpaid failure returns status:'failed' and IS a job failure so
        // it's visible and the hourly generation-retry below re-attempts it.
        { successCheck: (r) => r?.status !== 'failed' },
      ));
      cronTasks.push(t);
      registerJob({ name: 'commission-monthly-archive', type: 'cron', cronExpression: '0 3 24 * *', taskRef: t, mode: 'site', description: 'Commission monthly archive — generate + archive the current commission period (24th-of-month cycle)' });
    }

    // Commission boot-time catch-up — backfills up to 12 missed months
    // on app startup. 60-second delay so migrations + Sage health probe
    // have settled; the catch-up may run several reports back-to-back
    // if the site has been offline for months, better to start cleanly.
    setTimeout(track(
      'commission-boot-catchup',
      () => runCommissionBootCatchUp({ db, monthsBack: 12 }),
      (result) => ({
        archived: result.archived?.length || 0,
        skipped: result.skipped?.length || 0,
        failed: result.failed || null,
      }),
      { successCheck: (r) => !r?.failed },
    ), 60_000);
    registerJob({ name: 'commission-boot-catchup', type: 'one-shot', delayMs: 60_000, mode: 'site', description: 'Commission catch-up — backfill up to 12 missed months on boot' });

    // Commission generation retry — every 60 minutes, re-run a short
    // catch-up (current + previous period). A transient Sage/PDF/unpaid
    // failure at the 03:00 cron, or a brief outage on the 24th, would
    // otherwise leave that month un-archived until the next reboot. The
    // hasScheduledArchive guard makes this a cheap DB no-op once the period
    // is archived; only a genuinely missing period re-hits Sage.
    intervals.push(setInterval(track(
      'commission-generation-retry',
      () => runCommissionBootCatchUp({ db, monthsBack: 2 }),
      (result) => ({
        archived: result.archived?.length || 0,
        skipped: result.skipped?.length || 0,
        failed: result.failed || null,
      }),
      { successCheck: (r) => !r?.failed },
    ), 60 * 60 * 1000));
    registerJob({ name: 'commission-generation-retry', type: 'interval', intervalMs: 60 * 60 * 1000, mode: 'site', description: 'Commission generation retry — re-attempt missed/failed monthly archives hourly' });

    // Commission hub-push retry tick — every 15 minutes, scan for
    // archives in pending/failed state and try to send them. Same
    // safety-net role as the JTI retry tick.
    intervals.push(setInterval(track(
      'commission-hub-push-retry',
      () => pushPendingCommissionArchives({ db, batchSize: 10 }),
      (result) => result,
      { successCheck: () => true },
    ), 15 * 60 * 1000));
    registerJob({ name: 'commission-hub-push-retry', type: 'interval', intervalMs: 15 * 60 * 1000, mode: 'site', description: 'Commission hub push retry — re-attempt any pending/failed pushes' });
  }

  // Alert engine evaluation tick — runs every 60s, evaluates the rules
  // in src/lib/alertRules.js, fires/resolves rows in the alerts table.
  // Rules are dedup'd by dedup_key so this loop is safe to run
  // frequently — a persistent condition produces ONE active row, not
  // one per minute. Site-mode AND hub-mode both run this; the rules
  // each decide whether they apply (e.g. sage-down only fires when
  // the Sage health probe is active, which is site-mode only).
  intervals.push(setInterval(() => {
    evaluateAllRules().catch((err) => console.error('[alertRules] evaluation failed:', err.message));
  }, 60_000));
  // Initial pass shortly after boot so the admin UI doesn't show "no
  // alerts" while waiting for the first 60s tick.
  setTimeout(() => { evaluateAllRules().catch(() => {}); }, 20_000);
  // Daily prune of resolved alerts at 04:30 (after job_runs prune at 04:00).
  {
    const t = cron.schedule('30 4 * * *', () => {
      try { pruneResolvedAlerts(30); } catch (err) { console.error('[alertEngine] prune failed:', err.message); }
    });
    cronTasks.push(t);
    registerJob({ name: 'prune-resolved-alerts', type: 'cron', cronExpression: '30 4 * * *', taskRef: t, mode: 'all', description: 'Daily prune of resolved alerts older than 30 days' });
  }

  // Auto-sync interval — wrapped in track() so each invocation lands in
  // job_runs as 'auto-sync-cycle' with a context blob recording how many
  // connections were considered and how many were due. The track helper
  // (scheduler.js:track) handles the catch + lifecycle write; the inner
  // async fn just does the work and returns the context object.
  //
  // (Merge of #178 + #180 mangled this block — #180's plain setInterval
  // body and #178's track-wrapped form combined into a `try {}` with no
  // catch/finally and a stray `(r) => r)` argument fragment. Restoring
  // the #178 form, which is what was intended.)
  intervals.push(setInterval(
    track('auto-sync-cycle', async () => {
      // Cycle-level guard: the 5-min interval keeps firing even while a cycle is
      // still awaiting its sequential imports. Without this, a cycle that runs
      // longer than the interval would overlap the next one — which could start
      // importing a DIFFERENT due connection (runConnectionImport only locks the
      // SAME connection), reintroducing the cross-connection pool clash this
      // sequential loop set out to avoid. Mirrors runScheduledSyncCycle.
      if (autoSyncRunning) return { skipped: 'already_running' };
      autoSyncRunning = true;
      try {
        const conns = db.prepare(
          "SELECT id, last_sync, sync_interval_hours FROM databaseconnection WHERE status = 'active' AND COALESCE(is_bat_only, 0) = 0 AND sync_interval_hours IS NOT NULL AND sync_interval_hours > 0"
        ).all();
        const now = Date.now();
        let triggered = 0;
        let failed = 0;
        const errors = [];
        for (const conn of conns) {
          const lastSync = conn.last_sync ? new Date(conn.last_sync).getTime() : 0;
          const intervalMs = conn.sync_interval_hours * 60 * 60 * 1000;
          if (now - lastSync >= intervalMs) {
            console.log(`[auto-sync] triggering sync for connection ${conn.id}`);
            triggered += 1;
            // Await each import SEQUENTIALLY rather than firing them all unawaited:
            // concurrent imports across connections clash on the shared MSSQL pool
            // (CRIT-1), and the old unawaited fire let track() record the cycle
            // 'succeeded' before any import finished. A failure now goes to the
            // System Log (logError) instead of being swallowed to console (SYNC-6).
            try {
              await runConnectionImport(conn.id, { isShuttingDown: () => shuttingDown });
            } catch (err) {
              failed += 1;
              errors.push(`conn ${conn.id}: ${err?.message || String(err)}`);
              try { logError('scheduler.auto_sync', err, { connection_id: conn.id }); } catch { /* logError is best-effort; the cycle keeps going */ }
            }
            if (shuttingDown) break;
          }
        }
        return { triggered, considered: conns.length, failed, errors: errors.length ? errors : undefined };
      } finally {
        autoSyncRunning = false;
      }
    },
    // contextFn passes the summary through; successCheck records the cycle as
    // 'failed' when any due import failed, so Operations → Job Runs and the
    // job-failure-spike alert (which counts only status='failed') surface it —
    // not just a buried context blob an operator has to open by hand (SYNC-6).
    (r) => r, { successCheck: (r) => !r?.failed }),
    5 * 60 * 1000,
  ));
  registerJob({ name: 'auto-sync-cycle', type: 'interval', intervalMs: 5 * 60 * 1000, mode: 'all', description: 'Auto-sync — fire any connection past its sync_interval_hours' });

  // Daily prune of job_runs at 04:00 (after backup-verify at 03:30).
  // Keeps the table from growing unbounded over months.
  {
    const t = cron.schedule('0 4 * * *', () => {
      try { pruneOldJobRuns(30); } catch (err) { console.error('[jobRunner] prune failed:', err.message); }
    });
    cronTasks.push(t);
    registerJob({ name: 'prune-job-runs', type: 'cron', cronExpression: '0 4 * * *', taskRef: t, mode: 'all', description: 'Daily prune of job_runs rows older than 30 days' });
  }

  // Daily prune at 04:15 of the other unbounded tables — error_log,
  // auditlog, syncrun, login_log. Each one's keep-days horizon is
  // env-tunable (see src/lib/retention.js). Slotted between the
  // job_runs prune (04:00) and the alerts prune (04:30) so the three
  // writes don't contend for the writer slot. Wrapped in track() so
  // the per-table summary lands in job_runs.context — operator can
  // see at a glance how many rows each prune touched.
  {
    const t = cron.schedule('15 4 * * *', track(
      'retention-prune',
      pruneOldRows,
      (result) => ({ tables: result }),
    ));
    cronTasks.push(t);
    registerJob({ name: 'retention-prune', type: 'cron', cronExpression: '15 4 * * *', taskRef: t, mode: 'all', description: 'Daily prune of error_log / auditlog / syncrun / login_log per env retention horizons' });
  }

  // Monthly VACUUM at 04:45 on the 1st — reclaims pages freed by the
  // daily prunes above (and the v66 record_snapshots drop). Without
  // VACUUM, DELETEs leave free pages internally and cardoso.db never
  // shrinks; the production site that hit 3.7 GB had 99% free pages
  // by the time we caught it. Holds an EXCLUSIVE lock for the duration
  // (typically <5s on a healthy DB, longer on the first run after a
  // bulk drop) so we run it at the quietest hour — well after the
  // 02:00 backup and the daily prunes have settled.
  {
    const t = cron.schedule('45 4 1 * *', track(
      'vacuum-db',
      vacuumDb,
      (result) => result,
    ));
    cronTasks.push(t);
    registerJob({ name: 'vacuum-db', type: 'cron', cronExpression: '45 4 1 * *', taskRef: t, mode: 'all', description: 'Monthly VACUUM — reclaims free pages on the 1st @ 04:45' });
  }
}

export function startHubSchedulers(syncAllSites, runHubBackupPull, pingAllSites) {
  // Overlap guard: if a previous syncAllSites is still running when the
  // 5-minute interval fires (which happens when one site has slow ETL or
  // a long-running backup pull), skip the new tick instead of letting two
  // syncs race on the Hub Postgres pool and per-site sync state. Same
  // pattern for pingAllSites — defensive even though pings are normally fast.
  let syncRunning = false;
  const guardedSync = () => {
    if (syncRunning) {
      console.warn('[hub-sync] previous syncAllSites still running — skipping this tick');
      return Promise.resolve({ skipped: true });
    }
    syncRunning = true;
    return recordJob('hub-sync', syncAllSites)
      .catch((err) => console.error('[hub-sync] syncAllSites failed:', err.message))
      .finally(() => { syncRunning = false; });
  };
  setTimeout(guardedSync, 10000);
  registerJob({ name: 'hub-sync', type: 'one-shot', delayMs: 10000, mode: 'hub', description: 'Hub sync — boot kickoff' });
  intervals.push(setInterval(guardedSync, 5 * 60 * 1000));
  registerJob({ name: 'hub-sync', type: 'interval', intervalMs: 5 * 60 * 1000, mode: 'hub', description: 'Hub sync — pull records/inventory/KPIs from every site every 5 min' });

  {
    const t = cron.schedule('0 3 * * *', track('hub-backup-pull', runHubBackupPull));
    cronTasks.push(t);
    registerJob({ name: 'hub-backup-pull', type: 'cron', cronExpression: '0 3 * * *', taskRef: t, mode: 'hub', description: 'Daily pull of every site\'s SQLite backup' });
  }

  // Daily JTI pull-fallback at 03:30 — runs after the 03:00 backup
  // pull so the heavy daily I/O is staggered. For each configured
  // site, hits /api/reporting/jti/archives, dedups by sha256, and
  // pulls anything the hub doesn't have. The site→hub push (Phase 2)
  // is the primary path; this is the safety net for sites that were
  // offline at push time. Imported lazily so site-mode installs (which
  // don't call startHubSchedulers) never load the hub-only modules.
  {
    const t = cron.schedule('30 3 * * *', track(
      'hub-jti-pull',
      async () => {
        const { pullMissingArchivesAll } = await import('./services/hub/jtiHubPull.js');
        const { HUB_SITES } = await import('./services/hubEtl.js');
        return pullMissingArchivesAll({ sites: HUB_SITES, db });
      },
      (result) => ({
        sitesProcessed: result?.sitesProcessed || 0,
        totalPulled: result?.totalPulled || 0,
        totalMissing: result?.totalMissing || 0,
      }),
      // Per-site failures land in result.results[].status — they're
      // expected (a site can be offline) and not job-level failures.
      { successCheck: () => true },
    ));
    cronTasks.push(t);
    registerJob({ name: 'hub-jti-pull', type: 'cron', cronExpression: '30 3 * * *', taskRef: t, mode: 'hub', description: 'JTI pull-fallback — fetch any archives missing from hub_jti_archive' });
  }

  if (pingAllSites) {
    let pingRunning = false;
    const guardedPing = () => {
      if (pingRunning) return Promise.resolve({ skipped: true });
      pingRunning = true;
      return recordJob('hub-ping', pingAllSites)
        .catch((err) => console.error('[hub-sync] pingAllSites failed:', err.message))
        .finally(() => { pingRunning = false; });
    };
    setTimeout(guardedPing, 15000);
    registerJob({ name: 'hub-ping', type: 'one-shot', delayMs: 15000, mode: 'hub', description: 'Hub ping — boot kickoff' });
    intervals.push(setInterval(guardedPing, 15 * 60 * 1000));
    registerJob({ name: 'hub-ping', type: 'interval', intervalMs: 15 * 60 * 1000, mode: 'hub', description: 'Hub ping — health-check every site every 15 min' });
  }
}

export function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const task of cronTasks) { try { task.stop(); } catch (e) { console.warn('[scheduler.shutdown.task_stop]', e.message); } }
  for (const interval of intervals) { try { clearInterval(interval); } catch (e) { console.warn('[scheduler.shutdown.clear_interval]', e.message); } }

  if (serverRef) {
    serverRef.close(() => {
      try { db.exec('PRAGMA optimize'); } catch (e) { console.warn('[scheduler.shutdown.pragma_optimize]', e.message); }
      try { db.close(); } catch (e) { console.warn('[scheduler.shutdown.db_close]', e.message); }
      process.exit(0);
    });

    setTimeout(() => {
      try { db.close(); } catch (e) { console.warn('[scheduler.shutdown.forced_db_close]', e.message); }
      process.exit(1);
    }, 5000);
  } else {
    try { db.close(); } catch (e) { console.warn('[scheduler.shutdown.no_server_db_close]', e.message); }
    process.exit(0);
  }
}
