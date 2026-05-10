import cron from 'node-cron';
import path from 'path';
import { mkdirSync } from 'fs';
import Database from 'better-sqlite3';
import db, { dbPath } from './db/index.js';
import { runConnectionImport } from './services/syncEngine.js';
// networkDevices service removed (replaced by ntopng integration)
import { syncCreditLogicFromHub, probeHubUrl } from './services/creditLogic.js';
import { logError } from './lib/errorLog.js';
import { refreshSageWeekTotalsCache, probeSageHealth } from './services/batReconciliation.js';
import { recordJob, pruneOldJobRuns } from './lib/jobRunner.js';
import { evaluateAllRules } from './lib/alertRules.js';
import { pruneResolvedAlerts } from './lib/alertEngine.js';

let scheduledSyncInProgress = false;
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
  } catch (error) {
    console.error('Scheduled sync job failed:', error);
  } finally {
    scheduledSyncInProgress = false;
  }
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

  // Open read-only and run integrity_check + row counts on the tables we'd
  // need to actually restore. better-sqlite3 readonly mode means we can't
  // accidentally mutate the backup file.
  let backupDb;
  try {
    backupDb = new Database(latest.full, { readonly: true, fileMustExist: true });
  } catch (err) {
    console.error(`[backup-verify] Cannot open ${latest.name}: ${err.message}`);
    return { ok: false, reason: 'cannot_open', file: latest.name, error: err.message };
  }

  try {
    const integrity = backupDb.prepare('PRAGMA integrity_check').all();
    const passed = integrity.length === 1 && integrity[0].integrity_check === 'ok';
    if (!passed) {
      const issues = integrity.map(r => r.integrity_check).slice(0, 5).join('; ');
      console.error(`[backup-verify] integrity_check FAILED on ${latest.name}: ${issues}`);
      return { ok: false, reason: 'integrity_check_failed', file: latest.name, issues };
    }

    // Critical tables — if any of these are present in the live DB but
    // missing/empty in the backup, the backup is structurally suspect.
    // Wrapped per-table so a single missing table (e.g. fresh install
    // where bat_reconciliations doesn't exist yet) doesn't fail the whole
    // verification.
    const criticalTables = ['datarecord', 'user', 'databaseconnection'];
    const counts = {};
    for (const t of criticalTables) {
      try {
        const row = backupDb.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get();
        counts[t] = row?.c ?? 0;
      } catch (err) {
        counts[t] = `error: ${err.message}`;
      }
    }

    console.log(`[backup-verify] ${latest.name} OK (${ageHours.toFixed(1)}h old, ${JSON.stringify(counts)})`);
    return { ok: true, file: latest.name, ageHours, counts };
  } finally {
    try { backupDb.close(); } catch {}
  }
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
    console.log(`[backup] Saved to ${destPath}`);

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
    // NaN-guard: parseInt('abc', 10) returns NaN; default if so. Floor of
    // 1 because keeping zero backups defeats the purpose.
    const { readdirSync, statSync, unlinkSync } = await import('fs');
    const files = readdirSync(backupDir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => ({ name: f, mtime: statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    const parsedKeep = parseInt(process.env.BACKUP_KEEP_COUNT, 10);
    const keep = Number.isFinite(parsedKeep) && parsedKeep >= 1 ? parsedKeep : 6;
    files.slice(keep).forEach((f) => {
      try { unlinkSync(path.join(backupDir, f.name)); } catch (_) {}
    });
    if (files.length > keep) {
      console.log(`[backup] Pruned ${files.length - keep} old backup(s), keeping ${keep}`);
    }
  } catch (err) {
    console.error('[backup] Failed:', err.message);
  }
}

// Helper: wrap a scheduled job in recordJob + a swallowed-error trailer so
// the lifecycle row gets written but a thrown error doesn't escape into
// node-cron / setInterval (which would crash the next tick). Each call
// site previously had its own .catch — this centralises the pattern.
// `opts` is forwarded to recordJob — most importantly `successCheck`,
// for jobs (like verifyLatestBackup) that signal failure by returning
// `{ ok: false }` rather than throwing.
function track(name, fn, contextFn, opts) {
  return () => recordJob(name, fn, contextFn, opts).catch((err) => {
    // Hard failures (thrown errors) already land in job_runs.error_message
    // via recordJob. Mirror them to error_log so they also show up in
    // System Log — without this, the operator had to flip between
    // Operations → Job Runs and Operations → System Log to triage. The
    // mirror only fires for HARD failures (thrown); soft failures (where
    // the function returned ok:false) live in job_runs only by design,
    // since those usually have their own dedicated logging upstream
    // (e.g. credit-logic-sync writes to credit_logic_state.last_error).
    console.error(`[${name}] failed:`, err.message);
    try { logError(`scheduler.${name}`, err); } catch {}
  });
}

export function startSchedulers() {
  cronTasks.push(cron.schedule('0,30 6-16 * * 1-5', track('scheduled-sync', runScheduledSyncCycle)));
  cronTasks.push(cron.schedule('0 17 * * 1-5', track('scheduled-sync', runScheduledSyncCycle)));

  // BAT Sage week-totals cache — refresh every 3h on weekdays at 7/10/13/16.
  // Site-only: the Hub doesn't have a Sage connection (it aggregates data
  // pulled from sites via /api/reporting/bat-summary, not by querying Sage
  // directly). Without this gate the Hub fired refreshSageWeekTotalsCache
  // on every cron tick and on every boot, each call throwing "No Sage
  // connection configured" into the System Log.
  if (process.env.HUB_MODE !== 'true') {
    cronTasks.push(cron.schedule('0 7,10,13,16 * * 1-5', track('sage-cache-refresh', refreshSageWeekTotalsCache)));

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
  }

  if (process.env.HUB_MODE !== 'true') {
    // Daily backup at 02:00 — replaces backup.ps1 Task Scheduler dependency
    cronTasks.push(cron.schedule('0 2 * * *', track('local-backup', runLocalBackup)));
    // Daily backup verification at 03:30 — 90 min after the backup, well
    // before the 06:30 morning sync window. Catches corrupt/truncated/stale
    // backups so an operator finds out before the day they need to restore.
    cronTasks.push(cron.schedule('30 3 * * *', track(
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
    )));
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
          } catch {}
        }
      } catch (err) {
        try { logError('hub.probe', err, { phase: 'unhandled' }); } catch {}
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
    intervals.push(setInterval(
      track(
        'credit-logic-sync',
        () => syncCreditLogicFromHub({ triggeredBy: 'scheduler' }),
        null,
        { successCheck: (r) => r?.ok !== false },
      ),
      10 * 60 * 1000,
    ));
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
  cronTasks.push(cron.schedule('30 4 * * *', () => {
    try { pruneResolvedAlerts(30); } catch (err) { console.error('[alertEngine] prune failed:', err.message); }
  }));

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
      const conns = db.prepare(
        "SELECT id, last_sync, sync_interval_hours FROM databaseconnection WHERE status = 'active' AND COALESCE(is_bat_only, 0) = 0 AND sync_interval_hours IS NOT NULL AND sync_interval_hours > 0"
      ).all();
      const now = Date.now();
      let triggered = 0;
      for (const conn of conns) {
        const lastSync = conn.last_sync ? new Date(conn.last_sync).getTime() : 0;
        const intervalMs = conn.sync_interval_hours * 60 * 60 * 1000;
        if (now - lastSync >= intervalMs) {
          console.log(`[auto-sync] triggering sync for connection ${conn.id}`);
          triggered += 1;
          runConnectionImport(conn.id, { isShuttingDown: () => shuttingDown }).catch(err => console.error(`[auto-sync] error for ${conn.id}:`, err));
        }
      }
      return { triggered, considered: conns.length };
    }, (r) => r),
    5 * 60 * 1000,
  ));

  // Daily prune of job_runs at 04:00 (after backup-verify at 03:30).
  // Keeps the table from growing unbounded over months.
  cronTasks.push(cron.schedule('0 4 * * *', () => {
    try { pruneOldJobRuns(30); } catch (err) { console.error('[jobRunner] prune failed:', err.message); }
  }));
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
  intervals.push(setInterval(guardedSync, 5 * 60 * 1000));

  cronTasks.push(cron.schedule('0 3 * * *', track('hub-backup-pull', runHubBackupPull)));

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
    intervals.push(setInterval(guardedPing, 15 * 60 * 1000));
  }
}

export function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const task of cronTasks) { try { task.stop(); } catch {} }
  for (const interval of intervals) { try { clearInterval(interval); } catch {} }

  if (serverRef) {
    serverRef.close(() => {
      try { db.exec('PRAGMA optimize'); } catch {}
      try { db.close(); } catch {}
      process.exit(0);
    });

    setTimeout(() => {
      try { db.close(); } catch {}
      process.exit(1);
    }, 5000);
  } else {
    try { db.close(); } catch {}
    process.exit(0);
  }
}
