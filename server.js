import express from 'express';
import compression from 'compression';
import helmet from 'helmet';
import cors from 'cors';
import session from 'express-session';
import dotenv from 'dotenv';
import path from 'path';
import { createRequire } from 'module';
import db, { dbPath } from './src/db/index.js';
import { startMainThreadWatch, checkPreviousRunFreeze } from './src/lib/mainThreadWatch.js';
import { fireAlert } from './src/lib/alertEngine.js';
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
import { createDrRouter } from './src/routes/dr.js';
import { createSystemRouter } from './src/routes/system.js';
import { createCreditLogicRouter } from './src/routes/creditLogic.js';
import { createCollectionsRouter } from './src/routes/collections.js';
import { createNetworkDevicesRouter } from './src/routes/networkDevices.js';
import { initBatSchema } from './src/db/batSchema.js';
import { createBatReconciliationRouter } from './src/routes/batReconciliation.js';
import { createJtiRouter } from './src/routes/jti.js';
import { createSageCorrectionsRouter } from './src/routes/sageCorrections.js';
import { createInventoryMovementRouter } from './src/routes/inventoryMovement.js';
import { createStockReceiptRouter } from './src/routes/stockReceipts.js';
import { createCreditorRouter } from './src/routes/creditors.js';
import { createDebtorRouter } from './src/routes/debtors.js';
import { createPricingRouter } from './src/routes/pricing.js';
import { createDepotProfileRouter } from './src/routes/depotProfile.js';
import { createCommissionRouter } from './src/routes/commission.js';
import { resumeExtractionWorker } from './src/services/batReconciliation.js';
import { autoHealSessionSecretIfNeeded, validateEncryptionKey, migrateUnencryptedPasswords, recoverAbandonedSyncs, ensureSeedUsers, createGetUserById } from './src/startup.js';
import { recoverPendingPreviewRenders } from './src/services/ocr/previewRenderQueue.js';
import { isShuttingDown, startSchedulers, startHubSchedulers, setServer, gracefulShutdown } from './src/scheduler.js';
import { initHubStorageRuntime } from './src/hub/storage/runtime.js';
import { validateEnvOrExit } from './src/config/env.js';
import { logError } from './src/lib/errorLog.js';
import { captureSecuritySignal } from './src/lib/securitySignals.js';

const require = createRequire(import.meta.url);
dotenv.config();

// Boot-time env validation — three steps:
// 1. Auto-heal SESSION_SECRET in production if it's the installer
//    placeholder (so the service keeps running on a fresh install).
// 2. Run the zod schema over every other env var. Aggregates ALL
//    failures into one boot message (no fix-restart-fix-restart).
// 3. validateEncryptionKey checks against the DB (separate because it
//    requires a query) and runs a touch later, after the DB is open.
autoHealSessionSecretIfNeeded();
validateEnvOrExit();
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

// gzip responses. Hub payloads (sites list, kpis, aged-debtors) run into
// multiple MB and ship over Tailscale/LAN — gzip cuts wire size 5-10×.
// Mounted BEFORE express.static so the hashed JS/CSS bundles are compressed
// too; compression() only touches responses that pass through it first.
app.use(compression());

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
// 2 MB JSON body cap. The previous (default) limit was 100kb but
// express's default actually allows unbounded bodies on app.use(json())
// without an explicit `limit` — every hub receive endpoint
// (/api/hub/receive-rules, /api/hub/receive-users) accepted arbitrarily
// large payloads, a memory-DoS vector. 2MB comfortably covers the
// largest known payload (full users + rules push for a 50-user
// install ≈ 200KB) with 10× headroom; raise per-route via a dedicated
// express.json({ limit: ... }) on a router if a future endpoint
// legitimately needs more.
app.use(express.json({ limit: '2mb' }));

// Session store backed by a dedicated better-sqlite3 connection. Replaces
// connect-sqlite3 (which depended on the legacy `sqlite3` package and pulled
// in 6 high-severity transitive vulns through node-gyp + tar). Sessions live
// in their own DB file alongside the main app DB so a session table corruption
// can't take the main app offline.
const Database = require('better-sqlite3');
const SqliteStore = require('better-sqlite3-session-store')(session);
const sessionsDbDir = path.dirname(process.env.DB_PATH || './database/cardoso.db');
const sessionsDb = new Database(path.join(sessionsDbDir, 'sessions.db'));

