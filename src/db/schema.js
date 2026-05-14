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
      outstanding_balance TEXT,
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
      unpaid_invoices TEXT,
      receipts TEXT,
      flag_color TEXT CHECK(flag_color IN ('none', 'red', 'green', 'orange')) DEFAULT 'none',
      flag_reason TEXT,
      flag_created_by TEXT,
      flag_source TEXT DEFAULT NULL,
      note TEXT,
      synced_at TEXT,
      last_checked TEXT,
      terms TEXT,
      sales_rep TEXT,
      account_type TEXT,
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
      use_encryption INTEGER NOT NULL DEFAULT 0,
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
      -- resource_type intentionally has NO CHECK constraint. The original
      -- whitelist ('user'|'connection'|'record'|'rule'|'system') silently
      -- dropped audit rows whenever a feature added a new resource type
      -- without coordinating a schema migration (PR #198 added 'site' for
      -- the Sync from Accpac trigger; rows lost until v65 ran). Migration
      -- v65 drops the constraint on existing installs; this mirrors it
      -- for fresh installs.
      resource_type TEXT,
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
  // Base indexes on columns that have always existed — safe to batch
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_datarecord_source_lookup
    ON datarecord (source_table, source_id);

    CREATE INDEX IF NOT EXISTS idx_databaseconnection_status
    ON databaseconnection (status);

    CREATE INDEX IF NOT EXISTS idx_datarecord_customer_number
    ON datarecord (customer_number);

    CREATE INDEX IF NOT EXISTS idx_datarecord_flag_color
    ON datarecord (flag_color);

    CREATE INDEX IF NOT EXISTS idx_datarecord_updated_date
    ON datarecord (updated_date);
  `);

  // Indexes on columns added via migrations — guard individually so old DBs don't crash
  const optionalIndexes = [
    `CREATE INDEX IF NOT EXISTS idx_datarecord_outstanding_balance ON datarecord (outstanding_balance)`,
    `CREATE INDEX IF NOT EXISTS idx_datarecord_flag_source ON datarecord (flag_source)`,
    `CREATE INDEX IF NOT EXISTS idx_datarecord_auto_flagged ON datarecord (auto_flagged)`,
    `CREATE INDEX IF NOT EXISTS idx_datarecord_terms ON datarecord (terms)`,
    // Partial index for the /api/reports/top-balances DISTINCT TRIM
    // query and the /api/reports/rep-exposure GROUP BY. Without it the
    // query plans to a full table scan + hash distinct; with it we
    // get an index seek over the non-empty rep set.
    `CREATE INDEX IF NOT EXISTS idx_datarecord_sales_rep ON datarecord (sales_rep) WHERE sales_rep IS NOT NULL AND sales_rep != ''`,
  ];
  for (const sql of optionalIndexes) {
    try { db.exec(sql); } catch { /* column not yet added — migration will handle it */ }
  }

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
  // ==================== FLEXIBLE CUSTOM FIELD CONFIG TABLE ====================
  ensureFlexibleCustomFieldConfigTable(db);

  // ==================== RUN MIGRATIONS ====================
  runMigrations(db);

  // Indexes on columns that may have been added by migrations — create after migrations run
  db.exec(`CREATE INDEX IF NOT EXISTS idx_datarecord_auto_flagged ON datarecord(auto_flagged)`);

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
        status TEXT DEFAULT 'unknown',
        logic_version INTEGER,
        logic_sync_status TEXT DEFAULT 'never_synced',
        logic_last_error TEXT,
        logic_last_synced_at TEXT,
        logic_status_updated_at TEXT,
        -- Soft-tombstone for env drift. upsertSites flips in_env=0 on
        -- any row whose id dropped out of HUB_SITES (and stamps
        -- removed_from_env_at). Read endpoints still serve the row so
        -- it appears in the dashboard with an "ORPHAN" pill; write
        -- endpoints (trigger-accpac-sync, force-resync, push-*) refuse
        -- with 409. Migration v63 adds these to existing hub installs.
        in_env INTEGER NOT NULL DEFAULT 1,
        removed_from_env_at TEXT,
        -- Accpac freshness signal. Migration v62 ensureColumns these on
        -- existing hub installs; for fresh installs they need to be in
        -- the canonical CREATE TABLE because runMigrations runs BEFORE
        -- this CREATE TABLE statement (line 206 vs 212), so v62's
        -- gate-on-table-exists no-ops and records itself as applied
        -- before hub_sites exists. Without these columns here, fresh
        -- hub installs would permanently miss last_accpac_* and every
        -- hub.sync UPDATE would crash with "no such column".
        last_accpac_synced_at TEXT,
        last_accpac_status TEXT,
        last_accpac_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hub_sites_in_env ON hub_sites(in_env);

      CREATE TABLE IF NOT EXISTS credit_logic_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version INTEGER NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL,
        notes TEXT,
        created_by TEXT,
        is_active INTEGER DEFAULT 0,
        published_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS credit_logic_state (
        scope TEXT PRIMARY KEY,
        logic_version INTEGER,
        payload_json TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1,
        published_at TEXT,
        last_synced_at TEXT,
        sync_status TEXT DEFAULT 'never_synced',
        last_error TEXT,
        source TEXT DEFAULT 'default',
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS hub_records (
        site_id TEXT,
        record_id TEXT,
        customer_number TEXT,
        customer_name TEXT,
        flag_color TEXT,
        flag_reason TEXT,
        flag_created_by TEXT,
        outstanding_balance TEXT,
        unpaid_invoices TEXT,
        receipts TEXT,
        updated_date TEXT,
        synced_at TEXT,
        auto_flagged INTEGER DEFAULT 0,
        terms TEXT,
        sales_rep TEXT,
        account_type TEXT,
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
      CREATE INDEX IF NOT EXISTS idx_hub_records_outstanding ON hub_records(site_id, outstanding_balance);
      CREATE INDEX IF NOT EXISTS idx_hub_records_sales_rep ON hub_records(sales_rep) WHERE sales_rep IS NOT NULL AND sales_rep != '';
      CREATE INDEX IF NOT EXISTS idx_hub_inventory_site ON hub_inventory(site_id, item_number);
      CREATE INDEX IF NOT EXISTS idx_hub_inventory_search ON hub_inventory(item_description, item_number);
      CREATE INDEX IF NOT EXISTS idx_hub_sync_log_site_id ON hub_sync_log(site_id);
    `);

    // Normalised invoice-numbers column + maintenance triggers for hub_records.
    // The matching column on datarecord is created by migration v51, but
    // hub_records is created here AFTER runMigrations on hub installs, so we
    // mirror the same setup inline. Kept idempotent (IF NOT EXISTS guards).
    const hrCols = db.prepare("PRAGMA table_info(hub_records)").all().map(c => c.name);
    if (!hrCols.includes('unpaid_invoice_numbers')) {
      db.exec('ALTER TABLE hub_records ADD COLUMN unpaid_invoice_numbers TEXT');
    }
    db.exec(`
      UPDATE hub_records
         SET unpaid_invoice_numbers = (
           SELECT COALESCE(GROUP_CONCAT(UPPER(json_extract(value, '$.number')), ' '), '')
             FROM json_each(hub_records.unpaid_invoices)
            WHERE json_extract(value, '$.number') IS NOT NULL
         )
       WHERE unpaid_invoices IS NOT NULL
         AND unpaid_invoices != ''
         AND unpaid_invoices != '[]'
         AND (unpaid_invoice_numbers IS NULL OR unpaid_invoice_numbers = '')
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_hub_records_unpaid_invoice_numbers
             ON hub_records(unpaid_invoice_numbers)`);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS hub_records_unpaid_invoice_numbers_ai
      AFTER INSERT ON hub_records
      WHEN NEW.unpaid_invoices IS NOT NULL
      BEGIN
        UPDATE hub_records
           SET unpaid_invoice_numbers = COALESCE((
             SELECT GROUP_CONCAT(UPPER(json_extract(value, '$.number')), ' ')
               FROM json_each(NEW.unpaid_invoices)
              WHERE json_extract(value, '$.number') IS NOT NULL
           ), '')
         WHERE site_id = NEW.site_id AND record_id = NEW.record_id;
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS hub_records_unpaid_invoice_numbers_au
      AFTER UPDATE OF unpaid_invoices ON hub_records
      BEGIN
        UPDATE hub_records
           SET unpaid_invoice_numbers = COALESCE((
             SELECT GROUP_CONCAT(UPPER(json_extract(value, '$.number')), ' ')
               FROM json_each(NEW.unpaid_invoices)
              WHERE json_extract(value, '$.number') IS NOT NULL
           ), '')
         WHERE site_id = NEW.site_id AND record_id = NEW.record_id;
      END
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
