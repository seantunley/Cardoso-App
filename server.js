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
import crypto from 'crypto';
import { createRequire } from 'module';
import rateLimit from 'express-rate-limit';

const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('./package.json');

dotenv.config();

// ==================== AES-256-GCM ENCRYPTION HELPERS ====================
function getEncryptionKey() {
  const raw = process.env.ENCRYPTION_KEY || '';
  if (!raw) return null;
  if (raw.length !== 64) {
    console.warn('⚠️  ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). Password encryption disabled.');
    return null;
  }
  try {
    return Buffer.from(raw, 'hex');
  } catch {
    console.warn('⚠️  ENCRYPTION_KEY is not valid hex. Password encryption disabled.');
    return null;
  }
}

// Returns 'iv:authTag:ciphertext' (all hex) or plaintext if no key
function encryptPassword(plaintext) {
  const key = getEncryptionKey();
  if (!key || !plaintext) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

// Detects encrypted format (3 hex segments) and decrypts; falls back to plaintext
function decryptPassword(stored) {
  if (!stored) return stored;
  const parts = stored.split(':');
  if (parts.length !== 3) return stored; // plaintext
  const key = getEncryptionKey();
  if (!key) return stored; // no key, return as-is (connection will fail if truly encrypted)
  try {
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const ciphertext = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(ciphertext) + decipher.final('utf8');
  } catch {
    console.warn('⚠️  Failed to decrypt password — returning stored value as-is');
    return stored;
  }
}

// Returns true if value looks like encrypted format
function isEncryptedFormat(value) {
  if (!value || typeof value !== 'string') return false;
  const parts = value.split(':');
  return parts.length === 3 && parts.every((p) => /^[0-9a-f]+$/i.test(p));
}

function normalizeVersion(version) {
  return String(version || '')
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}

function isVersionNewer(latestVersion, currentVersion) {
  const latest = normalizeVersion(latestVersion);
  const current = normalizeVersion(currentVersion);
  const maxLength = Math.max(latest.length, current.length);

  for (let i = 0; i < maxLength; i += 1) {
    const latestPart = latest[i] || 0;
    const currentPart = current[i] || 0;
    if (latestPart > currentPart) return true;
    if (latestPart < currentPart) return false;
  }

  return false;
}

const VERSION_CHECK_CACHE_MS = 1000 * 60 * 30;
let versionStatusCache = {
  data: {
    currentVersion: APP_VERSION,
    latestVersion: APP_VERSION,
    updateAvailable: false,
    source: 'local',
    checkedAt: null,
  },
  fetchedAt: 0,
};

async function getVersionStatus() {
  const now = Date.now();
  if (now - versionStatusCache.fetchedAt < VERSION_CHECK_CACHE_MS) {
    return versionStatusCache.data;
  }

  const fallback = {
    currentVersion: APP_VERSION,
    latestVersion: versionStatusCache.data.latestVersion || APP_VERSION,
    updateAvailable: isVersionNewer(versionStatusCache.data.latestVersion || APP_VERSION, APP_VERSION),
    source: 'cache',
    checkedAt: new Date(now).toISOString(),
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch('https://api.github.com/repos/seantunley/Cardoso-App/releases/latest', {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'cardoso-app-version-check',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`GitHub version check failed with status ${response.status}`);
    }

    const release = await response.json();
    const latestVersion = String(release.tag_name || release.name || APP_VERSION).replace(/^v/i, '') || APP_VERSION;
    const data = {
      currentVersion: APP_VERSION,
      latestVersion,
      updateAvailable: isVersionNewer(latestVersion, APP_VERSION),
      source: 'github-release',
      checkedAt: new Date(now).toISOString(),
    };

    versionStatusCache = {
      data,
      fetchedAt: now,
    };

    return data;
  } catch (error) {
    console.warn('Version check failed:', error.message);
    versionStatusCache = {
      data: fallback,
      fetchedAt: now,
    };
    return fallback;
  }
}

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

  CREATE TABLE IF NOT EXISTS login_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL,
    user_name TEXT,
    ip_address TEXT,
    logged_in_at TEXT DEFAULT CURRENT_TIMESTAMP
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

  CREATE INDEX IF NOT EXISTS idx_datarecord_customer_number
  ON datarecord (customer_number);

  CREATE INDEX IF NOT EXISTS idx_datarecord_flag_color
  ON datarecord (flag_color);

  CREATE INDEX IF NOT EXISTS idx_datarecord_outstanding_balance
  ON datarecord (outstanding_balance);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS inventoryrecord (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_table TEXT NOT NULL,
    item_number TEXT NOT NULL,
    item_description TEXT,
    qty_on_hand TEXT,
    last_cost TEXT,
    price_list TEXT,
    price TEXT,
    terms TEXT,
    created_date TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_date TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_table, item_number)
  );
  CREATE INDEX IF NOT EXISTS idx_inventoryrecord_source ON inventoryrecord (source_table, item_number);
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
// Invoice fields 1-5 (number, amount, date) — ensure all exist for existing DBs
ensureColumn('datarecord', 'last_unpaid_invoice_1', 'TEXT');
ensureColumn('datarecord', 'last_unpaid_invoice_1_amount', 'TEXT');
ensureColumn('datarecord', 'last_unpaid_invoice_1_date', 'TEXT');
ensureColumn('datarecord', 'last_unpaid_invoice_2', 'TEXT');
ensureColumn('datarecord', 'last_unpaid_invoice_2_amount', 'TEXT');
ensureColumn('datarecord', 'last_unpaid_invoice_2_date', 'TEXT');
ensureColumn('datarecord', 'last_unpaid_invoice_3', 'TEXT');
ensureColumn('datarecord', 'last_unpaid_invoice_3_amount', 'TEXT');
ensureColumn('datarecord', 'last_unpaid_invoice_3_date', 'TEXT');
ensureColumn('datarecord', 'last_unpaid_invoice_4', 'TEXT');
ensureColumn('datarecord', 'last_unpaid_invoice_4_amount', 'TEXT');
ensureColumn('datarecord', 'last_unpaid_invoice_4_date', 'TEXT');
ensureColumn('datarecord', 'last_unpaid_invoice_5', 'TEXT');
ensureColumn('datarecord', 'last_unpaid_invoice_5_amount', 'TEXT');
ensureColumn('datarecord', 'last_unpaid_invoice_5_date', 'TEXT');
// Receipt fields 1-5 (number, amount, date) — ensure all exist for existing DBs
ensureColumn('datarecord', 'last_receipt_1', 'TEXT');
ensureColumn('datarecord', 'last_receipt_1_amount', 'TEXT');
ensureColumn('datarecord', 'last_receipt_1_date', 'TEXT');
ensureColumn('datarecord', 'last_receipt_2', 'TEXT');
ensureColumn('datarecord', 'last_receipt_2_amount', 'TEXT');
ensureColumn('datarecord', 'last_receipt_2_date', 'TEXT');
ensureColumn('datarecord', 'last_receipt_3', 'TEXT');
ensureColumn('datarecord', 'last_receipt_3_amount', 'TEXT');
ensureColumn('datarecord', 'last_receipt_3_date', 'TEXT');
ensureColumn('datarecord', 'last_receipt_4', 'TEXT');
ensureColumn('datarecord', 'last_receipt_4_amount', 'TEXT');
ensureColumn('datarecord', 'last_receipt_4_date', 'TEXT');
ensureColumn('datarecord', 'last_receipt_5', 'TEXT');
ensureColumn('datarecord', 'last_receipt_5_amount', 'TEXT');
ensureColumn('datarecord', 'last_receipt_5_date', 'TEXT');
ensureColumn('datarecord', 'flag_source', "TEXT DEFAULT NULL");

// One-time data migration: copy old singular field names into new _1 slots if new slots are empty
{
  const colNames = db.prepare('PRAGMA table_info(datarecord)').all().map(c => c.name);
  const migrations = [
    // old column name -> new column name
    ['last_unpaid_invoice_1_date', null],  // already existed, no old name for the number/amount
    ['last_unpaid_invoice_date', 'last_unpaid_invoice_1_date'],
    ['last_receipt_number', 'last_receipt_1'],
    ['last_receipt_amount', 'last_receipt_1_amount'],
    ['last_receipt_date', 'last_receipt_1_date'],
  ];
  for (const [oldCol, newCol] of migrations) {
    if (!newCol) continue;
    if (colNames.includes(oldCol) && colNames.includes(newCol)) {
      try {
        db.exec(`UPDATE datarecord SET ${newCol} = ${oldCol} WHERE (${newCol} IS NULL OR ${newCol} = '') AND (${oldCol} IS NOT NULL AND ${oldCol} != '')`);
      } catch(e) { console.warn('Migration skip:', oldCol, '->', newCol, e.message); }
    }
  }
}
ensureColumn('datarecord', 'terms', 'TEXT');
// Query-mode columns
ensureColumn('databaseconnection', 'sync_query', 'TEXT');
ensureColumn('databaseconnection', 'query_index_field', 'TEXT');
ensureColumn('databaseconnection', 'query_field_mappings', 'TEXT');
ensureColumn('databaseconnection', 'record_type', `TEXT DEFAULT 'customer'`);

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
ensureColumn('user', 'must_change_password', 'INTEGER DEFAULT 0');
ensureColumn('user', 'is_active', 'INTEGER DEFAULT 1');
ensureColumn('user', 'can_access_customer_search', 'INTEGER DEFAULT 1');
ensureColumn('user', 'can_access_records', 'INTEGER DEFAULT 0');
ensureColumn('user', 'can_access_reports', 'INTEGER DEFAULT 0');
ensureColumn('user', 'can_access_connections', 'INTEGER DEFAULT 0');
ensureColumn('user', 'can_access_settings', 'INTEGER DEFAULT 0');
ensureColumn('user', 'can_manage_users', 'INTEGER DEFAULT 0');
ensureColumn('user', 'can_manage_rules', 'INTEGER DEFAULT 0');
// Back-fill: existing admin users should have can_manage_rules = 1
db.prepare(`UPDATE "user" SET can_manage_rules = 1 WHERE role = 'admin' AND can_manage_rules = 0`).run();
ensureColumn('user', 'can_edit_records', 'INTEGER DEFAULT 1');
ensureColumn('user', 'can_flag_records', 'INTEGER DEFAULT 1');
ensureColumn('user', 'hub_redirect', 'INTEGER DEFAULT 0');

// ==================== SCHEMA CACHE ====================
// Pre-load and cache table schemas at startup so PRAGMA table_info is never
// called on hot request paths (PUT/POST run it on every write otherwise).
const _schemaCache = new Map();
function getTableColumns(table) {
  if (_schemaCache.has(table)) return _schemaCache.get(table);
  const cols = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name));
  _schemaCache.set(table, cols);
  return cols;
}
function invalidateSchemaCache(table) { _schemaCache.delete(table); }
// Warm the cache for all allowed tables at startup
for (const t of allowedTables) {
  try { getTableColumns(t); } catch {}
}

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


