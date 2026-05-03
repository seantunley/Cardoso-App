import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import session from 'express-session';
import dotenv from 'dotenv';
import path from 'path';
import { createRequire } from 'module';
import db from './src/db/index.js';
import { initSchema } from './src/db/schema.js';
import { runMigrations } from './src/db/migrations.js';
import { buildStatements } from './src/db/statements.js';
import { createAuthMiddleware } from './src/middleware/auth.js';
import { loginLimiter } from './src/middleware/rateLimit.js';
import { sanitizeUser } from './src/helpers.js';
import { createAuthRouter } from './src/routes/auth.js';
import { createRecordsRouter } from './src/routes/records.js';
import { createConnectionsRouter } from './src/routes/connections.js';
import { initHubTables, initHubSiteRegistry, syncAllSites, runHubBackupPull, pingAllSites } from './src/services/hubEtl.js';
import { createHubRouter, createNonHubFallbackRouter, createReceiveUsersRouter } from './src/routes/hub.js';
import { createReportingRouter } from './src/routes/reporting.js';
import { createBackupRouter } from './src/routes/backup.js';
import { createSystemRouter } from './src/routes/system.js';
import { createCreditLogicRouter } from './src/routes/creditLogic.js';
import { createCollectionsRouter } from './src/routes/collections.js';
import { createNetworkDevicesRouter } from './src/routes/networkDevices.js';
import { initBatSchema } from './src/db/batSchema.js';
import { createBatReconciliationRouter } from './src/routes/batReconciliation.js';
import { resumeExtractionWorker } from './src/services/batReconciliation.js';
import { validateSessionSecret, validateHubTokenSecret, validateEncryptionKey, migrateUnencryptedPasswords, recoverAbandonedSyncs, ensureSeedUsers, createGetUserById } from './src/startup.js';
import { isShuttingDown, startSchedulers, startHubSchedulers, setServer, gracefulShutdown } from './src/scheduler.js';
import { initHubStorageRuntime } from './src/hub/storage/runtime.js';
import { validateHubPostgresConfig } from './src/config/hubPostgres.js';
import { logError } from './src/lib/errorLog.js';

const require = createRequire(import.meta.url);
dotenv.config();
validateSessionSecret(process.env.SESSION_SECRET);
validateHubTokenSecret(process.env.HUB_TOKEN_SECRET);
validateHubPostgresConfig(process.env);
initHubStorageRuntime();

const app = express();
const PORT = process.env.PORT || 3001;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// TLS_FRONTING is set when there's a Caddy/nginx/etc reverse proxy in
// front of this app terminating HTTPS. When true, helmet flips on the
// HTTPS-only protections that were disabled for plain-HTTP LAN use:
//   - HSTS: forces clients to re-use HTTPS for the configured window
//   - Content-Security-Policy: includes upgrade-insecure-requests so any
//     stray http://... subresource gets bumped to https://
//   - Cross-Origin-Opener-Policy + Origin-Agent-Cluster: stricter
//     isolation that requires HTTPS to function correctly
// Defaults to false to preserve LAN-only HTTP installs (sites today).
// See docs/plans/https-rollout.md for the rollout context.
const TLS_FRONTING = process.env.TLS_FRONTING === 'true';

if (TLS_FRONTING) {
  app.use(helmet({
    hsts: { maxAge: 15552000, includeSubDomains: false }, // 180 days
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        // Bump any http:// subresource to https:// — closes mixed-content gaps
        'upgrade-insecure-requests': [],
        // Allow inline styles for the Vite-built bundle. Tightening this
        // further is a follow-up — needs an audit of what the UI actually loads.
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'connect-src': ["'self'"],
      },
    },
    // crossOriginOpenerPolicy + originAgentCluster default to safe
  }));
} else {
  // LAN-only HTTP mode: keep the HTTPS-dependent protections off so
  // browsers don't try to upgrade plain-http subresources or insist on
  // HSTS for a host that doesn't have a cert.
  app.use(helmet({
    hsts: false,
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
  }));
}

// Trust proxy so X-Forwarded-For is used correctly (rate limiting, login logging)
// On Tailscale/network proxies, this should be safe — only trust hop 1 (the proxy itself)
app.set('trust proxy', 1);

if (IS_PRODUCTION) {
  app.use(express.static(path.join(process.cwd(), 'dist')));
  app.use(cors({
    origin: (origin, callback) => {
      // Allow all origins — frontend is served by this same server
      callback(null, true);
    },
    credentials: true,
  }));
} else {
  app.use(cors({ origin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173', credentials: true }));
}
app.use(express.json());

const SQLiteStore = require('connect-sqlite3')(session);
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: path.dirname(process.env.DB_PATH || './database/cardoso.db'), table: 'sessions' }),
  secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.HTTPS === 'true', sameSite: 'strict', maxAge: 1000 * 60 * 60 * 12 },
}));

