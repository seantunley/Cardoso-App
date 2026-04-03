/**
 * Database schema initialisation — PRAGMAs, core tables, indexes.
 * Extracted from server.js for US-002.
 */
import { runMigrations } from './migrations.js';

function initSchema(db) {
  // Performance PRAGMAs
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('cache_size = -65536');
  db.pragma('mmap_size = 268435456');
  db.pragma('temp_store = MEMORY');
  db.exec('PRAGMA optimize');

  // schema_migrations table (needed before running migrations)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

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

  // ==================== INDEXES ====================
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

    CREATE INDEX IF NOT EXISTS idx_datarecord_updated_date
    ON datarecord (updated_date);
  `);

  // ==================== INVENTORY TABLE ====================
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
      stocking_uom TEXT,
      commodity TEXT,
      inventory_value TEXT,
      terms TEXT,
      created_date TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_date TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_table, item_number)
    );
    CREATE INDEX IF NOT EXISTS idx_inventoryrecord_source ON inventoryrecord (source_table, item_number);
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_auditlog_created_date ON auditlog(created_date)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_login_log_logged_in_at ON login_log(logged_in_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_syncrun_connection_id ON syncrun(connection_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_datarecord_auto_flagged ON datarecord(auto_flagged)`);

  // ==================== FLEXIBLE CUSTOM FIELD CONFIG TABLE ====================
  ensureFlexibleCustomFieldConfigTable(db);

  // ==================== RUN MIGRATIONS ====================
  runMigrations(db);

  // ==================== HUB TABLES (after migrations, so tables exist before any prepared statements) ====================
  if (process.env.HUB_MODE === 'true') {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hub_sites (
        id TEXT PRIMARY KEY,
        slug TEXT,
        name TEXT,
        url TEXT,
        token TEXT,
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
        inventory_value TEXT,
        terms TEXT,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(site_id, item_number)
      );
    `);
    db.prepare(`INSERT OR IGNORE INTO hub_settings (key, value) VALUES ('backup_sync_enabled', 'true')`).run();
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_hub_records_site_id ON hub_records(site_id);
      CREATE INDEX IF NOT EXISTS idx_hub_records_customer_number ON hub_records(customer_number);
      CREATE INDEX IF NOT EXISTS idx_hub_records_flag_color ON hub_records(flag_color);
      CREATE INDEX IF NOT EXISTS idx_hub_sync_log_site_id ON hub_sync_log(site_id);
    `);
  }
}

