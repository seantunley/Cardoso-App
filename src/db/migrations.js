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
        // No HUB_MODE gate — use table-existence checks so non-hub → hub upgrades also get the columns
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
          ensureColumn(db, 'hub_records', 'flag_created_by', 'TEXT');
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
    {
      version: 15,
      name: 'datarecord_complete_schema',
      up() {
        // Force-add all columns that should exist on datarecord but may be missing
        // on installs that created the table before these columns were in CREATE TABLE.
        // safe to re-run — ALTER TABLE fails silently via try/catch
        const forceAdd = (table, col, def) => {
          try { db.exec(`ALTER TABLE "${table}" ADD COLUMN ${col} ${def}`); } catch (_) {}
        };
        forceAdd('datarecord', 'outstanding_balance', 'TEXT');
        forceAdd('datarecord', 'unpaid_invoices', 'TEXT');
        forceAdd('datarecord', 'receipts', 'TEXT');
        forceAdd('datarecord', 'flag_source', 'TEXT DEFAULT NULL');
        forceAdd('datarecord', 'terms', 'TEXT');
      },
    },
    {
      version: 16,
      name: 'hub_user_sites_table',
      up() {
        db.prepare(`
          CREATE TABLE IF NOT EXISTS hub_user_sites (
            email TEXT NOT NULL,
            site_slug TEXT NOT NULL,
            pushed_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (email, site_slug)
          )
        `).run();
      },
    },
    {
      version: 17,
      name: 'feature_permissions_balances_inventory',
      up() {
        ensureColumn(db, 'user', 'can_access_customer_balances', 'INTEGER DEFAULT 1');
        ensureColumn(db, 'user', 'can_access_inventory', 'INTEGER DEFAULT 1');
        // Grant to all existing users so no one loses access
        db.prepare(`UPDATE "user" SET can_access_customer_balances = 1 WHERE can_access_customer_balances = 0`).run();
        db.prepare(`UPDATE "user" SET can_access_inventory = 1 WHERE can_access_inventory = 0`).run();
      },
    },
    {
      version: 18,
      name: 'speedtest_tables',
      up() {
        db.exec(`
          CREATE TABLE IF NOT EXISTS site_speedtest (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            download_mbps REAL,
            upload_mbps REAL,
            ping_ms REAL,
            isp TEXT,
            server_name TEXT,
            server_location TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          );
          CREATE TABLE IF NOT EXISTS hub_speedtest (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            site_slug TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            download_mbps REAL,
            upload_mbps REAL,
            ping_ms REAL,
            isp TEXT,
            server_name TEXT,
            server_location TEXT,
            pulled_at TEXT DEFAULT (datetime('now')),
            UNIQUE(site_slug, timestamp)
          );
        `);
      },
    },

    {
      version: 19,
      name: 'ensure_speedtest_tables',
      up() {
        // Belt-and-suspenders: create speedtest tables if migration v18 was
        // recorded but the DDL never actually ran (e.g. partial migration failure).
        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS site_speedtest (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              timestamp TEXT NOT NULL,
              download_mbps REAL,
              upload_mbps REAL,
              ping_ms REAL,
              isp TEXT,
              server_name TEXT,
              server_location TEXT,
              created_at TEXT DEFAULT (datetime('now'))
            );
          `);
        } catch (e) { /* table may already exist */ }
        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS hub_speedtest (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              site_slug TEXT NOT NULL,
              timestamp TEXT NOT NULL,
              download_mbps REAL,
              upload_mbps REAL,
              ping_ms REAL,
              isp TEXT,
              server_name TEXT,
              server_location TEXT,
              pulled_at TEXT DEFAULT (datetime('now')),
              UNIQUE(site_slug, timestamp)
            );
          `);
        } catch (e) { /* table may already exist */ }
      },
    },

    {
      version: 20,
      name: 'hub_site_ping_table',
      up() {
        db.exec(`
          CREATE TABLE IF NOT EXISTS hub_site_ping (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            site_slug TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            online INTEGER NOT NULL DEFAULT 0,
            latency_ms INTEGER,
            created_at TEXT DEFAULT (datetime('now'))
          );
        `);
      },
    },

    {
      version: 21,
      name: 'ensure_hub_user_sites_table',
      up() {
        // Belt-and-suspenders: v16 may have been recorded without the DDL
        // actually running on some installs. Force-create here.
        try {
          db.exec(`
            CREATE TABLE IF NOT EXISTS hub_user_sites (
              email TEXT NOT NULL,
              site_slug TEXT NOT NULL,
              pushed_at TEXT DEFAULT (datetime('now')),
              PRIMARY KEY (email, site_slug)
            );
          `);
        } catch (e) { /* already exists, no-op */ }
      },
    },
    {
      version: 22,
      name: 'collections_pipeline_table',
      up() {
        db.exec(`
          CREATE TABLE IF NOT EXISTS collections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id TEXT NOT NULL UNIQUE,
            status TEXT DEFAULT 'pending',
            contacted_at TEXT,
            notes TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_collections_status ON collections(status);
          CREATE INDEX IF NOT EXISTS idx_collections_customer_id ON collections(customer_id);
        `);
      },
    },

    {
      version: 23,
      name: 'hub_audit_log_table',
      up() {
        db.exec(`
          CREATE TABLE IF NOT EXISTS hub_audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT,
            performed_by TEXT,
            target TEXT,
            detail TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          )
        `);
      },
    },

    {
      version: 24,
      name: 'hub_backup_integrity_table',
      up() {
        db.exec(`
          CREATE TABLE IF NOT EXISTS hub_backup_integrity (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            site_id TEXT,
            filename TEXT,
            result TEXT,
            checked_at TEXT DEFAULT (datetime('now'))
          )
        `);
      },
    },

    {
      version: 25,
      name: 'feature_permissions_sidebar_expansion',
      up() {
        ensureColumn(db, 'user', 'can_access_collections', 'INTEGER DEFAULT 1');
        ensureColumn(db, 'user', 'can_access_hub_metrics', 'INTEGER DEFAULT 0');
        ensureColumn(db, 'user', 'can_access_hub_backups', 'INTEGER DEFAULT 0');
        ensureColumn(db, 'user', 'can_access_hub_trends', 'INTEGER DEFAULT 0');
        ensureColumn(db, 'user', 'can_access_hub_audit_log', 'INTEGER DEFAULT 0');

        db.prepare(`
          UPDATE "user"
          SET can_access_collections = COALESCE(can_access_customer_balances, 1)
          WHERE can_access_collections IS NULL
             OR can_access_collections = 0
        `).run();
      },
    },

    {
      version: 26,
      name: 'hub_records_flag_created_by',
      up() {
        const hubRecordsExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_records'`).get();
        if (hubRecordsExists) {
          ensureColumn(db, 'hub_records', 'flag_created_by', 'TEXT');
        }
      },
    },

    {
      version: 27,
      name: 'network_devices_tables',
      up() {
        db.exec(`
          CREATE TABLE IF NOT EXISTS network_devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            site_id TEXT,
            site_slug TEXT,
            site_name TEXT,
            mac_address TEXT NOT NULL UNIQUE,
            ip_address TEXT,
            hostname TEXT,
            vendor TEXT,
            device_category TEXT,
            classification_label TEXT,
            classification_confidence TEXT,
            classification_rationale TEXT,
            discovery_source TEXT,
            interface_alias TEXT,
            interface_description TEXT,
            neighbor_state TEXT,
            first_seen TEXT,
            last_seen TEXT,
            last_scan_at TEXT,
            active INTEGER DEFAULT 0,
            recently_seen INTEGER DEFAULT 0,
            details_json TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_network_devices_last_seen ON network_devices(last_seen);
          CREATE INDEX IF NOT EXISTS idx_network_devices_active ON network_devices(active);
          CREATE INDEX IF NOT EXISTS idx_network_devices_category ON network_devices(device_category);

          CREATE TABLE IF NOT EXISTS network_device_scan_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            status TEXT,
            trigger_reason TEXT,
            device_count INTEGER DEFAULT 0,
            active_count INTEGER DEFAULT 0,
            message TEXT
          );
        `);

        if (process.env.HUB_MODE === 'true') {
          db.exec(`
            CREATE TABLE IF NOT EXISTS hub_network_devices (
              site_id TEXT NOT NULL,
              site_slug TEXT,
              site_name TEXT,
              mac_address TEXT NOT NULL,
              ip_address TEXT,
              hostname TEXT,
              vendor TEXT,
              device_category TEXT,
              classification_label TEXT,
              classification_confidence TEXT,
              classification_rationale TEXT,
              interface_alias TEXT,
              interface_description TEXT,
              neighbor_state TEXT,
              first_seen TEXT,
              last_seen TEXT,
              last_scan_at TEXT,
              active INTEGER DEFAULT 0,
              recently_seen INTEGER DEFAULT 0,
              details_json TEXT,
              pulled_at TEXT DEFAULT (datetime('now')),
              PRIMARY KEY (site_id, mac_address)
            );
            CREATE INDEX IF NOT EXISTS idx_hub_network_devices_site ON hub_network_devices(site_id, active);
          `);
        }
      },
    },

    {
      version: 28,
      name: 'feature_permission_network_devices',
      up() {
        ensureColumn(db, 'user', 'can_access_network_devices', 'INTEGER DEFAULT 0');
        db.prepare(`UPDATE "user" SET can_access_network_devices = 1 WHERE role = 'admin'`).run();
      },
    },

    {
      version: 29,
      name: 'credit_logic_centralisation',
      up() {
        db.exec(`
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
          CREATE INDEX IF NOT EXISTS idx_credit_logic_versions_active ON credit_logic_versions(is_active, version DESC);

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
        `);

        const hubSitesExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_sites'`).get();
        if (hubSitesExists) {
          ensureColumn(db, 'hub_sites', 'logic_version', 'INTEGER');
          ensureColumn(db, 'hub_sites', 'logic_sync_status', `TEXT DEFAULT 'never_synced'`);
          ensureColumn(db, 'hub_sites', 'logic_last_error', 'TEXT');
          ensureColumn(db, 'hub_sites', 'logic_last_synced_at', 'TEXT');
          ensureColumn(db, 'hub_sites', 'logic_status_updated_at', 'TEXT');
        }
      },
    },

    {
      version: 30,
      name: 'drop_network_device_bandwidth_tables',
      up() {
        // Bandwidth estimation removed from Network Devices (inventory-only).
        // Drop bandwidth sample tables created by v27 on existing installs.
        db.exec(`
          DROP TABLE IF EXISTS network_device_bandwidth_samples;
          DROP TABLE IF EXISTS hub_network_device_bandwidth_samples;
        `);
      },
    },
    {
      version: 31,
      name: 'ntopng_hub_settings',
      up() {
        // Add ntopng connection settings to hub_settings (Hub only).
        // Also drop old PowerShell-based network device tables — replaced by ntopng.
        const hubSettingsExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_settings'`).get();
        if (hubSettingsExists) {
          const upsert = db.prepare(
            `INSERT OR IGNORE INTO hub_settings (key, value) VALUES (?, ?)`
          );
          upsert.run('ntopng_url', 'http://localhost:3000');
          upsert.run('ntopng_user', 'admin');
        }
        // Drop PowerShell-era tables (no longer used)
        db.exec(`
          DROP TABLE IF EXISTS network_devices;
          DROP TABLE IF EXISTS network_device_scan_runs;
          DROP TABLE IF EXISTS hub_network_devices;
        `);
      },
    },

    {
      version: 32,
      name: 'databaseconnection_use_encryption',
      up() {
        ensureColumn(db, 'databaseconnection', 'use_encryption', 'INTEGER NOT NULL DEFAULT 0');
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