// Migrate from the old connect-sqlite3 schema if present.
//
// connect-sqlite3 created `sessions(sid, expired, sess)`. better-sqlite3-session-store
// expects `sessions(sid, expire, sess)` — note `expire` not `expired`. On any
// site upgrading from < v2026.4.18, the old table sits on disk and the first
// session lookup (e.g. POST /api/auth/login → save session) hits the new
// store's INSERT path, which fails with `no such column: expire` and bubbles
// up to the UI as `{"error":"no such column: expire"}`.
//
// Detect the old shape by checking column names. If the table exists but
// lacks `expire`, drop it — the store will recreate it with the new shape on
// first use. All existing sessions are invalidated; users have to log in once
// after the upgrade. (We can't preserve them across the schema break — the
// `sess` blob format is also slightly different between the two libraries.)
try {
  const tableExists = sessionsDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
    .get();
  if (tableExists) {
    const cols = sessionsDb.prepare("PRAGMA table_info(sessions)").all();
    const hasExpire = cols.some(c => c.name === 'expire');
    if (!hasExpire) {
      console.log('[session-store] Detected old connect-sqlite3 schema, dropping legacy sessions table — users will need to log in again.');
      sessionsDb.exec('DROP TABLE sessions');
    }
  }
} catch (err) {
  // Don't crash boot on a schema-detect failure — the store will surface
  // the real error on first request if migration was actually needed.
  console.error('[session-store] Schema detection failed:', err.message);
}

app.use(session({
  store: new SqliteStore({
    client: sessionsDb,
    // GC expired rows every 15 min so the file doesn't grow forever.
    expired: { clear: true, intervalMs: 15 * 60 * 1000 },
  }),
  secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.HTTPS === 'true', sameSite: 'strict', maxAge: 1000 * 60 * 60 * 12 },
}));

// Security-signals telemetry — registered AFTER session so any future
// tweak that wants to bucket by user-id sees req.session populated.
// Today the listener doesn't read session, but this position is the
// safe default. See src/lib/securitySignals.js for the threshold model
// and src/lib/alertRules.js for the alert wiring.
app.use(captureSecuritySignal);

// initBatSchema must run BEFORE the main migrations because some perf-index
// migrations (e.g. v45 idx_bat_cardoso_inv_overwritten) target BAT tables.
// initBatSchema is idempotent: every CREATE / ALTER uses IF NOT EXISTS or a
// PRAGMA-guarded check, so calling it on existing installs is safe.
initBatSchema(db);
initSchema(db);
runMigrations(db);
// Freeze forensics: report a hard main-thread freeze from the PREVIOUS run
// (the marker file the watchdog worker wrote while the app was wedged), then
// start this run's heartbeat + watchdog. After migrations so error_log and
// alerts tables exist; before routes so the first request is covered.
checkPreviousRunFreeze(dbPath, { fireAlert });
startMainThreadWatch(dbPath);
validateEncryptionKey();
migrateUnencryptedPasswords();
const stmts = buildStatements(db);
const getUserById = createGetUserById(stmts);
const { requireAuth, requireAdmin, requirePermission, requireSelfOrAdmin, checkTableAccess } = createAuthMiddleware({ getUserById, sanitizeUser });

app.use(createAuthRouter({ db, stmts, getUserById, requireAuth, requireAdmin, requireSelfOrAdmin, loginLimiter }));
app.use(createSystemRouter({ requireAuth, requireAdmin }));
app.use(createCreditLogicRouter({ requireAuth, requirePermission }));
app.use(createBackupRouter());
app.use(createDrRouter());
app.use(createReportingRouter({ requireAuth, requirePermission }));
app.use(createCollectionsRouter({ requireAuth, requirePermission }));
app.use(createNetworkDevicesRouter({ requireAuth, requireAdmin, requirePermission }));
app.use(createConnectionsRouter({ db, requireAuth, requirePermission, isShuttingDown }));

