import cron from 'node-cron';
import path from 'path';
import { mkdirSync } from 'fs';
import Database from 'better-sqlite3';
import db, { dbPath } from './db/index.js';
import { runConnectionImport } from './services/syncEngine.js';
// networkDevices service removed (replaced by ntopng integration)
import { syncCreditLogicFromHub } from './services/creditLogic.js';
import { refreshSageWeekTotalsCache, probeSageHealth } from './services/batReconciliation.js';
import { recordJob, pruneOldJobRuns } from './lib/jobRunner.js';

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

    // Prune: keep last 30
    const { readdirSync, statSync, unlinkSync } = await import('fs');
    const files = readdirSync(backupDir)
      .filter((f) => f.endsWith('.db'))
      .map((f) => ({ name: f, mtime: statSync(path.join(backupDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    const keep = parseInt(process.env.BACKUP_KEEP_COUNT || '30', 10);
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
function track(name, fn, contextFn) {
  return () => recordJob(name, fn, contextFn).catch((err) => {
    console.error(`[${name}] failed:`, err.message);
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
    )));
    // ntopng integration: no local scheduled scan needed (ntopng pulls flows continuously)
    setTimeout(
      track('credit-logic-sync', () => syncCreditLogicFromHub({ triggeredBy: 'startup' })),
      12000,
    );
    intervals.push(setInterval(
      track('credit-logic-sync', () => syncCreditLogicFromHub({ triggeredBy: 'scheduler' })),
      10 * 60 * 1000,
    ));
  }

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
