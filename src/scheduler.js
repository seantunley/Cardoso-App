import cron from 'node-cron';
import db from './db/index.js';
import { runConnectionImport } from './services/syncEngine.js';

async function runSpeedTest() {
  if (process.env.HUB_MODE === 'true') return;
  try {
    const { default: speedTest } = await import('speedtest-net');
    console.log('[speedtest] Starting speed test...');
    const result = await speedTest({ acceptLicense: true, acceptGdpr: true });
    const download_mbps = result.download?.bandwidth != null ? (result.download.bandwidth * 8) / 1_000_000 : null;
    const upload_mbps = result.upload?.bandwidth != null ? (result.upload.bandwidth * 8) / 1_000_000 : null;
    const ping_ms = result.ping?.latency ?? null;
    const isp = result.isp ?? null;
    const server_name = result.server?.name ?? null;
    const server_location = result.server?.location ?? result.server?.country ?? null;
    const timestamp = new Date().toISOString();
    db.prepare(`
      INSERT INTO site_speedtest (timestamp, download_mbps, upload_mbps, ping_ms, isp, server_name, server_location)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(timestamp, download_mbps, upload_mbps, ping_ms, isp, server_name, server_location);
    // Prune to last 90 results
    db.prepare(`
      DELETE FROM site_speedtest WHERE id NOT IN (
        SELECT id FROM site_speedtest ORDER BY id DESC LIMIT 90
      )
    `).run();
    console.log(`[speedtest] Done — ↓${download_mbps?.toFixed(1)} ↑${upload_mbps?.toFixed(1)} ping=${ping_ms}ms`);
  } catch (err) {
    console.error('[speedtest] Speed test failed:', err.message);
  }
}

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
    const connections = db
      .prepare(`SELECT id, name FROM databaseconnection WHERE status = 'active'`)
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

export function startSchedulers() {
  cronTasks.push(cron.schedule('0,30 6-16 * * 1-5', runScheduledSyncCycle));
  cronTasks.push(cron.schedule('0 17 * * 1-5', runScheduledSyncCycle));
  if (process.env.HUB_MODE !== 'true') {
    cronTasks.push(cron.schedule('0 7,10,13,16 * * *', runSpeedTest));
  }

  intervals.push(setInterval(async () => {
    try {
      const conns = db.prepare(
        "SELECT id, last_sync, sync_interval_hours FROM databaseconnection WHERE status = 'active' AND sync_interval_hours IS NOT NULL AND sync_interval_hours > 0"
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

export function startHubSchedulers(syncAllSites, runHubBackupPull) {
  setTimeout(syncAllSites, 10000);
  intervals.push(setInterval(syncAllSites, 5 * 60 * 1000));
  cronTasks.push(cron.schedule('0 3 * * *', runHubBackupPull));
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
