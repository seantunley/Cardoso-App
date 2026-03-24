import express from 'express';
import cors from 'cors';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import cron from 'node-cron';
import Database from 'better-sqlite3';
import sql from 'mssql';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import rateLimit from 'express-rate-limit';

const require = createRequire(import.meta.url);

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
  const distPath = path.join(__dirname, 'dist');
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
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 1000 * 60 * 60 * 12,
    },
  })
);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per IP per window
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const dbPath = process.env.DB_PATH || './database/cardoso.db';
// Ensure database directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

console.log(`✅ SQLite database ready → ${dbPath}`);

const activeSyncs = new Set();
let scheduledSyncInProgress = false;
let shuttingDown = false;
let server;

function acquireSyncLock(connectionId) {
  const key = String(connectionId);
  if (activeSyncs.has(key)) return false;
  activeSyncs.add(key);
  return true;
}

function releaseSyncLock(connectionId) {
  activeSyncs.delete(String(connectionId));
}

const allowedTables = new Set([
  'datarecord',
  'databaseconnection',
  'autoflagrule',
  'customfieldconfig',
  'auditlog',
  'user',
  'syncrun',
]);

function isValidTableName(table) {
  return allowedTables.has(table);
}

// ==================== CORE TABLES ====================
db.exec(`
  CREATE TABLE IF NOT EXISTS datarecord (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_date TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_date TEXT DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT,
    customer_number TEXT,
    customer_name TEXT,
    age_analysis TEXT,
    age_current TEXT,
    age_7_days TEXT,
    age_14_days TEXT,
    age_21_days TEXT,
    source_id TEXT,
    source_table TEXT,
    data TEXT,
    custom_field_1 TEXT,
    custom_field_2 TEXT,
    custom_field_3 TEXT,
    local_fields TEXT DEFAULT '{}',
    last_unpaid_invoice_1 TEXT,
    last_unpaid_invoice_1_amount TEXT,
    last_unpaid_invoice_2 TEXT,
    last_unpaid_invoice_2_amount TEXT,
    last_unpaid_invoice_3 TEXT,
    last_unpaid_invoice_3_amount TEXT,
    flag_color TEXT CHECK(flag_color IN ('none', 'red', 'green', 'orange')) DEFAULT 'none',
    flag_reason TEXT,
    flag_created_by TEXT,
    note TEXT,
    synced_at TEXT,
    last_checked TEXT,
    auto_flagged INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS databaseconnection (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    database_name TEXT NOT NULL,
    username TEXT NOT NULL,
    encrypted_password TEXT,
    table_configs TEXT,
    join_configuration TEXT,
    field_mappings TEXT,
    status TEXT CHECK(status IN ('active', 'inactive', 'error', 'testing')) DEFAULT 'inactive',
    last_sync TEXT,
    last_error TEXT,
    record_count INTEGER DEFAULT 0,
    created_by TEXT,
    created_date TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_date TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS autoflagrule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_name TEXT NOT NULL,
    conditions TEXT,
    logic TEXT CHECK(logic IN ('AND', 'OR')),
    flag_color TEXT CHECK(flag_color IN ('red', 'green', 'orange')) NOT NULL,
    is_active INTEGER DEFAULT 1,
    priority INTEGER,
    created_by TEXT,
    created_date TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_date TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS auditlog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_type TEXT NOT NULL,
    user_email TEXT NOT NULL,
    user_name TEXT,
    resource_type TEXT CHECK(resource_type IN ('user', 'connection', 'record', 'rule', 'system')),
    resource_id TEXT,
    resource_name TEXT,
    action_details TEXT,
    changes TEXT,
    ip_address TEXT,
    status TEXT CHECK(status IN ('success', 'failure')) NOT NULL,
    created_date TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS "user" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    full_name TEXT,
    created_date TEXT DEFAULT CURRENT_TIMESTAMP,
    role TEXT CHECK(role IN ('admin', 'user')) DEFAULT 'user',
    theme_preference TEXT CHECK(theme_preference IN ('light', 'dark')) DEFAULT 'light'
  );

  CREATE TABLE IF NOT EXISTS syncrun (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT CHECK(status IN ('running', 'completed', 'failed', 'abandoned')) NOT NULL,
    message TEXT
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_datarecord_source_lookup
  ON datarecord (source_table, source_id);

  CREATE INDEX IF NOT EXISTS idx_databaseconnection_status
  ON databaseconnection (status);
`);