// ── Inline auto-flag rule evaluator (mirrors src/lib/evalFlagRules.js) ────────
function _evalCondition(condition, record) {
  const { field, condition_type, condition_value, condition_value_secondary } = condition;
  const raw = record[field];

  if (condition_type === 'is_empty')     return raw === null || raw === undefined || String(raw).trim() === '';
  if (condition_type === 'is_not_empty') return raw !== null && raw !== undefined && String(raw).trim() !== '';

  if (['contains','equals','starts_with','ends_with'].includes(condition_type)) {
    const val = String(raw ?? '').toLowerCase();
    const cmp = String(condition_value ?? '').toLowerCase();
    if (condition_type === 'contains')    return val.includes(cmp);
    if (condition_type === 'equals')      return val === cmp;
    if (condition_type === 'starts_with') return val.startsWith(cmp);
    if (condition_type === 'ends_with')   return val.endsWith(cmp);
  }

  if (['greater_than','less_than','greater_or_equal','less_or_equal','range_between'].includes(condition_type)) {
    const num = parseFloat(String(raw ?? '').replace(/,/g, '').replace(/\s/g, ''));
    if (isNaN(num)) return false;
    const threshold = parseFloat(condition_value);
    if (condition_type === 'greater_than')     return num > threshold;
    if (condition_type === 'less_than')        return num < threshold;
    if (condition_type === 'greater_or_equal') return num >= threshold;
    if (condition_type === 'less_or_equal')    return num <= threshold;
    if (condition_type === 'range_between') {
      const hi = parseFloat(condition_value_secondary);
      return num >= threshold && num <= hi;
    }
  }

  if (['date_older_than','date_newer_than','before_date','after_date'].includes(condition_type)) {
    if (!raw) return false;
    let dateStr = String(raw).trim();
    if (/^\d{8}$/.test(dateStr)) dateStr = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
    const recordDate = new Date(dateStr);
    if (isNaN(recordDate.getTime())) return false;
    const now = new Date();
    if (condition_type === 'date_older_than') return (now - recordDate) / 86400000 > parseFloat(condition_value);
    if (condition_type === 'date_newer_than') return (now - recordDate) / 86400000 < parseFloat(condition_value);
    if (condition_type === 'before_date')     return recordDate < new Date(condition_value);
    if (condition_type === 'after_date')      return recordDate > new Date(condition_value);
  }

  return false;
}

function _evalRuleConditions(conditions, record) {
  if (!Array.isArray(conditions) || conditions.length === 0) return false;
  let result = _evalCondition(conditions[0], record);
  for (let i = 1; i < conditions.length; i++) {
    const op = (conditions[i].operator ?? 'AND').toUpperCase();
    const val = _evalCondition(conditions[i], record);
    result = op === 'OR' ? (result || val) : (result && val);
  }
  return result;
}

/**
 * Check active auto-flag rules against a record object.
 * Returns { flag_color, flag_reason, auto_flagged: 1 } or null.
 * Only applies if the record has NOT been manually flagged by a user.
 */
