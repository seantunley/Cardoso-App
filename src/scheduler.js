import cron from 'node-cron';
import path from 'path';
import { mkdirSync } from 'fs';
import db, { dbPath } from './db/index.js';
import { runConnectionImport } from './services/syncEngine.js';
// networkDevices service removed (replaced by ntopng integration)
import { syncCreditLogicFromHub } from './services/creditLogic.js';
import { refreshSageWeekTotalsCache } from './services/batReconciliation.js';

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

export function startSchedulers() {
  cronTasks.push(cron.schedule('0,30 6-16 * * 1-5', runScheduledSyncCycle));
  cronTasks.push(cron.schedule('0 17 * * 1-5', runScheduledSyncCycle));

  // BAT Sage week-totals cache — refresh every 3h on weekdays at 7/10/13/16.
  // Site-only: the Hub doesn't have a Sage connection (it aggregates data
  // pulled from sites via /api/reporting/bat-summary, not by querying Sage
  // directly). Without this gate the Hub fired refreshSageWeekTotalsCache
  // on every cron tick and on every boot, each call throwing "No Sage
  // connection configured" into the System Log.
  if (process.env.HUB_MODE !== 'true') {
    cronTasks.push(cron.schedule('0 7,10,13,16 * * 1-5', () => {
      refreshSageWeekTotalsCache().catch((e) => console.error('[bat-sage-cache] scheduled refresh failed:', e.message));
    }));
    // Initial boot refresh (delayed so DB migrations and Sage pool init can settle)
    setTimeout(() => {
      refreshSageWeekTotalsCache().catch((e) => console.error('[bat-sage-cache] boot refresh failed:', e.message));
    }, 15000);
  }

  if (process.env.HUB_MODE !== 'true') {
    // Daily backup at 02:00 — replaces backup.ps1 Task Scheduler dependency
    cronTasks.push(cron.schedule('0 2 * * *', runLocalBackup));
    // ntopng integration: no local scheduled scan needed (ntopng pulls flows continuously)
    setTimeout(() => {
      syncCreditLogicFromHub({ triggeredBy: 'startup' }).catch((error) => {
        console.error('[credit-logic] startup sync failed:', error.message);
      });
    }, 12000);
    intervals.push(setInterval(() => {
      syncCreditLogicFromHub({ triggeredBy: 'scheduler' }).catch((error) => {
        console.error('[credit-logic] scheduled sync failed:', error.message);
      });
    }, 10 * 60 * 1000));
  }

  intervals.push(setInterval(async () => {
    try {
      const conns = db.prepare(
        "SELECT id, last_sync, sync_interval_hours FROM databaseconnection WHERE status = 'active' AND COALESCE(is_bat_only, 0) = 0 AND sync_interval_hours IS NOT NULL AND sync_interval_hours > 0"
      ).all();
      const now = Date.now();
      for (const conn of conns) {
        const lastSync = conn.last_sync ? new Date(conn.last_sync).getTime() : 0;
        const intervalMs = conn.sync_interval_hours * 60 * 60 * 1000;
        if (now - lastSync >= intervalMs) {
          console.log(`[auto-sync] triggering sync for connection ${conn.id}`);
          runConnectionImport(conn.id, { isShuttingDown: () => shuttingDown }).catch(err => console.error(`[auto-sync] error for ${conn.id}:`, err));
        }
      }
    } catch (err) {
      console.error("[auto-sync] scheduler error:", err);
    }
  }, 5 * 60 * 1000));
}

export function startHubSchedulers(syncAllSites, runHubBackupPull, pingAllSites) {
  // Overlap guard: if a previous syncAllSites is still running when the
  // 5-minute interval fires (which happens when one site has slow ETL or
  // a long-running backup pull), skip the new tick instead of letting two
  // syncs race on the Hub Postgres pool and per-site sync state. Same
  // pattern for pingAllSites — defensive even though pings are normally fast.
  let syncRunning = false;
  const guardedSync = async () => {
    if (syncRunning) {
      console.warn('[hub-sync] previous syncAllSites still running — skipping this tick');
      return;
    }
    syncRunning = true;
    try { await syncAllSites(); }
    catch (err) { console.error('[hub-sync] syncAllSites failed:', err.message); }
    finally { syncRunning = false; }
  };
  setTimeout(guardedSync, 10000);
  intervals.push(setInterval(guardedSync, 5 * 60 * 1000));

  cronTasks.push(cron.schedule('0 3 * * *', runHubBackupPull));

  if (pingAllSites) {
    let pingRunning = false;
    const guardedPing = async () => {
      if (pingRunning) return;
      pingRunning = true;
      try { await pingAllSites(); }
      catch (err) { console.error('[hub-sync] pingAllSites failed:', err.message); }
      finally { pingRunning = false; }
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
