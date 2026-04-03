import express from 'express';
import cors from 'cors';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import cron from 'node-cron';
import sql from 'mssql';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { encryptPassword, decryptPassword, isEncryptedFormat, getEncryptionKey } from './src/services/encryption.js';
import { normalizeVersion, isVersionNewer, getVersionStatus } from './src/services/versionCheck.js';
import db, { dbPath } from './src/db/index.js';
import { initSchema } from './src/db/schema.js';
import { buildStatements } from './src/db/statements.js';
import { createAuthMiddleware } from './src/middleware/auth.js';
import { loginLimiter } from './src/middleware/rateLimit.js';
import { FIELD_REGISTRY, INVOICE_SLOTS, RECEIPT_SLOTS, getMappingForKey, getRowValue, firstDefined, getMappedOrFallbackValue, shouldApplyMappedValue, buildFieldPatch, buildDynamicLocalFieldsPatch } from './src/fieldRegistry.js';
import { sanitizeForSqlite, parseJsonSafely, stringifyJsonSafely, expandDataRecord, normalizeFieldKey, validateCustomFieldKey, boolFromRow, defaultPermissionsForRole, sanitizeUser, sanitizeConnection } from './src/helpers.js';
import { _evalCondition, _evalRuleConditions, applyAutoFlagRulesToRecord } from './src/services/autoFlag.js';
import { createAuthRouter } from './src/routes/auth.js';
import { createRecordsRouter } from './src/routes/records.js';
import { createConnectionsRouter } from './src/routes/connections.js';
import { runConnectionImport, activeSyncs } from './src/services/syncEngine.js';
import { initHubTables, initHubSiteRegistry, syncAllSites, runHubBackupPull } from './src/services/hubEtl.js';
import { createHubRouter, createNonHubFallbackRouter } from './src/routes/hub.js';

const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('./package.json');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error('❌ SESSION_SECRET environment variable is required. Set it in your .env file.');
  process.exit(1);
}
if (SESSION_SECRET === 'change-me-to-a-long-random-string') {
  console.error('FATAL: SESSION_SECRET is set to the example value. Please generate a real secret in .env');
  process.exit(1);
}
if (SESSION_SECRET.length < 32) {
  console.error('FATAL: SESSION_SECRET must be at least 32 characters long.');
  process.exit(1);
}

// In production, serve React build and allow same-origin requests
if (IS_PRODUCTION) {
  const distPath = path.join(process.cwd(), 'dist');
  app.use(express.static(distPath));
  app.use(cors({ origin: false, credentials: true }));
} else {
  app.use(
    cors({
      origin: FRONTEND_ORIGIN,
      credentials: true,
    })
  );
}
app.use(express.json());

const SQLiteStore = require('connect-sqlite3')(session);