function applyAutoFlagRulesToRecord(record, activeRules) {
  // Never overwrite a manual flag (flag exists AND was set by a real user AND not auto-flagged)
  if (record.flag_color && record.flag_color !== 'none' && record.flag_created_by && !record.auto_flagged) return null;

  for (const rule of activeRules) {
    let conditions = rule.conditions;
    if (typeof conditions === 'string') { try { conditions = JSON.parse(conditions); } catch { conditions = []; } }
    if (!Array.isArray(conditions) || conditions.length === 0) continue;
    if (_evalRuleConditions(conditions, record)) {
      return { flag_color: rule.flag_color, flag_reason: `Auto-flagged: ${rule.rule_name}`, auto_flagged: 1 };
    }
  }
  return null;
}
// ─────────────────────────────────────────────────────────────────────────────

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
    last_unpaid_invoice_1_date: {
      fallbacks: ['last_unpaid_invoice_1_date', 'LastUnpaidInvoice1Date', 'LAST_UNPAID_INVOICE_1_DATE', 'InvoiceDate', 'INVDATE', 'LastInvoiceDate'],
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
    last_unpaid_invoice_2_date: {
      fallbacks: ['last_unpaid_invoice_2_date', 'LastUnpaidInvoice2Date', 'LAST_UNPAID_INVOICE_2_DATE'],
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
    last_unpaid_invoice_3_date: {
      fallbacks: ['last_unpaid_invoice_3_date', 'LastUnpaidInvoice3Date', 'LAST_UNPAID_INVOICE_3_DATE'],
      defaultMode: 'sync',
    },
    last_unpaid_invoice_4: {
      fallbacks: ['last_unpaid_invoice_4', 'LastUnpaidInvoice4', 'LAST_UNPAID_INVOICE_4'],
      defaultMode: 'sync',
    },
    last_unpaid_invoice_4_amount: {
      fallbacks: ['last_unpaid_invoice_4_amount', 'LastUnpaidInvoice4Amount', 'LAST_UNPAID_INVOICE_4_AMOUNT'],
      defaultMode: 'sync',
    },
    last_unpaid_invoice_4_date: {
      fallbacks: ['last_unpaid_invoice_4_date', 'LastUnpaidInvoice4Date', 'LAST_UNPAID_INVOICE_4_DATE'],
      defaultMode: 'sync',
    },
    last_unpaid_invoice_5: {
      fallbacks: ['last_unpaid_invoice_5', 'LastUnpaidInvoice5', 'LAST_UNPAID_INVOICE_5'],
      defaultMode: 'sync',
    },
    last_unpaid_invoice_5_amount: {
      fallbacks: ['last_unpaid_invoice_5_amount', 'LastUnpaidInvoice5Amount', 'LAST_UNPAID_INVOICE_5_AMOUNT'],
      defaultMode: 'sync',
    },
    last_unpaid_invoice_5_date: {
      fallbacks: ['last_unpaid_invoice_5_date', 'LastUnpaidInvoice5Date', 'LAST_UNPAID_INVOICE_5_DATE'],
      defaultMode: 'sync',
    },
    last_receipt_1: {
      fallbacks: ['last_receipt_1', 'LastReceipt1', 'LAST_RECEIPT_1', 'last_receipt_number', 'LastReceiptNumber', 'ReceiptNo', 'RECNO'],
      defaultMode: 'sync',
    },
    last_receipt_1_amount: {
      fallbacks: ['last_receipt_1_amount', 'LastReceipt1Amount', 'LAST_RECEIPT_1_AMOUNT', 'last_receipt_amount', 'LastReceiptAmount', 'ReceiptAmount', 'RECAMT'],
      defaultMode: 'sync',
    },
    last_receipt_1_date: {
      fallbacks: ['last_receipt_1_date', 'LastReceipt1Date', 'LAST_RECEIPT_1_DATE', 'last_receipt_date', 'LastReceiptDate', 'ReceiptDate', 'RECDATE'],
      defaultMode: 'sync',
    },
    last_receipt_2: {
      fallbacks: ['last_receipt_2', 'LastReceipt2', 'LAST_RECEIPT_2'],
      defaultMode: 'sync',
    },
    last_receipt_2_amount: {
      fallbacks: ['last_receipt_2_amount', 'LastReceipt2Amount', 'LAST_RECEIPT_2_AMOUNT'],
      defaultMode: 'sync',
    },
    last_receipt_2_date: {
      fallbacks: ['last_receipt_2_date', 'LastReceipt2Date', 'LAST_RECEIPT_2_DATE'],
      defaultMode: 'sync',
    },
    last_receipt_3: {
      fallbacks: ['last_receipt_3', 'LastReceipt3', 'LAST_RECEIPT_3'],
      defaultMode: 'sync',
    },
    last_receipt_3_amount: {
      fallbacks: ['last_receipt_3_amount', 'LastReceipt3Amount', 'LAST_RECEIPT_3_AMOUNT'],
      defaultMode: 'sync',
    },
    last_receipt_3_date: {
      fallbacks: ['last_receipt_3_date', 'LastReceipt3Date', 'LAST_RECEIPT_3_DATE'],
      defaultMode: 'sync',
    },
    last_receipt_4: {
      fallbacks: ['last_receipt_4', 'LastReceipt4', 'LAST_RECEIPT_4'],
      defaultMode: 'sync',
    },
    last_receipt_4_amount: {
      fallbacks: ['last_receipt_4_amount', 'LastReceipt4Amount', 'LAST_RECEIPT_4_AMOUNT'],
      defaultMode: 'sync',
    },
    last_receipt_4_date: {
      fallbacks: ['last_receipt_4_date', 'LastReceipt4Date', 'LAST_RECEIPT_4_DATE'],
      defaultMode: 'sync',
    },
    last_receipt_5: {
      fallbacks: ['last_receipt_5', 'LastReceipt5', 'LAST_RECEIPT_5'],
      defaultMode: 'sync',
    },
    last_receipt_5_amount: {
      fallbacks: ['last_receipt_5_amount', 'LastReceipt5Amount', 'LAST_RECEIPT_5_AMOUNT'],
      defaultMode: 'sync',
    },
    last_receipt_5_date: {
      fallbacks: ['last_receipt_5_date', 'LastReceipt5Date', 'LAST_RECEIPT_5_DATE'],
      defaultMode: 'sync',
    },
    terms: {
      fallbacks: ['terms', 'Terms', 'TERMS', 'PaymentTerms', 'payment_terms', 'PAYMENT_TERMS'],
      defaultMode: 'sync',
    },
    note: {
      fallbacks: ['note', 'Note', 'notes', 'Notes'],
      defaultMode: 'local-only',
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
    can_manage_rules: user.role === 'admin' ? true : boolFromRow(user.can_manage_rules, false),
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

function requirePermission(...permissionKeys) {
  return (req, res, next) => {
    if (!req.currentUser) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    if (req.currentUser.role === 'admin') {
      return next();
    }

    // Deny access if no permission key was specified (fail-closed)
    if (!permissionKeys.length) {
      return res.status(403).json({ error: 'Permission denied' });
    }

    // Allow if user has ANY of the specified permissions (OR logic)
    if (!permissionKeys.some(key => req.currentUser[key])) {
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
      password: decryptPassword(connConfig.encrypted_password),
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
        local_fields = ?,
        last_unpaid_invoice_1 = ?,
        last_unpaid_invoice_1_amount = ?,
        last_unpaid_invoice_1_date = ?,
        last_unpaid_invoice_2 = ?,
        last_unpaid_invoice_2_amount = ?,
        last_unpaid_invoice_2_date = ?,
        last_unpaid_invoice_3 = ?,
        last_unpaid_invoice_3_amount = ?,
        last_unpaid_invoice_3_date = ?,
        last_unpaid_invoice_4 = ?,
        last_unpaid_invoice_4_amount = ?,
        last_unpaid_invoice_4_date = ?,
        last_unpaid_invoice_5 = ?,
        last_unpaid_invoice_5_amount = ?,
        last_unpaid_invoice_5_date = ?,
        last_receipt_1 = ?,
        last_receipt_1_amount = ?,
        last_receipt_1_date = ?,
        last_receipt_2 = ?,
        last_receipt_2_amount = ?,
        last_receipt_2_date = ?,
        last_receipt_3 = ?,
        last_receipt_3_amount = ?,
        last_receipt_3_date = ?,
        last_receipt_4 = ?,
        last_receipt_4_amount = ?,
        last_receipt_4_date = ?,
        last_receipt_5 = ?,
        last_receipt_5_amount = ?,
        last_receipt_5_date = ?,
        terms = ?,
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
        local_fields,
        last_unpaid_invoice_1,
        last_unpaid_invoice_1_amount,
        last_unpaid_invoice_1_date,
        last_unpaid_invoice_2,
        last_unpaid_invoice_2_amount,
        last_unpaid_invoice_2_date,
        last_unpaid_invoice_3,
        last_unpaid_invoice_3_amount,
        last_unpaid_invoice_3_date,
        last_unpaid_invoice_4,
        last_unpaid_invoice_4_amount,
        last_unpaid_invoice_4_date,
        last_unpaid_invoice_5,
        last_unpaid_invoice_5_amount,
        last_unpaid_invoice_5_date,
        last_receipt_1,
        last_receipt_1_amount,
        last_receipt_1_date,
        last_receipt_2,
        last_receipt_2_amount,
        last_receipt_2_date,
        last_receipt_3,
        last_receipt_3_amount,
        last_receipt_3_date,
        last_receipt_4,
        last_receipt_4_amount,
        last_receipt_4_date,
        last_receipt_5,
        last_receipt_5_amount,
        last_receipt_5_date,
        terms,
        note,
        synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const inventoryMappingConfig = {
      item_number:      { fallbacks: ['item_number', 'ItemNumber', 'ITEM_NUMBER', 'ItemNo', 'ITEMNO', 'item_no'] },
      item_description: { fallbacks: ['item_description', 'ItemDescription', 'ITEM_DESCRIPTION', 'Description', 'DESC', 'ItemDesc'] },
      qty_on_hand:      { fallbacks: ['qty_on_hand', 'QtyOnHand', 'QTY_ON_HAND', 'Quantity', 'QTY', 'OnHand'] },
      last_cost:        { fallbacks: ['last_cost', 'LastCost', 'LAST_COST', 'Cost', 'COST'] },
      price_list:       { fallbacks: ['price_list', 'PriceList', 'PRICE_LIST', 'Pricelist'] },
      price:            { fallbacks: ['price', 'Price', 'PRICE', 'SellPrice', 'UnitPrice'] },
    };

    const upsertInventoryRecord = db.prepare(`
      INSERT INTO inventoryrecord (source_table, item_number, item_description, qty_on_hand, last_cost, price_list, price, updated_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_table, item_number) DO UPDATE SET
        item_description=excluded.item_description,
        qty_on_hand=excluded.qty_on_hand,
        last_cost=excluded.last_cost,
        price_list=excluded.price_list,
        price=excluded.price,
        updated_date=excluded.updated_date
    `);

    const runInventoryRows = (rows, sourceName) => {
      const syncTimestamp = new Date().toISOString();
      const writeInventory = db.transaction((rowsToWrite) => {
        for (const row of rowsToWrite) {
          const itemNumber = String(
            getMappedOrFallbackValue(row, {}, 'item_number', inventoryMappingConfig.item_number.fallbacks) || ''
          );
          if (!itemNumber) continue;
          upsertInventoryRecord.run(
            sourceName,
            itemNumber,
            String(getMappedOrFallbackValue(row, {}, 'item_description', inventoryMappingConfig.item_description.fallbacks) || ''),
            String(getMappedOrFallbackValue(row, {}, 'qty_on_hand', inventoryMappingConfig.qty_on_hand.fallbacks) || ''),
            String(getMappedOrFallbackValue(row, {}, 'last_cost', inventoryMappingConfig.last_cost.fallbacks) || ''),
            String(getMappedOrFallbackValue(row, {}, 'price_list', inventoryMappingConfig.price_list.fallbacks) || ''),
            String(getMappedOrFallbackValue(row, {}, 'price', inventoryMappingConfig.price.fallbacks) || ''),
            syncTimestamp
          );
        }
      });
      writeInventory(rows);
    };

    // Shared write-rows helper used by both query mode and legacy table mode
    const runWriteRows = (rows, sourceName, mappings, indexField) => {
      const existingRows = db.prepare(`
        SELECT id, source_id, source_table, customer_number, customer_name,
               age_analysis, age_current, age_7_days, age_14_days, age_21_days,
               note, local_fields, flag_color, flag_reason, flag_created_by, data,
               outstanding_balance, terms,
               last_unpaid_invoice_1, last_unpaid_invoice_1_amount, last_unpaid_invoice_1_date,
               last_unpaid_invoice_2, last_unpaid_invoice_2_amount, last_unpaid_invoice_2_date,
               last_unpaid_invoice_3, last_unpaid_invoice_3_amount, last_unpaid_invoice_3_date,
               last_unpaid_invoice_4, last_unpaid_invoice_4_amount, last_unpaid_invoice_4_date,
               last_unpaid_invoice_5, last_unpaid_invoice_5_amount, last_unpaid_invoice_5_date,
               last_receipt_1, last_receipt_1_amount, last_receipt_1_date,
               last_receipt_2, last_receipt_2_amount, last_receipt_2_date,
               last_receipt_3, last_receipt_3_amount, last_receipt_3_date,
               last_receipt_4, last_receipt_4_amount, last_receipt_4_date,
               last_receipt_5, last_receipt_5_amount, last_receipt_5_date
        FROM datarecord
        WHERE source_table = ?
      `).all(sourceName);

      const existingMap = new Map(
        existingRows.map((r) => [`${r.source_table}::${r.source_id}`, r])
      );

      const syncTimestamp = new Date().toISOString();

      // Load active auto-flag rules once for the entire sync batch
      const activeAutoFlagRules = db.prepare(
        `SELECT * FROM autoflagrule WHERE is_active = 1 ORDER BY priority DESC`
      ).all();

      const updateRecordFlag = db.prepare(`
        UPDATE datarecord SET flag_color = ?, flag_reason = ?, auto_flagged = ?, flag_source = 'auto' WHERE id = ?
      `);

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
              String(baseRecordData.local_fields ?? stringifyJsonSafely(existingLocalFields)),
              String(baseRecordData.last_unpaid_invoice_1 ?? existing.last_unpaid_invoice_1 ?? ''),
              String(baseRecordData.last_unpaid_invoice_1_amount ?? existing.last_unpaid_invoice_1_amount ?? ''),
              String(baseRecordData.last_unpaid_invoice_1_date ?? existing.last_unpaid_invoice_1_date ?? ''),
              String(baseRecordData.last_unpaid_invoice_2 ?? existing.last_unpaid_invoice_2 ?? ''),
              String(baseRecordData.last_unpaid_invoice_2_amount ?? existing.last_unpaid_invoice_2_amount ?? ''),
              String(baseRecordData.last_unpaid_invoice_2_date ?? existing.last_unpaid_invoice_2_date ?? ''),
              String(baseRecordData.last_unpaid_invoice_3 ?? existing.last_unpaid_invoice_3 ?? ''),
              String(baseRecordData.last_unpaid_invoice_3_amount ?? existing.last_unpaid_invoice_3_amount ?? ''),
              String(baseRecordData.last_unpaid_invoice_3_date ?? existing.last_unpaid_invoice_3_date ?? ''),
              String(baseRecordData.last_unpaid_invoice_4 ?? existing.last_unpaid_invoice_4 ?? ''),
              String(baseRecordData.last_unpaid_invoice_4_amount ?? existing.last_unpaid_invoice_4_amount ?? ''),
              String(baseRecordData.last_unpaid_invoice_4_date ?? existing.last_unpaid_invoice_4_date ?? ''),
              String(baseRecordData.last_unpaid_invoice_5 ?? existing.last_unpaid_invoice_5 ?? ''),
              String(baseRecordData.last_unpaid_invoice_5_amount ?? existing.last_unpaid_invoice_5_amount ?? ''),
              String(baseRecordData.last_unpaid_invoice_5_date ?? existing.last_unpaid_invoice_5_date ?? ''),
              String(baseRecordData.last_receipt_1 ?? existing.last_receipt_1 ?? ''),
              String(baseRecordData.last_receipt_1_amount ?? existing.last_receipt_1_amount ?? ''),
              String(baseRecordData.last_receipt_1_date ?? existing.last_receipt_1_date ?? ''),
              String(baseRecordData.last_receipt_2 ?? existing.last_receipt_2 ?? ''),
              String(baseRecordData.last_receipt_2_amount ?? existing.last_receipt_2_amount ?? ''),
              String(baseRecordData.last_receipt_2_date ?? existing.last_receipt_2_date ?? ''),
              String(baseRecordData.last_receipt_3 ?? existing.last_receipt_3 ?? ''),
              String(baseRecordData.last_receipt_3_amount ?? existing.last_receipt_3_amount ?? ''),
              String(baseRecordData.last_receipt_3_date ?? existing.last_receipt_3_date ?? ''),
              String(baseRecordData.last_receipt_4 ?? existing.last_receipt_4 ?? ''),
              String(baseRecordData.last_receipt_4_amount ?? existing.last_receipt_4_amount ?? ''),
              String(baseRecordData.last_receipt_4_date ?? existing.last_receipt_4_date ?? ''),
              String(baseRecordData.last_receipt_5 ?? existing.last_receipt_5 ?? ''),
              String(baseRecordData.last_receipt_5_amount ?? existing.last_receipt_5_amount ?? ''),
              String(baseRecordData.last_receipt_5_date ?? existing.last_receipt_5_date ?? ''),
              String(baseRecordData.terms ?? existing.terms ?? ''),
              existing.flag_color,
              existing.flag_reason,
              existing.flag_created_by,
              String(baseRecordData.note ?? existing.note ?? ''),
              baseRecordData.synced_at,
              syncTimestamp,
              existing.id
            );
             // Apply auto-flag rules only if the record was NOT manually flagged by a user
             // (manually flagged = has a flag AND auto_flagged is 0 AND flag_created_by is set)
             const manuallyFlagged = existing.flag_color && !existing.auto_flagged && existing.flag_created_by;
             if (activeAutoFlagRules.length > 0 && !manuallyFlagged) {
               const mergedRecord = { ...existing, ...baseRecordData };
               const autoFlag = applyAutoFlagRulesToRecord(mergedRecord, activeAutoFlagRules);
               if (autoFlag) {
                 // Flag it (or update the auto-flag if the rule result changed)
                 updateRecordFlag.run(autoFlag.flag_color, autoFlag.flag_reason, 1, existing.id);
               } else if (existing.auto_flagged) {
                 // Rule no longer matches — clear the auto-flag
                 updateRecordFlag.run(null, null, 0, existing.id);
               }
             }
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
              String(baseRecordData.local_fields ?? '{}'),
              String(baseRecordData.last_unpaid_invoice_1 ?? ''),
              String(baseRecordData.last_unpaid_invoice_1_amount ?? ''),
              String(baseRecordData.last_unpaid_invoice_1_date ?? ''),
              String(baseRecordData.last_unpaid_invoice_2 ?? ''),
              String(baseRecordData.last_unpaid_invoice_2_amount ?? ''),
              String(baseRecordData.last_unpaid_invoice_2_date ?? ''),
              String(baseRecordData.last_unpaid_invoice_3 ?? ''),
              String(baseRecordData.last_unpaid_invoice_3_amount ?? ''),
              String(baseRecordData.last_unpaid_invoice_3_date ?? ''),
              String(baseRecordData.last_unpaid_invoice_4 ?? ''),
              String(baseRecordData.last_unpaid_invoice_4_amount ?? ''),
              String(baseRecordData.last_unpaid_invoice_4_date ?? ''),
              String(baseRecordData.last_unpaid_invoice_5 ?? ''),
              String(baseRecordData.last_unpaid_invoice_5_amount ?? ''),
              String(baseRecordData.last_unpaid_invoice_5_date ?? ''),
              String(baseRecordData.last_receipt_1 ?? ''),
              String(baseRecordData.last_receipt_1_amount ?? ''),
              String(baseRecordData.last_receipt_1_date ?? ''),
              String(baseRecordData.last_receipt_2 ?? ''),
              String(baseRecordData.last_receipt_2_amount ?? ''),
              String(baseRecordData.last_receipt_2_date ?? ''),
              String(baseRecordData.last_receipt_3 ?? ''),
              String(baseRecordData.last_receipt_3_amount ?? ''),
              String(baseRecordData.last_receipt_3_date ?? ''),
              String(baseRecordData.last_receipt_4 ?? ''),
              String(baseRecordData.last_receipt_4_amount ?? ''),
              String(baseRecordData.last_receipt_4_date ?? ''),
              String(baseRecordData.last_receipt_5 ?? ''),
              String(baseRecordData.last_receipt_5_amount ?? ''),
              String(baseRecordData.last_receipt_5_date ?? ''),
              String(baseRecordData.terms ?? ''),
              String(baseRecordData.note ?? ''),
              baseRecordData.synced_at
            );
            // Apply auto-flag rules to new records (user hasn't touched them yet)
            if (activeAutoFlagRules.length > 0) {
              const newRecord = db.prepare(`SELECT * FROM datarecord WHERE source_table = ? AND source_id = ?`).get(sourceName, String(sourceId || ''));
              if (newRecord) {
                const autoFlag = applyAutoFlagRulesToRecord(newRecord, activeAutoFlagRules);
                if (autoFlag) {
                  updateRecordFlag.run(autoFlag.flag_color, autoFlag.flag_reason, 1, newRecord.id);
                }
              }
            }
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

      if (connConfig.record_type === 'inventory') {
        runInventoryRows(rows, sourceName);
      } else {
        runWriteRows(rows, sourceName, queryFieldMappings, queryIndexField);
      }
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

        const configRecordType = config.record_type || connConfig.record_type || 'customer';
        if (configRecordType === 'inventory') {
          runInventoryRows(rows, table_name);
        } else {
          runWriteRows(rows, table_name, fieldMappings, index_field);
        }
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
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const user = db.prepare(`SELECT * FROM "user" WHERE lower(email) = lower(?)`).get(email);

    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'User is inactive' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    req.session.userId = user.id;

    try {
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
      db.prepare(`INSERT INTO login_log (user_email, user_name, ip_address, logged_in_at) VALUES (?, ?, ?, datetime('now'))`).run(
        user.email,
        user.full_name || null,
        ip
      );
    } catch (logErr) {
      console.error('Failed to write login log:', logErr);
    }

    // Force password change on first login
    if (user.must_change_password) {
      // Create a temporary session token so the client can call set-initial-password
      req.session.pendingUserId = user.id;
      req.session.userId = null;
      return res.json({ success: false, force_password_change: true });
    }

    // Hub redirect: if user is flagged as a hub user, send them to head office
    if (user.hub_redirect) {
      const hubUrl = process.env.HUB_REDIRECT_URL || null;
      if (hubUrl) {
        // Don't create a session on this site — just redirect
        req.session.destroy(() => {});
        return res.json({ success: true, hub_redirect: hubUrl });
      }
    }

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

app.post('/api/auth/set-initial-password', async (req, res) => {
  const userId = req.session.pendingUserId;
  if (!userId) return res.status(401).json({ error: 'No pending session' });

  const { password } = req.body;
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    db.prepare(`UPDATE "user" SET password_hash = ?, must_change_password = 0 WHERE id = ?`).run(hash, userId);

    // Upgrade session to full login
    const user = db.prepare(`SELECT * FROM "user" WHERE id = ?`).get(userId);
    req.session.pendingUserId = null;
    req.session.userId = userId;

    // Hub redirect check
    if (user.hub_redirect) {
      const hubUrl = process.env.HUB_REDIRECT_URL || null;
      if (hubUrl) {
        req.session.destroy(() => {});
        return res.json({ success: true, hub_redirect: hubUrl });
      }
    }

    res.json({ success: true, user: sanitizeUser(user) });
  } catch (err) {
    console.error('set-initial-password error:', err);
    res.status(500).json({ error: 'Failed to set password' });
  }
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

app.get('/api/app-info', (req, res) => {
  res.json({
    hub_mode: process.env.HUB_MODE === 'true',
    version: require('./package.json').version,
  });
});

// POST /api/test-rule
// Accepts { conditions, sample_size } and runs the rule logic against real records.
// Returns up to sample_size records (default 5) that matched, plus up to sample_size that didn't.
app.post('/api/test-rule', requireAuth, (req, res) => {
  try {
    const { conditions: rawConditions, sample_size = 5 } = req.body;
    let conditions = rawConditions;
    if (typeof conditions === 'string') { try { conditions = JSON.parse(conditions); } catch { conditions = []; } }
    if (!Array.isArray(conditions) || conditions.length === 0) {
      return res.status(400).json({ error: 'No conditions provided' });
    }

    // Fetch a reasonably large sample to find matches and non-matches
    const rows = db.prepare(
      `SELECT customer_number, customer_name, outstanding_balance,
              last_unpaid_invoice_1_date, last_receipt_1_date, updated_date, created_date,
              age_analysis, flag_color
       FROM datarecord ORDER BY RANDOM() LIMIT 200`
    ).all();

    function evalCondition(cond, record) {
      const raw = record[cond.field];
      const ct = cond.condition_type;
      if (ct === 'is_empty') return raw === null || raw === undefined || String(raw).trim() === '';
      if (ct === 'is_not_empty') return raw !== null && raw !== undefined && String(raw).trim() !== '';
      if (['contains','equals','starts_with','ends_with'].includes(ct)) {
        const val = String(raw ?? '').toLowerCase();
        const cmp = String(cond.condition_value ?? '').toLowerCase();
        if (ct === 'contains') return val.includes(cmp);
        if (ct === 'equals') return val === cmp;
        if (ct === 'starts_with') return val.startsWith(cmp);
        if (ct === 'ends_with') return val.endsWith(cmp);
      }
      if (['greater_than','less_than','greater_or_equal','less_or_equal','range_between'].includes(ct)) {
        const num = parseFloat(String(raw ?? '').replace(/,/g, '').replace(/\s/g, ''));
        if (isNaN(num)) return false;
        const t = parseFloat(cond.condition_value);
        if (ct === 'greater_than') return num > t;
        if (ct === 'less_than') return num < t;
        if (ct === 'greater_or_equal') return num >= t;
        if (ct === 'less_or_equal') return num <= t;
        if (ct === 'range_between') return num >= t && num <= parseFloat(cond.condition_value_secondary);
      }
      if (['date_older_than','date_newer_than','before_date','after_date'].includes(ct)) {
        if (!raw) return false;
        let _ds = String(raw).trim();
        if (/^\d{8}$/.test(_ds)) _ds = `${_ds.slice(0,4)}-${_ds.slice(4,6)}-${_ds.slice(6,8)}`;
        const d = new Date(_ds);
        if (isNaN(d.getTime())) return false;
        const now = new Date();
        if (ct === 'date_older_than') return (now - d) / 86400000 > parseFloat(cond.condition_value);
        if (ct === 'date_newer_than') return (now - d) / 86400000 < parseFloat(cond.condition_value);
        if (ct === 'before_date') return d < new Date(cond.condition_value);
        if (ct === 'after_date') return d > new Date(cond.condition_value);
      }
      return false;
    }

    function evalAll(conditions, record) {
      let result = evalCondition(conditions[0], record);
      for (let i = 1; i < conditions.length; i++) {
        const op = (conditions[i].operator || 'AND').toUpperCase();
        const val = evalCondition(conditions[i], record);
        result = op === 'OR' ? result || val : result && val;
      }
      return result;
    }

    const matched = [];
    const unmatched = [];
    const limit = Math.min(parseInt(sample_size) || 5, 20);

    for (const row of rows) {
      // Per-condition results for display
      const condResults = conditions.map(c => ({
        field: c.field,
        passed: evalCondition(c, row),
        operator: c.operator,
      }));
      const passes = evalAll(conditions, row);
      const entry = {
        customer_number: row.customer_number,
        customer_name: row.customer_name,
        outstanding_balance: row.outstanding_balance,
        last_unpaid_invoice_1_date: row.last_unpaid_invoice_1_date,
        last_receipt_1_date: row.last_receipt_1_date,
        updated_date: row.updated_date,
        age_analysis: row.age_analysis,
        flag_color: row.flag_color,
        passes,
        condition_results: condResults,
      };
      if (passes && matched.length < limit) matched.push(entry);
      else if (!passes && unmatched.length < limit) unmatched.push(entry);
      if (matched.length >= limit && unmatched.length >= limit) break;
    }

    res.json({ matched, unmatched, total_sampled: rows.length });
  } catch (err) {
    console.error('test-rule error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/top-balances?limit=30
// Returns top customers by outstanding balance, sorted descending.
// In hub mode, queries the hub_records table (cross-site).
// In site mode, queries the local datarecord table.
app.get('/api/top-balances', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 200);
  const isHub = process.env.HUB_MODE === 'true';

  try {
    let rows;
    if (isHub) {
      // hub_records has site_id, customer_number, customer_name, outstanding_balance
      // join hub_sites for a friendly site name
      const stmt = db.prepare(`
        SELECT
          r.customer_number,
          r.customer_name,
          r.outstanding_balance,
          r.last_unpaid_invoice_1,
          r.last_unpaid_invoice_1_amount,
          r.last_unpaid_invoice_1_date,
          r.last_receipt_1,
          r.last_receipt_1_amount,
          r.last_receipt_1_date,
          r.flag_color,
          r.flag_reason,
          r.auto_flagged,
          COALESCE(s.name, r.site_id) AS site_name
        FROM hub_records r
        LEFT JOIN hub_sites s ON s.id = r.site_id
        WHERE r.outstanding_balance IS NOT NULL
          AND r.outstanding_balance != ''
          AND r.outstanding_balance != '0'
          AND CAST(REPLACE(REPLACE(r.outstanding_balance, ',', ''), ' ', '') AS REAL) > 0
        ORDER BY CAST(REPLACE(REPLACE(r.outstanding_balance, ',', ''), ' ', '') AS REAL) DESC
        LIMIT ?
      `);
      rows = stmt.all(limit);
    } else {
      const stmt = db.prepare(`
        SELECT
          customer_number,
          customer_name,
          outstanding_balance,
          last_unpaid_invoice_1,
          last_unpaid_invoice_1_amount,
          last_unpaid_invoice_1_date,
          last_receipt_1,
          last_receipt_1_amount,
          last_receipt_1_date,
          flag_color,
          flag_reason,
          auto_flagged,
          ? AS site_name
        FROM datarecord
        WHERE outstanding_balance IS NOT NULL
          AND outstanding_balance != ''
          AND outstanding_balance != '0'
          AND CAST(REPLACE(REPLACE(outstanding_balance, ',', ''), ' ', '') AS REAL) > 0
        ORDER BY CAST(REPLACE(REPLACE(outstanding_balance, ',', ''), ' ', '') AS REAL) DESC
        LIMIT ?
      `);
      rows = stmt.all(SITE_NAME, limit);
    }
    res.json(rows);
  } catch (err) {
    console.error('top-balances error', err);
    res.status(500).json({ error: 'Failed to fetch top balances' });
  }
});

// GET /api/inventory?search=&limit=500
app.get('/api/inventory', requireAuth, (req, res) => {
  const search = req.query.search || '';
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 10000);
  try {
    let rows;
    if (search) {
      rows = db.prepare(
        `SELECT * FROM inventoryrecord WHERE item_number LIKE ? OR item_description LIKE ? ORDER BY item_number ASC LIMIT ?`
      ).all(`%${search}%`, `%${search}%`, limit);
    } else {
      rows = db.prepare(
        `SELECT * FROM inventoryrecord ORDER BY item_number ASC LIMIT ?`
      ).all(limit);
    }
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
  requirePermission('can_access_records', 'can_access_customer_search'),
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

// ==================== LOGIN LOG ROUTE ====================
app.get('/api/login-logs', requireAuth, requireAdmin, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, user_email, user_name, ip_address, logged_in_at
      FROM login_log
      ORDER BY logged_in_at DESC
      LIMIT 500
    `).all();
    res.json(rows);
  } catch (error) {
    console.error('Login log error:', error);
    res.status(500).json({ error: 'Failed to load login logs' });
  }
});

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
    return res.status(400).json({ error: 'Username and password are required' });
  }

  if (!['admin', 'user'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  try {
    const existing = db.prepare(`SELECT id FROM "user" WHERE lower(email) = lower(?)`).get(email);
    if (existing) {
      return res.status(400).json({ error: 'A user with this username already exists' });
    }

    const defaults = defaultPermissionsForRole(role);
    const defaultPassword = process.env.DEFAULT_USER_PASSWORD || `Cardoso@${new Date().getFullYear()}`;
    const finalPassword = password || defaultPassword;
    const mustChange = password ? 0 : 1;
    const passwordHash = await bcrypt.hash(finalPassword, 12);

    const info = db.prepare(`
      INSERT INTO "user" (
        email, full_name, role, password_hash, is_active, must_change_password,
        can_access_customer_search, can_access_records, can_access_reports, can_access_connections, can_access_settings,
        can_manage_users, can_manage_rules, can_edit_records, can_flag_records
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      email.trim().toLowerCase(),
      full_name,
      role,
      passwordHash,
      1,
      mustChange,
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
      return res.status(400).json({ error: 'Username is required' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const existing = getUserById(id);
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check username not already taken by another user
    const emailTaken = db.prepare('SELECT id FROM "user" WHERE lower(email) = ? AND id != ?').get(normalizedEmail, id);
    if (emailTaken) {
      return res.status(409).json({ error: 'Username already in use by another account' });
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
    const { host, port = 1433, database_name, username, connectionId } = req.body;
    let { password } = req.body;
    let pool;

    // If no password supplied but a connectionId is, decrypt the stored one
    if (!password && connectionId) {
      const stored = db.prepare('SELECT encrypted_password FROM databaseconnection WHERE id = ?').get(connectionId);
      if (stored?.encrypted_password) {
        try { password = decryptPassword(stored.encrypted_password); } catch {}
      }
    }

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
        const { host, port = 1433, database_name, username, query, connectionId } = req.body;
    let { password } = req.body;
    let pool;

    // If no password supplied but a connectionId is, decrypt the stored one
    if (!password && connectionId) {
      const stored = db.prepare('SELECT encrypted_password FROM databaseconnection WHERE id = ?').get(connectionId);
      if (stored?.encrypted_password) {
        try { password = decryptPassword(stored.encrypted_password); } catch {}
      }
    }

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
  const total = db.prepare('SELECT COUNT(*) as count FROM datarecord').get();
  const byFlag = db.prepare(
    "SELECT flag_color, COUNT(*) as count FROM datarecord GROUP BY flag_color"
  ).all();
  const lastSync = db.prepare(
    "SELECT completed_at, status FROM syncrun WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1"
  ).get();
  const activeConns = db.prepare(
    "SELECT COUNT(*) as count FROM databaseconnection WHERE status = 'active'"
  ).get();

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
              outstanding_balance, last_unpaid_invoice_1, last_unpaid_invoice_1_amount, last_unpaid_invoice_1_date, last_unpaid_invoice_2, last_unpaid_invoice_2_amount, last_unpaid_invoice_2_date, last_unpaid_invoice_3, last_unpaid_invoice_3_amount, last_unpaid_invoice_3_date, last_unpaid_invoice_4, last_unpaid_invoice_4_amount, last_unpaid_invoice_4_date, last_unpaid_invoice_5, last_unpaid_invoice_5_amount, last_unpaid_invoice_5_date,
              last_receipt_1, last_receipt_1_amount, last_receipt_1_date, last_receipt_2, last_receipt_2_amount, last_receipt_2_date, last_receipt_3, last_receipt_3_amount, last_receipt_3_date, last_receipt_4, last_receipt_4_amount, last_receipt_4_date, last_receipt_5, last_receipt_5_amount, last_receipt_5_date,
              updated_date, synced_at, source_table, source_id
       FROM datarecord WHERE updated_date > ? ORDER BY updated_date ASC LIMIT ? OFFSET ?`
    ).all(since, limit, offset);
  } else {
    rows = db.prepare(
      `SELECT id, customer_number, customer_name, flag_color, flag_reason,
              outstanding_balance, last_unpaid_invoice_1, last_unpaid_invoice_1_amount, last_unpaid_invoice_1_date, last_unpaid_invoice_2, last_unpaid_invoice_2_amount, last_unpaid_invoice_2_date, last_unpaid_invoice_3, last_unpaid_invoice_3_amount, last_unpaid_invoice_3_date, last_unpaid_invoice_4, last_unpaid_invoice_4_amount, last_unpaid_invoice_4_date, last_unpaid_invoice_5, last_unpaid_invoice_5_amount, last_unpaid_invoice_5_date,
              last_receipt_1, last_receipt_1_amount, last_receipt_1_date, last_receipt_2, last_receipt_2_amount, last_receipt_2_date, last_receipt_3, last_receipt_3_amount, last_receipt_3_date, last_receipt_4, last_receipt_4_amount, last_receipt_4_date, last_receipt_5, last_receipt_5_amount, last_receipt_5_date,
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
  const total = db.prepare('SELECT COUNT(*) as count FROM datarecord').get();
  const lastRun = db.prepare(
    'SELECT status, completed_at FROM syncrun ORDER BY started_at DESC LIMIT 1'
  ).get();
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
    `SELECT id, source_table, item_number, item_description, qty_on_hand, last_cost, price_list, price, updated_date
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
// Only active when HUB_MODE=true. Aggregates data from remote sites.

if (process.env.HUB_MODE === 'true') {
  // --- Hub tables ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS hub_sites (
      id TEXT PRIMARY KEY,
      slug TEXT,
      name TEXT,
      url TEXT,
      last_seen TEXT,
      last_kpis TEXT,
      status TEXT DEFAULT 'unknown'
    );
    CREATE TABLE IF NOT EXISTS hub_records (
      site_id TEXT,
      record_id TEXT,
      customer_number TEXT,
      customer_name TEXT,
      flag_color TEXT,
      flag_reason TEXT,
      outstanding_balance TEXT,
      last_unpaid_invoice_1 TEXT,
      last_unpaid_invoice_1_amount TEXT,
      last_unpaid_invoice_1_date TEXT,
      last_unpaid_invoice_2 TEXT,
      last_unpaid_invoice_2_amount TEXT,
      last_unpaid_invoice_2_date TEXT,
      last_unpaid_invoice_3 TEXT,
      last_unpaid_invoice_3_amount TEXT,
      last_unpaid_invoice_3_date TEXT,
      last_unpaid_invoice_4 TEXT,
      last_unpaid_invoice_4_amount TEXT,
      last_unpaid_invoice_4_date TEXT,
      last_unpaid_invoice_5 TEXT,
      last_unpaid_invoice_5_amount TEXT,
      last_unpaid_invoice_5_date TEXT,
      last_receipt_1 TEXT,
      last_receipt_1_amount TEXT,
      last_receipt_1_date TEXT,
      last_receipt_2 TEXT,
      last_receipt_2_amount TEXT,
      last_receipt_2_date TEXT,
      last_receipt_3 TEXT,
      last_receipt_3_amount TEXT,
      last_receipt_3_date TEXT,
      last_receipt_4 TEXT,
      last_receipt_4_amount TEXT,
      last_receipt_4_date TEXT,
      last_receipt_5 TEXT,
      last_receipt_5_amount TEXT,
      last_receipt_5_date TEXT,
      updated_date TEXT,
      synced_at TEXT,
      PRIMARY KEY (site_id, record_id)
    );
    CREATE TABLE IF NOT EXISTS hub_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id TEXT,
      started_at TEXT,
      completed_at TEXT,
      records_fetched INTEGER,
      status TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS hub_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id TEXT NOT NULL,
      item_number TEXT NOT NULL,
      item_description TEXT,
      qty_on_hand TEXT,
      last_cost TEXT,
      price_list TEXT,
      price TEXT,
      terms TEXT,
      synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(site_id, item_number)
    );
  `);

  // --- Site registry from env ---
  let HUB_SITES = [];
  try {
    HUB_SITES = JSON.parse(process.env.HUB_SITES || '[]');
  } catch (e) {
    console.error('[HUB] Invalid HUB_SITES JSON:', e.message);
  }

  // Upsert site registry into db
  const upsertSite = db.prepare(`
    INSERT INTO hub_sites (id, slug, name, url, status)
    VALUES (@id, @slug, @name, @url, 'unknown')
    ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, name=excluded.name, url=excluded.url
  `);
  for (const site of HUB_SITES) {
    upsertSite.run({ id: site.id, slug: site.slug, name: site.name, url: site.url });
  }

  // --- ETL function ---
  async function syncSite(site) {
    const startedAt = new Date().toISOString();
    let recordsFetched = 0;
    let syncError = null;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const headers = { 'X-Reporting-Token': site.token };

      // Health check
      const healthRes = await fetch(`${site.url}/api/reporting/health`, { headers, signal: controller.signal });
      clearTimeout(timeout);
      if (!healthRes.ok) throw new Error(`Health check failed: ${healthRes.status}`);

      // KPIs
      const ctrl2 = new AbortController();
      const t2 = setTimeout(() => ctrl2.abort(), 10000);
      const kpisRes = await fetch(`${site.url}/api/reporting/kpis`, { headers, signal: ctrl2.signal });
      clearTimeout(t2);
      const kpis = kpisRes.ok ? await kpisRes.json() : null;

      // Last sync for incremental pull
      const lastSync = db.prepare(
        `SELECT completed_at FROM hub_sync_log WHERE site_id=? AND status='ok' ORDER BY completed_at DESC LIMIT 1`
      ).get(site.id);
      const sinceParam = lastSync ? `?since=${encodeURIComponent(lastSync.completed_at)}` : '';

      // Records — paginate until has_more is false
      const upsertRec = db.prepare(`
        INSERT INTO hub_records (
          site_id, record_id, customer_number, customer_name, flag_color, flag_reason,
          outstanding_balance, last_unpaid_invoice_1, last_unpaid_invoice_1_amount, last_unpaid_invoice_1_date, last_unpaid_invoice_2, last_unpaid_invoice_2_amount, last_unpaid_invoice_2_date, last_unpaid_invoice_3, last_unpaid_invoice_3_amount, last_unpaid_invoice_3_date, last_unpaid_invoice_4, last_unpaid_invoice_4_amount, last_unpaid_invoice_4_date, last_unpaid_invoice_5, last_unpaid_invoice_5_amount, last_unpaid_invoice_5_date,
          last_receipt_1, last_receipt_1_amount, last_receipt_1_date, last_receipt_2, last_receipt_2_amount, last_receipt_2_date, last_receipt_3, last_receipt_3_amount, last_receipt_3_date, last_receipt_4, last_receipt_4_amount, last_receipt_4_date, last_receipt_5, last_receipt_5_amount, last_receipt_5_date,
          updated_date, synced_at
        ) VALUES (
          @site_id, @record_id, @customer_number, @customer_name, @flag_color, @flag_reason,
          @outstanding_balance, @last_unpaid_invoice_1, @last_unpaid_invoice_1_amount, @last_unpaid_invoice_1_date, @last_unpaid_invoice_2, @last_unpaid_invoice_2_amount, @last_unpaid_invoice_2_date, @last_unpaid_invoice_3, @last_unpaid_invoice_3_amount, @last_unpaid_invoice_3_date, @last_unpaid_invoice_4, @last_unpaid_invoice_4_amount, @last_unpaid_invoice_4_date, @last_unpaid_invoice_5, @last_unpaid_invoice_5_amount, @last_unpaid_invoice_5_date,
          @last_receipt_1, @last_receipt_1_amount, @last_receipt_1_date, @last_receipt_2, @last_receipt_2_amount, @last_receipt_2_date, @last_receipt_3, @last_receipt_3_amount, @last_receipt_3_date, @last_receipt_4, @last_receipt_4_amount, @last_receipt_4_date, @last_receipt_5, @last_receipt_5_amount, @last_receipt_5_date,
          @updated_date, @synced_at
        )
        ON CONFLICT(site_id, record_id) DO UPDATE SET
          customer_number=excluded.customer_number,
          customer_name=excluded.customer_name,
          flag_color=excluded.flag_color,
          flag_reason=excluded.flag_reason,
          outstanding_balance=excluded.outstanding_balance,
          last_unpaid_invoice_1=excluded.last_unpaid_invoice_1,
          last_unpaid_invoice_1_amount=excluded.last_unpaid_invoice_1_amount,
          last_unpaid_invoice_1_date=excluded.last_unpaid_invoice_1_date,
          last_unpaid_invoice_2=excluded.last_unpaid_invoice_2,
          last_unpaid_invoice_2_amount=excluded.last_unpaid_invoice_2_amount,
          last_unpaid_invoice_2_date=excluded.last_unpaid_invoice_2_date,
          last_unpaid_invoice_3=excluded.last_unpaid_invoice_3,
          last_unpaid_invoice_3_amount=excluded.last_unpaid_invoice_3_amount,
          last_unpaid_invoice_3_date=excluded.last_unpaid_invoice_3_date,
          last_unpaid_invoice_4=excluded.last_unpaid_invoice_4,
          last_unpaid_invoice_4_amount=excluded.last_unpaid_invoice_4_amount,
          last_unpaid_invoice_4_date=excluded.last_unpaid_invoice_4_date,
          last_unpaid_invoice_5=excluded.last_unpaid_invoice_5,
          last_unpaid_invoice_5_amount=excluded.last_unpaid_invoice_5_amount,
          last_unpaid_invoice_5_date=excluded.last_unpaid_invoice_5_date,
          last_receipt_1=excluded.last_receipt_1,
          last_receipt_1_amount=excluded.last_receipt_1_amount,
          last_receipt_1_date=excluded.last_receipt_1_date,
          last_receipt_2=excluded.last_receipt_2,
          last_receipt_2_amount=excluded.last_receipt_2_amount,
          last_receipt_2_date=excluded.last_receipt_2_date,
          last_receipt_3=excluded.last_receipt_3,
          last_receipt_3_amount=excluded.last_receipt_3_amount,
          last_receipt_3_date=excluded.last_receipt_3_date,
          last_receipt_4=excluded.last_receipt_4,
          last_receipt_4_amount=excluded.last_receipt_4_amount,
          last_receipt_4_date=excluded.last_receipt_4_date,
          last_receipt_5=excluded.last_receipt_5,
          last_receipt_5_amount=excluded.last_receipt_5_amount,
          last_receipt_5_date=excluded.last_receipt_5_date,
          updated_date=excluded.updated_date,
          synced_at=excluded.synced_at
      `);
      const insertMany = db.transaction((records) => {
        const now = new Date().toISOString();
        for (const r of records) {
          upsertRec.run({
            site_id: site.id,
            record_id: r.id,
            customer_number: r.customer_number,
            customer_name: r.customer_name,
            flag_color: r.flag_color || 'none',
            flag_reason: r.flag_reason || null,
            outstanding_balance: r.outstanding_balance || null,
            last_unpaid_invoice_1: r.last_unpaid_invoice_1 || null,
            last_unpaid_invoice_1_amount: r.last_unpaid_invoice_1_amount || null,
            last_unpaid_invoice_1_date: r.last_unpaid_invoice_1_date || null,
            last_unpaid_invoice_2: r.last_unpaid_invoice_2 || null,
            last_unpaid_invoice_2_amount: r.last_unpaid_invoice_2_amount || null,
            last_unpaid_invoice_2_date: r.last_unpaid_invoice_2_date || null,
            last_unpaid_invoice_3: r.last_unpaid_invoice_3 || null,
            last_unpaid_invoice_3_amount: r.last_unpaid_invoice_3_amount || null,
            last_unpaid_invoice_3_date: r.last_unpaid_invoice_3_date || null,
            last_unpaid_invoice_4: r.last_unpaid_invoice_4 || null,
            last_unpaid_invoice_4_amount: r.last_unpaid_invoice_4_amount || null,
            last_unpaid_invoice_4_date: r.last_unpaid_invoice_4_date || null,
            last_unpaid_invoice_5: r.last_unpaid_invoice_5 || null,
            last_unpaid_invoice_5_amount: r.last_unpaid_invoice_5_amount || null,
            last_unpaid_invoice_5_date: r.last_unpaid_invoice_5_date || null,
            last_receipt_1: r.last_receipt_1 || null,
            last_receipt_1_amount: r.last_receipt_1_amount || null,
            last_receipt_1_date: r.last_receipt_1_date || null,
            last_receipt_2: r.last_receipt_2 || null,
            last_receipt_2_amount: r.last_receipt_2_amount || null,
            last_receipt_2_date: r.last_receipt_2_date || null,
            last_receipt_3: r.last_receipt_3 || null,
            last_receipt_3_amount: r.last_receipt_3_amount || null,
            last_receipt_3_date: r.last_receipt_3_date || null,
            last_receipt_4: r.last_receipt_4 || null,
            last_receipt_4_amount: r.last_receipt_4_amount || null,
            last_receipt_4_date: r.last_receipt_4_date || null,
            last_receipt_5: r.last_receipt_5 || null,
            last_receipt_5_amount: r.last_receipt_5_amount || null,
            last_receipt_5_date: r.last_receipt_5_date || null,
            updated_date: r.updated_date,
            synced_at: now,
          });
        }
      });

      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const ctrl3 = new AbortController();
        const t3 = setTimeout(() => ctrl3.abort(), 10000);
        const pageUrl = `${site.url}/api/reporting/records${sinceParam}${sinceParam ? '&' : '?'}offset=${offset}&limit=1000`;
        const recRes = await fetch(pageUrl, { headers, signal: ctrl3.signal });
        clearTimeout(t3);
        if (!recRes.ok) break;
        const recData = await recRes.json();
        if (recData.records && recData.records.length > 0) {
          insertMany(recData.records);
          recordsFetched += recData.records.length;
          offset += recData.records.length;
        }
        hasMore = recData.has_more === true;
      }

      // Inventory — full refresh
      const upsertInv = db.prepare(`
        INSERT INTO hub_inventory (site_id, item_number, item_description, qty_on_hand, last_cost, price_list, price, synced_at)
        VALUES (@site_id, @item_number, @item_description, @qty_on_hand, @last_cost, @price_list, @price, @synced_at)
        ON CONFLICT(site_id, item_number) DO UPDATE SET
          item_description=excluded.item_description,
          qty_on_hand=excluded.qty_on_hand,
          last_cost=excluded.last_cost,
          price_list=excluded.price_list,
          price=excluded.price,
          synced_at=excluded.synced_at
      `);
      const insertInventory = db.transaction((invRecords) => {
        const now = new Date().toISOString();
        for (const r of invRecords) {
          upsertInv.run({
            site_id: site.id,
            item_number: r.item_number,
            item_description: r.item_description || null,
            qty_on_hand: r.qty_on_hand || null,
            last_cost: r.last_cost || null,
            price_list: r.price_list || null,
            price: r.price || null,
            synced_at: now,
          });
        }
      });
      let invOffset = 0;
      let invHasMore = true;
      while (invHasMore) {
        const ctrlInv = new AbortController();
        const tInv = setTimeout(() => ctrlInv.abort(), 10000);
        const invUrl = `${site.url}/api/reporting/inventory?offset=${invOffset}&limit=1000`;
        const invRes = await fetch(invUrl, { headers, signal: ctrlInv.signal });
        clearTimeout(tInv);
        if (!invRes.ok) break;
        const invData = await invRes.json();
        if (invData.records && invData.records.length > 0) {
          insertInventory(invData.records);
          invOffset += invData.records.length;
        }
        invHasMore = invData.has_more === true;
      }

      // Update hub_sites
      db.prepare(`
        UPDATE hub_sites SET last_seen=?, last_kpis=?, status='ok' WHERE id=?
      `).run(new Date().toISOString(), kpis ? JSON.stringify(kpis) : null, site.id);

    } catch (err) {
      syncError = err.message;
      db.prepare(`UPDATE hub_sites SET status='error' WHERE id=?`).run(site.id);
      console.error(`[HUB] Sync error for ${site.slug}:`, err.message);
    }

    db.prepare(`
      INSERT INTO hub_sync_log (site_id, started_at, completed_at, records_fetched, status, error)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(site.id, startedAt, new Date().toISOString(), recordsFetched, syncError ? 'error' : 'ok', syncError || null);

    return { site_id: site.id, site_slug: site.slug, records_fetched: recordsFetched, error: syncError };
  }

  async function syncAllSites() {
    console.log(`[HUB] Syncing ${HUB_SITES.length} site(s)...`);
    const results = await Promise.allSettled(HUB_SITES.map(syncSite));
    results.forEach(r => {
      if (r.status === 'fulfilled') {
        console.log(`[HUB] ${r.value.site_slug}: ${r.value.records_fetched} records, error=${r.value.error || 'none'}`);
      } else {
        console.error('[HUB] Unexpected error:', r.reason);
      }
    });
  }

  // Startup sync after 10s delay
  setTimeout(syncAllSites, 10000);
  // Scheduled every 5 minutes
  setInterval(syncAllSites, 5 * 60 * 1000);

  // --- Hub API routes ---



  // GET /api/hub/proxy-backup?site_id=xxx
  // Proxies a backup download from a site through the Hub server to avoid CORS.
  // Admin-only.
  app.get('/api/hub/proxy-backup', async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });
    const user = db.prepare('SELECT role FROM "user" WHERE id = ?').get(req.session.userId);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const { site_id } = req.query;
    if (!site_id) return res.status(400).json({ error: 'site_id required' });

    const site = db.prepare('SELECT id, name, url FROM hub_sites WHERE id = ?').get(site_id);
    if (!site || !site.url) return res.status(404).json({ error: 'Site not found or no URL' });

    const token = process.env.REPORTING_TOKEN || '';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const upstream = await fetch(`${site.url}/api/backup/download`, {
        headers: { 'x-reporting-token': token },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!upstream.ok) return res.status(upstream.status).json({ error: `Site returned ${upstream.status}` });

      const filename = `cardoso-${site.id}-${new Date().toISOString().slice(0,10)}.db`;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      upstream.body.pipe(res);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // GET /api/hub/backup-status
  // Polls /api/backup/status on each registered site and returns aggregated results.
  // Admin-only (session required).
  app.get('/api/hub/backup-status', async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });
    const user = db.prepare('SELECT role FROM "user" WHERE id = ?').get(req.session.userId);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const sites = db.prepare('SELECT id, name, url FROM hub_sites').all();
    const token = process.env.REPORTING_TOKEN || '';

    const results = await Promise.all(sites.map(async (site) => {
      const base = { site_id: site.id, site_name: site.name, url: site.url };
      if (!site.url) return { ...base, error: 'No API URL configured', status: 'unknown' };
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const r = await fetch(`${site.url}/api/backup/status`, {
          headers: { 'x-reporting-token': token },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!r.ok) return { ...base, error: `HTTP ${r.status}`, status: 'error' };
        const data = await r.json();
        // Determine health
        let status = 'ok';
        if (!data.last_backup) {
          status = 'never';
        } else {
          const hoursAgo = (Date.now() - new Date(data.last_backup.mtime).getTime()) / 3600000;
          if (hoursAgo > 48) status = 'stale';
          else if (hoursAgo > 25) status = 'warning';
        }
        return { ...base, ...data, status };
      } catch (err) {
        return { ...base, error: err.name === 'AbortError' ? 'Timeout' : err.message, status: 'unreachable' };
      }
    }));

    res.json({ sites: results });
  });

  // GET /api/hub/sites
  // Accessible via session (dashboard) OR x-reporting-token (scripts/hub-pull-backups.ps1)
  app.get('/api/hub/sites', (req, res) => {
    const tokenHeader = req.headers['x-reporting-token'];
    const expectedToken = process.env.REPORTING_TOKEN;
    const authedByToken = expectedToken && tokenHeader === expectedToken;
    if (!authedByToken && !req.session?.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const rawSites = db.prepare('SELECT * FROM hub_sites').all();
    const mapped = rawSites.map(s => ({ ...s, last_kpis: s.last_kpis ? JSON.parse(s.last_kpis) : null }));
    // Returns JSON array — compatible with both the UI and hub-pull-backups.ps1
    res.json(mapped);
  });

  // GET /api/hub/records
  app.get('/api/hub/records', (req, res) => {
    const { site_id, flag_color, search } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 500, 10000);
    let query = 'SELECT * FROM hub_records WHERE 1=1';
    const params = [];
    if (site_id) { query += ' AND site_id=?'; params.push(site_id); }
    if (flag_color) { query += ' AND flag_color=?'; params.push(flag_color); }
    if (search) { query += ' AND (customer_name LIKE ? OR customer_number LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    query += ` ORDER BY updated_date DESC LIMIT ${limit}`;
    const rows = db.prepare(query).all(...params);
    res.json({ count: rows.length, records: rows });
  });

  // GET /api/hub/kpis
  app.get('/api/hub/kpis', (req, res) => {
    const sites = db.prepare('SELECT * FROM hub_sites').all();
    const totals = db.prepare('SELECT flag_color, COUNT(*) as count FROM hub_records GROUP BY flag_color').all();
    const totalRecords = db.prepare('SELECT COUNT(*) as count FROM hub_records').get();

    const flagTotals = { none: 0, red: 0, orange: 0, green: 0 };
    for (const row of totals) {
      if (row.flag_color in flagTotals) flagTotals[row.flag_color] = row.count;
    }

    const perSite = sites.map(s => {
      const kpis = s.last_kpis ? JSON.parse(s.last_kpis) : null;
      return {
        site_id: s.id,
        site_slug: s.slug,
        site_name: s.name,
        status: s.status,
        last_seen: s.last_seen,
        kpis,
      };
    });

    res.json({
      total_records: totalRecords.count,
      records_by_flag: flagTotals,
      sites: perSite,
      generated_at: new Date().toISOString(),
    });
  });

  // GET /api/hub/inventory
  app.get('/api/hub/inventory', requireAuth, (req, res) => {
    const { site_id, search } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 500, 10000);
    let query = 'SELECT * FROM hub_inventory WHERE 1=1';
    const params = [];
    if (site_id) { query += ' AND site_id=?'; params.push(site_id); }
    if (search) { query += ' AND (item_number LIKE ? OR item_description LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    query += ` ORDER BY item_number ASC LIMIT ${limit}`;
    try {
      const rows = db.prepare(query).all(...params);
      res.json({ count: rows.length, records: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/hub/sync-log
  app.get('/api/hub/sync-log', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const rows = db.prepare(
      'SELECT * FROM hub_sync_log ORDER BY started_at DESC LIMIT ?'
    ).all(limit);
    res.json(rows);
  });

  // POST /api/hub/sync
  app.post('/api/hub/sync', (req, res) => {
    res.status(202).json({ message: 'Sync triggered', sites: HUB_SITES.map(s => s.slug) });
    syncAllSites().catch(err => console.error('[HUB] Manual sync error:', err));
  });

  // ==================== HUB: CENTRALISED USER MANAGEMENT ====================

  // GET /api/hub/users — list all users on this hub (admin only)
  app.get('/api/hub/users', requireAuth, requireAdmin, (req, res) => {
    try {
      const users = db.prepare(`
        SELECT id, email, full_name, role, is_active, hub_redirect,
               can_access_connections, can_manage_users, can_manage_rules,
               can_edit_records, can_flag_records, created_date
        FROM "user" ORDER BY role DESC, full_name ASC
      `).all();
      res.json(users.map(u => ({
        ...u,
        is_active: boolFromRow(u.is_active, true),
        hub_redirect: boolFromRow(u.hub_redirect, false),
        can_access_connections: boolFromRow(u.can_access_connections, false),
        can_manage_users: boolFromRow(u.can_manage_users, false),
        can_manage_rules: boolFromRow(u.can_manage_rules, false),
        can_edit_records: boolFromRow(u.can_edit_records, true),
        can_flag_records: boolFromRow(u.can_flag_records, true),
      })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/hub/push-users — push selected users to one or all sites
  app.post('/api/hub/push-users', requireAuth, requireAdmin, async (req, res) => {
    const { user_ids, site_ids } = req.body; // site_ids = null means all sites
    if (!Array.isArray(user_ids) || user_ids.length === 0) {
      return res.status(400).json({ error: 'user_ids required' });
    }

    const usersToSync = db.prepare(`
      SELECT id, email, full_name, role, is_active, hub_redirect,
             can_access_connections, can_manage_users, can_manage_rules,
             can_edit_records, can_flag_records
      FROM "user" WHERE id IN (${user_ids.map(() => '?').join(',')})
    `).all(...user_ids);

    if (usersToSync.length === 0) return res.status(404).json({ error: 'No matching users' });

    const targetSites = site_ids
      ? HUB_SITES.filter(s => site_ids.includes(s.id))
      : HUB_SITES;

    if (targetSites.length === 0) return res.status(400).json({ error: 'No target sites' });

    const results = await Promise.allSettled(targetSites.map(async (site) => {
      const resp = await fetch(`${site.url}/api/hub/receive-users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Reporting-Token': site.token,
        },
        body: JSON.stringify({ users: usersToSync }),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`${site.name}: HTTP ${resp.status} — ${body}`);
      }
      return { site: site.name, ok: true };
    }));

    const summary = results.map((r, i) => ({
      site: targetSites[i].name,
      ok: r.status === 'fulfilled',
      error: r.status === 'rejected' ? r.reason.message : null,
    }));

    const allOk = summary.every(s => s.ok);
    res.status(allOk ? 200 : 207).json({ results: summary });
  });

  // POST /api/hub/receive-users — site endpoint: receive users pushed from hub
  app.post(`/api/hub/receive-users`, async (req, res) => {
    const token = req.headers['x-reporting-token'];
    const expectedToken = process.env.REPORTING_TOKEN;
    if (!expectedToken || token !== expectedToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { users } = req.body;
    if (!Array.isArray(users) || users.length === 0) {
      return res.status(400).json({ error: 'users array required' });
    }

    let created = 0, updated = 0, errors = [];

    for (const u of users) {
      try {
        const existing = db.prepare('SELECT id FROM "user" WHERE email = ?').get(u.email);
        if (existing) {
          // Update everything except password_hash — never overwrite local password
          db.prepare(`
            UPDATE "user" SET
              full_name = ?, role = ?, is_active = ?, hub_redirect = ?,
              can_access_connections = ?, can_manage_users = ?, can_manage_rules = ?,
              can_edit_records = ?, can_flag_records = ?
            WHERE email = ?
          `).run(
            u.full_name || null,
            u.role || 'user',
            u.is_active ? 1 : 0,
            u.hub_redirect ? 1 : 0,
            u.can_access_connections ? 1 : 0,
            u.can_manage_users ? 1 : 0,
            u.can_manage_rules ? 1 : 0,
            u.can_edit_records ? 1 : 0,
            u.can_flag_records ? 1 : 0,
            u.email
          );
          updated++;
        } else {
          // Create new user — no password set (they must set one or reset locally)
          const defaultPw = process.env.DEFAULT_USER_PASSWORD || `Cardoso@${new Date().getFullYear()}`;
          const defaultHash = await bcrypt.hash(defaultPw, 12);
          db.prepare(`
            INSERT INTO "user" (email, full_name, role, is_active, hub_redirect, must_change_password,
              can_access_connections, can_manage_users, can_manage_rules,
              can_edit_records, can_flag_records, password_hash)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
          `).run(
            u.email,
            u.full_name || null,
            u.role || 'user',
            u.is_active ? 1 : 0,
            u.hub_redirect ? 1 : 0,
            u.can_access_connections ? 1 : 0,
            u.can_manage_users ? 1 : 0,
            u.can_manage_rules ? 1 : 0,
            u.can_edit_records ? 1 : 0,
            u.can_flag_records ? 1 : 0,
            defaultHash
          );
          created++;
        }
      } catch (err) {
        errors.push({ email: u.email, error: err.message });
      }
    }

    res.json({ created, updated, errors });
  });

  // Migrate hub_records schema for existing databases
  const hubFinancialCols = [
    'outstanding_balance', 'last_unpaid_invoice_1', 'last_unpaid_invoice_1_amount', 'last_unpaid_invoice_1_date', 'last_unpaid_invoice_2', 'last_unpaid_invoice_2_amount', 'last_unpaid_invoice_2_date', 'last_unpaid_invoice_3', 'last_unpaid_invoice_3_amount', 'last_unpaid_invoice_3_date', 'last_unpaid_invoice_4', 'last_unpaid_invoice_4_amount', 'last_unpaid_invoice_4_date', 'last_unpaid_invoice_5', 'last_unpaid_invoice_5_amount', 'last_unpaid_invoice_5_date', 'last_receipt_1', 'last_receipt_1_amount', 'last_receipt_1_date', 'last_receipt_2', 'last_receipt_2_amount', 'last_receipt_2_date', 'last_receipt_3', 'last_receipt_3_amount', 'last_receipt_3_date', 'last_receipt_4', 'last_receipt_4_amount', 'last_receipt_4_date', 'last_receipt_5', 'last_receipt_5_amount', 'last_receipt_5_date',
  ];
  const existingCols = db.prepare("PRAGMA table_info(hub_records)").all().map(c => c.name);
  for (const col of hubFinancialCols) {
    if (!existingCols.includes(col)) {
      db.prepare(`ALTER TABLE hub_records ADD COLUMN ${col} TEXT`).run();
      console.log(`[HUB] Migrated hub_records: added column ${col}`);
    }
  }

  console.log('[HUB] Hub ETL initialized. Sites:', HUB_SITES.map(s => s.slug).join(', ') || 'none configured');
}


// ==================== DYNAMIC CRUD ROUTES ====================

app.post('/api/apply-auto-flags', requireAuth, (req, res) => {
  try {
    const rules = db.prepare(`SELECT * FROM autoflagrule WHERE is_active = 1 ORDER BY priority DESC`).all();
    const activeRules = rules.map(r => {
      try { r.conditions = JSON.parse(r.conditions || '[]'); } catch { r.conditions = []; }
      return r;
    });
    if (activeRules.length === 0) return res.json({ flagged: 0, cleared: 0 });

    const records = db.prepare(`SELECT * FROM datarecord`).all();
    let flagged = 0, cleared = 0;

    const updateFlag = db.prepare(`UPDATE datarecord SET flag_color = ?, flag_reason = ?, auto_flagged = ?, flag_source = 'auto' WHERE id = ?`);
    const clearFlag = db.prepare(`UPDATE datarecord SET flag_color = NULL, flag_reason = NULL, auto_flagged = 0, flag_source = NULL WHERE id = ?`);

    const applyAll = db.transaction(() => {
      for (const record of records) {
        const manuallyFlagged = record.flag_color && !record.auto_flagged && record.flag_created_by;
        if (manuallyFlagged) continue;

        const autoFlag = applyAutoFlagRulesToRecord(record, activeRules);
        if (autoFlag) {
          updateFlag.run(autoFlag.flag_color, autoFlag.flag_reason, 1, record.id);
          flagged++;
        } else if (record.auto_flagged) {
          clearFlag.run(record.id);
          cleared++;
        }
      }
    });
    applyAll();
    res.json({ flagged, cleared });
  } catch (err) {
    console.error('apply-auto-flags error:', err);
    res.status(500).json({ error: err.message });
  }
});


app.post('/api/clear-auto-flags', requireAuth, (req, res) => {
  try {
    const result = db.prepare(`UPDATE datarecord SET flag_color = NULL, flag_reason = NULL, auto_flagged = 0, flag_source = NULL WHERE auto_flagged = 1`).run();
    res.json({ cleared: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ─── Auto-Flag Rules Export / Import ─────────────────────────────────────────

app.get('/api/autoflagrule/export', requireAuth, requireAdmin, (req, res) => {
  try {
    const rules = db.prepare(`SELECT rule_name, priority, conditions, flag_color, is_active FROM autoflagrule ORDER BY priority DESC`).all();
    const exportData = rules.map(r => ({
      name: r.rule_name,
      priority: r.priority,
      color: r.flag_color,
      is_active: r.is_active,
      conditions: (() => { try { return JSON.parse(r.conditions); } catch { return r.conditions; } })()
    }));
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="cardoso-rules-export.json"');
    res.json(exportData);
  } catch (err) {
    console.error('[export error]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/autoflagrule/import', requireAuth, requireAdmin, (req, res) => {
  try {
    const rules = req.body;
    if (!Array.isArray(rules)) return res.status(400).json({ error: 'Expected array of rules' });

    let created = 0, updated = 0, skipped = 0;
    const upsert = db.transaction(() => {
      for (const rule of rules) {
        if (!rule.name || !rule.conditions) { skipped++; continue; }
        const ruleColor = rule.color ?? rule.flag_color ?? 'red';
        const condStr = typeof rule.conditions === 'string' ? rule.conditions : JSON.stringify(rule.conditions);
        const existing = db.prepare(`SELECT id FROM autoflagrule WHERE rule_name = ?`).get(rule.name);
        if (existing) {
          db.prepare(`UPDATE autoflagrule SET priority = ?, conditions = ?, flag_color = ?, is_active = ? WHERE id = ?`)
            .run(rule.priority ?? 1, condStr, ruleColor, rule.is_active ?? 1, existing.id);
          updated++;
        } else {
          db.prepare(`INSERT INTO autoflagrule (rule_name, priority, conditions, flag_color, is_active) VALUES (?, ?, ?, ?, ?)`)
            .run(rule.name, rule.priority ?? 1, condStr, ruleColor, rule.is_active ?? 1);
          created++;
        }
      }
    });
    upsert();
    res.json({ created, updated, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
    // Optional sort: ?sort=priority (asc) or ?sort=-priority (desc)
    const sortParam = req.query.sort;
    let orderClause = '';
    if (sortParam) {
      const desc = sortParam.startsWith('-');
      const col = desc ? sortParam.slice(1) : sortParam;
      const validCols = getTableColumns(table);
      if (validCols.has(col)) {
        orderClause = ` ORDER BY "${col}" ${desc ? 'DESC' : 'ASC'}`;
      }
    }
    const stmt = db.prepare(`SELECT * FROM "${table}"${orderClause}`);
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

  // Serialize JSON fields that must be stored as strings
  if (table === 'autoflagrule' && data.conditions !== undefined && typeof data.conditions !== 'string') {
    data.conditions = JSON.stringify(data.conditions);
  }

  if (table === 'databaseconnection' && data.status !== undefined) {
    const allowedStatuses = new Set(['active', 'inactive', 'error', 'testing']);
    if (!allowedStatuses.has(data.status)) {
      return res.status(400).json({ error: `Invalid status: ${data.status}` });
    }
  }

  // Encrypt MSSQL password before storing
  if (table === 'databaseconnection' && data.encrypted_password) {
    data.encrypted_password = encryptPassword(data.encrypted_password);
  }

  // Serialize conditions array for autoflagrule
  if (table === 'autoflagrule' && data.conditions !== undefined && typeof data.conditions !== 'string') {
    data.conditions = JSON.stringify(data.conditions);
  }

  try {
    const columns = Object.keys(data);
    if (columns.length === 0) {
      return res.status(400).json({ error: 'No data provided' });
    }

    // Validate column names against actual schema to prevent injection
    const validColumns = getTableColumns(table);
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

  let data = sanitizeForSqlite(req.body);

  if (table === 'databaseconnection' && data.status !== undefined) {
    const allowedStatuses = new Set(['active', 'inactive', 'error', 'testing']);
    if (!allowedStatuses.has(data.status)) {
      return res.status(400).json({ error: `Invalid status: ${data.status}` });
    }
  }

  // Encrypt MSSQL password before storing
  if (table === 'databaseconnection' && data.encrypted_password) {
    data.encrypted_password = encryptPassword(data.encrypted_password);
  }

  // Serialize conditions array for autoflagrule
  if (table === 'autoflagrule' && data.conditions !== undefined && typeof data.conditions !== 'string') {
    data.conditions = JSON.stringify(data.conditions);
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

    // Sanitize booleans/undefined to SQLite-compatible types
    data = sanitizeForSqlite(data);

    const keys = Object.keys(data);
    if (keys.length === 0) {
      return res.status(400).json({ error: 'No data provided' });
    }

    // Validate column names against actual schema to prevent injection
    const validColumns = getTableColumns(table);
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