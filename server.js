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
        unpaid_invoices = ?,
        receipts = ?,
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
        unpaid_invoices,
        receipts,
        terms,
        note,
        synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const inventoryMappingConfig = {
      item_number:      { fallbacks: ['item_number', 'Item Number', 'ItemNumber', 'ITEM_NUMBER', 'ItemNo', 'ITEMNO', 'item_no'] },
      item_description: { fallbacks: ['item_description', 'Item Description', 'ItemDescription', 'ITEM_DESCRIPTION', 'Description', 'DESC', 'ItemDesc', 'ItemName'] },
      qty_on_hand:      { fallbacks: ['qty_on_hand', 'Qty on Hand', 'QtyOnHand', 'QTY_ON_HAND', 'Quantity', 'QTY', 'OnHand', 'QTYONHAND', 'TotalLiveQtyOnHand'] },
      last_cost:        { fallbacks: ['last_cost', 'Last Cost', 'LastCost', 'LAST_COST', 'Cost', 'COST', 'RECENTCOST', 'LowestRecentCost'] },
      price_list:       { fallbacks: ['price_list', 'Price List', 'PriceList', 'PRICE_LIST', 'Pricelist', 'PRICELIST'] },
      price:            { fallbacks: ['price', 'Price', 'PRICE', 'SellPrice', 'UnitPrice', 'UNITPRICE', 'HighestUnitPrice'] },
      stocking_uom:     { fallbacks: ['stocking_uom', 'StockingUnitOfMeasure', 'Stocking Unit of measure', 'Stocking Unit', 'StockingUOM', 'UOM', 'STOCKUNIT', 'stk_uom'] },
      commodity:        { fallbacks: ['commodity', 'CommodityNumber', 'Commodity', 'COMMODITY', 'Category', 'ItemCategory'] },
      inventory_value:  { fallbacks: ['inventory_value', 'InventoryValue', 'TotalInventoryValueAtCost', 'TotalValue', 'inventory_value_at_cost'] },
    };

    const upsertInventoryRecord = db.prepare(`
      INSERT INTO inventoryrecord (source_table, item_number, item_description, qty_on_hand, last_cost, price_list, price, stocking_uom, commodity, inventory_value, updated_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_table, item_number) DO UPDATE SET
        item_description=excluded.item_description,
        qty_on_hand=excluded.qty_on_hand,
        last_cost=excluded.last_cost,
        price_list=excluded.price_list,
        price=excluded.price,
        stocking_uom=excluded.stocking_uom,
        commodity=excluded.commodity,
        inventory_value=excluded.inventory_value,
        updated_date=excluded.updated_date
    `);

    const runInventoryRows = (rows, sourceName, mappings = {}) => {
      const syncTimestamp = new Date().toISOString();
      const writeInventory = db.transaction((rowsToWrite) => {
        for (const row of rowsToWrite) {
          const itemNumber = String(
            getMappedOrFallbackValue(row, mappings, 'item_number', inventoryMappingConfig.item_number.fallbacks) || ''
          );
          if (!itemNumber) continue;
          upsertInventoryRecord.run(
            sourceName,
            itemNumber,
            String(getMappedOrFallbackValue(row, mappings, 'item_description', inventoryMappingConfig.item_description.fallbacks) || ''),
            String(getMappedOrFallbackValue(row, mappings, 'qty_on_hand', inventoryMappingConfig.qty_on_hand.fallbacks) || ''),
            String(getMappedOrFallbackValue(row, mappings, 'last_cost', inventoryMappingConfig.last_cost.fallbacks) || ''),
            String(getMappedOrFallbackValue(row, mappings, 'price_list', inventoryMappingConfig.price_list.fallbacks) || ''),
            String(getMappedOrFallbackValue(row, mappings, 'price', inventoryMappingConfig.price.fallbacks) || ''),
            String(getMappedOrFallbackValue(row, mappings, 'stocking_uom', inventoryMappingConfig.stocking_uom.fallbacks) || ''),
            String(getMappedOrFallbackValue(row, mappings, 'commodity', inventoryMappingConfig.commodity.fallbacks) || ''),
            String(getMappedOrFallbackValue(row, mappings, 'inventory_value', inventoryMappingConfig.inventory_value.fallbacks) || ''),
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
               outstanding_balance, terms, unpaid_invoices, receipts
        FROM datarecord
        WHERE source_table = ?
      `).all(sourceName);

      const existingMap = new Map(
        existingRows.map((r) => [`${r.source_table}::${r.source_id}`, r])
      );

      const syncTimestamp = new Date().toISOString();

      // Load active auto-flag rules once for the entire sync batch
      const activeAutoFlagRules = stmts.activeAutoFlagRules.all();

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
              baseRecordData.unpaid_invoices ?? existing.unpaid_invoices ?? '[]',
              baseRecordData.receipts ?? existing.receipts ?? '[]',
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
               const mergedRecord = expandDataRecord({ ...existing, ...baseRecordData });
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
              baseRecordData.unpaid_invoices ?? '[]',
              baseRecordData.receipts ?? '[]',
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
        runInventoryRows(rows, sourceName, queryFieldMappings);
        // Prune items no longer returned by the query (upsert-then-prune keeps data live)
        const freshItemNumbers = rows.map(r =>
          String(getMappedOrFallbackValue(r, queryFieldMappings, 'item_number', inventoryMappingConfig.item_number.fallbacks) || '')
        ).filter(Boolean);
        if (freshItemNumbers.length > 0) {
          const placeholders = freshItemNumbers.map(() => '?').join(',');
          db.prepare(
            `DELETE FROM inventoryrecord WHERE source_table = ? AND item_number NOT IN (${placeholders})`
          ).run(sourceName, ...freshItemNumbers);
        }
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
          runInventoryRows(rows, table_name, fieldMappings);
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

// Login-log and user routes are now in src/routes/auth.js

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
      unpaid_invoices TEXT,
      receipts TEXT,
      updated_date TEXT,
      synced_at TEXT,
      auto_flagged INTEGER DEFAULT 0,
      terms TEXT,
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
    CREATE TABLE IF NOT EXISTS hub_settings (
      key TEXT PRIMARY KEY,
      value TEXT
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
      stocking_uom TEXT,
      commodity TEXT,
      terms TEXT,
      synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(site_id, item_number)
    );
  `);

  // Seed default hub settings
  db.prepare(`INSERT OR IGNORE INTO hub_settings (key, value) VALUES ('backup_sync_enabled', 'true')`).run();

  // GET /api/hub/backup-settings
  app.get('/api/hub/backup-settings', (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });
    const user = db.prepare('SELECT role FROM "user" WHERE id = ?').get(req.session.userId);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const row = stmts.getHubSetting.get('backup_sync_enabled');
    res.json({ backup_sync_enabled: row ? row.value === 'true' : true });
  });

  app.post('/api/hub/backup-settings', (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });
    const user = db.prepare('SELECT role FROM "user" WHERE id = ?').get(req.session.userId);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { backup_sync_enabled } = req.body;
    if (typeof backup_sync_enabled !== 'boolean') return res.status(400).json({ error: 'backup_sync_enabled must be boolean' });
    stmts.setHubSetting.run('backup_sync_enabled', backup_sync_enabled ? 'true' : 'false');
    res.json({ ok: true, backup_sync_enabled });
  });

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
          outstanding_balance, unpaid_invoices, receipts,
          updated_date, synced_at
        ) VALUES (
          @site_id, @record_id, @customer_number, @customer_name, @flag_color, @flag_reason,
          @outstanding_balance, @unpaid_invoices, @receipts,
          @updated_date, @synced_at
        )
        ON CONFLICT(site_id, record_id) DO UPDATE SET
          customer_number=excluded.customer_number,
          customer_name=excluded.customer_name,
          flag_color=excluded.flag_color,
          flag_reason=excluded.flag_reason,
          outstanding_balance=excluded.outstanding_balance,
          unpaid_invoices=excluded.unpaid_invoices,
          receipts=excluded.receipts,
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
            unpaid_invoices: r.unpaid_invoices || '[]',
            receipts: r.receipts || '[]',
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
        INSERT INTO hub_inventory (site_id, item_number, item_description, qty_on_hand, last_cost, price_list, price, stocking_uom, commodity, inventory_value, synced_at)
        VALUES (@site_id, @item_number, @item_description, @qty_on_hand, @last_cost, @price_list, @price, @stocking_uom, @commodity, @inventory_value, @synced_at)
        ON CONFLICT(site_id, item_number) DO UPDATE SET
          item_description=excluded.item_description,
          qty_on_hand=excluded.qty_on_hand,
          last_cost=excluded.last_cost,
          price_list=excluded.price_list,
          price=excluded.price,
          stocking_uom=excluded.stocking_uom,
          commodity=excluded.commodity,
          inventory_value=excluded.inventory_value,
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
            stocking_uom: r.stocking_uom || null,
            commodity: r.commodity || null,
            inventory_value: r.inventory_value || null,
            synced_at: now,
          });
        }
      });
      const syncedItemNumbers = [];
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
          invData.records.forEach(r => { if (r.item_number) syncedItemNumbers.push(r.item_number); });
          invOffset += invData.records.length;
        }
        invHasMore = invData.has_more === true;
      }
      // Prune hub_inventory rows no longer in the site's query (upsert-then-prune)
      if (syncedItemNumbers.length > 0) {
        const placeholders = syncedItemNumbers.map(() => '?').join(',');
        db.prepare(
          `DELETE FROM hub_inventory WHERE site_id = ? AND item_number NOT IN (${placeholders})`
        ).run(site.id, ...syncedItemNumbers);
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
    const { site_id, search, commodity } = req.query;
    let query = 'SELECT hi.*, COALESCE(s.name, hi.site_id) AS site_name FROM hub_inventory hi LEFT JOIN hub_sites s ON s.id = hi.site_id WHERE 1=1';
    const params = [];
    if (site_id) { query += ' AND hi.site_id=?'; params.push(site_id); }
    if (search) { query += ' AND (hi.item_number LIKE ? OR hi.item_description LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    if (commodity) { query += ' AND CAST(commodity AS TEXT)=?'; params.push(commodity); }
    query += ' ORDER BY hi.item_number ASC';
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

  // POST /api/hub/force-resync — clears sync history and hub_records, triggers full re-pull
  app.post('/api/hub/force-resync', requireAuth, requireAdmin, (req, res) => {
    try {
      db.prepare('DELETE FROM hub_sync_log').run();
      db.prepare('DELETE FROM hub_records').run();
      db.prepare('DELETE FROM hub_inventory').run();
      res.status(202).json({ message: 'Force resync triggered — full pull from all sites' });
      syncAllSites().catch(err => console.error('[HUB] Force resync error:', err));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/hub/force-resync/:siteId — per-site force resync
  app.post('/api/hub/force-resync/:siteId', requireAuth, requireAdmin, (req, res) => {
    const { siteId } = req.params;
    try {
      db.prepare("DELETE FROM hub_sync_log WHERE site_id = ?").run(siteId);
      db.prepare("DELETE FROM hub_records WHERE site_id = ?").run(siteId);
      db.prepare("DELETE FROM hub_inventory WHERE site_id = ?").run(siteId);
      syncAllSites().catch(err => console.error("force-resync error:", err));
      res.status(202).json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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

  console.log('[HUB] Hub ETL initialized. Sites:', HUB_SITES.map(s => s.slug).join(', ') || 'none configured');
}


// ==================== NON-HUB FALLBACKS ====================
// Return empty/minimal responses for hub endpoints called by UI on non-hub installs
if (process.env.HUB_MODE !== 'true') {
  app.get('/api/hub/sites', (req, res) => res.json([]));
  app.get('/api/hub/records', (req, res) => res.json({ records: [], total: 0 }));
  app.get('/api/hub/kpis', (req, res) => res.json({ sites: [] }));
  app.get('/api/hub/inventory', (req, res) => res.json([]));
  app.get('/api/hub/sync-log', (req, res) => res.json([]));
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

// Hub backup pull cron (03:00 daily, hub mode only)
let hubBackupCronTask = null;
async function runHubBackupPull() {
  if (process.env.HUB_MODE !== 'true') return;
  const row = stmts.getHubSetting.get('backup_sync_enabled');
  const enabled = row ? row.value === 'true' : true;
  if (!enabled) {
    console.log('[HUB BACKUP] Skipping scheduled pull — backup sync disabled.');
    return;
  }
  const sites = stmts.hubSitesForBackup.all();
  const token = process.env.REPORTING_TOKEN || '';
  console.log(`[HUB BACKUP] Starting parallel pull for ${sites.length} site(s)`);
  const { mkdirSync, writeFileSync } = await import('fs');
  const pathMod = await import('path');
  await Promise.allSettled(sites.map(async (site) => {
    try {
      const controller = new AbortController();
      const hardTimeout = setTimeout(() => controller.abort(), 30000);
      const upstream = await fetch(`${site.url}/api/backup/download`, {
        headers: { 'x-reporting-token': token },
        signal: controller.signal,
      });
      clearTimeout(hardTimeout);
      if (!upstream.ok) { console.error(`[HUB BACKUP] ${site.name}: HTTP ${upstream.status}`); return; }
      const buf = Buffer.from(await upstream.arrayBuffer());
      const dir = pathMod.join(process.cwd(), 'database', 'hub-backups', site.id);
      mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const file = pathMod.join(dir, `cardoso-${site.id}-${ts}.db`);
      writeFileSync(file, buf);
      console.log(`[HUB BACKUP] ${site.name}: saved ${buf.length} bytes -> ${file}`);
    } catch (err) {
      console.error(`[HUB BACKUP] ${site.name}: ${err.message}`);
    }
  }));
}
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
        runConnectionImport(conn.id).catch(err => console.error(`[auto-sync] error for ${conn.id}:`, err));
      }
    }
  } catch (err) {
    console.error("[auto-sync] scheduler error:", err);
  }
}, 5 * 60 * 1000);