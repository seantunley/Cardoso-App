import express from 'express';
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
import { validateSessionSecret, validateEncryptionKey, migrateUnencryptedPasswords, recoverAbandonedSyncs, ensureSeedUsers, createGetUserById } from './src/startup.js';
import { isShuttingDown, startSchedulers, startHubSchedulers, setServer, gracefulShutdown } from './src/scheduler.js';

const require = createRequire(import.meta.url);
dotenv.config();
validateSessionSecret(process.env.SESSION_SECRET);

const app = express();
const PORT = process.env.PORT || 3001;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
if (IS_PRODUCTION) {
  app.use(express.static(path.join(process.cwd(), 'dist')));
  app.use(cors({ origin: false, credentials: true }));
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

if (IS_PRODUCTION) {
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) res.sendFile(path.join(process.cwd(), 'dist', 'index.html'));
  });
}

startSchedulers();
recoverAbandonedSyncs();
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, gracefulShutdown));
ensureSeedUsers().then(() => {
  setServer(app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Local backend + SQLite running at http://0.0.0.0:${PORT}`)));
}).catch((error) => { console.error('Failed to seed users:', error); process.exit(1); });