app.use(
  session({
    store: new SQLiteStore({
      db: 'sessions.db',
      dir: path.dirname(process.env.DB_PATH || './database/cardoso.db'),
      table: 'sessions',
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.HTTPS === 'true',
      sameSite: 'strict',
      maxAge: 1000 * 60 * 60 * 12,
    },
  })
);

// Initialize database schema, tables, indexes, and run migrations
initSchema(db);

// Sync lock helpers (activeSyncs, acquireSyncLock, releaseSyncLock) are now in src/services/syncEngine.js
let scheduledSyncInProgress = false;
let shuttingDown = false;
let server;

// Core tables, indexes, custom field config table, and migrations are now handled by initSchema(db) above.

// ==================== PASSWORD ENCRYPTION AUTO-MIGRATION ====================
(function migrateUnencryptedPasswords() {
  const key = getEncryptionKey();
  if (!key) return; // ENCRYPTION_KEY not set — skip

  const connections = db.prepare('SELECT id, encrypted_password FROM databaseconnection').all();
  let migrated = 0;
  for (const conn of connections) {
    if (!conn.encrypted_password) continue;
    if (isEncryptedFormat(conn.encrypted_password)) continue; // already encrypted
    try {
      const encrypted = encryptPassword(conn.encrypted_password);
      db.prepare('UPDATE databaseconnection SET encrypted_password = ? WHERE id = ?')
        .run(encrypted, conn.id);
      migrated++;
    } catch (e) {
      console.error(`[migration] Failed to encrypt password for connection ${conn.id}:`, e.message);
    }
  }
  if (migrated > 0) {
    console.log(`🔐 Auto-migrated ${migrated} MSSQL password(s) to AES-256-GCM encryption`);
  }
})();

// Migrations are now handled by src/db/migrations.js (called from initSchema)

// Schema cache, allowedTables, isValidTableName, getTableColumns now in src/routes/records.js

// ==================== PRE-COMPILED STATEMENTS ====================
const stmts = buildStatements(db);

// Helpers, field registry, and utility functions are now imported from src/helpers.js and src/fieldRegistry.js



function getUserById(id) {
  return stmts.getUserById.get(id);
}

function recoverAbandonedSyncs() {
  const info = db.prepare(`
    UPDATE syncrun
    SET status = 'abandoned',
        completed_at = ?,
        message = COALESCE(message, 'Server restarted before sync completed')
    WHERE status = 'running'
  `).run(new Date().toISOString());

  if (info.changes > 0) {
    console.log(`Recovered ${info.changes} abandoned sync run(s)`);
  }
}

async function ensureSeedUsers() {
  const admin = db.prepare(`SELECT * FROM "user" WHERE email = ?`).get('admin@example.com');
  const normal = db.prepare(`SELECT * FROM "user" WHERE email = ?`).get('user@example.com');

  const adminDefaults = defaultPermissionsForRole('admin');
  const userDefaults = defaultPermissionsForRole('user');

  if (!admin) {
    const hash = await bcrypt.hash('admin123', 12);
    db.prepare(`
      INSERT INTO "user" (
        email, full_name, role, password_hash, is_active,
        can_access_customer_search, can_access_records, can_access_reports, can_access_connections, can_access_settings,
        can_manage_users, can_manage_rules, can_edit_records, can_flag_records
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'admin@example.com',
      'Admin User',
      'admin',
      hash,
      1,
      adminDefaults.can_access_customer_search ? 1 : 0,
      adminDefaults.can_access_records ? 1 : 0,
      adminDefaults.can_access_reports ? 1 : 0,
      adminDefaults.can_access_connections ? 1 : 0,
      adminDefaults.can_access_settings ? 1 : 0,
      adminDefaults.can_manage_users ? 1 : 0,
      adminDefaults.can_manage_rules ? 1 : 0,
      adminDefaults.can_edit_records ? 1 : 0,
      adminDefaults.can_flag_records ? 1 : 0
    );
    console.warn('⚠️  DEFAULT CREDENTIALS ACTIVE: admin@example.com / admin123 — CHANGE IMMEDIATELY');
  } else if (!admin.password_hash) {
    const hash = await bcrypt.hash('admin123', 12);
    db.prepare(`UPDATE "user" SET password_hash = ? WHERE id = ?`).run(hash, admin.id);
    console.warn('⚠️  DEFAULT CREDENTIALS ACTIVE: admin@example.com / admin123 — CHANGE IMMEDIATELY');
  }

  if (!normal) {
    const hash = await bcrypt.hash('user123', 12);
    db.prepare(`
      INSERT INTO "user" (
        email, full_name, role, password_hash, is_active,
        can_access_customer_search, can_access_records, can_access_reports, can_access_connections, can_access_settings,
        can_manage_users, can_manage_rules, can_edit_records, can_flag_records
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'user@example.com',
      'Regular User',
      'user',
      hash,
      1,
      userDefaults.can_access_customer_search ? 1 : 0,
      userDefaults.can_access_records ? 1 : 0,
      userDefaults.can_access_reports ? 1 : 0,
      userDefaults.can_access_connections ? 1 : 0,
      userDefaults.can_access_settings ? 1 : 0,
      userDefaults.can_manage_users ? 1 : 0,
      userDefaults.can_manage_rules ? 1 : 0,
      userDefaults.can_edit_records ? 1 : 0,
      userDefaults.can_flag_records ? 1 : 0
    );
  } else if (!normal.password_hash) {
    const hash = await bcrypt.hash('user123', 12);
    db.prepare(`UPDATE "user" SET password_hash = ? WHERE id = ?`).run(hash, normal.id);
  }
}

// Auth middleware — extracted to src/middleware/auth.js
const { requireAuth, requireAdmin, requirePermission, requireSelfOrAdmin, checkTableAccess } = createAuthMiddleware({ getUserById, sanitizeUser });

// Auth and user routes — extracted to src/routes/auth.js
const authRouter = createAuthRouter({ db, stmts, getUserById, requireAuth, requireAdmin, requireSelfOrAdmin, loginLimiter });
app.use(authRouter);

// Data-record, auto-flag, and dynamic CRUD routes — extracted to src/routes/records.js
const recordsRouter = createRecordsRouter({ db, stmts, requireAuth, requireAdmin, requirePermission, checkTableAccess });
app.use(recordsRouter);

// runConnectionImport, acquireSyncLock, releaseSyncLock, activeSyncs are now in src/services/syncEngine.js

// Connection and sync routes — extracted to src/routes/connections.js
const connectionsRouter = createConnectionsRouter({ db, requireAuth, requirePermission, isShuttingDown: () => shuttingDown });
app.use(connectionsRouter);

// Auth routes (login, logout, set-initial-password, me) are now in src/routes/auth.js

app.get('/api/app-info', (req, res) => {
  res.json({
    hub_mode: process.env.HUB_MODE === 'true',
    version: require('./package.json').version,
  });
});

// test-rule route now in src/routes/records.js

// GET /api/top-balances?limit=30
// Returns top customers by outstanding balance, sorted descending.
// In hub mode, queries the hub_records table (cross-site).
// In site mode, queries the local datarecord table.
app.get('/api/kpis', requireAuth, (req, res) => {
  try {
    const total = stmts.kpiTotalRecords.get();
    const byFlag = stmts.kpiFlagCounts.all();
    const lastSync = stmts.kpiLastSync.get();
    const flagCounts = { none: 0, red: 0, orange: 0, green: 0 };
    for (const row of byFlag) {
      if (row.flag_color in flagCounts) flagCounts[row.flag_color] = row.count;
    }
    res.json({
      total_records: total.count,
      records_by_flag: flagCounts,
      last_sync_at: lastSync?.completed_at || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/top-balances', requireAuth, (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = (page - 1) * limit;
  const isHub = process.env.HUB_MODE === 'true';

  const balanceWhere = `outstanding_balance IS NOT NULL
          AND outstanding_balance != ''
          AND outstanding_balance != '0'
          AND CAST(REPLACE(REPLACE(outstanding_balance, ',', ''), ' ', '') AS REAL) > 0`;

  try {
    let rows, total;
    if (isHub) {
      total = db.prepare(`SELECT COUNT(*) AS count FROM hub_records r WHERE r.${balanceWhere}`).get().count;
      const stmt = db.prepare(`
        SELECT
          r.customer_number,
          r.customer_name,
          r.outstanding_balance,
          r.unpaid_invoices,
          r.receipts,
          r.flag_color,
          r.flag_reason,
          r.auto_flagged,
          COALESCE(s.name, r.site_id) AS site_name
        FROM hub_records r
        LEFT JOIN hub_sites s ON s.id = r.site_id
        WHERE r.${balanceWhere}
        ORDER BY CAST(REPLACE(REPLACE(r.outstanding_balance, ',', ''), ' ', '') AS REAL) DESC
        LIMIT ? OFFSET ?
      `);
      rows = stmt.all(limit, offset).map(expandDataRecord);
    } else {
      total = db.prepare(`SELECT COUNT(*) AS count FROM datarecord WHERE ${balanceWhere}`).get().count;
      const stmt = db.prepare(`
        SELECT
          customer_number,
          customer_name,
          outstanding_balance,
          unpaid_invoices,
          receipts,
          flag_color,
          flag_reason,
          auto_flagged,
          ? AS site_name
        FROM datarecord
        WHERE ${balanceWhere}
        ORDER BY CAST(REPLACE(REPLACE(outstanding_balance, ',', ''), ' ', '') AS REAL) DESC
        LIMIT ? OFFSET ?
      `);
      rows = stmt.all(SITE_NAME, limit, offset).map(expandDataRecord);
    }
    const totalPages = Math.ceil(total / limit);
    res.json({ records: rows, total, page, totalPages });
  } catch (err) {
    console.error('top-balances error', err);
    res.status(500).json({ error: 'Failed to fetch top balances' });
  }
});

// GET /api/inventory?search=&commodity=&limit=
app.get('/api/inventory', requireAuth, (req, res) => {
  const search = (req.query.search || '').trim();
  const commodity = (req.query.commodity || '').trim();
  const limit = Math.min(parseInt(req.query.limit, 10) || 100000, 100000);
  try {
    const conditions = [];
    const params = [];
    if (search) {
      conditions.push('(item_number LIKE ? OR item_description LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    if (commodity) {
      conditions.push('CAST(commodity AS TEXT) = ?');
      params.push(commodity);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(limit);
    const rows = db.prepare(
      `SELECT * FROM inventoryrecord ${where} ORDER BY item_number ASC LIMIT ?`
    ).all(...params);
    res.json({ count: rows.length, records: rows });
  } catch (err) {
    console.error('inventory error', err);
    res.status(500).json({ error: 'Failed to fetch inventory' });
  }
});

app.get('/api/app-version-status', requireAuth, async (req, res) => {
  try {
    const versionStatus = await getVersionStatus();
    res.json(versionStatus);
  } catch (error) {
    console.error('Version status error:', error);
    res.status(500).json({ error: 'Failed to check app version' });
  }
});

// Custom-field, record-history, login-log, and user routes are now in src/routes/records.js and src/routes/auth.js

// Connection routes (test-connection, test-query, import) are now in src/routes/connections.js

// ==================== MULTI-SITE REPORTING API ====================
// Read-only endpoints for hub ETL. Requires X-Reporting-Token header.

const SITE_ID = process.env.SITE_ID || 'local';
const SITE_SLUG = process.env.SITE_SLUG || 'local';
const SITE_NAME = process.env.SITE_NAME || 'Local';

function requireReportingToken(req, res, next) {
  const token = process.env.REPORTING_TOKEN;
  if (!token) {
    return res.status(503).json({ error: 'Reporting API not configured' });
  }
  if (req.headers['x-reporting-token'] !== token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// GET /api/reporting/site-info
app.get('/api/reporting/site-info', requireReportingToken, (req, res) => {
  res.json({
    site_id: SITE_ID,
    site_slug: SITE_SLUG,
    site_name: SITE_NAME,
    app_version: APP_VERSION,
    schema_version: 1,
    reporting_at: new Date().toISOString(),
  });
});

// GET /api/reporting/kpis
app.get('/api/reporting/kpis', requireReportingToken, (req, res) => {
  const total = stmts.kpiTotalRecords.get();
  const byFlag = stmts.kpiFlagCounts.all();
  const lastSync = stmts.kpiLastSync.get();
  const activeConns = stmts.kpiActiveConns.get();

  const flagCounts = { none: 0, red: 0, orange: 0, green: 0 };
  for (const row of byFlag) {
    if (row.flag_color in flagCounts) flagCounts[row.flag_color] = row.count;
  }

  res.json({
    site_id: SITE_ID,
    site_slug: SITE_SLUG,
    total_records: total.count,
    records_by_flag: flagCounts,
    last_sync_at: lastSync?.completed_at || null,
    active_connections: activeConns.count,
    generated_at: new Date().toISOString(),
  });
});

// GET /api/reporting/records?since=ISO_DATE&offset=0&limit=1000
app.get('/api/reporting/records', requireReportingToken, (req, res) => {
  const since = req.query.since;
  const limit = Math.min(parseInt(req.query.limit) || 1000, 1000);
  const offset = parseInt(req.query.offset) || 0;
  let rows;
  if (since) {
    rows = db.prepare(
      `SELECT id, customer_number, customer_name, flag_color, flag_reason,
              outstanding_balance, unpaid_invoices, receipts,
              updated_date, synced_at, source_table, source_id
       FROM datarecord WHERE updated_date > ? ORDER BY updated_date ASC LIMIT ? OFFSET ?`
    ).all(since, limit, offset);
  } else {
    rows = db.prepare(
      `SELECT id, customer_number, customer_name, flag_color, flag_reason,
              outstanding_balance, unpaid_invoices, receipts,
              updated_date, synced_at, source_table, source_id
       FROM datarecord ORDER BY updated_date ASC LIMIT ? OFFSET ?`
    ).all(limit, offset);
  }
  res.json({
    site_id: SITE_ID,
    site_slug: SITE_SLUG,
    since: since || null,
    offset,
    limit,
    count: rows.length,
    has_more: rows.length === limit,
    records: rows,
  });
});

// GET /api/reporting/health
app.get('/api/reporting/health', requireReportingToken, (req, res) => {
  const total = stmts.kpiTotalRecords.get();
  const lastRun = stmts.kpiLastRun.get();
  res.json({
    site_id: SITE_ID,
    site_slug: SITE_SLUG,
    status: 'ok',
    db_record_count: total.count,
    last_sync_status: lastRun?.status || null,
    last_sync_at: lastRun?.completed_at || null,
    uptime_seconds: Math.floor(process.uptime()),
    checked_at: new Date().toISOString(),
  });
});



// GET /api/reporting/inventory?offset=0&limit=1000
app.get('/api/reporting/inventory', requireReportingToken, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 1000, 1000);
  const offset = parseInt(req.query.offset) || 0;
  const rows = db.prepare(
    `SELECT id, source_table, item_number, item_description, qty_on_hand, last_cost, price_list, price, stocking_uom, commodity, updated_date
     FROM inventoryrecord ORDER BY item_number ASC LIMIT ? OFFSET ?`
  ).all(limit, offset);
  res.json({
    site_id: SITE_ID,
    site_slug: SITE_SLUG,
    offset,
    limit,
    count: rows.length,
    has_more: rows.length === limit,
    records: rows,
  });
});

// ==================== HUB ETL ====================
// Hub routes and ETL — extracted to src/routes/hub.js and src/services/hubEtl.js
if (process.env.HUB_MODE === 'true') {
  initHubTables();
  initHubSiteRegistry();
  const hubRouter = createHubRouter({ requireAuth, requireAdmin });
  app.use(hubRouter);

  // Startup sync after 10s delay
  setTimeout(syncAllSites, 10000);
  // Scheduled every 5 minutes
  setInterval(syncAllSites, 5 * 60 * 1000);
} else {
  // Non-hub fallback: empty responses for hub endpoints called by UI on non-hub installs
  app.use(createNonHubFallbackRouter());
}

// Dynamic CRUD routes, auto-flag routes, and test-rule are now in src/routes/records.js

// ==================== SCHEDULED SYNC ====================
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

// Scheduled sync runs within the server process
const weekdayHalfHourTask = cron.schedule('0,30 6-16 * * 1-5', runScheduledSyncCycle);
const weekdayFivePmTask = cron.schedule('0 17 * * 1-5', runScheduledSyncCycle);

// Hub backup pull cron (03:00 daily, hub mode only) — logic in src/services/hubEtl.js
let hubBackupCronTask = null;
if (process.env.HUB_MODE === 'true') {
  hubBackupCronTask = cron.schedule('0 3 * * *', runHubBackupPull);
}


// ==================== SHUTDOWN ====================
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    weekdayHalfHourTask.stop();
    weekdayFivePmTask.stop();
    try { hubBackupCronTask?.stop(); } catch {}
  } catch {}

  if (server) {
    server.close(() => {
      try {
        db.exec('PRAGMA optimize');
      } catch {}

      try {
        db.close();
      } catch {}

      process.exit(0);
    });

    setTimeout(() => {
      try {
        db.close();
      } catch {}
      process.exit(1);
    }, 5000);
  } else {
    try {
      db.close();
    } catch {}
    process.exit(0);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ==================== AUTO-UPDATE (WINDOWS SERVICE) ====================
import { exec as execChild } from 'child_process';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

let autoUpdateRunning = false;

async function triggerWindowsUpdate() {
  if (autoUpdateRunning) {
    console.log('[AutoUpdate] Update already in progress, skipping.');
    return { ok: false, reason: 'already_running' };
  }
  autoUpdateRunning = true;

  try {
    // Get download URL for latest release asset
    const releaseResp = await fetch('https://api.github.com/repos/seantunley/Cardoso-App/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'cardoso-app-auto-update' }
    });
    if (!releaseResp.ok) throw new Error(`GitHub API error: ${releaseResp.status}`);
    const release = await releaseResp.json();
    const asset = release.assets.find(a => a.name.startsWith('CardosoSetup-') && a.name.endsWith('.exe'));
    if (!asset) throw new Error('CardosoSetup.exe not found in latest release');

    console.log(`[AutoUpdate] Downloading ${asset.name} (${(asset.size/1024/1024).toFixed(1)} MB)...`);

    // Download to temp file
    const tmpPath = path.join(process.env.TEMP || 'C:\Windows\Temp', 'CardosoSetup-update.exe');
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
app.post('/api/app-update-trigger', requireAuth, requireAdmin, async (req, res) => {
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

// ==================== PRODUCTION SPA FALLBACK ====================
if (IS_PRODUCTION) {
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(process.cwd(), 'dist', 'index.html'));
    }
  });
}



// ==================== BACKUP STATUS ====================

// GET /api/backup/status
// Returns metadata about the most recent local backup file.
// Used by the Hub to monitor backup health across sites.
app.get('/api/backup/status', (req, res) => {
  const token = req.headers['x-reporting-token'];
  const expectedToken = process.env.REPORTING_TOKEN;
  if (!expectedToken || token !== expectedToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const fs = require('fs');
  const backupDir = path.resolve(path.dirname(dbPath), 'backups');

  let lastBackup = null;
  if (fs.existsSync(backupDir)) {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.db'))
      .map(f => {
        const full = path.join(backupDir, f);
        const stat = fs.statSync(full);
        return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));

    if (files.length > 0) {
      lastBackup = files[0];
      lastBackup.total_backups = files.length;
    }
  }

  const dbStat = fs.existsSync(dbPath) ? fs.statSync(path.resolve(dbPath)) : null;

  res.json({
    site_id: process.env.SITE_ID || 'unknown',
    site_name: process.env.SITE_NAME || 'Unknown',
    db_size: dbStat ? dbStat.size : null,
    db_modified: dbStat ? dbStat.mtime.toISOString() : null,
    last_backup: lastBackup,
    backup_dir: backupDir,
  });
});

// ==================== BACKUP ====================
// GET /api/backup/download
// Streams the live SQLite database to the caller as a binary file.
// Protected by x-reporting-token header — same token used for hub reporting.
// The database is checkpointed (WAL → main file) before streaming so the
// downloaded file is consistent and can be opened directly with any SQLite tool.
app.get('/api/backup/download', (req, res) => {
  const token = req.headers['x-reporting-token'];
  const expectedToken = process.env.REPORTING_TOKEN;

  if (!expectedToken || token !== expectedToken) {
    return res.status(401).json({ error: 'Unauthorized: valid x-reporting-token required' });
  }

  try {
    // Flush WAL to main DB file so the file on disk is complete
    db.pragma('wal_checkpoint(TRUNCATE)');

    const resolvedDbPath = path.resolve(dbPath);
    const filename = `cardoso-backup-${process.env.SITE_ID || 'site'}-${new Date().toISOString().slice(0,10)}.db`;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Backup-Site', process.env.SITE_ID || 'unknown');
    res.setHeader('X-Backup-Timestamp', new Date().toISOString());

    const stream = require('fs').createReadStream(resolvedDbPath);
    stream.on('error', (err) => {
      console.error('[backup] Stream error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to stream database' });
    });
    stream.pipe(res);
  } catch (err) {
    console.error('[backup] Error preparing backup:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== STARTUP ====================
recoverAbandonedSyncs();

ensureSeedUsers()
  .then(() => {
    server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Local backend + SQLite running at http://0.0.0.0:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Failed to seed users:', error);
    process.exit(1);
  });

// Auto-sync scheduler: checks every 5 minutes
setInterval(async () => {
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
}, 5 * 60 * 1000);