// ── BAT Supplier Reconciliation ──
// (initBatSchema already ran earlier, before the migrations.)
app.use(createBatReconciliationRouter({ requireAuth, requireAdmin, requirePermission }));

// ── Sage credit-note description corrections (admin-only) ──
app.use(createSageCorrectionsRouter({ requireAuth, requireAdmin }));

// ── JTI Sales export (Accpac OE Shipment History → .xlsx) ──
app.use(createJtiRouter({ requireAuth, requirePermission }));

// ── Inventory Movement (sales velocity / dead stock analytics) ──
app.use(createInventoryMovementRouter({ requireAuth, requireAdmin, requirePermission }));

// Stock Receipt Expiry — mounted on both site and hub. The router
// internally gates write operations (sync, add-expiry) to site-only;
// hub gets read-only list endpoints querying hub_stock_receipt_expiry.
app.use(createStockReceiptRouter({ requireAuth, requirePermission }));

// Creditors module — vendor master + AP transactions + POs synced
// from Sage. Mounted on both modes; hub branches in the router itself
// (read-only on hub once the ETL is wired).
app.use(createCreditorRouter({ requireAuth, requireAdmin, requirePermission }));
// Debtors — AR open-item sync admin (the Aged Debtors report itself is served
// by the reporting router). Sync controls are admin-only.
app.use(createDebtorRouter({ requireAuth, requireAdmin }));

// ── Price List (Sage ICPRICP per-unit prices) ──
app.use(createPricingRouter({ requireAuth, requireAdmin, requirePermission }));
app.use(createCommissionRouter({ requireAuth, requireAdmin, requirePermission }));

// ── Depot profile (letterhead details for customer-facing documents) ──
app.use(createDepotProfileRouter({ db, requireAuth, requireAdmin }));

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
// Any /api request that no route matched is a 404 — answer with JSON and never
// let it fall through to the SPA catch-all below, which only responds for
// non-/api paths and would otherwise leave the socket hanging until the client
// times out (CRIT-3). app.use (not app.get) so unmatched POST/PUT/DELETE under
// /api also get a clean 404 instead of Express's default HTML page. Mounted
// after all /api routers, before the error handler.
app.use('/api', (req, res) => {
  res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` });
});

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
  // Express 5 (path-to-regexp v8) no longer accepts bare '*' wildcards;
  // catch-all routes must use the named-splat syntax. Serves the SPA's
  // index.html for any client-side route. /api paths are already handled by the
  // JSON 404 above and can't reach here — but guard anyway so a stray /api GET
  // is never answered with index.html and a 200.
  app.get('/{*splat}', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(process.cwd(), 'dist', 'index.html'));
  });
}

startSchedulers();
recoverAbandonedSyncs();
// Re-render any multi-page POD previews whose background job was interrupted by
// a restart (cached PDFs left in uploads/bat-pdf-cache/). Best-effort, async.
recoverPendingPreviewRenders().catch((e) => console.error('[startup] preview recovery failed:', e.message));
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, (...args) => {
  try { logError('system.shutdown', new Error(`Received ${sig} — shutting down`), { signal: sig }, 'info'); } catch {} // eslint-disable-line no-empty -- logError wrapper; shutdown continues regardless
  gracefulShutdown(...args);
}));
// Process-level safety nets — anything that escapes a callback or promise
// chain still lands in the System Log so we can correlate "X stalled" with
// "uncaught error at Y".
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err.message);
  try { logError('system.uncaught', err); } catch {} // eslint-disable-line no-empty -- logError wrapper inside process-level safety net; cannot recurse here
});
process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED]', err?.message || err);
  try { logError('system.unhandled', err instanceof Error ? err : new Error(String(err))); } catch {} // eslint-disable-line no-empty -- logError wrapper inside process-level safety net; cannot recurse here
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
    } catch {} // eslint-disable-line no-empty -- logError wrapper; boot continues regardless
  }));
  // Resume any paused BAT OCR extractions from a previous run
  resumeExtractionWorker();
}).catch((error) => {
  console.error('Failed to seed users:', error);
  try { logError('system.boot', error, { phase: 'ensureSeedUsers' }); } catch {} // eslint-disable-line no-empty -- logError wrapper; we still exit(1) below
  process.exit(1);
});
