import express from 'express';
import cors from 'cors';
import session from 'express-session';
import dotenv from 'dotenv';
import path from 'path';
import { createRequire } from 'module';
import db from './src/db/index.js';
import { initSchema } from './src/db/schema.js';
import { buildStatements } from './src/db/statements.js';
import { createAuthMiddleware } from './src/middleware/auth.js';
import { loginLimiter } from './src/middleware/rateLimit.js';
import { sanitizeUser } from './src/helpers.js';
import { createAuthRouter } from './src/routes/auth.js';
import { createRecordsRouter } from './src/routes/records.js';
import { createConnectionsRouter } from './src/routes/connections.js';
import { initHubTables, initHubSiteRegistry, syncAllSites, runHubBackupPull } from './src/services/hubEtl.js';
import { createHubRouter, createNonHubFallbackRouter } from './src/routes/hub.js';
import { createReportingRouter } from './src/routes/reporting.js';
import { createBackupRouter } from './src/routes/backup.js';
import { createSystemRouter } from './src/routes/system.js';
import { validateSessionSecret, migrateUnencryptedPasswords, recoverAbandonedSyncs, ensureSeedUsers, createGetUserById } from './src/startup.js';
import { isShuttingDown, startSchedulers, startHubSchedulers, setServer, gracefulShutdown } from './src/scheduler.js';

const require = createRequire(import.meta.url);
dotenv.config();
validateSessionSecret(process.env.SESSION_SECRET);

// ==================== FIELD REGISTRY ====================
// Defines all MSSQL→SQLite field mappings. buildFieldPatch iterates this.
const FIELD_REGISTRY = [
  { key: 'customer_number',    sources: ['customer_number', 'CustomerNumber', 'CUSTOMER_NUMBER'],                                                                       defaultMode: 'sync' },
  { key: 'customer_name',      sources: ['customer_name', 'CustomerName', 'CUSTOMER_NAME', 'name', 'Name'],                                                             defaultMode: 'sync' },
  { key: 'age_analysis',       sources: ['age_analysis', 'AgeAnalysis', 'AGE_ANALYSIS'],                                                                                defaultMode: 'sync' },
  { key: 'outstanding_balance',sources: ['outstanding_balance', 'OutstandingBalance', 'OUTSTANDING_BALANCE', 'Balance', 'BALANCE', 'AMTDUE', 'AMTDUE1', 'AMTDUE1HC', 'AMTOUTSTANDING', 'OUTSTANDING', 'OutstandingAmt', 'outstanding_amt', 'balance_due', 'BalanceDue', 'BALANCEDUE', 'TotalDue', 'TOTALDUE', 'total_due', 'AmountDue', 'AMOUNTDUE', 'amount_due'], defaultMode: 'sync' },
  { key: 'age_current',        sources: ['age_current', 'AgeCurrent', 'AGE_CURRENT', 'Current', 'CURRENT'],                                                             defaultMode: 'sync' },
  { key: 'age_7_days',         sources: ['age_7_days', 'Age7Days', 'AGE_7_DAYS', 'Age7', 'AMTDUE07'],                                                                  defaultMode: 'sync' },
  { key: 'age_14_days',        sources: ['age_14_days', 'Age14Days', 'AGE_14_DAYS', 'Age14', 'AMTDUE14'],                                                               defaultMode: 'sync' },
  { key: 'age_21_days',        sources: ['age_21_days', 'Age21Days', 'AGE_21_DAYS', 'Age21', 'AMTDUE21'],                                                               defaultMode: 'sync' },
  { key: 'terms',              sources: ['terms', 'Terms', 'TERMS', 'PaymentTerms', 'payment_terms', 'PAYMENT_TERMS'],                                                  defaultMode: 'sync' },
  { key: 'note',               sources: ['note', 'Note', 'notes', 'Notes'],                                                                                             defaultMode: 'local-only' },
];

// Invoice/receipt slot definitions — used by buildFieldPatch to produce JSON arrays
const INVOICE_SLOTS = [1, 2, 3, 4, 5].map(i => ({
  index: i,
  number_sources: i === 1
    ? [`last_unpaid_invoice_1`, 'LastUnpaidInvoice1', 'LAST_UNPAID_INVOICE_1']
    : [`last_unpaid_invoice_${i}`, `LastUnpaidInvoice${i}`, `LAST_UNPAID_INVOICE_${i}`],
  amount_sources: i === 1
    ? ['last_unpaid_invoice_1_amount', 'LastUnpaidInvoice1Amount', 'LAST_UNPAID_INVOICE_1_AMOUNT']
    : [`last_unpaid_invoice_${i}_amount`, `LastUnpaidInvoice${i}Amount`, `LAST_UNPAID_INVOICE_${i}_AMOUNT`],
  date_sources: i === 1
    ? ['last_unpaid_invoice_1_date', 'LastUnpaidInvoice1Date', 'LAST_UNPAID_INVOICE_1_DATE', 'InvoiceDate', 'INVDATE', 'LastInvoiceDate']
    : [`last_unpaid_invoice_${i}_date`, `LastUnpaidInvoice${i}Date`, `LAST_UNPAID_INVOICE_${i}_DATE`],
}));

const RECEIPT_SLOTS = [1, 2, 3, 4, 5].map(i => ({
  index: i,
  number_sources: i === 1
    ? ['last_receipt_1', 'LastReceipt1', 'LAST_RECEIPT_1', 'last_receipt_number', 'LastReceiptNumber', 'ReceiptNo', 'RECNO']
    : [`last_receipt_${i}`, `LastReceipt${i}`, `LAST_RECEIPT_${i}`],
  amount_sources: i === 1
    ? ['last_receipt_1_amount', 'LastReceipt1Amount', 'LAST_RECEIPT_1_AMOUNT', 'last_receipt_amount', 'LastReceiptAmount', 'ReceiptAmount', 'RECAMT']
    : [`last_receipt_${i}_amount`, `LastReceipt${i}Amount`, `LAST_RECEIPT_${i}_AMOUNT`],
  date_sources: i === 1
    ? ['last_receipt_1_date', 'LastReceipt1Date', 'LAST_RECEIPT_1_DATE', 'last_receipt_date', 'LastReceiptDate', 'ReceiptDate', 'RECDATE']
    : [`last_receipt_${i}_date`, `LastReceipt${i}Date`, `LAST_RECEIPT_${i}_DATE`],
}));

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
migrateUnencryptedPasswords();
const stmts = buildStatements(db);
const getUserById = createGetUserById(stmts);
const { requireAuth, requireAdmin, requirePermission, requireSelfOrAdmin, checkTableAccess } = createAuthMiddleware({ getUserById, sanitizeUser });

app.use(createAuthRouter({ db, stmts, getUserById, requireAuth, requireAdmin, requireSelfOrAdmin, loginLimiter }));
app.use(createSystemRouter({ requireAuth, requireAdmin }));
app.use(createBackupRouter());
app.use(createReportingRouter({ requireAuth }));
app.use(createConnectionsRouter({ db, requireAuth, requirePermission, isShuttingDown }));

if (process.env.HUB_MODE === 'true') {
  initHubTables();
  initHubSiteRegistry();
  app.use(createHubRouter({ requireAuth, requireAdmin }));
  startHubSchedulers(syncAllSites, runHubBackupPull);
} else {
  app.use(createNonHubFallbackRouter());
}

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
