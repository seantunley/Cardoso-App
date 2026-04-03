import express from 'express';
import cors from 'cors';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import cron from 'node-cron';
import dotenv from 'dotenv';
import path from 'path';
import { createRequire } from 'module';
import { encryptPassword, isEncryptedFormat, getEncryptionKey } from './src/services/encryption.js';
import db from './src/db/index.js';
import { initSchema } from './src/db/schema.js';
import { buildStatements } from './src/db/statements.js';
import { createAuthMiddleware } from './src/middleware/auth.js';
import { loginLimiter } from './src/middleware/rateLimit.js';
import { sanitizeUser, defaultPermissionsForRole } from './src/helpers.js';
import { createAuthRouter } from './src/routes/auth.js';
import { createRecordsRouter } from './src/routes/records.js';
import { createConnectionsRouter } from './src/routes/connections.js';
import { runConnectionImport } from './src/services/syncEngine.js';
import { initHubTables, initHubSiteRegistry, syncAllSites, runHubBackupPull } from './src/services/hubEtl.js';
import { createHubRouter, createNonHubFallbackRouter } from './src/routes/hub.js';
import { createReportingRouter } from './src/routes/reporting.js';
import { createBackupRouter } from './src/routes/backup.js';
import { createSystemRouter } from './src/routes/system.js';

const require = createRequire(import.meta.url);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
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

// Reporting, KPI, top-balances, inventory, and multi-site reporting API — extracted to src/routes/reporting.js
const reportingRouter = createReportingRouter({ requireAuth });
app.use(reportingRouter);

// System routes (app-info, version-status, auto-update) — extracted to src/routes/system.js
const systemRouter = createSystemRouter({ requireAuth, requireAdmin });
app.use(systemRouter);

// Backup routes (status, download) — extracted to src/routes/backup.js
const backupRouter = createBackupRouter();
app.use(backupRouter);

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

// ==================== PRODUCTION SPA FALLBACK ====================
if (IS_PRODUCTION) {
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(process.cwd(), 'dist', 'index.html'));
    }
  });
}

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