// ==================== FLEXIBLE CUSTOM FIELD CONFIG TABLE ====================
function ensureFlexibleCustomFieldConfigTable() {
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='customfieldconfig'`)
    .get();

  if (!exists) {
    db.exec(`
      CREATE TABLE customfieldconfig (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        field_key TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        field_type TEXT CHECK(field_type IN ('text', 'select', 'number', 'date')) NOT NULL,
        options TEXT,
        is_active INTEGER DEFAULT 1,
        created_by TEXT,
        created_date TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_date TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    return;
  }

  const createSqlRow = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='customfieldconfig'`)
    .get();

  const createSql = createSqlRow?.sql || '';
  const hasOldCheckConstraint = createSql.includes("field_key IN ('custom_field_1', 'custom_field_2', 'custom_field_3')");

  if (!hasOldCheckConstraint) return;

  db.exec(`
    ALTER TABLE customfieldconfig RENAME TO customfieldconfig_old;

    CREATE TABLE customfieldconfig (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field_key TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      field_type TEXT CHECK(field_type IN ('text', 'select', 'number', 'date')) NOT NULL,
      options TEXT,
      is_active INTEGER DEFAULT 1,
      created_by TEXT,
      created_date TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_date TEXT DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO customfieldconfig (
      id, field_key, label, field_type, options, is_active, created_by, created_date, updated_date
    )
    SELECT
      id, field_key, label, field_type, options, is_active, created_by, created_date, updated_date
    FROM customfieldconfig_old;

    DROP TABLE customfieldconfig_old;
  `);
}

ensureFlexibleCustomFieldConfigTable();

// ==================== MIGRATIONS ====================
function ensureColumn(tableName, columnName, definition) {
  const cols = db.prepare(`PRAGMA table_info("${tableName}")`).all();
  const exists = cols.some((c) => c.name === columnName);
  if (!exists) {
    db.exec(`ALTER TABLE "${tableName}" ADD COLUMN ${columnName} ${definition}`);
  }
}

ensureColumn('datarecord', 'local_fields', `TEXT DEFAULT '{}'`);
ensureColumn('databaseconnection', 'last_error', 'TEXT');
ensureColumn('datarecord', 'age_current', 'TEXT');
ensureColumn('datarecord', 'age_7_days', 'TEXT');
ensureColumn('datarecord', 'age_14_days', 'TEXT');
ensureColumn('datarecord', 'age_21_days', 'TEXT');
ensureColumn('datarecord', 'outstanding_balance', 'TEXT');
ensureColumn('datarecord', 'last_unpaid_invoice_date', 'TEXT');
ensureColumn('datarecord', 'last_receipt_number', 'TEXT');
ensureColumn('datarecord', 'last_receipt_amount', 'TEXT');
ensureColumn('datarecord', 'last_receipt_date', 'TEXT');
// Query-mode columns
ensureColumn('databaseconnection', 'sync_query', 'TEXT');
ensureColumn('databaseconnection', 'query_index_field', 'TEXT');
ensureColumn('databaseconnection', 'query_field_mappings', 'TEXT');

// Migrate field_mappings from legacy flat format to per-table format
// Legacy: { localKey: { sourceField, ... } }
// New:    { tableName: { localKey: { sourceField, ... } } }
(function migrateFieldMappingsToPerTable() {
  const connections = db.prepare('SELECT id, table_configs, field_mappings FROM databaseconnection').all();
  for (const conn of connections) {
    try {
      const raw = JSON.parse(conn.field_mappings || '{}');
      const isFlat = Object.keys(raw).length > 0 &&
        Object.values(raw).some((v) => v && typeof v === 'object' && v.sourceField);
      if (!isFlat) continue; // already per-table or empty

      const tableConfigs = JSON.parse(conn.table_configs || '[]');
      if (!tableConfigs.length) continue;

      const migrated = {};
      for (const t of tableConfigs) {
        migrated[t.table_name] = raw;
      }

      db.prepare('UPDATE databaseconnection SET field_mappings = ? WHERE id = ?')
        .run(JSON.stringify(migrated), conn.id);

      console.log(`[migration] Migrated field_mappings to per-table format for connection ${conn.id}`);
    } catch (e) {
      console.error(`[migration] Failed to migrate field_mappings for connection ${conn.id}:`, e.message);
    }
  }
})();

ensureColumn('user', 'password_hash', 'TEXT');
ensureColumn('user', 'is_active', 'INTEGER DEFAULT 1');
ensureColumn('user', 'can_access_customer_search', 'INTEGER DEFAULT 1');
ensureColumn('user', 'can_access_records', 'INTEGER DEFAULT 0');
ensureColumn('user', 'can_access_reports', 'INTEGER DEFAULT 0');
ensureColumn('user', 'can_access_connections', 'INTEGER DEFAULT 0');
ensureColumn('user', 'can_access_settings', 'INTEGER DEFAULT 0');
ensureColumn('user', 'can_manage_users', 'INTEGER DEFAULT 0');
ensureColumn('user', 'can_manage_rules', 'INTEGER DEFAULT 0');
ensureColumn('user', 'can_edit_records', 'INTEGER DEFAULT 1');
ensureColumn('user', 'can_flag_records', 'INTEGER DEFAULT 1');

// ==================== HELPERS ====================
const sanitizeForSqlite = (data) => {
  const sanitized = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value === undefined) continue;
    sanitized[key] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  }
  return sanitized;
};

function parseJsonSafely(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stringifyJsonSafely(value, fallback = '{}') {
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

// Spread local_fields JSON into the top-level record object so clients can
// access dynamic custom fields as record[field_key] instead of parsing JSON.
function expandDataRecord(row) {
  if (!row || typeof row !== 'object') return row;
  const localFields = parseJsonSafely(row.local_fields, {});
  return { ...row, ...localFields };
}

function normalizeFieldKey(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_ ]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function validateCustomFieldKey(key) {
  return /^[a-z][a-z0-9_]*$/.test(key);
}

function getMappingForKey(fieldMappings, localKey) {
  const mapping = fieldMappings?.[localKey];
  if (!mapping) return null;

  return {
    sourceField: mapping.sourceField || null,
    mode: mapping.mode || 'sync',
    label: mapping.label || localKey,
    type: mapping.type || 'text',
    isCustom: !!mapping.isCustom,
  };
}

function getRowValue(row, fieldName) {
  if (!fieldName) return undefined;
  return row[fieldName];
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function getMappedOrFallbackValue(row, fieldMappings, localKey, fallbacks = []) {
  const mapping = getMappingForKey(fieldMappings, localKey);
  const mappedValue = getRowValue(row, mapping?.sourceField);

  if (mappedValue !== undefined && mappedValue !== null && mappedValue !== '') {
    return mappedValue;
  }

  for (const key of fallbacks) {
    const fallbackValue = getRowValue(row, key);
    if (fallbackValue !== undefined && fallbackValue !== null && fallbackValue !== '') {
      return fallbackValue;
    }
  }

  return '';
}

function shouldApplyMappedValue(mode, existingValue, incomingValue) {
  if (mode === 'local-only') return false;
  if (incomingValue === undefined || incomingValue === null) return false;

  if (mode === 'sync') return true;

  if (mode === 'sync-if-empty') {
    return existingValue === undefined || existingValue === null || String(existingValue).trim() === '';
  }

  return true;
}

function buildFieldPatch(existingRecord, row, fieldMappings, indexField) {
  const patch = {};

  const mappingConfig = {
    customer_number: {
      fallbacks: ['customer_number', 'CustomerNumber', 'CUSTOMER_NUMBER', indexField, 'id'],
      defaultMode: 'sync',
    },
    customer_name: {
      fallbacks: ['customer_name', 'CustomerName', 'CUSTOMER_NAME', 'name', 'Name'],
      defaultMode: 'sync',
    },
    age_analysis: {
      fallbacks: ['age_analysis', 'AgeAnalysis', 'AGE_ANALYSIS'],
      defaultMode: 'sync',
    },
    outstanding_balance: {
      fallbacks: ['outstanding_balance', 'OutstandingBalance', 'OUTSTANDING_BALANCE', 'Balance', 'BALANCE',
        'AMTDUE', 'AMTDUE1', 'AMTDUE1HC', 'AMTOUTSTANDING', 'OUTSTANDING', 'OutstandingAmt',
        'outstanding_amt', 'balance_due', 'BalanceDue', 'BALANCEDUE', 'TotalDue', 'TOTALDUE',
        'total_due', 'AmountDue', 'AMOUNTDUE', 'amount_due'],
      defaultMode: 'sync',
    },
    age_current: {
      fallbacks: ['age_current', 'AgeCurrent', 'AGE_CURRENT', 'Current', 'CURRENT'],
      defaultMode: 'sync',
    },
    age_7_days: {
      fallbacks: ['age_7_days', 'Age7Days', 'AGE_7_DAYS', 'Age7', 'AMTDUE07'],
      defaultMode: 'sync',
    },
    age_14_days: {
      fallbacks: ['age_14_days', 'Age14Days', 'AGE_14_DAYS', 'Age14', 'AMTDUE14'],
      defaultMode: 'sync',
    },
    age_21_days: {
      fallbacks: ['age_21_days', 'Age21Days', 'AGE_21_DAYS', 'Age21', 'AMTDUE21'],
      defaultMode: 'sync',
    },
    last_unpaid_invoice_1: {
      fallbacks: ['last_unpaid_invoice_1', 'LastUnpaidInvoice1', 'LAST_UNPAID_INVOICE_1'],
      defaultMode: 'sync',
    },
    last_unpaid_invoice_1_amount: {
      fallbacks: ['last_unpaid_invoice_1_amount', 'LastUnpaidInvoice1Amount', 'LAST_UNPAID_INVOICE_1_AMOUNT'],
      defaultMode: 'sync',
    },
    last_unpaid_invoice_2: {
      fallbacks: ['last_unpaid_invoice_2', 'LastUnpaidInvoice2', 'LAST_UNPAID_INVOICE_2'],
      defaultMode: 'sync',
    },
    last_unpaid_invoice_2_amount: {
      fallbacks: ['last_unpaid_invoice_2_amount', 'LastUnpaidInvoice2Amount', 'LAST_UNPAID_INVOICE_2_AMOUNT'],
      defaultMode: 'sync',
    },
    last_unpaid_invoice_3: {
      fallbacks: ['last_unpaid_invoice_3', 'LastUnpaidInvoice3', 'LAST_UNPAID_INVOICE_3'],
      defaultMode: 'sync',
    },
    last_unpaid_invoice_3_amount: {
      fallbacks: ['last_unpaid_invoice_3_amount', 'LastUnpaidInvoice3Amount', 'LAST_UNPAID_INVOICE_3_AMOUNT'],
      defaultMode: 'sync',
    },
    last_unpaid_invoice_date: {
      fallbacks: ['last_unpaid_invoice_date', 'LastUnpaidInvoiceDate', 'LAST_UNPAID_INVOICE_DATE', 'InvoiceDate', 'INVDATE', 'LastInvoiceDate'],
      defaultMode: 'sync',
    },
    last_receipt_number: {
      fallbacks: ['last_receipt_number', 'LastReceiptNumber', 'LAST_RECEIPT_NUMBER', 'ReceiptNo', 'RECNO', 'LastReceiptNo'],
      defaultMode: 'sync',
    },
    last_receipt_amount: {
      fallbacks: ['last_receipt_amount', 'LastReceiptAmount', 'LAST_RECEIPT_AMOUNT', 'ReceiptAmount', 'RECAMT', 'LastReceiptAmt'],
      defaultMode: 'sync',
    },
    last_receipt_date: {
      fallbacks: ['last_receipt_date', 'LastReceiptDate', 'LastReceiptIssuedDate', 'LAST_RECEIPT_DATE', 'ReceiptDate', 'RECDATE'],
      defaultMode: 'sync',
    },
    note: {
      fallbacks: ['note', 'Note', 'notes', 'Notes'],
      defaultMode: 'local-only',
    },
    custom_field_1: {
      fallbacks: [],
      defaultMode: 'sync-if-empty',
    },
    custom_field_2: {
      fallbacks: [],
      defaultMode: 'sync-if-empty',
    },
    custom_field_3: {
      fallbacks: [],
      defaultMode: 'sync-if-empty',
    },
  };

  for (const [localKey, config] of Object.entries(mappingConfig)) {
    const mapping = getMappingForKey(fieldMappings, localKey);
    const mode = mapping?.mode || config.defaultMode;
    const incomingValue = getMappedOrFallbackValue(row, fieldMappings, localKey, config.fallbacks);
    const existingValue = existingRecord?.[localKey];

    if (shouldApplyMappedValue(mode, existingValue, incomingValue)) {
      patch[localKey] = String(incomingValue ?? '');
    } else if (!existingRecord && incomingValue !== undefined && incomingValue !== null && incomingValue !== '') {
      patch[localKey] = String(incomingValue);
    }
  }

  return patch;
}

function buildDynamicLocalFieldsPatch(existingRecord, row, fieldMappings) {
  const existingLocalFields = parseJsonSafely(existingRecord?.local_fields, {});
  const nextLocalFields = { ...existingLocalFields };

  for (const [localKey, mapping] of Object.entries(fieldMappings || {})) {
    if (!mapping?.isCustom) continue;

    const mode = mapping.mode || 'sync';
    const incomingValue = getRowValue(row, mapping.sourceField);
    const existingValue = existingLocalFields[localKey];

    if (!shouldApplyMappedValue(mode, existingValue, incomingValue)) {
      continue;
    }

    if (incomingValue === undefined || incomingValue === null || incomingValue === '') {
      if (mode === 'sync') {
        nextLocalFields[localKey] = '';
      }
      continue;
    }

    nextLocalFields[localKey] = String(incomingValue);
  }

  return nextLocalFields;
}

function boolFromRow(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  return !!value;
}

function defaultPermissionsForRole(role) {
  if (role === 'admin') {
    return {
      can_access_customer_search: true,
      can_access_records: true,
      can_access_reports: true,
      can_access_connections: true,
      can_access_settings: true,
      can_manage_users: true,
      can_manage_rules: true,
      can_edit_records: true,
      can_flag_records: true,
    };
  }

  return {
    can_access_customer_search: true,
    can_access_records: false,
    can_access_reports: false,
    can_access_connections: false,
    can_access_settings: false,
    can_manage_users: false,
    can_manage_rules: false,
    can_edit_records: true,
    can_flag_records: true,
  };
}

function sanitizeUser(user) {
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    full_name: user.full_name,
    role: user.role,
    theme_preference: user.theme_preference,
    is_active: boolFromRow(user.is_active, true),
    can_access_customer_search: boolFromRow(user.can_access_customer_search, true),
    can_access_records: boolFromRow(user.can_access_records, false),
    can_access_reports: boolFromRow(user.can_access_reports, false),
    can_access_connections: boolFromRow(user.can_access_connections, false),
    can_access_settings: boolFromRow(user.can_access_settings, false),
    can_manage_users: boolFromRow(user.can_manage_users, false),
    can_manage_rules: boolFromRow(user.can_manage_rules, false),
    can_edit_records: boolFromRow(user.can_edit_records, true),
    can_flag_records: boolFromRow(user.can_flag_records, true),
    created_date: user.created_date,
  };
}

function sanitizeConnection(conn) {
  if (!conn) return null;
  const { encrypted_password, ...safe } = conn;
  return safe;
}

function getUserById(id) {
  return db.prepare(`SELECT * FROM "user" WHERE id = ?`).get(id);
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

function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const user = getUserById(req.session.userId);
  if (!user || !user.is_active) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'Session expired' });
  }

  req.currentUser = sanitizeUser(user);
  next();
}

function requireAdmin(req, res, next) {
  if (!req.currentUser || req.currentUser.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requirePermission(permissionKey) {
  return (req, res, next) => {
    if (!req.currentUser) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (req.currentUser.role === 'admin') {
      return next();
    }

    // Deny access if no permission key was specified (fail-closed)
    if (!permissionKey) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    if (!req.currentUser[permissionKey]) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    next();
  };
}

function requireSelfOrAdmin(req, res, next) {
  const targetId = parseInt(req.params.id, 10);
  if (req.currentUser?.role === 'admin' || req.currentUser?.id === targetId) {
    return next();
  }
  return res.status(403).json({ error: 'Permission denied' });
}

function checkTableAccess(req, table, method) {
  const user = req.currentUser;
  if (!user) return { ok: false, status: 401, error: 'Not authenticated' };

  if (user.role === 'admin') return { ok: true };

  const readOnly = method === 'GET';

  switch (table) {
    case 'datarecord':
      // can_access_customer_search grants read access (used by CustomerSearch page)
      // can_access_records grants full read + edit access (Records management page)
      if (!user.can_access_records && !user.can_access_customer_search) {
        return { ok: false, status: 403, error: 'No access to records' };
      }
      if (!readOnly && !user.can_edit_records) {
        return { ok: false, status: 403, error: 'No permission to edit records' };
      }
      return { ok: true };

    case 'databaseconnection':
      // All authenticated users can read connections (sync status is global)
      // Only users with can_access_connections can create/edit/delete
      if (!readOnly && !user.can_access_connections) {
        return { ok: false, status: 403, error: 'No permission to modify connections' };
      }
      return { ok: true };

    case 'autoflagrule':
    case 'customfieldconfig':
      if (!user.can_access_settings && !user.can_manage_rules) {
        return { ok: false, status: 403, error: 'No access to settings' };
      }
      return { ok: true };

    case 'auditlog':
    case 'user':
    case 'syncrun':
      return { ok: false, status: 403, error: 'Restricted table' };

    default:
      return { ok: true };
  }
}

async function runConnectionImport(connectionId) {
  let pool;
  let syncRunId = null;

  if (shuttingDown) {
    return {
      success: false,
      skipped: true,
      message: 'Server is shutting down',
    };
  }

  if (!acquireSyncLock(connectionId)) {
    return {
      success: false,
      skipped: true,
      message: `Import already running for connection ${connectionId}`,
    };
  }

  try {
    const connConfig = db.prepare(`SELECT * FROM databaseconnection WHERE id = ?`).get(connectionId);

    if (!connConfig) {
      throw new Error('Connection not found');
    }

    syncRunId = db.prepare(`
      INSERT INTO syncrun (connection_id, started_at, status)
      VALUES (?, ?, 'running')
    `).run(connectionId, new Date().toISOString()).lastInsertRowid;

    const sqlConfig = {
      user: connConfig.username,
      password: connConfig.encrypted_password,
      server: connConfig.host,
      database: connConfig.database_name,
      port: parseInt(connConfig.port, 10),
      options: {
        encrypt: false,
        trustServerCertificate: true,
      },
      requestTimeout: 30000,
      connectionTimeout: 15000,
    };

    pool = await sql.connect(sqlConfig);

    // ── Query mode (new) vs legacy table-config mode ──────────────────────────
    const syncQuery = connConfig.sync_query ? connConfig.sync_query.trim() : null;
    const queryIndexField = connConfig.query_index_field ? connConfig.query_index_field.trim() : null;
    const queryFieldMappings = parseJsonSafely(connConfig.query_field_mappings, {});

    // Legacy fallback
    const tableConfigs = parseJsonSafely(connConfig.table_configs, []);
    const allFieldMappings = parseJsonSafely(connConfig.field_mappings, {});
    const isPerTableMappings = Object.keys(allFieldMappings).length > 0 &&
      Object.values(allFieldMappings).every(
        (v) => v && typeof v === 'object' && !v.sourceField
      );

    let importedCount = 0;

    const updateExistingRecord = db.prepare(`
      UPDATE datarecord
      SET
        created_by = ?,
        customer_number = ?,
        customer_name = ?,
        age_analysis = ?,
        age_current = ?,
        age_7_days = ?,
        age_14_days = ?,
        age_21_days = ?,
        outstanding_balance = ?,
        source_id = ?,
        source_table = ?,
        data = ?,
        custom_field_1 = ?,
        custom_field_2 = ?,
        custom_field_3 = ?,
        local_fields = ?,
        last_unpaid_invoice_1 = ?,
        last_unpaid_invoice_1_amount = ?,
        last_unpaid_invoice_2 = ?,
        last_unpaid_invoice_2_amount = ?,
        last_unpaid_invoice_3 = ?,
        last_unpaid_invoice_3_amount = ?,
        last_unpaid_invoice_date = ?,
        last_receipt_number = ?,
        last_receipt_amount = ?,
        last_receipt_date = ?,
        flag_color = ?,
        flag_reason = ?,
        flag_created_by = ?,
        note = ?,
        synced_at = ?,
        updated_date = ?
      WHERE id = ?
    `);

    const insertNewRecord = db.prepare(`
      INSERT INTO datarecord (
        created_by,
        customer_number,
        customer_name,
        age_analysis,
        age_current,
        age_7_days,
        age_14_days,
        age_21_days,
        outstanding_balance,
        source_id,
        source_table,
        data,
        custom_field_1,
        custom_field_2,
        custom_field_3,
        local_fields,
        last_unpaid_invoice_1,
        last_unpaid_invoice_1_amount,
        last_unpaid_invoice_2,
        last_unpaid_invoice_2_amount,
        last_unpaid_invoice_3,
        last_unpaid_invoice_3_amount,
        last_unpaid_invoice_date,
        last_receipt_number,
        last_receipt_amount,
        last_receipt_date,
        note,
        synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // Shared write-rows helper used by both query mode and legacy table mode
    const runWriteRows = (rows, sourceName, mappings, indexField) => {
      const existingRows = db.prepare(`
        SELECT id, source_id, source_table, customer_number, customer_name,
               age_analysis, age_current, age_7_days, age_14_days, age_21_days,
               note, custom_field_1, custom_field_2, custom_field_3,
               local_fields, flag_color, flag_reason, flag_created_by, data,
               last_unpaid_invoice_1, last_unpaid_invoice_1_amount,
               last_unpaid_invoice_2, last_unpaid_invoice_2_amount,
               last_unpaid_invoice_3, last_unpaid_invoice_3_amount,
               last_unpaid_invoice_date, outstanding_balance,
               last_receipt_number, last_receipt_amount, last_receipt_date
        FROM datarecord
        WHERE source_table = ?
      `).all(sourceName);

      const existingMap = new Map(
        existingRows.map((r) => [`${r.source_table}::${r.source_id}`, r])
      );

      const syncTimestamp = new Date().toISOString();

      const writeRowsTransaction = db.transaction((rowsToWrite) => {
        for (const row of rowsToWrite) {
          const sourceId = String(
            firstDefined(
              getMappedOrFallbackValue(row, mappings, 'customer_number', [indexField, 'id']),
              row[indexField],
              row.id,
              ''
            )
          );

          const existing = existingMap.get(`${sourceName}::${String(sourceId || '')}`);
          const mappedPatch = buildFieldPatch(existing, row, mappings, indexField);
          const dynamicLocalFieldsPatch = buildDynamicLocalFieldsPatch(existing, row, mappings);
          const dataJson = JSON.stringify(row);

          const existingLocalFields = parseJsonSafely(existing?.local_fields, {});
          const mergedLocalFields = { ...existingLocalFields, ...dynamicLocalFieldsPatch };

          const baseRecordData = sanitizeForSqlite({
            source_id: String(sourceId || ''),
            source_table: sourceName,
            data: dataJson,
            synced_at: syncTimestamp,
            created_by: 'import',
            local_fields: stringifyJsonSafely(mergedLocalFields),
            ...mappedPatch,
          });

          if (existing) {
            updateExistingRecord.run(
              baseRecordData.created_by,
              String(baseRecordData.customer_number ?? existing.customer_number ?? ''),
              String(baseRecordData.customer_name ?? existing.customer_name ?? ''),
              String(baseRecordData.age_analysis ?? existing.age_analysis ?? ''),
              String(baseRecordData.age_current ?? existing.age_current ?? ''),
              String(baseRecordData.age_7_days ?? existing.age_7_days ?? ''),
              String(baseRecordData.age_14_days ?? existing.age_14_days ?? ''),
              String(baseRecordData.age_21_days ?? existing.age_21_days ?? ''),
              String(baseRecordData.outstanding_balance ?? existing.outstanding_balance ?? ''),
              baseRecordData.source_id,
              baseRecordData.source_table,
              baseRecordData.data,
              String(baseRecordData.custom_field_1 ?? existing.custom_field_1 ?? ''),
              String(baseRecordData.custom_field_2 ?? existing.custom_field_2 ?? ''),
              String(baseRecordData.custom_field_3 ?? existing.custom_field_3 ?? ''),
              String(baseRecordData.local_fields ?? stringifyJsonSafely(existingLocalFields)),
              String(baseRecordData.last_unpaid_invoice_1 ?? existing.last_unpaid_invoice_1 ?? ''),
              String(baseRecordData.last_unpaid_invoice_1_amount ?? existing.last_unpaid_invoice_1_amount ?? ''),
              String(baseRecordData.last_unpaid_invoice_2 ?? existing.last_unpaid_invoice_2 ?? ''),
              String(baseRecordData.last_unpaid_invoice_2_amount ?? existing.last_unpaid_invoice_2_amount ?? ''),
              String(baseRecordData.last_unpaid_invoice_3 ?? existing.last_unpaid_invoice_3 ?? ''),
              String(baseRecordData.last_unpaid_invoice_3_amount ?? existing.last_unpaid_invoice_3_amount ?? ''),
              String(baseRecordData.last_unpaid_invoice_date ?? existing.last_unpaid_invoice_date ?? ''),
              String(baseRecordData.last_receipt_number ?? existing.last_receipt_number ?? ''),
              String(baseRecordData.last_receipt_amount ?? existing.last_receipt_amount ?? ''),
              String(baseRecordData.last_receipt_date ?? existing.last_receipt_date ?? ''),
              existing.flag_color,
              existing.flag_reason,
              existing.flag_created_by,
              String(baseRecordData.note ?? existing.note ?? ''),
              baseRecordData.synced_at,
              syncTimestamp,
              existing.id
            );
          } else {
            insertNewRecord.run(
              baseRecordData.created_by,
              String(baseRecordData.customer_number ?? ''),
              String(baseRecordData.customer_name ?? ''),
              String(baseRecordData.age_analysis ?? ''),
              String(baseRecordData.age_current ?? ''),
              String(baseRecordData.age_7_days ?? ''),
              String(baseRecordData.age_14_days ?? ''),
              String(baseRecordData.age_21_days ?? ''),
              String(baseRecordData.outstanding_balance ?? ''),
              baseRecordData.source_id,
              baseRecordData.source_table,
              baseRecordData.data,
              String(baseRecordData.custom_field_1 ?? ''),
              String(baseRecordData.custom_field_2 ?? ''),
              String(baseRecordData.custom_field_3 ?? ''),
              String(baseRecordData.local_fields ?? '{}'),
              String(baseRecordData.last_unpaid_invoice_1 ?? ''),
              String(baseRecordData.last_unpaid_invoice_1_amount ?? ''),
              String(baseRecordData.last_unpaid_invoice_2 ?? ''),
              String(baseRecordData.last_unpaid_invoice_2_amount ?? ''),
              String(baseRecordData.last_unpaid_invoice_3 ?? ''),
              String(baseRecordData.last_unpaid_invoice_3_amount ?? ''),
              String(baseRecordData.last_unpaid_invoice_date ?? ''),
              String(baseRecordData.last_receipt_number ?? ''),
              String(baseRecordData.last_receipt_amount ?? ''),
              String(baseRecordData.last_receipt_date ?? ''),
              String(baseRecordData.note ?? ''),
              baseRecordData.synced_at
            );
          }
        }
      });

      writeRowsTransaction(rows);
    };

    if (syncQuery) {
      // ── QUERY MODE ─────────────────────────────────────────────────────────
      const syncQueryStripped = syncQuery
        .replace(/--[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim()
        .toUpperCase();
      if (!syncQueryStripped.startsWith('SELECT') && !syncQueryStripped.startsWith('WITH')) {
        throw new Error('sync_query must be a SELECT or CTE (WITH ...) statement');
      }
      if (!queryIndexField) {
        throw new Error('query_index_field is required for query mode');
      }

      const result = await pool.request().query(syncQuery);
      const rows = result.recordset || [];

      // Use the connection name as the logical source_table so existing records
      // are keyed to this connection rather than a physical table name
      const sourceName = `query::${connConfig.id}`;

      runWriteRows(rows, sourceName, queryFieldMappings, queryIndexField);
      importedCount = rows.length;
    } else {
      // ── LEGACY TABLE MODE (backward compat) ────────────────────────────────
      const SAFE_IDENTIFIER = /^[a-zA-Z0-9_ ]+$/;

      for (const config of tableConfigs) {
        const { table_name, selected_fields = [], index_field } = config;
        if (!table_name) continue;

        if (!SAFE_IDENTIFIER.test(table_name)) {
          throw new Error(`Invalid table name: ${table_name}`);
        }

        const fieldMappings = isPerTableMappings
          ? (allFieldMappings[table_name] || {})
          : allFieldMappings;

        let fields = '*';
        if (Array.isArray(selected_fields) && selected_fields.length > 0) {
          const mappedSourceFields = Object.values(fieldMappings)
            .map((m) => m?.sourceField)
            .filter(Boolean);
          const uniqueFields = [...new Set([
            ...selected_fields,
            ...(index_field ? [index_field] : []),
            ...mappedSourceFields,
          ])];
          for (const field of uniqueFields) {
            if (!SAFE_IDENTIFIER.test(field)) {
              throw new Error(`Invalid field name: ${field}`);
            }
          }
          fields = uniqueFields.map((field) => `[${field}]`).join(', ');
        }

        const query = `SELECT ${fields} FROM [${table_name}]`;
        const result = await pool.request().query(query);
        const rows = result.recordset || [];

        runWriteRows(rows, table_name, fieldMappings, index_field);
        importedCount += rows.length;
      }
    }

    db.prepare(`
      UPDATE databaseconnection
      SET record_count = ?, last_sync = ?, last_error = NULL, updated_date = ?, status = 'active'
      WHERE id = ?
    `).run(importedCount, new Date().toISOString(), new Date().toISOString(), connectionId);

    if (syncRunId) {
      db.prepare(`
        UPDATE syncrun
        SET completed_at = ?, status = 'completed', message = ?
        WHERE id = ?
      `).run(
        new Date().toISOString(),
        `Imported ${importedCount} records`,
        syncRunId
      );
    }

    return {
      success: true,
      message: `Import completed - ${importedCount} records added`,
      imported: importedCount,
    };
  } catch (error) {
    try {
      db.prepare(`
        UPDATE databaseconnection
        SET status = 'error', last_error = ?, updated_date = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(error.message || 'Unknown error', connectionId);
    } catch {}

    try {
      if (syncRunId) {
        db.prepare(`
          UPDATE syncrun
          SET completed_at = ?, status = 'failed', message = ?
          WHERE id = ?
        `).run(
          new Date().toISOString(),
          error.message || 'Import failed',
          syncRunId
        );
      }
    } catch {}

    throw error;
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch {}
    }

    releaseSyncLock(connectionId);
  }
}

// ==================== AUTH ROUTES ====================
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const user = db.prepare(`SELECT * FROM "user" WHERE lower(email) = lower(?)`).get(email);

    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'User is inactive' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    req.session.userId = user.id;

    res.json({
      success: true,
      user: sanitizeUser(user),
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json(req.currentUser);
});

app.put('/api/auth/me', requireAuth, async (req, res) => {
  const { theme_preference } = req.body || {};
  const allowedThemes = ['light', 'dark'];

  if (theme_preference !== undefined && !allowedThemes.includes(theme_preference)) {
    return res.status(400).json({ error: 'Invalid theme preference' });
  }

  try {
    if (theme_preference !== undefined) {
      db.prepare(`UPDATE "user" SET theme_preference = ? WHERE id = ?`)
        .run(theme_preference, req.currentUser.id);
    }

    const updated = getUserById(req.currentUser.id);
    res.json(sanitizeUser(updated));
  } catch (error) {
    console.error('Update me error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ==================== CUSTOM FIELD CONFIG ROUTES ====================
app.get(
  '/api/custom-fields',
  requireAuth,
  requirePermission('can_access_settings'),
  (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT *
        FROM customfieldconfig
        ORDER BY datetime(created_date) DESC, field_key ASC
      `).all();

      res.json(rows);
    } catch (error) {
      console.error('List custom fields error:', error);
      res.status(500).json({ error: 'Failed to list custom fields' });
    }
  }
);

app.post(
  '/api/custom-fields',
  requireAuth,
  requirePermission('can_access_settings'),
  (req, res) => {
    const {
      field_key,
      label,
      field_type = 'text',
      options = null,
      is_active = 1,
    } = req.body || {};

    const normalizedKey = normalizeFieldKey(field_key || label);

    if (!normalizedKey || !validateCustomFieldKey(normalizedKey)) {
      return res.status(400).json({
        error: 'Invalid field key. Use lowercase letters, numbers, and underscores, starting with a letter.',
      });
    }

    if (!label || !String(label).trim()) {
      return res.status(400).json({ error: 'Label is required' });
    }

    if (!['text', 'select', 'number', 'date'].includes(field_type)) {
      return res.status(400).json({ error: 'Invalid field type' });
    }

    try {
      const existing = db.prepare(`
        SELECT id FROM customfieldconfig WHERE field_key = ?
      `).get(normalizedKey);

      if (existing) {
        return res.status(400).json({ error: 'A field with this key already exists' });
      }

      const info = db.prepare(`
        INSERT INTO customfieldconfig (
          field_key,
          label,
          field_type,
          options,
          is_active,
          created_by,
          created_date,
          updated_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalizedKey,
        String(label).trim(),
        field_type,
        options ? stringifyJsonSafely(options, '[]') : null,
        is_active ? 1 : 0,
        req.currentUser.email,
        new Date().toISOString(),
        new Date().toISOString()
      );

      const created = db.prepare(`
        SELECT * FROM customfieldconfig WHERE id = ?
      `).get(info.lastInsertRowid);

      res.json(created);
    } catch (error) {
      console.error('Create custom field error:', error);
      res.status(500).json({ error: 'Failed to create custom field' });
    }
  }
);

app.put(
  '/api/custom-fields/:id',
  requireAuth,
  requirePermission('can_access_settings'),
  (req, res) => {
    const { id } = req.params;
    const {
      label,
      field_type,
      options,
      is_active,
    } = req.body || {};

    try {
      const existing = db.prepare(`SELECT * FROM customfieldconfig WHERE id = ?`).get(id);

      if (!existing) {
        return res.status(404).json({ error: 'Custom field not found' });
      }

      const updates = {
        label: label !== undefined ? String(label).trim() : existing.label,
        field_type: field_type !== undefined ? field_type : existing.field_type,
        options: options !== undefined ? (options ? stringifyJsonSafely(options, '[]') : null) : existing.options,
        is_active: is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active,
        updated_date: new Date().toISOString(),
      };

      if (!updates.label) {
        return res.status(400).json({ error: 'Label is required' });
      }

      if (!['text', 'select', 'number', 'date'].includes(updates.field_type)) {
        return res.status(400).json({ error: 'Invalid field type' });
      }

      db.prepare(`
        UPDATE customfieldconfig
        SET label = ?, field_type = ?, options = ?, is_active = ?, updated_date = ?
        WHERE id = ?
      `).run(
        updates.label,
        updates.field_type,
        updates.options,
        updates.is_active,
        updates.updated_date,
        id
      );

      const updated = db.prepare(`SELECT * FROM customfieldconfig WHERE id = ?`).get(id);
      res.json(updated);
    } catch (error) {
      console.error('Update custom field error:', error);
      res.status(500).json({ error: 'Failed to update custom field' });
    }
  }
);

app.delete(
  '/api/custom-fields/:id',
  requireAuth,
  requirePermission('can_access_settings'),
  (req, res) => {
    const { id } = req.params;

    try {
      const existing = db.prepare(`SELECT * FROM customfieldconfig WHERE id = ?`).get(id);

      if (!existing) {
        return res.status(404).json({ error: 'Custom field not found' });
      }

      db.prepare(`DELETE FROM customfieldconfig WHERE id = ?`).run(id);

      res.json({ success: true });
    } catch (error) {
      console.error('Delete custom field error:', error);
      res.status(500).json({ error: 'Failed to delete custom field' });
    }
  }
);

// ==================== RECORD HISTORY ROUTE ====================
app.get(
  '/api/datarecord/:id/history',
  requireAuth,
  requirePermission('can_access_records'),
  (req, res) => {
    const { id } = req.params;

    try {
      const record = db.prepare(`
        SELECT id, customer_number, customer_name
        FROM datarecord
        WHERE id = ?
      `).get(id);

      if (!record) {
        return res.status(404).json({ error: 'Record not found' });
      }

      const history = db.prepare(`
        SELECT
          id,
          action_type,
          user_email,
          user_name,
          resource_id,
          resource_name,
          action_details,
          changes,
          status,
          created_date
        FROM auditlog
        WHERE resource_type = 'record'
          AND resource_id = ?
        ORDER BY datetime(created_date) DESC
        LIMIT 50
      `).all(String(id));

      res.json(history);
    } catch (error) {
      console.error('Record history error:', error);
      res.status(500).json({ error: 'Failed to load record history' });
    }
  }
);

// ==================== USER ROUTES ====================
app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  try {
    const users = db.prepare(`SELECT * FROM "user" ORDER BY created_date DESC`).all();
    res.json(users.map(sanitizeUser));
  } catch (error) {
    console.error('List users error:', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const {
    email,
    full_name = '',
    role = 'user',
    password,
  } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  if (!['admin', 'user'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  try {
    const existing = db.prepare(`SELECT id FROM "user" WHERE lower(email) = lower(?)`).get(email);
    if (existing) {
      return res.status(400).json({ error: 'A user with this email already exists' });
    }

    const defaults = defaultPermissionsForRole(role);
    const passwordHash = await bcrypt.hash(password, 12);

    const info = db.prepare(`
      INSERT INTO "user" (
        email, full_name, role, password_hash, is_active,
        can_access_customer_search, can_access_records, can_access_reports, can_access_connections, can_access_settings,
        can_manage_users, can_manage_rules, can_edit_records, can_flag_records
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      email.trim().toLowerCase(),
      full_name,
      role,
      passwordHash,
      1,
      defaults.can_access_customer_search ? 1 : 0,
      defaults.can_access_records ? 1 : 0,
      defaults.can_access_reports ? 1 : 0,
      defaults.can_access_connections ? 1 : 0,
      defaults.can_access_settings ? 1 : 0,
      defaults.can_manage_users ? 1 : 0,
      defaults.can_manage_rules ? 1 : 0,
      defaults.can_edit_records ? 1 : 0,
      defaults.can_flag_records ? 1 : 0
    );

    const newUser = getUserById(info.lastInsertRowid);
    res.json({
      success: true,
      user: sanitizeUser(newUser),
    });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.put('/api/users/:id/permissions', requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  const incoming = req.body || {};

  const allowed = [
    'can_access_customer_search',
    'can_access_records',
    'can_access_reports',
    'can_access_connections',
    'can_access_settings',
    'can_manage_users',
    'can_manage_rules',
    'can_edit_records',
    'can_flag_records',
    'is_active',
  ];

  try {
    const existing = getUserById(id);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    const updates = {};
    for (const key of allowed) {
      if (incoming[key] !== undefined) {
        updates[key] = incoming[key] ? 1 : 0;
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid permission updates provided' });
    }

    const sets = Object.keys(updates).map((key) => `${key} = ?`).join(', ');
    db.prepare(`UPDATE "user" SET ${sets} WHERE id = ?`).run(...Object.values(updates), id);

    const updated = getUserById(id);
    res.json({
      success: true,
      user: sanitizeUser(updated),
    });
  } catch (error) {
    console.error('Update permissions error:', error);
    res.status(500).json({ error: 'Failed to update permissions' });
  }
});

app.put('/api/users/:id/profile', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, email } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Basic email format check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const existing = getUserById(id);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check email not already taken by another user
    const emailTaken = db.prepare('SELECT id FROM "user" WHERE lower(email) = ? AND id != ?').get(normalizedEmail, id);
    if (emailTaken) {
      return res.status(409).json({ error: 'Email already in use by another account' });
    }

    db.prepare('UPDATE "user" SET email = ?, full_name = ? WHERE id = ?')
      .run(normalizedEmail, (full_name || '').trim(), id);

    const updated = getUserById(id);
    res.json(sanitizeUser(updated));
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/users/:id/password', requireAuth, requireSelfOrAdmin, async (req, res) => {
  const { id } = req.params;
  const { password } = req.body || {};

  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const existing = getUserById(id);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    db.prepare(`UPDATE "user" SET password_hash = ? WHERE id = ?`).run(passwordHash, id);

    res.json({ success: true });
  } catch (error) {
    console.error('Update password error:', error);
    res.status(500).json({ error: 'Failed to update password' });
  }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params;
  const targetId = parseInt(id, 10);

  try {
    const existing = getUserById(targetId);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (targetId === req.currentUser.id) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    db.prepare(`DELETE FROM "user" WHERE id = ?`).run(targetId);

    res.json({ success: true });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ==================== TEST SQL SERVER CONNECTION ====================
app.post(
  '/api/test-connection',
  requireAuth,
  requirePermission('can_access_connections'),
  async (req, res) => {
    const { host, port = 1433, database_name, username, password } = req.body;
    let pool;

    if (!host || !database_name || !username || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
      const config = {
        user: username,
        password,
        server: host,
        database: database_name,
        port: parseInt(port, 10),
        options: {
          encrypt: false,
          trustServerCertificate: true,
        },
        requestTimeout: 30000,
        connectionTimeout: 15000,
      };

      pool = await sql.connect(config);

      const tablesResult = await pool.request().query(`
        SELECT TABLE_NAME
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME
      `);

      const tables = tablesResult.recordset.map((r) => r.TABLE_NAME);

      const fields = {};
      for (const table of tables) {
        const columnsResult = await pool.request()
          .input('tableName', sql.VarChar(128), table)
          .query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @tableName ORDER BY ORDINAL_POSITION`);
        fields[table] = columnsResult.recordset.map((r) => r.COLUMN_NAME);
      }

      res.json({
        success: true,
        tables,
        fields,
      });
    } catch (error) {
      console.error('Test connection error:', error);
      res.status(500).json({
        error: error.message || 'Failed to connect to SQL Server',
      });
    } finally {
      if (pool) {
        try {
          await pool.close();
        } catch {}
      }
    }
  }
);

// ==================== TEST QUERY ====================
app.post(
  '/api/test-query',
  requireAuth,
  requirePermission('can_access_connections'),
  async (req, res) => {
    const { host, port = 1433, database_name, username, password, query } = req.body;
    let pool;

    if (!host || !database_name || !username || !password) {
      return res.status(400).json({ error: 'Missing connection credentials' });
    }
    if (!query || !query.trim()) {
      return res.status(400).json({ error: 'No query provided' });
    }

    // Basic safety: only allow SELECT/CTE/comment-prefixed queries
    // Strip leading comments (-- lines and /* */ blocks) before checking
    const strippedForCheck = query
      .replace(/--[^\n]*/g, '')        // remove -- comments
      .replace(/\/\*[\s\S]*?\*\//g, '') // remove /* */ blocks
      .trim()
      .toUpperCase();
    if (!strippedForCheck.startsWith('SELECT') && !strippedForCheck.startsWith('WITH')) {
      return res.status(400).json({ error: 'Only SELECT or CTE (WITH ...) queries are allowed' });
    }

    try {
      pool = await sql.connect({
        user: username,
        password,
        server: host,
        database: database_name,
        port: parseInt(port, 10),
        options: { encrypt: false, trustServerCertificate: true },
        requestTimeout: 30000,
        connectionTimeout: 15000,
      });

      // Run the full query and slice — avoids any SQL modification that breaks
      // CTEs, comments, HAVING, ORDER BY, UNION, etc.
      const result = await pool.request().query(query);
      const allRows = result.recordset || [];
      const rows = allRows.slice(0, 5);
      const columns = rows.length > 0
        ? Object.keys(rows[0])
        : (result.recordset?.columns ? Object.keys(result.recordset.columns) : []);
      const columnsMeta = columns;

      res.json({
        success: true,
        columns: columnsMeta.length > 0 ? columnsMeta : columns,
        preview: rows,
      });
    } catch (error) {
      console.error('Test query error:', error);
      res.status(500).json({ error: error.message || 'Query failed', detail: error.originalError?.message || error.stack });
    } finally {
      if (pool) { try { await pool.close(); } catch {} }
    }
  }
);

// ==================== IMPORT FROM SQL SERVER ====================
app.post(
  '/api/import/:connectionId',
  requireAuth,
  requirePermission('can_access_connections'),
  async (req, res) => {
    if (shuttingDown) {
      return res.status(503).json({ error: 'Server is shutting down' });
    }

    try {
      const result = await runConnectionImport(req.params.connectionId);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message || 'Import failed' });
    }
  }
);

// ==================== DYNAMIC CRUD ROUTES ====================
app.get('/api/:table', requireAuth, (req, res) => {
  const { table } = req.params;

  if (!isValidTableName(table)) {
    return res.status(404).json({ error: `Table "${table}" not found` });
  }

  const access = checkTableAccess(req, table, 'GET');
  if (!access.ok) {
    return res.status(access.status).json({ error: access.error });
  }

  if (table === 'user') {
    return res.status(403).json({ error: 'Restricted table' });
  }

  try {
    const stmt = db.prepare(`SELECT * FROM "${table}"`);
    const rows = stmt.all();
    let output = table === 'datarecord' ? rows.map(expandDataRecord) : rows;
    if (table === 'databaseconnection') output = output.map(sanitizeConnection);
    res.json(output);
  } catch {
    res.status(404).json({ error: `Table "${table}" not found` });
  }
});

app.get('/api/:table/:id', requireAuth, (req, res) => {
  const { table, id } = req.params;

  if (!isValidTableName(table)) {
    return res.status(404).json({ error: `Table "${table}" not found` });
  }

  const access = checkTableAccess(req, table, 'GET');
  if (!access.ok) {
    return res.status(access.status).json({ error: access.error });
  }

  if (table === 'user') {
    return res.status(403).json({ error: 'Restricted table' });
  }

  try {
    const stmt = db.prepare(`SELECT * FROM "${table}" WHERE id = ?`);
    const row = stmt.get(id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    let output = table === 'datarecord' ? expandDataRecord(row) : row;
    if (table === 'databaseconnection') output = sanitizeConnection(output);
    res.json(output);
  } catch {
    res.status(404).json({ error: `Table "${table}" not found` });
  }
});

app.post('/api/:table', requireAuth, (req, res) => {
  const { table } = req.params;

  if (!isValidTableName(table)) {
    return res.status(404).json({ error: `Table "${table}" not found` });
  }

  const access = checkTableAccess(req, table, 'POST');
  if (!access.ok) {
    return res.status(access.status).json({ error: access.error });
  }

  if (table === 'user' || table === 'syncrun') {
    return res.status(403).json({ error: 'Direct create not allowed for this table' });
  }

  const data = sanitizeForSqlite(req.body);

  if (table === 'databaseconnection' && data.status !== undefined) {
    const allowedStatuses = new Set(['active', 'inactive', 'error', 'testing']);
    if (!allowedStatuses.has(data.status)) {
      return res.status(400).json({ error: `Invalid status: ${data.status}` });
    }
  }

  try {
    const columns = Object.keys(data);
    if (columns.length === 0) {
      return res.status(400).json({ error: 'No data provided' });
    }

    // Validate column names against actual schema to prevent injection
    const tableInfo = db.prepare(`PRAGMA table_info("${table}")`).all();
    const validColumns = new Set(tableInfo.map((col) => col.name));
    const invalidCols = columns.filter((k) => !validColumns.has(k));
    if (invalidCols.length > 0) {
      return res.status(400).json({ error: `Invalid fields: ${invalidCols.join(', ')}` });
    }

    const placeholders = columns.map(() => '?').join(',');
    const stmt = db.prepare(`INSERT INTO "${table}" (${columns.join(',')}) VALUES (${placeholders})`);
    const info = stmt.run(...Object.values(data));
    res.json({ id: info.lastInsertRowid, ...data });
  } catch (e) {
    console.error('POST error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/:table/:id', requireAuth, (req, res) => {
  const { table, id } = req.params;

  if (!isValidTableName(table)) {
    return res.status(404).json({ error: `Table "${table}" not found` });
  }

  const access = checkTableAccess(req, table, 'PUT');
  if (!access.ok) {
    return res.status(access.status).json({ error: access.error });
  }

  if (table === 'user' || table === 'syncrun') {
    return res.status(403).json({ error: 'Use dedicated routes instead' });
  }

  const data = sanitizeForSqlite(req.body);

  if (table === 'databaseconnection' && data.status !== undefined) {
    const allowedStatuses = new Set(['active', 'inactive', 'error', 'testing']);
    if (!allowedStatuses.has(data.status)) {
      return res.status(400).json({ error: `Invalid status: ${data.status}` });
    }
  }

  try {
    const existing = db.prepare(`SELECT * FROM "${table}" WHERE id = ?`).get(id);

    if (!existing) {
      return res.status(404).json({ error: 'Record not found' });
    }

    let flagChanged = false;
    let oldFlagColor = null;
    let oldFlagReason = null;
    let newFlagColor = null;
    let newFlagReason = null;

    if (table === 'datarecord') {
      oldFlagColor = existing.flag_color ?? null;
      oldFlagReason = existing.flag_reason ?? null;

      newFlagColor = data.flag_color !== undefined ? data.flag_color : oldFlagColor;
      newFlagReason = data.flag_reason !== undefined ? data.flag_reason : oldFlagReason;

      flagChanged = oldFlagColor !== newFlagColor || oldFlagReason !== newFlagReason;

      if (flagChanged) {
        data.flag_created_by = req.currentUser.email;
      }

      if (data.local_fields !== undefined) {
        data.local_fields = stringifyJsonSafely(
          typeof data.local_fields === 'string' ? parseJsonSafely(data.local_fields, {}) : data.local_fields,
          '{}'
        );
      }
    }

    const keys = Object.keys(data);
    if (keys.length === 0) {
      return res.status(400).json({ error: 'No data provided' });
    }

    // Validate column names against actual schema to prevent injection
    const tableInfo = db.prepare(`PRAGMA table_info("${table}")`).all();
    const validColumns = new Set(tableInfo.map((col) => col.name));
    const invalidKeys = keys.filter((k) => !validColumns.has(k));
    if (invalidKeys.length > 0) {
      return res.status(400).json({ error: `Invalid fields: ${invalidKeys.join(', ')}` });
    }

    const sets = keys.map((k) => `${k} = ?`).join(',');
    const stmt = db.prepare(`UPDATE "${table}" SET ${sets} WHERE id = ?`);
    stmt.run(...Object.values(data), id);

    if (table === 'datarecord' && flagChanged) {
      const beforeColorLabel = oldFlagColor || 'none';
      const afterColorLabel = newFlagColor || 'none';
      const beforeReasonLabel = oldFlagReason || '';
      const afterReasonLabel = newFlagReason || '';

      let actionDetails = `Flag changed from ${beforeColorLabel} to ${afterColorLabel}`;

      if (beforeReasonLabel !== afterReasonLabel) {
        if (!beforeReasonLabel && afterReasonLabel) {
          actionDetails += `; reason added: "${afterReasonLabel}"`;
        } else if (beforeReasonLabel && !afterReasonLabel) {
          actionDetails += '; reason cleared';
        } else {
          actionDetails += `; reason changed from "${beforeReasonLabel}" to "${afterReasonLabel}"`;
        }
      }

      db.prepare(`
        INSERT INTO auditlog (
          action_type,
          user_email,
          user_name,
          resource_type,
          resource_id,
          resource_name,
          action_details,
          changes,
          ip_address,
          status,
          created_date
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'update_flag',
        req.currentUser.email,
        req.currentUser.full_name || '',
        'record',
        String(id),
        existing.customer_number || existing.customer_name || `Record ${id}`,
        actionDetails,
        JSON.stringify({
          field_changes: {
            flag_color: {
              from: oldFlagColor,
              to: newFlagColor,
            },
            flag_reason: {
              from: oldFlagReason,
              to: newFlagReason,
            },
            flag_created_by: {
              from: existing.flag_created_by ?? null,
              to: data.flag_created_by ?? existing.flag_created_by ?? null,
            },
          },
          summary: {
            changed_by: req.currentUser.email,
            changed_at: new Date().toISOString(),
            previous_flag: oldFlagColor,
            new_flag: newFlagColor,
            previous_reason: oldFlagReason,
            new_reason: newFlagReason,
          },
        }),
        req.ip || '',
        'success',
        new Date().toISOString()
      );
    }

    res.json({ success: true });
  } catch (e) {
    console.error('PUT error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/:table/:id', requireAuth, (req, res) => {
  const { table, id } = req.params;

  if (!isValidTableName(table)) {
    return res.status(404).json({ error: `Table "${table}" not found` });
  }

  const access = checkTableAccess(req, table, 'DELETE');
  if (!access.ok) {
    return res.status(access.status).json({ error: access.error });
  }

  if (table === 'user' || table === 'syncrun') {
    return res.status(403).json({ error: 'Use dedicated routes instead' });
  }

  try {
    const stmt = db.prepare(`DELETE FROM "${table}" WHERE id = ?`);
    stmt.run(id);
    res.json({ success: true });
  } catch (e) {
    console.error('DELETE error:', e);
    res.status(500).json({ error: e.message });
  }
});

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
        await runConnectionImport(connection.id);
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
const weekdayHalfHourTask = { stop: () => {} };
const weekdayFivePmTask = { stop: () => {} };

// ==================== SHUTDOWN ====================
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    weekdayHalfHourTask.stop();
    weekdayFivePmTask.stop();
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
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
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