function ensureFlexibleCustomFieldConfigTable(db) {
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

export { initSchema };
/**
 * Database migrations — versioned schema changes.
 * Extracted from server.js for US-002.
 */

function ensureColumn(db, tableName, columnName, definition) {
  const cols = db.prepare(`PRAGMA table_info("${tableName}")`).all();
  const exists = cols.some((c) => c.name === columnName);
  if (!exists) {
    db.exec(`ALTER TABLE "${tableName}" ADD COLUMN ${columnName} ${definition}`);
  }
}

function buildMigrations(db) {
  return [
    {
      version: 1,
      name: 'initial_schema_columns',
      up() {
        ensureColumn(db, 'datarecord', 'local_fields', `TEXT DEFAULT '{}'`);
        ensureColumn(db, 'databaseconnection', 'last_error', 'TEXT');
        ensureColumn(db, 'datarecord', 'age_current', 'TEXT');
        ensureColumn(db, 'datarecord', 'age_7_days', 'TEXT');
        ensureColumn(db, 'datarecord', 'age_14_days', 'TEXT');
        ensureColumn(db, 'datarecord', 'age_21_days', 'TEXT');
        ensureColumn(db, 'datarecord', 'outstanding_balance', 'TEXT');
      },
    },
    {
      version: 2,
      name: 'invoice_receipt_numbered_columns',
      up() {
        for (let i = 1; i <= 5; i++) {
          ensureColumn(db, 'datarecord', `last_unpaid_invoice_${i}`, 'TEXT');
          ensureColumn(db, 'datarecord', `last_unpaid_invoice_${i}_amount`, 'TEXT');
          ensureColumn(db, 'datarecord', `last_unpaid_invoice_${i}_date`, 'TEXT');
          ensureColumn(db, 'datarecord', `last_receipt_${i}`, 'TEXT');
          ensureColumn(db, 'datarecord', `last_receipt_${i}_amount`, 'TEXT');
          ensureColumn(db, 'datarecord', `last_receipt_${i}_date`, 'TEXT');
        }
        // One-time data migration: copy old singular field names into new _1 slots
        const colNames = db.prepare('PRAGMA table_info(datarecord)').all().map(c => c.name);
        const renames = [
          ['last_unpaid_invoice_date', 'last_unpaid_invoice_1_date'],
          ['last_receipt_number', 'last_receipt_1'],
          ['last_receipt_amount', 'last_receipt_1_amount'],
          ['last_receipt_date', 'last_receipt_1_date'],
        ];
        for (const [oldCol, newCol] of renames) {
          if (colNames.includes(oldCol) && colNames.includes(newCol)) {
            try {
              db.exec(`UPDATE datarecord SET ${newCol} = ${oldCol} WHERE (${newCol} IS NULL OR ${newCol} = '') AND (${oldCol} IS NOT NULL AND ${oldCol} != '')`);
            } catch(e) { console.warn('Migration skip:', oldCol, '->', newCol, e.message); }
          }
        }
      },
    },
    {
      version: 3,
      name: 'flag_source_and_terms',
      up() {
        ensureColumn(db, 'datarecord', 'flag_source', `TEXT DEFAULT NULL`);
        ensureColumn(db, 'datarecord', 'terms', 'TEXT');
      },
    },
    {
      version: 4,
      name: 'query_mode_and_inventory_columns',
      up() {
        ensureColumn(db, 'databaseconnection', 'sync_query', 'TEXT');
        ensureColumn(db, 'databaseconnection', 'query_index_field', 'TEXT');
        ensureColumn(db, 'databaseconnection', 'query_field_mappings', 'TEXT');
        ensureColumn(db, 'inventoryrecord', 'stocking_uom', 'TEXT');
        ensureColumn(db, 'inventoryrecord', 'commodity', 'TEXT');
        ensureColumn(db, 'inventoryrecord', 'inventory_value', 'TEXT');
        ensureColumn(db, 'databaseconnection', 'record_type', `TEXT DEFAULT 'customer'`);
        ensureColumn(db, 'databaseconnection', 'sync_interval_hours', 'INTEGER');
      },
    },
    {
      version: 5,
      name: 'field_mappings_per_table_format',
      up() {
        const connections = db.prepare('SELECT id, table_configs, field_mappings FROM databaseconnection').all();
        for (const conn of connections) {
          try {
            const raw = JSON.parse(conn.field_mappings || '{}');
            const isFlat = Object.keys(raw).length > 0 &&
              Object.values(raw).some((v) => v && typeof v === 'object' && v.sourceField);
            if (!isFlat) continue;
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
      },
    },
    {
      version: 6,
      name: 'user_permissions',
      up() {
        ensureColumn(db, 'user', 'password_hash', 'TEXT');
        ensureColumn(db, 'user', 'must_change_password', 'INTEGER DEFAULT 0');
        ensureColumn(db, 'user', 'is_active', 'INTEGER DEFAULT 1');
        ensureColumn(db, 'user', 'can_access_customer_search', 'INTEGER DEFAULT 1');
        ensureColumn(db, 'user', 'can_access_records', 'INTEGER DEFAULT 0');
        ensureColumn(db, 'user', 'can_access_reports', 'INTEGER DEFAULT 0');
        ensureColumn(db, 'user', 'can_access_connections', 'INTEGER DEFAULT 0');
        ensureColumn(db, 'user', 'can_access_settings', 'INTEGER DEFAULT 0');
        ensureColumn(db, 'user', 'can_manage_users', 'INTEGER DEFAULT 0');
        ensureColumn(db, 'user', 'can_manage_rules', 'INTEGER DEFAULT 0');
        db.prepare(`UPDATE "user" SET can_manage_rules = 1 WHERE role = 'admin' AND can_manage_rules = 0`).run();
        ensureColumn(db, 'user', 'can_edit_records', 'INTEGER DEFAULT 1');
        ensureColumn(db, 'user', 'can_flag_records', 'INTEGER DEFAULT 1');
        ensureColumn(db, 'user', 'hub_redirect', 'INTEGER DEFAULT 0');
      },
    },
    {
      version: 7,
      name: 'invoice_receipt_json_columns',
      up() {
        // Add JSON array columns to datarecord
        ensureColumn(db, 'datarecord', 'unpaid_invoices', 'TEXT');
        ensureColumn(db, 'datarecord', 'receipts', 'TEXT');

        // Migrate existing numbered columns into JSON arrays
        const rows = db.prepare(`
          SELECT id,
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
          FROM datarecord WHERE unpaid_invoices IS NULL OR receipts IS NULL
        `).all();
        const updateStmt = db.prepare(`UPDATE datarecord SET unpaid_invoices = ?, receipts = ? WHERE id = ?`);
        const migrateRows = db.transaction(() => {
          for (const row of rows) {
            const invoices = [];
            const recs = [];
            for (let i = 1; i <= 5; i++) {
              const num = row[`last_unpaid_invoice_${i}`];
              const amt = row[`last_unpaid_invoice_${i}_amount`];
              const dt  = row[`last_unpaid_invoice_${i}_date`];
              if (num || amt || dt) invoices.push({ date: dt || '', number: num || '', amount: amt || '' });
              const rnum = row[`last_receipt_${i}`];
              const ramt = row[`last_receipt_${i}_amount`];
              const rdt  = row[`last_receipt_${i}_date`];
              if (rnum || ramt || rdt) recs.push({ date: rdt || '', number: rnum || '', amount: ramt || '' });
            }
            updateStmt.run(JSON.stringify(invoices), JSON.stringify(recs), row.id);
          }
        });
        migrateRows();
        if (rows.length > 0) console.log(`[migration 7] Migrated ${rows.length} datarecord rows to JSON invoice/receipt columns`);

        // Hub records migration (only if table exists — new DBs get correct schema from CREATE TABLE)
        if (process.env.HUB_MODE === 'true') {
          const hubExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_records'`).get();
          if (hubExists) {
            ensureColumn(db, 'hub_records', 'unpaid_invoices', 'TEXT');
            ensureColumn(db, 'hub_records', 'receipts', 'TEXT');
            const hubRows = db.prepare(`
              SELECT site_id, record_id,
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
              FROM hub_records WHERE unpaid_invoices IS NULL OR receipts IS NULL
            `).all();
            const updateHub = db.prepare(`UPDATE hub_records SET unpaid_invoices = ?, receipts = ? WHERE site_id = ? AND record_id = ?`);
            const migrateHub = db.transaction(() => {
              for (const row of hubRows) {
                const invoices = [];
                const recs = [];
                for (let i = 1; i <= 5; i++) {
                  const num = row[`last_unpaid_invoice_${i}`];
                  const amt = row[`last_unpaid_invoice_${i}_amount`];
                  const dt  = row[`last_unpaid_invoice_${i}_date`];
                  if (num || amt || dt) invoices.push({ date: dt || '', number: num || '', amount: amt || '' });
                  const rnum = row[`last_receipt_${i}`];
                  const ramt = row[`last_receipt_${i}_amount`];
                  const rdt  = row[`last_receipt_${i}_date`];
                  if (rnum || ramt || rdt) recs.push({ date: rdt || '', number: rnum || '', amount: ramt || '' });
                }
                updateHub.run(JSON.stringify(invoices), JSON.stringify(recs), row.site_id, row.record_id);
              }
            });
            migrateHub();
            if (hubRows.length > 0) console.log(`[migration 7] Migrated ${hubRows.length} hub_records rows to JSON invoice/receipt columns`);
          }
        }
      },
    },
    {
      version: 8,
      name: 'hub_schema_columns',
      up() {
        if (process.env.HUB_MODE !== 'true') return;
        const hubInventoryExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_inventory'`).get();
        if (hubInventoryExists) {
          ensureColumn(db, 'hub_inventory', 'stocking_uom', 'TEXT');
          ensureColumn(db, 'hub_inventory', 'commodity', 'TEXT');
        }
        const hubRecordsExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_records'`).get();
        if (hubRecordsExists) {
          ensureColumn(db, 'hub_records', 'unpaid_invoices', 'TEXT');
          ensureColumn(db, 'hub_records', 'receipts', 'TEXT');
          ensureColumn(db, 'hub_records', 'outstanding_balance', 'TEXT');
          ensureColumn(db, 'hub_records', 'auto_flagged', 'INTEGER DEFAULT 0');
          ensureColumn(db, 'hub_records', 'flag_color', 'TEXT');
          ensureColumn(db, 'hub_records', 'flag_reason', 'TEXT');
          ensureColumn(db, 'hub_records', 'terms', 'TEXT');
          ensureColumn(db, 'hub_records', 'updated_date', 'TEXT');
          ensureColumn(db, 'hub_records', 'synced_at', 'TEXT');
        }
      },
    },
    {
      version: 9,
      name: 'record_snapshots_table',
      up() {
        db.exec(`
          CREATE TABLE IF NOT EXISTS record_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            connection_id TEXT,
            customer_number TEXT,
            snapshot_data TEXT,
            synced_at TEXT
          )
        `);
      },
    },
    {
      version: 10,
      name: 'hub_sites_token',
      up() {
        // Add token column to hub_sites if table exists (covers all installs — hub and sites with legacy hub_sites table)
        const hubSitesExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_sites'`).get();
        if (hubSitesExists) {
          ensureColumn(db, 'hub_sites', 'token', 'TEXT');
        }
      },
    },
    {
      version: 11,
      name: 'hub_inventory_value_column',
      up() {
        // Add inventory_value to hub_inventory — not gated on HUB_MODE so it runs wherever the table exists
        const hubInventoryExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_inventory'`).get();
        if (hubInventoryExists) {
          ensureColumn(db, 'hub_inventory', 'inventory_value', 'TEXT');
        }
      },
    },
    {
      version: 12,
      name: 'inventoryrecord_missing_columns',
      up() {
        // Sites upgraded from v2026.3.1 (monolithic server.js) may have had v4 recorded
        // before stocking_uom/commodity/inventory_value were added to it.
        // This migration ensures those columns exist unconditionally.
        ensureColumn(db, 'inventoryrecord', 'stocking_uom', 'TEXT');
        ensureColumn(db, 'inventoryrecord', 'commodity', 'TEXT');
        ensureColumn(db, 'inventoryrecord', 'inventory_value', 'TEXT');
      },
    },
    {
      version: 13,
      name: 'hub_sites_token_force',
      up() {
        // Migration v10 added hub_sites.token but may have been recorded before
        // the column was actually present (schema drift from old server.js).
        // This migration unconditionally ensures the column exists on any install
        // where hub_sites exists, regardless of prior migration history.
        const hubSitesExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_sites'`).get();
        if (hubSitesExists) {
          ensureColumn(db, 'hub_sites', 'token', 'TEXT');
        }
      },
    },

    {
      version: 14,
      name: 'force_add_missing_columns',
      up() {
        // Force-add columns that may have been silently missed on older installs.
        // Uses raw ALTER TABLE with try/catch instead of ensureColumn so it always
        // attempts the add regardless of migration history.
        const forceAdd = (table, col, def) => {
          try { db.exec(`ALTER TABLE "${table}" ADD COLUMN ${col} ${def}`); } catch (_) {}
        };
        forceAdd('inventoryrecord', 'stocking_uom', 'TEXT');
        forceAdd('inventoryrecord', 'commodity', 'TEXT');
        forceAdd('inventoryrecord', 'inventory_value', 'TEXT');
        const hubInvExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_inventory'`).get();
        if (hubInvExists) {
          forceAdd('hub_inventory', 'stocking_uom', 'TEXT');
          forceAdd('hub_inventory', 'commodity', 'TEXT');
          forceAdd('hub_inventory', 'inventory_value', 'TEXT');
        }
        const hubSitesExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_sites'`).get();
        if (hubSitesExists) {
          forceAdd('hub_sites', 'token', 'TEXT');
        }
      },
    },
  ];
}

function runMigrations(db) {
  const MIGRATIONS = buildMigrations(db);
  for (const migration of MIGRATIONS) {
    const already = db.prepare('SELECT id FROM schema_migrations WHERE version = ?').get(migration.version);
    if (already) continue;
    const run = db.transaction(() => {
      migration.up();
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(migration.version, migration.name);
    });
    try {
      run();
      console.log(`[migration] Applied v${migration.version}: ${migration.name}`);
    } catch (err) {
      console.error(`[migration] Failed v${migration.version} (${migration.name}):`, err.message);
      throw err;
    }
  }
}

export { ensureColumn, buildMigrations, runMigrations };
/**
 * Pre-compiled prepared statements.
 * Extracted from server.js for US-002.
 */

function buildStatements(db) {
  const stmts = {};

  stmts.getUserById        = db.prepare('SELECT * FROM "user" WHERE id = ?');
  stmts.getUserByEmail     = db.prepare('SELECT * FROM "user" WHERE email = ?');
  stmts.updateUserPassword = db.prepare('UPDATE "user" SET password_hash = ? WHERE id = ?');

  stmts.kpiTotalRecords  = db.prepare('SELECT COUNT(*) as count FROM datarecord');
  stmts.kpiFlagCounts    = db.prepare('SELECT flag_color, COUNT(*) as count FROM datarecord GROUP BY flag_color');
  stmts.kpiLastSync      = db.prepare('SELECT MAX(synced_at) as last_sync FROM datarecord');
  stmts.kpiLastRun       = db.prepare('SELECT MAX(last_sync) as last_run FROM databaseconnection');
  stmts.kpiActiveConns   = db.prepare("SELECT COUNT(*) as count FROM databaseconnection WHERE status = 'active'");

  stmts.activeAutoFlagRules  = db.prepare('SELECT * FROM autoflagrule WHERE is_active = 1 ORDER BY priority DESC');
  stmts.autoRecordsForFlags  = db.prepare('SELECT * FROM datarecord');
  stmts.updateAutoFlag       = db.prepare('UPDATE datarecord SET flag_color = ?, flag_source = ? WHERE id = ?');
  stmts.clearAutoFlag        = db.prepare("UPDATE datarecord SET flag_color = 'none', flag_source = NULL WHERE id = ? AND flag_source = ?");
  stmts.clearAllAutoFlags    = db.prepare("UPDATE datarecord SET flag_color = 'none', flag_source = NULL WHERE flag_source = 'auto'");

  if (process.env.HUB_MODE === 'true') {
    stmts.getHubSetting     = db.prepare('SELECT value FROM hub_settings WHERE key = ?');
    stmts.setHubSetting     = db.prepare('INSERT INTO hub_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    stmts.hubSitesForBackup = db.prepare('SELECT id, name, url, token FROM hub_sites');
  }

  return stmts;
}

export { buildStatements };
/**
 * Hub-mode routes — extracted from server.js (US-010).
 *
 * Factory pattern: createHubRouter(deps) returns an Express router.
 * Also exports createNonHubFallbackRouter() for empty-response stubs.
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db/index.js';
import { buildStatements } from '../db/statements.js';
import { boolFromRow } from '../helpers.js';
import { syncAllSites, HUB_SITES } from '../services/hubEtl.js';

export function createHubRouter({ requireAuth, requireAdmin }) {
  const stmts = buildStatements(db);
  const router = Router();

  // GET /api/hub/backup-settings
  router.get('/api/hub/backup-settings', (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });
    const user = db.prepare('SELECT role FROM "user" WHERE id = ?').get(req.session.userId);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const row = stmts.getHubSetting.get('backup_sync_enabled');
    res.json({ backup_sync_enabled: row ? row.value === 'true' : true });
  });

  router.post('/api/hub/backup-settings', (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });
    const user = db.prepare('SELECT role FROM "user" WHERE id = ?').get(req.session.userId);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { backup_sync_enabled } = req.body;
    if (typeof backup_sync_enabled !== 'boolean') return res.status(400).json({ error: 'backup_sync_enabled must be boolean' });
    stmts.setHubSetting.run('backup_sync_enabled', backup_sync_enabled ? 'true' : 'false');
    res.json({ ok: true, backup_sync_enabled });
  });

  // GET /api/hub/proxy-backup?site_id=xxx
  // Proxies a backup download from a site through the Hub server to avoid CORS.
  // Admin-only.
  router.get('/api/hub/proxy-backup', async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });
    const user = db.prepare('SELECT role FROM "user" WHERE id = ?').get(req.session.userId);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const { site_id } = req.query;
    if (!site_id) return res.status(400).json({ error: 'site_id required' });

    const site = db.prepare('SELECT id, name, url, token FROM hub_sites WHERE id = ?').get(site_id);
    if (!site || !site.url) return res.status(404).json({ error: 'Site not found or no URL' });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const upstream = await fetch(`${site.url}/api/backup/download`, {
        headers: { 'x-reporting-token': site.token || '' },
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
  router.get('/api/hub/backup-status', async (req, res) => {
    if (!req.session?.userId) return res.status(401).json({ error: 'Unauthorized' });
    const user = db.prepare('SELECT role FROM "user" WHERE id = ?').get(req.session.userId);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });

    const sites = db.prepare('SELECT id, name, url, token FROM hub_sites').all();

    const results = await Promise.all(sites.map(async (site) => {
      const base = { site_id: site.id, site_name: site.name, url: site.url };
      if (!site.url) return { ...base, error: 'No API URL configured', status: 'unknown' };
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const r = await fetch(`${site.url}/api/backup/status`, {
          headers: { 'x-reporting-token': site.token || '' },
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
  router.get('/api/hub/sites', (req, res) => {
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
  router.get('/api/hub/records', (req, res) => {
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
  router.get('/api/hub/kpis', (req, res) => {
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
  router.get('/api/hub/inventory', requireAuth, (req, res) => {
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
  router.get('/api/hub/sync-log', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const rows = db.prepare(
      'SELECT * FROM hub_sync_log ORDER BY started_at DESC LIMIT ?'
    ).all(limit);
    res.json(rows);
  });

  // POST /api/hub/force-resync — clears sync history and hub_records, triggers full re-pull
  router.post('/api/hub/force-resync', requireAuth, requireAdmin, (req, res) => {
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
  router.post('/api/hub/force-resync/:siteId', requireAuth, requireAdmin, (req, res) => {
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
  router.post('/api/hub/sync', (req, res) => {
    res.status(202).json({ message: 'Sync triggered', sites: HUB_SITES.map(s => s.slug) });
    syncAllSites().catch(err => console.error('[HUB] Manual sync error:', err));
  });

  // ==================== HUB: CENTRALISED USER MANAGEMENT ====================

  // GET /api/hub/users — list all users on this hub (admin only)
  router.get('/api/hub/users', requireAuth, requireAdmin, (req, res) => {
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
  router.post('/api/hub/push-users', requireAuth, requireAdmin, async (req, res) => {
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
  router.post(`/api/hub/receive-users`, async (req, res) => {
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

  return router;
}

// Non-hub fallback router — empty responses for hub endpoints called by UI on non-hub installs
export function createNonHubFallbackRouter() {
  const router = Router();
  router.get('/api/hub/sites', (req, res) => res.json([]));
  router.get('/api/hub/records', (req, res) => res.json({ records: [], total: 0 }));
  router.get('/api/hub/kpis', (req, res) => res.json({ sites: [] }));
  router.get('/api/hub/inventory', (req, res) => res.json([]));
  router.get('/api/hub/sync-log', (req, res) => res.json([]));
  return router;
}
import express from 'express';
import db from '../db/index.js';
import { buildStatements } from '../db/statements.js';
import { expandDataRecord } from '../helpers.js';

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

export function createReportingRouter({ requireAuth }) {
  const stmts = buildStatements(db);
  const router = express.Router();

  // GET /api/kpis
  router.get('/api/kpis', requireAuth, (req, res) => {
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

  // GET /api/top-balances?limit=30
  router.get('/api/top-balances', requireAuth, (req, res) => {
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
  router.get('/api/inventory', requireAuth, (req, res) => {
    const search = (req.query.search || '').trim();
    const commodity = (req.query.commodity || '').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 100000, 100000);
    const isHub = process.env.HUB_MODE === 'true';
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
      let rows;
      if (isHub) {
        const hubWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        rows = db.prepare(
          `SELECT i.id, i.site_id, COALESCE(s.name, i.site_id) AS site_name,
                  i.item_number, i.item_description, i.qty_on_hand, i.last_cost,
                  i.price_list, i.price, i.stocking_uom, i.commodity, i.inventory_value, i.terms, i.synced_at
           FROM hub_inventory i
           LEFT JOIN hub_sites s ON s.id = i.site_id
           ${hubWhere} ORDER BY i.item_number ASC LIMIT ?`
        ).all(...params);
      } else {
        rows = db.prepare(
          `SELECT * FROM inventoryrecord ${where} ORDER BY item_number ASC LIMIT ?`
        ).all(...params);
      }
      res.json({ count: rows.length, records: rows });
    } catch (err) {
      console.error('inventory error', err);
      res.status(500).json({ error: 'Failed to fetch inventory' });
    }
  });

  // ==================== MULTI-SITE REPORTING API ====================

  // GET /api/reporting/site-info
  router.get('/api/reporting/site-info', requireReportingToken, (req, res) => {
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
  router.get('/api/reporting/kpis', requireReportingToken, (req, res) => {
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
  router.get('/api/reporting/records', requireReportingToken, (req, res) => {
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
  router.get('/api/reporting/health', requireReportingToken, (req, res) => {
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
  router.get('/api/reporting/inventory', requireReportingToken, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 1000, 1000);
    const offset = parseInt(req.query.offset) || 0;
    const rows = db.prepare(
      `SELECT id, source_table, item_number, item_description, qty_on_hand, last_cost, price_list, price, stocking_uom, commodity, inventory_value, updated_date
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

  return router;
}

// APP_VERSION loaded via createRequire
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { version: APP_VERSION } = require('../../package.json');
import express from 'express';
import { sanitizeForSqlite, parseJsonSafely, stringifyJsonSafely, expandDataRecord, normalizeFieldKey, validateCustomFieldKey, sanitizeConnection } from '../helpers.js';
import { applyAutoFlagRulesToRecord } from '../services/autoFlag.js';
import { encryptPassword } from '../services/encryption.js';

/**
 * Creates the data-record, auto-flag, and dynamic CRUD routes router.
 * @param {{ db, stmts, requireAuth, requireAdmin, checkTableAccess }} deps
 */
export function createRecordsRouter({ db, stmts, requireAuth, requireAdmin, requirePermission, checkTableAccess }) {
  const router = express.Router();

  // ==================== SCHEMA CACHE ====================
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

  const _schemaCache = new Map();
  function getTableColumns(table) {
    if (_schemaCache.has(table)) return _schemaCache.get(table);
    const cols = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name));
    _schemaCache.set(table, cols);
    return cols;
  }
  // Warm the cache for all allowed tables at startup
  for (const t of allowedTables) {
    try { getTableColumns(t); } catch {}
  }

  // ==================== CUSTOM FIELD CONFIG ROUTES ====================
  router.get(
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

  router.post(
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

  router.put(
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

  router.delete(
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
  router.get(
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

  // ==================== TEST RULE ====================

  // POST /api/test-rule
  // Accepts { conditions, sample_size } and runs the rule logic against real records.
  // Returns up to sample_size records (default 5) that matched, plus up to sample_size that didn't.
  router.post('/api/test-rule', requireAuth, (req, res) => {
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

  // ==================== AUTO-FLAG ROUTES ====================

  router.post('/api/apply-auto-flags', requireAuth, (req, res) => {
    try {
      const rules = stmts.activeAutoFlagRules.all();
      const activeRules = rules.map(r => {
        try { r.conditions = JSON.parse(r.conditions || '[]'); } catch { r.conditions = []; }
        return r;
      });
      if (activeRules.length === 0) return res.json({ flagged: 0, cleared: 0 });

      const records = stmts.autoRecordsForFlags.all();
      let flagged = 0, cleared = 0;

      const updateFlag = stmts.updateAutoFlag;
      const clearFlag = stmts.clearAutoFlag;

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


  router.post('/api/clear-auto-flags', requireAuth, (req, res) => {
    try {
      const result = stmts.clearAllAutoFlags.run();
      res.json({ cleared: result.changes });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });


  // ─── Auto-Flag Rules Export / Import ─────────────────────────────────────────

  router.get('/api/autoflagrule/export', requireAuth, requireAdmin, (req, res) => {
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

  router.post('/api/autoflagrule/import', requireAuth, requireAdmin, (req, res) => {
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

  // ==================== DYNAMIC CRUD ROUTES ====================

  router.get('/api/:table', requireAuth, (req, res) => {
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

  router.get('/api/:table/:id', requireAuth, (req, res) => {
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

  router.post('/api/:table', requireAuth, (req, res) => {
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

  router.put('/api/:table/:id', requireAuth, (req, res) => {
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

  router.delete('/api/:table/:id', requireAuth, (req, res) => {
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

  return router;
}
import express from 'express';
import path from 'path';
import fs from 'fs';
import db, { dbPath } from '../db/index.js';

export function createBackupRouter() {
  const router = express.Router();

  // GET /api/backup/status
  router.get('/api/backup/status', (req, res) => {
    const token = req.headers['x-reporting-token'];
    const expectedToken = process.env.REPORTING_TOKEN;
    if (!expectedToken || token !== expectedToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

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

  // GET /api/backup/download
  router.get('/api/backup/download', (req, res) => {
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

      const stream = fs.createReadStream(resolvedDbPath);
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

  return router;
}
import express from 'express';
import path from 'path';
import { exec as execChild } from 'child_process';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createRequire } from 'module';
import { getVersionStatus } from '../services/versionCheck.js';

const require = createRequire(import.meta.url);

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

export function createSystemRouter({ requireAuth, requireAdmin }) {
  const router = express.Router();

  // GET /api/health — unauthenticated health check
  router.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // GET /api/app-info
  router.get('/api/app-info', (req, res) => {
    res.json({
      hub_mode: process.env.HUB_MODE === 'true',
      version: require('../../package.json').version,
    });
  });

  // GET /api/app-version-status
  router.get('/api/app-version-status', requireAuth, async (req, res) => {
    try {
      const versionStatus = await getVersionStatus();
      res.json(versionStatus);
    } catch (error) {
      console.error('Version status error:', error);
      res.status(500).json({ error: 'Failed to check app version' });
    }
  });

  // ==================== AUTO-UPDATE (WINDOWS SERVICE) ====================
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
  router.post('/api/app-update-trigger', requireAuth, requireAdmin, async (req, res) => {
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

  return router;
}
/**
 * Hub ETL — extracted from server.js (US-010).
 *
 * Hub-mode table creation, site registry, sync-all-sites ETL,
 * and scheduled backup pull logic.
 */

import db from '../db/index.js';
import { buildStatements } from '../db/statements.js';

// --- Hub table creation (only called when HUB_MODE === 'true') ---
function initHubTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hub_sites (
      id TEXT PRIMARY KEY,
      slug TEXT,
      name TEXT,
      url TEXT,
      token TEXT,
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
      inventory_value TEXT,
      terms TEXT,
      synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(site_id, item_number)
    );
  `);

  // Seed default hub settings
  db.prepare(`INSERT OR IGNORE INTO hub_settings (key, value) VALUES ('backup_sync_enabled', 'true')`).run();
}

// --- Site registry from env ---
// Parsed lazily to avoid hoisting issues with ES module imports executing before dotenv.config()
function getHubSites() {
  try {
    return JSON.parse(process.env.HUB_SITES || '[]');
  } catch (e) {
    console.error('[HUB] Invalid HUB_SITES JSON:', e.message);
    return [];
  }
}

// Keep HUB_SITES as a getter so callers don't need to change
let HUB_SITES = [];

function initHubSiteRegistry() {
  HUB_SITES = getHubSites();
  const upsertSite = db.prepare(`
    INSERT INTO hub_sites (id, slug, name, url, token, status)
    VALUES (@id, @slug, @name, @url, @token, 'unknown')
    ON CONFLICT(id) DO UPDATE SET slug=excluded.slug, name=excluded.name, url=excluded.url, token=excluded.token
  `);
  for (const site of HUB_SITES) {
    upsertSite.run({ id: site.id, slug: site.slug, name: site.name, url: site.url, token: site.token || null });
  }
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

async function runHubBackupPull() {
  if (process.env.HUB_MODE !== 'true') return;
  const stmts = buildStatements(db);
  const row = stmts.getHubSetting.get('backup_sync_enabled');
  const enabled = row ? row.value === 'true' : true;
  if (!enabled) {
    console.log('[HUB BACKUP] Skipping scheduled pull — backup sync disabled.');
    return;
  }
  const sites = stmts.hubSitesForBackup.all();
  console.log(`[HUB BACKUP] Starting parallel pull for ${sites.length} site(s)`);
  const { mkdirSync, writeFileSync } = await import('fs');
  const pathMod = await import('path');
  await Promise.allSettled(sites.map(async (site) => {
    try {
      const controller = new AbortController();
      const hardTimeout = setTimeout(() => controller.abort(), 30000);
      const upstream = await fetch(`${site.url}/api/backup/download`, {
        headers: { 'x-reporting-token': site.token || '' },
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

export { initHubTables, initHubSiteRegistry, syncAllSites, runHubBackupPull, HUB_SITES };
/**
 * Auth middleware — extracted from server.js (US-003).
 *
 * Exports a factory so the caller can inject getUserById and sanitizeUser
 * (which depend on prepared statements built after db init).
 */

export function createAuthMiddleware({ getUserById, sanitizeUser }) {

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

  return { requireAuth, requireAdmin, requirePermission, requireSelfOrAdmin, checkTableAccess };
}
import cron from 'node-cron';
import db from './db/index.js';
import { runConnectionImport } from './services/syncEngine.js';

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
import bcrypt from 'bcryptjs';
import db from './db/index.js';
import { encryptPassword, isEncryptedFormat, getEncryptionKey } from './services/encryption.js';
import { defaultPermissionsForRole } from './helpers.js';

export function validateSessionSecret(secret) {
  if (!secret) {
    console.error('❌ SESSION_SECRET environment variable is required. Set it in your .env file.');
    process.exit(1);
  }
  if (secret === 'change-me-to-a-long-random-string') {
    console.error('FATAL: SESSION_SECRET is set to the example value. Please generate a real secret in .env');
    process.exit(1);
  }
  if (secret.length < 32) {
    console.error('FATAL: SESSION_SECRET must be at least 32 characters long.');
    process.exit(1);
  }
}

export function migrateUnencryptedPasswords() {
  const key = getEncryptionKey();
  if (!key) return;

  const connections = db.prepare('SELECT id, encrypted_password FROM databaseconnection').all();
  let migrated = 0;
  for (const conn of connections) {
    if (!conn.encrypted_password) continue;
    if (isEncryptedFormat(conn.encrypted_password)) continue;
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
}

export function recoverAbandonedSyncs() {
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

export async function ensureSeedUsers() {
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

export function createGetUserById(stmts) {
  return (id) => stmts.getUserById.get(id);
}
// ==================== SHARED HELPERS ====================
// Utility functions used across routes and services.
// This file must NOT import from any route or service file.

export const sanitizeForSqlite = (data) => {
  const sanitized = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value === undefined) continue;
    sanitized[key] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  }
  return sanitized;
};

export function parseJsonSafely(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function stringifyJsonSafely(value, fallback = '{}') {
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

// Spread local_fields JSON into the top-level record object so clients can
// access dynamic custom fields as record[field_key] instead of parsing JSON.
export function expandDataRecord(row) {
  if (!row || typeof row !== 'object') return row;
  const localFields = parseJsonSafely(row.local_fields, {});
  const expanded = { ...row, ...localFields };

  // Expand unpaid_invoices JSON array back to flat numbered fields for API compat
  const invoices = parseJsonSafely(row.unpaid_invoices, []);
  if (Array.isArray(invoices)) {
    invoices.forEach((inv, i) => {
      const n = i + 1;
      expanded[`last_unpaid_invoice_${n}`]        = inv.number ?? '';
      expanded[`last_unpaid_invoice_${n}_amount`] = inv.amount ?? '';
      expanded[`last_unpaid_invoice_${n}_date`]   = inv.date   ?? '';
    });
  }

  // Expand receipts JSON array back to flat numbered fields for API compat
  const recs = parseJsonSafely(row.receipts, []);
  if (Array.isArray(recs)) {
    recs.forEach((rec, i) => {
      const n = i + 1;
      expanded[`last_receipt_${n}`]        = rec.number ?? '';
      expanded[`last_receipt_${n}_amount`] = rec.amount ?? '';
      expanded[`last_receipt_${n}_date`]   = rec.date   ?? '';
    });
  }

  return expanded;
}

export function normalizeFieldKey(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_ ]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function validateCustomFieldKey(key) {
  return /^[a-z][a-z0-9_]*$/.test(key);
}

export function boolFromRow(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  return !!value;
}

export function defaultPermissionsForRole(role) {
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

export function sanitizeUser(user) {
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

export function sanitizeConnection(conn) {
  if (!conn) return null;
  const { encrypted_password, ...safe } = conn;
  return safe;
}
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
app.use(createRecordsRouter({ db, stmts, requireAuth, requireAdmin, requirePermission, checkTableAccess }));
app.use(createConnectionsRouter({ db, requireAuth, requirePermission, isShuttingDown }));
app.use(createReportingRouter({ requireAuth }));
app.use(createSystemRouter({ requireAuth, requireAdmin }));
app.use(createBackupRouter());

if (process.env.HUB_MODE === 'true') {
  initHubTables();
  initHubSiteRegistry();
  app.use(createHubRouter({ requireAuth, requireAdmin }));
  startHubSchedulers(syncAllSites, runHubBackupPull);
} else {
  app.use(createNonHubFallbackRouter());
}

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