// initBatSchema must run BEFORE the main migrations because some perf-index
// migrations (e.g. v45 idx_bat_cardoso_inv_overwritten) target BAT tables.
// initBatSchema is idempotent: every CREATE / ALTER uses IF NOT EXISTS or a
// PRAGMA-guarded check, so calling it on existing installs is safe.
initBatSchema(db);
initSchema(db);
runMigrations(db);
validateEncryptionKey();
migrateUnencryptedPasswords();
const stmts = buildStatements(db);
const getUserById = createGetUserById(stmts);
const { requireAuth, requireAdmin, requirePermission, requireSelfOrAdmin, checkTableAccess } = createAuthMiddleware({ getUserById, sanitizeUser });

app.use(createAuthRouter({ db, stmts, getUserById, requireAuth, requireAdmin, requireSelfOrAdmin, loginLimiter }));
app.use(createSystemRouter({ requireAuth, requireAdmin }));
app.use(createCreditLogicRouter({ requireAuth, requirePermission }));
app.use(createBackupRouter());
app.use(createReportingRouter({ requireAuth }));
app.use(createCollectionsRouter({ requireAuth, requirePermission }));
app.use(createNetworkDevicesRouter({ requireAuth, requireAdmin, requirePermission }));
app.use(createConnectionsRouter({ db, requireAuth, requirePermission, isShuttingDown }));

// ── BAT Supplier Reconciliation (admin-only while testing) ──
// (initBatSchema already ran earlier, before the migrations.)
app.use(createBatReconciliationRouter({ requireAuth, requireAdmin }));

if (process.env.HUB_MODE === 'true') {
  initHubTables();
  initHubSiteRegistry();
  app.use(createHubRouter({ requireAuth, requireAdmin, requirePermission }));
  startHubSchedulers(syncAllSites, runHubBackupPull, pingAllSites);
} else {
  app.use(createNonHubFallbackRouter());
}
// receive-users is always mounted — sites need it even when HUB_MODE is not set
app.use(createReceiveUsersRouter());

app.use(createRecordsRouter({ db, stmts, requireAuth, requireAdmin, requirePermission, checkTableAccess }));

// ── Global error middleware ─────────────────────────────────────────────────
// Safety net for anything a route handler didn't catch itself: synchronous
// throws inside handlers without try/catch, async rejections that bubble via
// next(err), errors thrown from upstream middleware. Explicit per-route
// logError() calls still take precedence — those get richer context. This
// just ensures *nothing* falls into the void.
app.use((err, req, res, next) => {
  try {
    logError('http.unhandled', err, {
      method: req.method,
      path: req.originalUrl?.split('?')[0],
      user: req.currentUser?.email,
      ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress,
    });
  } catch { /* logger itself failed — don't recurse */ }
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

if (IS_PRODUCTION) {
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) res.sendFile(path.join(process.cwd(), 'dist', 'index.html'));
  });
}

startSchedulers();
recoverAbandonedSyncs();
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, (...args) => {
  try { logError('system.shutdown', new Error(`Received ${sig} — shutting down`), { signal: sig }, 'info'); } catch {}
  gracefulShutdown(...args);
}));
// Process-level safety nets — anything that escapes a callback or promise
// chain still lands in the System Log so we can correlate "X stalled" with
// "uncaught error at Y".
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err.message);
  try { logError('system.uncaught', err); } catch {}
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED]', err?.message || err);
  try { logError('system.unhandled', err instanceof Error ? err : new Error(String(err))); } catch {}
});
// BIND_ADDRESS controls which network interface the server listens on.
//   '0.0.0.0' (default) — all interfaces; LAN clients can reach the app
//                        directly. Right setting for site installs and
//                        Hub installs that aren't behind a reverse proxy.
//   '127.0.0.1'         — loopback only. Right setting once Caddy is
//                        installed in front and only Caddy should be
//                        able to reach the Node service. Set this in
//                        the Hub's .env after running install-hub-caddy.ps1.
const BIND_ADDRESS = process.env.BIND_ADDRESS || '0.0.0.0';

ensureSeedUsers().then(() => {
  setServer(app.listen(PORT, BIND_ADDRESS, () => {
    const protocol = TLS_FRONTING ? 'https' : 'http';
    const proxyNote = TLS_FRONTING ? ' (behind TLS-terminating proxy)' : '';
    console.log(`🚀 Local backend + SQLite running at ${protocol}://${BIND_ADDRESS}:${PORT}${proxyNote}`);
    // Boot marker — lets operators see "OCR is paused" alongside "server
    // restarted at HH:MM" so the cause-and-effect is obvious.
    try {
      logError('system.boot', new Error(`Server started on port ${PORT} (node ${process.version}, hub_mode=${process.env.HUB_MODE === 'true'}, bind=${BIND_ADDRESS}, tls_fronting=${TLS_FRONTING})`), {
        port: PORT,
        bind: BIND_ADDRESS,
        tls_fronting: TLS_FRONTING,
        hub_mode: process.env.HUB_MODE === 'true',
        node: process.version,
        env: process.env.NODE_ENV || 'development',
      }, 'info');
    } catch {}
  }));
  // Resume any paused BAT OCR extractions from a previous run
  resumeExtractionWorker();
}).catch((error) => {
  console.error('Failed to seed users:', error);
  try { logError('system.boot', error, { phase: 'ensureSeedUsers' }); } catch {}
  process.exit(1);
});
