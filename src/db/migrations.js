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

function ensureTable(db, tableName, definition) {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (${definition})`);
  } catch {}
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
        // Uses raw ALTER TABLE: SQLite throws "duplicate column name" when the
        // column already exists, which is the expected/idempotent case here.
        // Any other error (table missing, constraint failure) is real and must surface.
        const forceAdd = (table, col, def) => {
          try { db.exec(`ALTER TABLE "${table}" ADD COLUMN ${col} ${def}`); }
          catch (e) {
            if (!/duplicate column name/i.test(e.message)) {
              console.error(`[migration-14] forceAdd failed on ${table}.${col}: ${e.message}`);
              throw e;
            }
          }
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
    {
      version: 33,
      name: 'perf_indexes_hub_inventory_and_records',
      up() {
        // hub_records and hub_inventory only exist on hub-mode machines — skip on sites
        const hubRecordsExists = db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='hub_records'"
        ).get();
        const hubInventoryExists = db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='hub_inventory'"
        ).get();

        if (hubRecordsExists) {
          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_hub_records_outstanding ON hub_records(site_id, outstanding_balance);
          `);
        }
        if (hubInventoryExists) {
          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_hub_inventory_site ON hub_inventory(site_id, item_number);
            CREATE INDEX IF NOT EXISTS idx_hub_inventory_search ON hub_inventory(item_description, item_number);
          `);
        }
      },
    },
    {
      version: 34,
      name: 'perf_index_autoflagrule_active_priority',
      up() {
        // activeAutoFlagRules runs on every sync and auto-flag check:
        //   SELECT * FROM autoflagrule WHERE is_active = 1 ORDER BY priority DESC
        // Without an index this is a full table scan on every run.
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_autoflagrule_active_priority
          ON autoflagrule (is_active, priority DESC);
        `);
      },
    },

    {
      version: 35,
      name: 'inventory_sales_rep_column',
      up() {
        // Historical migration kept for compatibility. A later cleanup migration
        // removes sales_rep from inventory ownership entirely.
        try { db.prepare('ALTER TABLE inventoryrecord ADD COLUMN sales_rep TEXT').run(); } catch {}
        try { db.prepare('ALTER TABLE hub_inventory ADD COLUMN sales_rep TEXT').run(); } catch {}
      },
    },

    {
      version: 36,
      name: 'datarecord_sales_rep_and_backfill',
      up() {
        // Add sales_rep to datarecord (site customer table)
        try { db.prepare('ALTER TABLE datarecord ADD COLUMN sales_rep TEXT').run(); } catch {}

        // Backfill datarecord.sales_rep from inventoryrecord.sales_rep (by customer_number)
        // This copies the first non-null sales_rep from inventory to the customer record
        try {
          db.exec(`
            UPDATE datarecord
            SET sales_rep = (
              SELECT MIN(i.sales_rep)
              FROM inventoryrecord i
              WHERE i.customer_number = datarecord.customer_number
                AND i.sales_rep IS NOT NULL
                AND i.customer_number IS NOT NULL
            )
            WHERE datarecord.sales_rep IS NULL
              AND datarecord.customer_number IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM inventoryrecord i2
                WHERE i2.customer_number = datarecord.customer_number
                  AND i2.sales_rep IS NOT NULL
              )
          `);
        } catch {}

        // Add sales_rep to hub_records (Hub aggregated customer table)
        // Guard: only runs on Hub machines (hub_records only exists on Hub)
        if (process.env.HUB_MODE === 'true') {
          try { db.prepare('ALTER TABLE hub_records ADD COLUMN sales_rep TEXT').run(); } catch {}
        }
      },
    },

    {
      version: 37,
      name: 'hub_user_allowed_sites',
      up() {
        // Only create this table on the Hub — sites don't need it
        if (process.env.HUB_MODE === 'true') {
          ensureTable(db, 'hub_user_allowed_sites',
            `email TEXT NOT NULL,
             site_slug TEXT NOT NULL,
             assigned_at TEXT DEFAULT (datetime('now')),
             PRIMARY KEY (email, site_slug)`
          );
        }
      },
    },
    {
      version: 38,
      name: 'remove_sales_rep_from_inventory_tables',
      up() {
        const hasColumn = (tableName, columnName) => {
          try {
            return db.prepare(`PRAGMA table_info("${tableName}")`).all().some((c) => c.name === columnName);
          } catch {
            return false;
          }
        };

        if (hasColumn('inventoryrecord', 'sales_rep')) {
          db.exec(`
            CREATE TABLE inventoryrecord_new (
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
            INSERT INTO inventoryrecord_new (
              id, source_table, item_number, item_description, qty_on_hand, last_cost,
              price_list, price, stocking_uom, commodity, inventory_value, terms,
              created_date, updated_date
            )
            SELECT
              id, source_table, item_number, item_description, qty_on_hand, last_cost,
              price_list, price, stocking_uom, commodity, inventory_value, terms,
              created_date, updated_date
            FROM inventoryrecord;
            DROP TABLE inventoryrecord;
            ALTER TABLE inventoryrecord_new RENAME TO inventoryrecord;
            CREATE INDEX IF NOT EXISTS idx_inventoryrecord_source ON inventoryrecord (source_table, item_number);
          `);
        }

        const hubInventoryExists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='hub_inventory'`).get();
        if (hubInventoryExists && hasColumn('hub_inventory', 'sales_rep')) {
          db.exec(`
            CREATE TABLE hub_inventory_new (
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
            INSERT INTO hub_inventory_new (
              id, site_id, item_number, item_description, qty_on_hand, last_cost,
              price_list, price, stocking_uom, commodity, inventory_value, terms, synced_at
            )
            SELECT
              id, site_id, item_number, item_description, qty_on_hand, last_cost,
              price_list, price, stocking_uom, commodity, inventory_value, terms, synced_at
            FROM hub_inventory;
            DROP TABLE hub_inventory;
            ALTER TABLE hub_inventory_new RENAME TO hub_inventory;
            CREATE INDEX IF NOT EXISTS idx_hub_inventory_site ON hub_inventory(site_id, item_number);
            CREATE INDEX IF NOT EXISTS idx_hub_inventory_search ON hub_inventory(item_description, item_number);
          `);
        }
      },
    },

    {
      version: 39,
      name: 'datarecord_account_type_column',
      up() {
        // Add account_type to site customer table
        try { db.prepare('ALTER TABLE datarecord ADD COLUMN account_type TEXT').run(); } catch {}

        // Add account_type to hub aggregated customer table (Hub-only)
        if (process.env.HUB_MODE === 'true') {
          try { db.prepare('ALTER TABLE hub_records ADD COLUMN account_type TEXT').run(); } catch {}
        }
      },
    },

    {
      version: 40,
      name: 'backfill_sales_rep_and_account_type_from_data_json',
      up() {
        const salesRepAliases = [
          'sales_rep', 'SalesRep', 'SALEREP', 'SalesRepCode', 'salesrep', 'SalesPerson', 'SalesPersonCode',
          'Sales Rep', 'Sales Rep Code', 'SalesRepName', 'SalesPersonName', 'Salesman', 'SalesmanCode',
          'SalesmanName', 'Rep', 'RepCode', 'RepName', 'sales_rep_name', 'salesperson_name', 'salesman_name'
        ];
        const accountTypeAliases = [
          'account_type', 'AccountType', 'ACCOUNT_TYPE', 'accounttype', 'Type', 'CUSTOMER_TYPE',
          'CustomerType', 'customer_type', 'Class', 'CustomerClass', 'Account Type'
        ];

        const getFirstValue = (row, aliases) => {
          for (const key of aliases) {
            const value = row?.[key];
            if (value !== undefined && value !== null && String(value).trim() !== '') {
              return String(value);
            }
          }
          return null;
        };

        const updateDatarecord = db.prepare(`
          UPDATE datarecord
          SET sales_rep = COALESCE(?, sales_rep),
              account_type = COALESCE(?, account_type),
              updated_date = ?
          WHERE id = ?
        `);

        const rows = db.prepare(`
          SELECT id, data, sales_rep, account_type
          FROM datarecord
          WHERE (sales_rep IS NULL OR TRIM(sales_rep) = '')
             OR (account_type IS NULL OR TRIM(account_type) = '')
        `).all();

        const now = new Date().toISOString();
        const runBackfill = db.transaction((records) => {
          for (const record of records) {
            let parsed;
            try {
              parsed = record.data ? JSON.parse(record.data) : null;
            } catch {
              parsed = null;
            }
            if (!parsed || typeof parsed !== 'object') continue;

            const nextSalesRep = (!record.sales_rep || String(record.sales_rep).trim() === '')
              ? getFirstValue(parsed, salesRepAliases)
              : null;
            const nextAccountType = (!record.account_type || String(record.account_type).trim() === '')
              ? getFirstValue(parsed, accountTypeAliases)
              : null;

            if (!nextSalesRep && !nextAccountType) continue;

            updateDatarecord.run(nextSalesRep, nextAccountType, now, record.id);
          }
        });

        runBackfill(rows);
      },
    },
    {
      version: 41,
      name: 'create_flag_snapshots_table',
      up() {
        db.exec(`
          CREATE TABLE IF NOT EXISTS flag_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_number TEXT NOT NULL,
            source_table TEXT,
            flag_color TEXT,
            flag_reason TEXT,
            flag_created_by TEXT,
            flag_source TEXT,
            auto_flagged INTEGER DEFAULT 0,
            note TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_flag_snapshots_customer ON flag_snapshots (customer_number, source_table)`);
      },
    },
    {
      version: 42,
      name: 'dedupe_datarecords_and_trim_source_ids',
      up() {
        // Trim trailing whitespace from source_id (MSSQL char padding)
        db.prepare(`UPDATE datarecord SET source_id = TRIM(source_id) WHERE source_id != TRIM(source_id)`).run();

        // Remove duplicate records — keep the one with the latest updated_date per source_table + source_id
        const dupes = db.prepare(`
          SELECT source_table, TRIM(source_id) AS source_id, COUNT(*) AS cnt
          FROM datarecord
          WHERE source_id IS NOT NULL AND TRIM(source_id) != ''
          GROUP BY source_table, TRIM(source_id)
          HAVING COUNT(*) > 1
        `).all();

        if (dupes.length > 0) {
          const deleteOlder = db.prepare(`
            DELETE FROM datarecord WHERE id NOT IN (
              SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (
                  PARTITION BY source_table, TRIM(source_id)
                  ORDER BY
                    CASE WHEN flag_color IS NOT NULL AND flag_color != '' AND flag_color != 'none' THEN 0 ELSE 1 END,
                    updated_date DESC
                ) AS rn
                FROM datarecord
                WHERE source_table = ? AND TRIM(source_id) = ?
              ) WHERE rn = 1
            ) AND source_table = ? AND TRIM(source_id) = ?
          `);

          let totalRemoved = 0;
          for (const d of dupes) {
            const result = deleteOlder.run(d.source_table, d.source_id, d.source_table, d.source_id);
            totalRemoved += result.changes;
          }
          console.log(`[migration-42] Removed ${totalRemoved} duplicate records across ${dupes.length} groups`);
        }

        // Add unique index to prevent future duplicates
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_datarecord_source_unique ON datarecord (source_table, source_id) WHERE source_id IS NOT NULL AND source_id != ''`);
      },
    },
    {
      version: 43,
      name: 'drop_speedtest_tables',
      up() {
        db.exec(`DROP TABLE IF EXISTS site_speedtest`);
        db.exec(`DROP TABLE IF EXISTS hub_speedtest`);
      },
    },
    {
      version: 44,
      name: 'bat_sage_week_cache',
      up() {
        db.exec(`
          CREATE TABLE IF NOT EXISTS bat_sage_week_cache (
            year INTEGER NOT NULL,
            week_number INTEGER NOT NULL,
            delivery REAL DEFAULT 0,
            discount REAL DEFAULT 0,
            pricing REAL DEFAULT 0,
            total REAL DEFAULT 0,
            batch_count INTEGER DEFAULT 0,
            refreshed_at TEXT,
            PRIMARY KEY (year, week_number)
          )
        `);
        db.exec(`
          CREATE TABLE IF NOT EXISTS bat_sage_cache_meta (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT
          )
        `);
      },
    },
    {
      version: 45,
      name: 'bat_reconciliation_perf_indexes',
      up() {
        // c_overwritten is filtered in replicateSupplierIntoCardoso() and
        // counted in the post-replicate summary. Without this index those
        // queries scan the full bat_cardoso_invoices table.
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_bat_cardoso_inv_overwritten
          ON bat_cardoso_invoices(c_overwritten)
        `);
        // extracted_invoice is the join key on every cross-ref query against
        // bat_cardoso_invoices (UPPER/REPLACE wraps mean the index is only
        // partially usable, but it still helps the IS NOT NULL / IS NULL passes
        // in listReconciliations and getDashboardData).
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_bat_extractions_invoice
          ON bat_invoice_extractions(extracted_invoice)
          WHERE extracted_invoice IS NOT NULL
        `);
      },
    },
    {
      version: 46,
      name: 'databaseconnection_is_bat_only',
      up() {
        // Per-connection flag isolating BAT Sage connections from the general
        // sync engine. When 1, the connection is NOT swept by the scheduler /
        // auto-sync into the local datarecord table — it's only accessed via
        // the BAT module (getSagePool in batReconciliation.js). Default 0.
        const cols = db.prepare("PRAGMA table_info(databaseconnection)").all().map(c => c.name);
        if (!cols.includes('is_bat_only')) {
          db.exec(`ALTER TABLE databaseconnection ADD COLUMN is_bat_only INTEGER DEFAULT 0`);
        }
        // Auto-mark any connection currently set as the BAT Sage connection
        // (via bat_settings.sage_connection_id) so the existing setup stops
        // bleeding into customer search the moment this migration runs.
        try {
          const row = db.prepare("SELECT value FROM bat_settings WHERE key = 'sage_connection_id'").get();
          const id = row?.value ? parseInt(row.value, 10) : null;
          if (id) db.prepare("UPDATE databaseconnection SET is_bat_only = 1 WHERE id = ?").run(id);
        } catch {}
      },
    },
    {
      version: 47,
      name: 'datarecord_outstanding_balance_num',
      up() {
        // Numeric mirror of outstanding_balance (which is TEXT, often with
        // commas / spaces). Lets ORDER BY / WHERE use a real index instead of
        // CAST(REPLACE(REPLACE(...))) on every row. SQLite triggers keep the
        // numeric column in sync on every insert/update — no app-code changes
        // needed in the sync engine.
        const dataCols = db.prepare("PRAGMA table_info(datarecord)").all().map(c => c.name);
        if (!dataCols.includes('outstanding_balance_num')) {
          db.exec(`ALTER TABLE datarecord ADD COLUMN outstanding_balance_num REAL`);
        }
        db.exec(`
          UPDATE datarecord
          SET outstanding_balance_num = CASE
            WHEN outstanding_balance IS NULL OR outstanding_balance = '' OR outstanding_balance = '0'
              THEN NULL
            ELSE CAST(REPLACE(REPLACE(outstanding_balance, ',', ''), ' ', '') AS REAL)
          END
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_datarecord_balance_num ON datarecord(outstanding_balance_num)`);
        // Triggers — fire on insert/update of outstanding_balance only.
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_datarecord_balance_num_ins
          AFTER INSERT ON datarecord
          BEGIN
            UPDATE datarecord SET outstanding_balance_num = CASE
              WHEN NEW.outstanding_balance IS NULL OR NEW.outstanding_balance = '' OR NEW.outstanding_balance = '0'
                THEN NULL
              ELSE CAST(REPLACE(REPLACE(NEW.outstanding_balance, ',', ''), ' ', '') AS REAL)
            END WHERE id = NEW.id;
          END
        `);
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS trg_datarecord_balance_num_upd
          AFTER UPDATE OF outstanding_balance ON datarecord
          BEGIN
            UPDATE datarecord SET outstanding_balance_num = CASE
              WHEN NEW.outstanding_balance IS NULL OR NEW.outstanding_balance = '' OR NEW.outstanding_balance = '0'
                THEN NULL
              ELSE CAST(REPLACE(REPLACE(NEW.outstanding_balance, ',', ''), ' ', '') AS REAL)
            END WHERE id = NEW.id;
          END
        `);

        // Mirror on hub_records if present.
        try {
          const hubCols = db.prepare("PRAGMA table_info(hub_records)").all().map(c => c.name);
          if (hubCols.length > 0 && !hubCols.includes('outstanding_balance_num')) {
            db.exec(`ALTER TABLE hub_records ADD COLUMN outstanding_balance_num REAL`);
            db.exec(`
              UPDATE hub_records
              SET outstanding_balance_num = CASE
                WHEN outstanding_balance IS NULL OR outstanding_balance = '' OR outstanding_balance = '0'
                  THEN NULL
                ELSE CAST(REPLACE(REPLACE(outstanding_balance, ',', ''), ' ', '') AS REAL)
              END
            `);
            db.exec(`CREATE INDEX IF NOT EXISTS idx_hub_records_balance_num ON hub_records(outstanding_balance_num)`);
            // hub_records uses a composite primary key (site_id, record_id),
            // not a single `id` column. The earlier version of this trigger
            // had `WHERE id = NEW.id` (copy-pasted from the datarecord
            // trigger) which makes SQLite refuse to prepare ANY insert/update
            // against hub_records with "no such column: id" — the Hub's
            // entire customer-records ETL silently fails as a result.
            //
            // Migration 54 below repairs already-broken Hubs by dropping +
            // recreating these triggers with the correct composite-key
            // WHERE clause.
            db.exec(`
              CREATE TRIGGER IF NOT EXISTS trg_hub_records_balance_num_ins
              AFTER INSERT ON hub_records
              BEGIN
                UPDATE hub_records SET outstanding_balance_num = CASE
                  WHEN NEW.outstanding_balance IS NULL OR NEW.outstanding_balance = '' OR NEW.outstanding_balance = '0'
                    THEN NULL
                  ELSE CAST(REPLACE(REPLACE(NEW.outstanding_balance, ',', ''), ' ', '') AS REAL)
                END WHERE site_id = NEW.site_id AND record_id = NEW.record_id;
              END
            `);
            db.exec(`
              CREATE TRIGGER IF NOT EXISTS trg_hub_records_balance_num_upd
              AFTER UPDATE OF outstanding_balance ON hub_records
              BEGIN
                UPDATE hub_records SET outstanding_balance_num = CASE
                  WHEN NEW.outstanding_balance IS NULL OR NEW.outstanding_balance = '' OR NEW.outstanding_balance = '0'
                    THEN NULL
                  ELSE CAST(REPLACE(REPLACE(NEW.outstanding_balance, ',', ''), ' ', '') AS REAL)
                END WHERE site_id = NEW.site_id AND record_id = NEW.record_id;
              END
            `);
          }
        } catch {}
      },
    },
    {
      version: 48,
      name: 'hub_bat_summary',
      up() {
        // Per-site BAT reconciliation summary, populated by the daily hub puller.
        // One row per site (site_id is PK). Hub UI aggregates these into the
        // cross-site Reconciliation page.
        db.exec(`
          CREATE TABLE IF NOT EXISTS hub_bat_summary (
            site_id TEXT PRIMARY KEY,
            total_supplier REAL DEFAULT 0,
            total_sage REAL DEFAULT 0,
            total_variance REAL DEFAULT 0,
            weeks_count INTEGER DEFAULT 0,
            matched_count INTEGER DEFAULT 0,
            mismatch_count INTEGER DEFAULT 0,
            awaiting_count INTEGER DEFAULT 0,
            total_exceptions INTEGER DEFAULT 0,
            total_exception_amount REAL DEFAULT 0,
            last_upload_at TEXT,
            synced_at TEXT,
            last_error TEXT
          )
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_hub_bat_summary_synced ON hub_bat_summary(synced_at)`);
      },
    },
    {
      version: 49,
      name: 'reconciliation_permissions',
      up() {
        // New per-user permissions for the BAT Reconciliation modules added
        // in this release. Default 0 — admins always see them via the role
        // bypass in hasPermission() — opt-in for non-admin users.
        ensureColumn(db, 'user', 'can_access_reconciliation', 'INTEGER DEFAULT 0');
        ensureColumn(db, 'user', 'can_access_hub_reconciliation', 'INTEGER DEFAULT 0');
      },
    },
    {
      version: 50,
      name: 'perf_indexes_audit_and_bat_extractions',
      up() {
        // Audit-log lookups by (resource_type, resource_id) — used by the
        // record-history endpoint and credit-debug — were doing a full table
        // scan + sort. Composite index covers the WHERE and the ORDER BY.
        db.exec(`CREATE INDEX IF NOT EXISTS idx_auditlog_resource
                 ON auditlog(resource_type, resource_id, created_date DESC)`);
        // BAT OCR claimNext() filters on (reconciliation_id, extraction_status)
        // and orders by id. The existing single-column status index forced a
        // re-sort on every claim during a 200-PDF extraction.
        db.exec(`CREATE INDEX IF NOT EXISTS idx_bat_extractions_recon_status
                 ON bat_invoice_extractions(reconciliation_id, extraction_status, id)`);
      },
    },
    {
      version: 51,
      name: 'normalise_unpaid_invoice_numbers',
      up() {
        // Backed-by column that holds the unpaid invoice numbers as a single
        // uppercase space-joined TEXT. Lets `customer-by-invoice` filter
        // against ~50-200 chars per row instead of LIKE-scanning the 1–3 KB
        // JSON blob in `unpaid_invoices`. SQLite triggers maintain it on
        // every insert/update of unpaid_invoices, no app-code changes needed.
        const sql = (table) => `
          UPDATE ${table}
             SET unpaid_invoice_numbers = (
               SELECT COALESCE(GROUP_CONCAT(UPPER(json_extract(value, '$.number')), ' '), '')
                 FROM json_each(${table}.unpaid_invoices)
                WHERE json_extract(value, '$.number') IS NOT NULL
             )
           WHERE unpaid_invoices IS NOT NULL
             AND unpaid_invoices != ''
             AND unpaid_invoices != '[]'
        `;
        const trigger = (table, suffix, when) => `
          CREATE TRIGGER IF NOT EXISTS ${table}_unpaid_invoice_numbers_${suffix}
          AFTER ${when} ON ${table}
          ${when === 'INSERT' ? 'WHEN NEW.unpaid_invoices IS NOT NULL' : ''}
          BEGIN
            UPDATE ${table}
               SET unpaid_invoice_numbers = COALESCE((
                 SELECT GROUP_CONCAT(UPPER(json_extract(value, '$.number')), ' ')
                   FROM json_each(NEW.unpaid_invoices)
                  WHERE json_extract(value, '$.number') IS NOT NULL
               ), '')
             WHERE id = NEW.id;
          END
        `;

        // datarecord
        const drCols = db.prepare('PRAGMA table_info(datarecord)').all().map(c => c.name);
        if (!drCols.includes('unpaid_invoice_numbers')) {
          db.exec('ALTER TABLE datarecord ADD COLUMN unpaid_invoice_numbers TEXT');
        }
        db.exec(sql('datarecord'));
        db.exec(`CREATE INDEX IF NOT EXISTS idx_datarecord_unpaid_invoice_numbers
                 ON datarecord(unpaid_invoice_numbers)`);
        db.exec(trigger('datarecord', 'ai', 'INSERT'));
        db.exec(trigger('datarecord', 'au', 'UPDATE OF unpaid_invoices'));

        // hub_records is created in schema.js AFTER runMigrations on hub
        // installs, so the column + index + triggers for it live there
        // (mirrored at src/db/schema.js, search for unpaid_invoice_numbers).
      },
    },
    {
      version: 52,
      name: 'connection_role',
      up() {
        // Explicit module-to-connection routing. Replaces the implicit "first
        // active non-BAT connection" auto-pick in customerSqlPool, which broke
        // when sites had multiple non-BAT connections (customer module ended up
        // hitting the inventory connection by id order). Each row maps a known
        // module identifier to the connection it should use; loaders fall back
        // to the legacy auto-pick when a role is unset.
        db.exec(`
          CREATE TABLE IF NOT EXISTS connection_role (
            role TEXT PRIMARY KEY,
            connection_id INTEGER NOT NULL REFERENCES databaseconnection(id) ON DELETE CASCADE,
            updated_at TEXT DEFAULT (datetime('now'))
          )
        `);
        // Migrate the existing BAT/Sage pick into the new table so operators
        // don't lose their saved selection on upgrade.
        try {
          const row = db.prepare("SELECT value FROM bat_settings WHERE key = 'sage_connection_id'").get();
          const id = row?.value ? parseInt(row.value, 10) : null;
          if (Number.isFinite(id) && id > 0) {
            const exists = db.prepare('SELECT 1 FROM databaseconnection WHERE id = ?').get(id);
            if (exists) {
              db.prepare(`
                INSERT OR REPLACE INTO connection_role (role, connection_id, updated_at)
                VALUES ('bat_sage', ?, datetime('now'))
              `).run(id);
            }
          }
        } catch { /* bat_settings may not exist yet on a fresh install */ }
      },
    },
    {
      version: 53,
      name: 'error_log',
      up() {
        // Centralised error journal — one row per error from anywhere in the
        // app (BAT/OCR, Sage pool, sync engine, audit-log flush, browser-side
        // errors via /api/log/client-error, unhandled promise rejections).
        // Surfaces a user-facing "System log" page so off-site operators can
        // see what failed without grepping logs/errors.log.
        db.exec(`
          CREATE TABLE IF NOT EXISTS error_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            level TEXT NOT NULL DEFAULT 'error',
            message TEXT NOT NULL,
            stack TEXT,
            context TEXT,
            occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_error_log_occurred ON error_log(occurred_at DESC)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_error_log_source ON error_log(source, occurred_at DESC)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_error_log_level ON error_log(level, occurred_at DESC)`);
      },
    },
    {
      version: 55,
      name: 'admin_module_visibility',
      up() {
        // Existing admins were assumed to have implicit access to every
        // module via the `if (user.role === 'admin') return true` bypass
        // in lib/permissions.js. That bypass now respects an explicit `0`
        // on a permission column, enabling per-admin module visibility
        // (e.g., a BAT-only admin who shouldn't see Network Devices).
        //
        // Existing admins may have permission columns at 0 (the
        // `ensureColumn DEFAULT 0` migration default for any column added
        // after the user row was created). Without this migration they'd
        // suddenly lose access to those modules under the new logic.
        //
        // Set every admin's permission columns to 1 to preserve current
        // "admins see everything" default. From here on, an operator can
        // explicitly turn OFF specific modules per admin via the User
        // Management modal.
        try {
          const cols = [
            'can_access_customer_search',
            'can_access_customer_balances',
            'can_access_collections',
            'can_access_inventory',
            'can_access_network_devices',
            'can_access_hub_metrics',
            'can_access_hub_backups',
            'can_access_hub_trends',
            'can_access_hub_audit_log',
            'can_access_records',
            'can_access_reports',
            'can_access_connections',
            'can_access_reconciliation',
            'can_access_hub_reconciliation',
            'can_access_settings',
            'can_manage_users',
            'can_manage_rules',
            'can_edit_records',
            'can_flag_records',
          ];
          // Filter to columns that actually exist on this DB (older sites
          // may not have every permission column yet — ensureColumn
          // migrations earlier add them lazily).
          const userCols = db.prepare("PRAGMA table_info(\"user\")").all().map(c => c.name);
          const present = cols.filter(c => userCols.includes(c));
          if (present.length > 0) {
            const setClause = present.map(c => `${c} = 1`).join(', ');
            db.prepare(`UPDATE "user" SET ${setClause} WHERE role = 'admin'`).run();
          }
        } catch (err) {
          console.error('[migration 55] admin permission backfill failed:', err.message);
        }
      },
    },
    {
      version: 54,
      name: 'fix_hub_records_balance_num_triggers',
      up() {
        // Repair the broken triggers from migration 47. Hub_records has a
        // composite PK (site_id, record_id), but the earlier trigger body
        // referenced `id` (copy-pasted from the datarecord trigger). Every
        // INSERT/UPDATE against hub_records on a migrated Hub fails to even
        // prepare with "no such column: id", silently breaking the entire
        // customer-records ETL — the Hub Reconciliation page shows
        // "Awaiting data" forever for those sites.
        //
        // Drop both triggers if present and re-create with the correct
        // composite-key WHERE clause. Idempotent + safe on Hubs that never
        // had hub_records (the inner CREATE silently no-ops because the
        // column-existence guard above only fires when the table exists).
        try {
          const hubExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_records'`).get();
          if (!hubExists) return;
          const hubCols = db.prepare("PRAGMA table_info(hub_records)").all().map(c => c.name);
          if (!hubCols.includes('outstanding_balance_num')) return;
          db.exec(`DROP TRIGGER IF EXISTS trg_hub_records_balance_num_ins`);
          db.exec(`DROP TRIGGER IF EXISTS trg_hub_records_balance_num_upd`);
          db.exec(`
            CREATE TRIGGER trg_hub_records_balance_num_ins
            AFTER INSERT ON hub_records
            BEGIN
              UPDATE hub_records SET outstanding_balance_num = CASE
                WHEN NEW.outstanding_balance IS NULL OR NEW.outstanding_balance = '' OR NEW.outstanding_balance = '0'
                  THEN NULL
                ELSE CAST(REPLACE(REPLACE(NEW.outstanding_balance, ',', ''), ' ', '') AS REAL)
              END WHERE site_id = NEW.site_id AND record_id = NEW.record_id;
            END
          `);
          db.exec(`
            CREATE TRIGGER trg_hub_records_balance_num_upd
            AFTER UPDATE OF outstanding_balance ON hub_records
            BEGIN
              UPDATE hub_records SET outstanding_balance_num = CASE
                WHEN NEW.outstanding_balance IS NULL OR NEW.outstanding_balance = '' OR NEW.outstanding_balance = '0'
                  THEN NULL
                ELSE CAST(REPLACE(REPLACE(NEW.outstanding_balance, ',', ''), ' ', '') AS REAL)
              END WHERE site_id = NEW.site_id AND record_id = NEW.record_id;
            END
          `);
        } catch (err) {
          console.error('[migration 54] hub_records trigger repair failed:', err.message);
        }
      },
    },
    {
      version: 56,
      name: 'fix_hub_records_unpaid_invoice_numbers_triggers',
      up() {
        // Same class of bug as migration 54, different pair of triggers.
        // hub_records_unpaid_invoice_numbers_ai / _au were created in
        // src/db/schema.js with `WHERE id = NEW.id` — copy-pasted from the
        // datarecord version, which has a single-column id PK. hub_records
        // uses a composite (site_id, record_id) PK, so SQLite refuses to
        // prepare ANY insert/update against hub_records with "no such
        // column: id" — exactly the failure mode the Sync Log surfaced
        // (every site flipping to status='error' the moment the trigger
        // got installed). Drop and recreate with the composite-key WHERE.
        try {
          const hubExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_records'`).get();
          if (!hubExists) return;
          const hubCols = db.prepare("PRAGMA table_info(hub_records)").all().map(c => c.name);
          if (!hubCols.includes('unpaid_invoice_numbers')) return;
          db.exec(`DROP TRIGGER IF EXISTS hub_records_unpaid_invoice_numbers_ai`);
          db.exec(`DROP TRIGGER IF EXISTS hub_records_unpaid_invoice_numbers_au`);
          db.exec(`
            CREATE TRIGGER hub_records_unpaid_invoice_numbers_ai
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
            CREATE TRIGGER hub_records_unpaid_invoice_numbers_au
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
        } catch (err) {
          console.error('[migration 56] hub_records unpaid-invoice-numbers trigger repair failed:', err.message);
        }
      },
    },
    {
      version: 57,
      name: 'hub_bat_summary_missing_weeks',
      up() {
        // Add a missing_weeks_count column for the Hub Reconciliation page's
        // per-site card. Unlike awaiting_count (BAT uploaded, Sage hasn't
        // posted yet), this counts the inverse — weeks where Sage HAS
        // credit notes but no BAT recon has been uploaded yet. Operators
        // need this prominently because it tells them which sites are
        // behind on data entry.
        try {
          const tableExists = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='hub_bat_summary'"
          ).get();
          if (!tableExists) return;
          const cols = db.prepare("PRAGMA table_info(hub_bat_summary)").all().map(c => c.name);
          if (!cols.includes('missing_weeks_count')) {
            db.exec(`ALTER TABLE hub_bat_summary ADD COLUMN missing_weeks_count INTEGER DEFAULT 0`);
          }
        } catch (err) {
          console.error('[migration 57] hub_bat_summary column add failed:', err.message);
        }
      },
    },
    {
      version: 58,
      name: 'hub_bat_summary_per_week_detail',
      up() {
        // Add per-week-detail fields to hub_bat_summary so the Hub
        // Reconciliation per-site card can show the same level of detail
        // the operator sees on each site's own dashboard:
        //
        //   - last_paid_week / last_paid_year: highest week with Sage
        //     credit notes posted (e.g. "W9/2026")
        //   - missing_credit_notes_weeks: JSON array of week numbers in
        //     the current ISO year where BAT was uploaded but Sage has
        //     no credit notes yet (the site's "Missing Credit Notes"
        //     tile, scoped to one site)
        //   - mismatch_weeks: JSON array of week numbers where both
        //     sides exist but the variance exceeds R0.01 — the weeks
        //     that need investigation
        //   - summary_year: ISO year the lists are scoped to (so a
        //     stale row from a prior year doesn't keep showing).
        try {
          const tableExists = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='hub_bat_summary'"
          ).get();
          if (!tableExists) return;
          const cols = db.prepare("PRAGMA table_info(hub_bat_summary)").all().map(c => c.name);
          const add = (name, decl) => {
            if (!cols.includes(name)) db.exec(`ALTER TABLE hub_bat_summary ADD COLUMN ${name} ${decl}`);
          };
          add('last_paid_week', 'INTEGER');
          add('last_paid_year', 'INTEGER');
          add('last_bat_week', 'INTEGER');
          add('last_bat_year', 'INTEGER');
          add('missing_credit_notes_weeks', 'TEXT');
          add('mismatch_weeks', 'TEXT');
          add('summary_year', 'INTEGER');
        } catch (err) {
          console.error('[migration 58] hub_bat_summary per-week detail add failed:', err.message);
        }
      },
    },
    {
      version: 59,
      name: 'bat_year_scoped_indexes',
      up() {
        // The /api/reporting/bat-summary endpoint and the new per-site card
        // queries all filter by year first (WHERE r.year = ?), but the
        // existing idx_bat_recon_week index is keyed on (week_number, year)
        // — leading column wrong, can't satisfy a year-only filter. SQLite
        // falls back to a full scan of bat_reconciliations / bat_sage_week_cache
        // for each year-scoped query (6 of them per /api/reporting/bat-summary
        // call, fired by the hub every 5 min per site). Invisible today
        // with sub-300-row tables, but real load by year 3.
        //
        // Add proper year-leading indexes; idempotent (CREATE INDEX IF NOT
        // EXISTS).
        try {
          db.exec(`CREATE INDEX IF NOT EXISTS idx_bat_recon_year_week ON bat_reconciliations(year, week_number)`);
        } catch (err) {
          console.error('[migration 59] idx_bat_recon_year_week failed:', err.message);
        }
        try {
          db.exec(`CREATE INDEX IF NOT EXISTS idx_bat_sage_cache_year_week ON bat_sage_week_cache(year, week_number)`);
        } catch (err) {
          console.error('[migration 59] idx_bat_sage_cache_year_week failed:', err.message);
        }
        try {
          // Partial index for the exceptions count — typically <1% of
          // extractions are flagged so a partial index is much smaller
          // than a regular one and serves the bat-summary query directly.
          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_bat_extractions_exception
              ON bat_invoice_extractions(is_exception)
              WHERE is_exception = 1
          `);
        } catch (err) {
          console.error('[migration 59] idx_bat_extractions_exception failed:', err.message);
        }
      },
    },
    {
      version: 60,
      name: 'job_runs',
      up() {
        // Lifecycle tracking for scheduled background jobs. One row per
        // invocation: started_at, ended_at, status, duration_ms,
        // error_message, optional context JSON. Backs the
        // GET /api/system/jobs admin endpoint and the alert engine's
        // job-failure-spike rule.
        //
        // (Originally shipped with PR #178 but the migration entry was
        // dropped in the #178 ↔ #180 merge collision — same merge that
        // ate the recordJob imports and the /api/system/jobs route.
        // jobRunner.js was already on disk; only this migration entry
        // was missing. Restoring it here so existing installs running
        // jobRunner queries stop failing with `no such table: job_runs`.)
        db.exec(`
          CREATE TABLE IF NOT EXISTS job_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('started','succeeded','failed')),
            started_at TEXT NOT NULL,
            ended_at TEXT,
            duration_ms INTEGER,
            error_message TEXT,
            context TEXT
          )
        `);
        // Compound index for "latest N runs of job X" — the dominant read
        // pattern from /api/system/jobs and from the alert engine's dedup checks.
        db.exec(`CREATE INDEX IF NOT EXISTS idx_job_runs_name_started ON job_runs(name, started_at DESC)`);
        // For "all jobs since timestamp" queries (the dashboard view).
        db.exec(`CREATE INDEX IF NOT EXISTS idx_job_runs_started ON job_runs(started_at DESC)`);
      },
    },
    {
      // Reserved gap: v62 = hub_sites_accpac_freshness (PR #198),
      // v63 = hub_sites_orphan_tombstone (PR #200). Skipping to v64
      // here so this migration can land independently of those PRs;
      // the runMigrations loop checks each version individually so
      // gaps are fine.
      version: 64,
      name: 'datarecord_customer_name_lower_index',
      up() {
        // Customer-lookup endpoints query
        //   WHERE lower(customer_name) = lower(?)
        // which is non-sargable against the existing
        // idx_datarecord_customer_name (plain column index). Adding an
        // expression index on lower(customer_name) lets SQLite use the
        // index for this equality. At typical site sizes (5K–20K rows)
        // the difference is sub-millisecond either way; at higher row
        // counts the scan-vs-index gap matters.
        //
        // TRIM(customer_number) equality is also non-sargable today —
        // not added here because customer_number is already
        // canonicalised at sync time (no leading/trailing whitespace
        // on the rows from runConnectionImport), so the TRIM is a
        // belt-and-braces guard against historical drift rather than
        // a real performance concern. If query-plan analysis later
        // shows TRIM hurting on a large estate, mirror this pattern
        // in a follow-up migration.
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_datarecord_customer_name_lower
            ON datarecord(lower(customer_name))
        `);
      },
    },
    {
      version: 61,
      name: 'alerts',
      up() {
        // Operator alerts surfaced by the alert engine (src/lib/alertEngine.js).
        // Each row is one firing of one rule. dedup_key is what stops
        // the engine writing the same active alert repeatedly while a
        // condition persists; resolved_at NULL = still active.
        //
        // Severity is a fixed enum mainly so the future email channel
        // (env-var opt-in) can apply per-severity routing without a
        // separate config table. context is a small JSON blob the rule
        // attaches at fire time (offending values, links, etc.).
        db.exec(`
          CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_name TEXT NOT NULL,
            severity TEXT NOT NULL CHECK (severity IN ('critical','warning','info')),
            message TEXT NOT NULL,
            context TEXT,
            dedup_key TEXT NOT NULL,
            fired_at TEXT NOT NULL,
            resolved_at TEXT,
            resolved_by TEXT
          )
        `);
        // The dominant query pattern is "is there an active alert for
        // this dedup_key?" — partial index keyed on dedup_key WHERE
        // resolved_at IS NULL satisfies that without scanning resolved
        // history.
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_alerts_active_dedup
            ON alerts(dedup_key) WHERE resolved_at IS NULL
        `);
        // For the dashboard / API: latest alerts overall.
        db.exec(`CREATE INDEX IF NOT EXISTS idx_alerts_fired ON alerts(fired_at DESC)`);
      },
    },
    {
      // Restored after the v62 entry was lost in a merge between PR #198,
      // PR #200, and PR #214 — production hubs upgrading to 2026.5.2 hit
      // "no such column: last_accpac_synced_at" on every hub.sync tick
      // because hubEtl.js / routes/hub.js / HubDashboard.jsx all reference
      // these three columns that the v62 migration was supposed to add.
      // Idempotent (ensureColumn) so re-running on installs that already
      // got the column some other way is a no-op.
      //
      // Two-channel install path (don't drop one without the other):
      //   - Existing hub installs: this migration ensureColumns the
      //     three columns onto the already-existing hub_sites table.
      //   - Fresh hub installs: runMigrations runs BEFORE schema.js's
      //     CREATE TABLE hub_sites (line 206 vs 212), so this migration
      //     no-ops and records itself as applied before hub_sites
      //     exists. The CREATE TABLE in schema.js is the canonical
      //     source — it includes the three accpac columns directly so
      //     fresh installs get them at creation time. Codex flagged
      //     this on PR #228: without the schema.js half, v62 would
      //     mark itself applied and the columns would never appear.
      version: 62,
      name: 'hub_sites_accpac_freshness',
      up() {
        // The hub's customer-management page used to show `last_seen` as
        // the freshness metric, but that's "when did the hub last reach
        // the site", not "when did the site last sync from Accpac". The
        // dashboard tile now surfaces the latter — the operator-relevant
        // signal for "is the data on this tile stale?".
        //
        // Three columns:
        //   - last_accpac_synced_at: most recent SUCCESSFUL Accpac sync
        //     (max of databaseconnection.last_sync across active
        //     non-BAT-only connections).
        //   - last_accpac_status: 'ok' | 'error' | 'never_synced'.
        //   - last_accpac_error: short user-facing reason via
        //     describeSqlError when status='error'.
        //
        // Gated on hub_sites table existing. On fresh installs the table
        // doesn't exist yet (schema.js creates it AFTER runMigrations) —
        // the CREATE TABLE there carries the three columns natively, so
        // this gate-skip is correct, not a bug. On existing hub installs
        // the table is present and we ensureColumn the new columns onto
        // it. Non-hub installs never have the table; the column is
        // meaningless there.
        const hubSitesExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_sites'`).get();
        if (hubSitesExists) {
          ensureColumn(db, 'hub_sites', 'last_accpac_synced_at', 'TEXT');
          ensureColumn(db, 'hub_sites', 'last_accpac_status',     'TEXT');
          ensureColumn(db, 'hub_sites', 'last_accpac_error',      'TEXT');
        }
      },
    },
    {
      version: 63,
      name: 'hub_sites_orphan_tombstone',
      up() {
        // hub_sites and HUB_SITES (the env-derived in-memory list) drift:
        // upsertSites writes new rows but never removes ones whose ids
        // dropped out of the env. The schedulers iterate HUB_SITES so
        // orphan rows simply stop being refreshed, but the dashboard
        // still serves them — operators see a tile that looks live but
        // is actually frozen. Worse: per-site action endpoints (trigger
        // accpac sync, force-resync, push-rules) happily forward to the
        // orphan's stored URL because they read hub_sites directly.
        //
        // Soft-tombstone fixes both gaps. upsertSites flips in_env=0 on
        // any row whose id is NOT in the incoming list (and stamps
        // removed_from_env_at the first time it does). Action endpoints
        // refuse on orphans with a clear 409. The UI shows orphans with
        // a badge but doesn't act on them, and an admin "Forget" button
        // is the only way to delete the row + cascade to hub_records /
        // hub_inventory.
        //
        // Default in_env=1 so existing rows are treated as live on
        // first boot — the next upsertSites call reconciles correctly.
        const hubSitesExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_sites'`).get();
        if (hubSitesExists) {
          ensureColumn(db, 'hub_sites', 'in_env',              "INTEGER NOT NULL DEFAULT 1");
          ensureColumn(db, 'hub_sites', 'removed_from_env_at', 'TEXT');
          db.exec(`CREATE INDEX IF NOT EXISTS idx_hub_sites_in_env ON hub_sites(in_env)`);
        }
      },
    },
    {
      // Drop the resource_type CHECK constraint from auditlog.
      //
      // The original schema whitelisted resource_type to one of
      //   'user' | 'connection' | 'record' | 'rule' | 'system'
      // PR #198 added the "Sync from Accpac" trigger flow with three new
      // logAudit calls passing resource_type='site' — without updating the
      // CHECK. Every operator click on the hub's "Sync from Accpac" button
      // (and every scheduled retry) emits a SQLITE_CONSTRAINT_CHECK and the
      // audit row is silently dropped, leaving the hub_audit_log page with
      // no record of who triggered what.
      //
      // The fix could be "add 'site' to the CHECK list", but that just sets
      // up the next merge-loss bug — every new feature that introduces a
      // resource type would need a coordinated CHECK migration. Drop the
      // constraint entirely; resource_type is descriptive metadata, not a
      // foreign-key-style invariant. The status CHECK ('success'|'failure')
      // stays — it's a finite domain that we DO want enforced.
      //
      // SQLite doesn't support ALTER TABLE DROP CONSTRAINT directly, so this
      // does the standard table-swap dance: create new table, copy rows,
      // drop old, rename. Run inside the migration transaction (runMigrations
      // wraps each in db.transaction) so a partial swap rolls back cleanly.
      // Indexes are recreated to match schema.js + migration v40 (the
      // resource lookup index).
      version: 65,
      name: 'auditlog_drop_resource_type_check',
      up() {
        const auditExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='auditlog'`).get();
        if (!auditExists) return; // Nothing to migrate; schema.js will create with the new shape.
        db.exec(`
          CREATE TABLE auditlog_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action_type TEXT NOT NULL,
            user_email TEXT NOT NULL,
            user_name TEXT,
            resource_type TEXT,
            resource_id TEXT,
            resource_name TEXT,
            action_details TEXT,
            changes TEXT,
            ip_address TEXT,
            status TEXT CHECK(status IN ('success', 'failure')) NOT NULL,
            created_date TEXT DEFAULT CURRENT_TIMESTAMP
          );
          INSERT INTO auditlog_new (
            id, action_type, user_email, user_name, resource_type,
            resource_id, resource_name, action_details, changes,
            ip_address, status, created_date
          )
          SELECT
            id, action_type, user_email, user_name, resource_type,
            resource_id, resource_name, action_details, changes,
            ip_address, status, created_date
          FROM auditlog;
          DROP TABLE auditlog;
          ALTER TABLE auditlog_new RENAME TO auditlog;
          CREATE INDEX IF NOT EXISTS idx_auditlog_created_date
            ON auditlog(created_date);
          CREATE INDEX IF NOT EXISTS idx_auditlog_resource
            ON auditlog(resource_type, resource_id, created_date DESC);
        `);
      },
    },
    {
      // Drop the defunct record_snapshots table.
      //
      // The table was a snapshot-on-every-sync record that nobody
      // actually read. Writes were dropped earlier (see the comment
      // at src/services/syncEngine.js around the runWriteRows helper)
      // but the existing rows were left in place — "the table itself
      // is kept around (no destructive migration)".
      //
      // On busy production sites that table accumulated ~600 MB/month
      // of dead JSON before writes stopped. One site was found at
      // 1,001,490 rows totalling 3.7 GB of cardoso.db (the entire
      // database file was 99% this one table). The defunct-table-with-
      // no-readers state had no upside; drop it.
      //
      // IF EXISTS so the migration is a no-op on installs that already
      // saw the table dropped manually (e.g. operator ran the
      // operator-runbook cleanup before this release deployed) AND on
      // brand-new installs that never had the table created.
      //
      // Important: DROP TABLE alone does NOT shrink cardoso.db on disk
      // — SQLite frees the pages but the file size is unchanged until
      // a VACUUM runs. The monthly VACUUM cron added in the same
      // release reclaims the disk within ~30 days. Operators who want
      // the disk back immediately can run a one-shot VACUUM (see the
      // operator runbook section on disk recovery).
      version: 66,
      name: 'drop_defunct_record_snapshots',
      up() {
        db.exec('DROP TABLE IF EXISTS record_snapshots');
      },
    },
    {
      // hub_audit_log was a parallel audit surface that mirrored
      // every hub admin action already captured in `auditlog` (see
      // PR #262 commit message). The dual-write was not actually
      // adding information — every logHubAudit call was paired
      // with a logAudit call writing a hub_*-prefixed action_type
      // to the canonical auditlog table, so the hub_audit_log page
      // was a strict subset of the System Audit Log filtered to
      // `action_type LIKE 'hub_%'`. Removed the page, the writer,
      // the route, and the can_access_hub_audit_log permission;
      // this migration drops the now-dead table.
      //
      // No data loss: every row in hub_audit_log has a corresponding
      // row in auditlog with the same actor + target + timestamp
      // (within milliseconds — the two writes were sequential at
      // the call site). DROP TABLE leaves disk pages dormant until
      // the next VACUUM (see the v66 comment for reclamation cadence).
      version: 67,
      name: 'drop_defunct_hub_audit_log',
      up() {
        db.exec('DROP TABLE IF EXISTS hub_audit_log');
      },
    },
    {
      // Archive every uploaded BAT supplier spreadsheet so a later
      // dispute can be replayed against the original file. Today the
      // upload route parses the .xlsx into DB rows then unlinks the
      // multer temp file in a finally block — once the operator is
      // looking at the recon there's no way to re-open the source if
      // a supplier disagrees with the totals. archive_path stores the
      // copy's location under uploads/bat-archive/<reconId>/.
      version: 68,
      name: 'bat_reconciliations_archive_path',
      up() {
        db.exec(`ALTER TABLE bat_reconciliations ADD COLUMN archive_path TEXT`);
      },
    },
    {
      // JTI export module — a vendor-scoped Sales report against Accpac
      // (Sage 300) that replaces an existing Crystal-report-plus-Excel-
      // macro workflow. Adds:
      //   - can_access_jti permission flag on the user table (defaults
      //     OFF for existing users; UserPermissionsModal exposes a
      //     toggle so admins can grant it)
      //   - jti_settings key/value table for the operator-supplied
      //     defaults (TownCity / Region / Country) that get pre-filled
      //     into every export. These are static per install; changing
      //     them is a once-per-deployment operation done via the JTI
      //     page's Defaults panel.
      //
      // The defaults live in the DB rather than env vars because they're
      // operator-editable from the UI; env vars would force a restart.
      version: 69,
      name: 'jti_export_permission_and_settings',
      up() {
        ensureColumn(db, 'user', 'can_access_jti', 'INTEGER DEFAULT 0');
        db.exec(`
          CREATE TABLE IF NOT EXISTS jti_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
          )
        `);
      },
    },
    {
      // JTI archive — versioned per (period_year, period_month) so the
      // operator's manual exports and the scheduled monthly job both
      // get persisted side-by-side without overwriting each other.
      // Files live on disk under uploads/jti-archive/<YYYY>-<MM>/; this
      // table stores the metadata + the hub-push state machine.
      //
      // Hub push lifecycle:
      //   pending  → never attempted (fresh row)
      //   pushed   → hub acknowledged receipt
      //   failed   → push attempted, hub returned error or unreachable;
      //              hub_push_attempts incremented; retry job picks it up
      //   skipped_no_hub → site isn't configured for hub mode (no
      //                    HUB_URL/REPORTING_TOKEN); won't be retried
      // The hub-side mirror table (hub_jti_archive) lives in a later
      // migration on the hub-mode side; keeping site-side and hub-side
      // schemas separate keeps the per-install footprint minimal.
      version: 70,
      name: 'jti_archive_table',
      up() {
        db.exec(`
          CREATE TABLE IF NOT EXISTS jti_archive (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            -- Calendar month this export covers
            period_year   INTEGER NOT NULL,
            period_month  INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),

            -- Provenance
            generated_at  TEXT NOT NULL DEFAULT (datetime('now')),
            generated_by  TEXT,
            source        TEXT NOT NULL CHECK (source IN ('scheduled', 'manual')),

            -- File on disk
            filename      TEXT NOT NULL,
            file_path     TEXT NOT NULL,
            byte_size     INTEGER NOT NULL,
            sha256        TEXT NOT NULL,
            row_count     INTEGER NOT NULL,

            -- Snapshot of the address fields stamped into this archive,
            -- so a future "what label values did we use for April?"
            -- can be answered without re-reading the .xlsx.
            town_city     TEXT,
            region        TEXT,
            country       TEXT,
            site_label    TEXT,

            -- Hub push state machine (see migration comment)
            hub_push_status   TEXT NOT NULL DEFAULT 'pending'
              CHECK (hub_push_status IN ('pending', 'pushed', 'failed', 'skipped_no_hub')),
            hub_push_at       TEXT,
            hub_push_error    TEXT,
            hub_push_attempts INTEGER NOT NULL DEFAULT 0
          )
        `);
        // Most common read: "list archives, latest first per period"
        // — drives the JTI page's Archive panel. (DESC, DESC, DESC)
        // matches the natural display order so SQLite can serve it
        // from the index without sorting.
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_jti_archive_period
          ON jti_archive(period_year DESC, period_month DESC, generated_at DESC)
        `);
        // Retry job scans rows in pending/failed state hourly; this
        // index keeps that scan cheap as the archive grows.
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_jti_archive_hub_push
          ON jti_archive(hub_push_status)
        `);
      },
    },
    {
      // v71 — hub_jti_archive: hub-side mirror of the per-site
      // jti_archive table (v70). Runs on hub installs only (the
      // table is created everywhere, but is empty / unused on a
      // pure site install). One row per (site_id, sha256) — sha256
      // is the natural dedup key, so a push followed by a pull-
      // fallback that targets the same archive can't double-insert.
      //
      // received_via captures whether the archive arrived via the
      // site→hub PUSH or the hub→site PULL fallback. Useful for
      // debugging "why did the hub not get last month's archive
      // until 24h after the site generated it" investigations.
      version: 71,
      name: 'hub_jti_archive_table',
      up() {
        db.exec(`
          CREATE TABLE IF NOT EXISTS hub_jti_archive (
            id INTEGER PRIMARY KEY AUTOINCREMENT,

            -- Which site this came from (matches HUB_SITES.id)
            site_id        TEXT NOT NULL,
            site_archive_id INTEGER,

            -- Calendar month
            period_year    INTEGER NOT NULL,
            period_month   INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),

            -- Provenance copied from the site row
            generated_at   TEXT NOT NULL,
            generated_by   TEXT,
            source         TEXT NOT NULL CHECK (source IN ('scheduled', 'manual')),

            -- File on hub disk
            filename       TEXT NOT NULL,
            file_path      TEXT NOT NULL,
            byte_size      INTEGER NOT NULL,
            sha256         TEXT NOT NULL,
            row_count      INTEGER NOT NULL,

            -- Snapshot of label fields the site stamped in
            town_city      TEXT,
            region         TEXT,
            country        TEXT,
            site_label     TEXT,

            -- How / when the hub got the file
            received_at    TEXT NOT NULL DEFAULT (datetime('now')),
            received_via   TEXT NOT NULL CHECK (received_via IN ('push', 'pull'))
          )
        `);
        // Natural dedup key — a site uploading the same .xlsx twice
        // (push retry, push then pull-fallback) collapses to one row.
        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_hub_jti_archive_dedup
          ON hub_jti_archive(site_id, sha256)
        `);
        // Most common UI read: list across all sites, latest period
        // first.
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_hub_jti_archive_period
          ON hub_jti_archive(period_year DESC, period_month DESC, received_at DESC)
        `);
        // Per-site filtered listing.
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_hub_jti_archive_site
          ON hub_jti_archive(site_id, period_year DESC, period_month DESC)
        `);
      },
    },
    {
      // bat_overview_orders: persistent record of every ODR that
      // appeared in BAT's Overview-tab pivot tables (normal + exception)
      // at upload time, regardless of whether a matching POD existed in
      // the same upload's Delivery POD sheet.
      //
      // Why: BAT's claim summary at the top of the Overview tab (which
      // becomes the recon's supplier_delivery/discount/pricing — the
      // headline BAT TOTAL) sums the Overview pivot, including orders
      // BAT didn't ship a POD for. We only created extraction rows for
      // orders that had a PDF in the Delivery POD sheet, so for any
      // POD-less Overview entry, the operator had no visibility — the
      // amount was rolled into the BAT TOTAL but invisible per-row.
      //
      // After this migration, every upload writes the full Overview
      // pivot ODR list here. The per-week tile's "Missing PODs"
      // indicator, the EXCEPTIONS tab on the per-invoice audit page,
      // and the new Missing PODs tab all read this table to find ODRs
      // present in BAT's Overview but absent from
      // bat_invoice_extractions (NOT EXISTS by order_number within the
      // same reconciliation).
      //
      // is_exception distinguishes the two pivots BAT ships side-by-
      // side: the normal pivot drives the claim summary, the exception
      // pivot is a separate population (PoD-not-signed,
      // incorrect-delivery-status etc.) that needs to balance against
      // its own pivot total.
      //
      // Older recons created before this migration have no rows here;
      // the operator can backfill by re-uploading the same spreadsheet.
      // The UI shows an explicit "re-upload to populate" hint per recon
      // when bat_overview_orders is empty for that recon_id.
      version: 72,
      name: 'bat_overview_orders_for_pod_coverage',
      up() {
        db.exec(`
          CREATE TABLE IF NOT EXISTS bat_overview_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reconciliation_id INTEGER NOT NULL REFERENCES bat_reconciliations(id) ON DELETE CASCADE,
            order_number TEXT NOT NULL,
            is_exception INTEGER NOT NULL DEFAULT 0 CHECK (is_exception IN (0, 1)),
            order_amount REAL NOT NULL DEFAULT 0,
            supplier_discount REAL DEFAULT 0,
            supplier_delivery REAL DEFAULT 0,
            supplier_pricing  REAL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(reconciliation_id, order_number)
          )
        `);
        // The "missing PODs" query is NOT EXISTS by (reconciliation_id,
        // order_number) against bat_invoice_extractions, so the natural
        // index is the same composite the UNIQUE already creates above.
        // A second index on (reconciliation_id, is_exception) speeds the
        // tab-grouping queries (EXCEPTIONS tab needs only is_exception=1).
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_bat_overview_orders_recon_exc
          ON bat_overview_orders(reconciliation_id, is_exception)
        `);
      },
    },
    {
      // Drop the NOT NULL constraint on bat_overview_orders.order_amount
      // so the parser can persist "amount not declared yet" as a true
      // NULL instead of coercing to 0. Without this, an Overview pivot
      // row whose Sub Total Excl NC cell is blank or non-numeric got
      // stored as R 0.00 and the Missing PODs tile understated the
      // operator's exposure (showing R 0 for orders whose value is
      // actually unknown). Consumers (getReconciliation.missingPods
      // and listReconciliations.mp_stats) already use COALESCE(...,0)
      // for sums, so they remain numeric-safe.
      //
      // SQLite ALTER COLUMN can't drop NOT NULL — recreate the table.
      // Done inside an explicit transaction so a crash mid-rewrite
      // doesn't leave the schema half-applied. Indexes are recreated
      // by name to match the v72 originals exactly (idempotent CREATE
      // IF NOT EXISTS).
      version: 73,
      name: 'bat_overview_orders_amount_nullable',
      up() {
        // No explicit BEGIN/COMMIT — the migration runner already wraps
        // each migration in a transaction. Nesting one inside throws
        // "cannot start a transaction within a transaction".
        db.exec(`
          CREATE TABLE bat_overview_orders_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reconciliation_id INTEGER NOT NULL REFERENCES bat_reconciliations(id) ON DELETE CASCADE,
            order_number TEXT NOT NULL,
            is_exception INTEGER NOT NULL DEFAULT 0 CHECK (is_exception IN (0, 1)),
            order_amount REAL,
            supplier_discount REAL DEFAULT 0,
            supplier_delivery REAL DEFAULT 0,
            supplier_pricing  REAL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(reconciliation_id, order_number)
          );
          INSERT INTO bat_overview_orders_new
            (id, reconciliation_id, order_number, is_exception, order_amount,
             supplier_discount, supplier_delivery, supplier_pricing, created_at)
            SELECT id, reconciliation_id, order_number, is_exception, order_amount,
                   supplier_discount, supplier_delivery, supplier_pricing, created_at
              FROM bat_overview_orders;
          DROP TABLE bat_overview_orders;
          ALTER TABLE bat_overview_orders_new RENAME TO bat_overview_orders;
          CREATE INDEX IF NOT EXISTS idx_bat_overview_orders_recon_exc
            ON bat_overview_orders(reconciliation_id, is_exception);
        `);
      },
    },
    {
      version: 74,
      name: 'stock_receipt_expiry_tables',
      up() {
        db.exec(`
          CREATE TABLE IF NOT EXISTS stock_receipt (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_table TEXT NOT NULL,
            receipt_number TEXT NOT NULL,
            supplier_code TEXT,
            supplier_name TEXT,
            receipt_date TEXT,
            external_uid TEXT,
            imported_at TEXT DEFAULT CURRENT_TIMESTAMP,
            created_date TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_date TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(source_table, receipt_number)
          );
          CREATE INDEX IF NOT EXISTS idx_stock_receipt_number ON stock_receipt(receipt_number);
          CREATE INDEX IF NOT EXISTS idx_stock_receipt_date ON stock_receipt(receipt_date);

          CREATE TABLE IF NOT EXISTS stock_receipt_line (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            receipt_id INTEGER NOT NULL REFERENCES stock_receipt(id) ON DELETE CASCADE,
            line_no INTEGER,
            item_number TEXT NOT NULL,
            item_description TEXT,
            qty_received TEXT,
            uom TEXT,
            unit_cost TEXT,
            batch_or_lot TEXT,
            source_line_uid TEXT,
            created_date TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_date TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(receipt_id, line_no, item_number)
          );
          CREATE INDEX IF NOT EXISTS idx_stock_receipt_line_item ON stock_receipt_line(item_number);
          CREATE INDEX IF NOT EXISTS idx_stock_receipt_line_receipt ON stock_receipt_line(receipt_id);

          CREATE TABLE IF NOT EXISTS stock_receipt_line_expiry (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            receipt_line_id INTEGER NOT NULL REFERENCES stock_receipt_line(id) ON DELETE CASCADE,
            expiry_date TEXT NOT NULL,
            qty_at_expiry TEXT,
            entered_by TEXT,
            entry_source TEXT DEFAULT 'manual',
            notes TEXT,
            created_date TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_date TEXT DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_stock_receipt_expiry_date ON stock_receipt_line_expiry(expiry_date);
          CREATE INDEX IF NOT EXISTS idx_stock_receipt_expiry_line ON stock_receipt_line_expiry(receipt_line_id);
        `);
      },
    },
    {
      version: 75,
      name: 'stock_receipt_site_context',
      up() {
        ensureColumn(db, 'stock_receipt', 'site_id', 'TEXT');
        db.exec(`CREATE INDEX IF NOT EXISTS idx_stock_receipt_site ON stock_receipt(site_id)`);
      },
    },
    {
      version: 76,
      name: 'stock_receipt_site_id_normalized_uniqueness',
      up() {
        db.exec(`
          UPDATE stock_receipt
             SET site_id = ''
           WHERE site_id IS NULL;
          CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_receipt_site_source_number_unique
            ON stock_receipt(COALESCE(site_id, ''), source_table, receipt_number);
        `);
      },
    },

    {
      version: 77,
      name: 'stock_receipt_drop_legacy_global_unique',
      up() {
        db.exec(`
          CREATE TABLE stock_receipt_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            site_id TEXT NOT NULL DEFAULT '',
            source_table TEXT NOT NULL,
            receipt_number TEXT NOT NULL,
            supplier_code TEXT,
            supplier_name TEXT,
            receipt_date TEXT,
            external_uid TEXT,
            imported_at TEXT DEFAULT CURRENT_TIMESTAMP,
            created_date TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_date TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(site_id, source_table, receipt_number)
          );

          INSERT INTO stock_receipt_new (
            id, site_id, source_table, receipt_number,
            supplier_code, supplier_name, receipt_date, external_uid,
            imported_at, created_date, updated_date
          )
          SELECT
            id,
            COALESCE(site_id, ''),
            source_table,
            receipt_number,
            supplier_code,
            supplier_name,
            receipt_date,
            external_uid,
            imported_at,
            created_date,
            updated_date
          FROM stock_receipt;

          CREATE TABLE stock_receipt_line_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            receipt_id INTEGER NOT NULL REFERENCES stock_receipt_new(id) ON DELETE CASCADE,
            line_no INTEGER,
            item_number TEXT NOT NULL,
            item_description TEXT,
            qty_received TEXT,
            uom TEXT,
            unit_cost TEXT,
            batch_or_lot TEXT,
            source_line_uid TEXT,
            created_date TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_date TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(receipt_id, line_no, item_number)
          );

          INSERT INTO stock_receipt_line_new (
            id, receipt_id, line_no, item_number, item_description,
            qty_received, uom, unit_cost, batch_or_lot, source_line_uid,
            created_date, updated_date
          )
          SELECT
            id, receipt_id, line_no, item_number, item_description,
            qty_received, uom, unit_cost, batch_or_lot, source_line_uid,
            created_date, updated_date
          FROM stock_receipt_line;

          CREATE TABLE stock_receipt_line_expiry_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            receipt_line_id INTEGER NOT NULL REFERENCES stock_receipt_line_new(id) ON DELETE CASCADE,
            expiry_date TEXT NOT NULL,
            qty_at_expiry TEXT,
            entered_by TEXT,
            entry_source TEXT DEFAULT 'manual',
            notes TEXT,
            created_date TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_date TEXT DEFAULT CURRENT_TIMESTAMP
          );

          INSERT INTO stock_receipt_line_expiry_new (
            id, receipt_line_id, expiry_date, qty_at_expiry, entered_by,
            entry_source, notes, created_date, updated_date
          )
          SELECT
            id, receipt_line_id, expiry_date, qty_at_expiry, entered_by,
            entry_source, notes, created_date, updated_date
          FROM stock_receipt_line_expiry;

          DROP TABLE stock_receipt_line_expiry;
          DROP TABLE stock_receipt_line;
          DROP TABLE stock_receipt;

          ALTER TABLE stock_receipt_new RENAME TO stock_receipt;
          ALTER TABLE stock_receipt_line_new RENAME TO stock_receipt_line;
          ALTER TABLE stock_receipt_line_expiry_new RENAME TO stock_receipt_line_expiry;

          CREATE INDEX IF NOT EXISTS idx_stock_receipt_site ON stock_receipt(site_id);
          CREATE INDEX IF NOT EXISTS idx_stock_receipt_number ON stock_receipt(receipt_number);
          CREATE INDEX IF NOT EXISTS idx_stock_receipt_date ON stock_receipt(receipt_date);
          CREATE INDEX IF NOT EXISTS idx_stock_receipt_line_item ON stock_receipt_line(item_number);
          CREATE INDEX IF NOT EXISTS idx_stock_receipt_line_receipt ON stock_receipt_line(receipt_id);
          CREATE INDEX IF NOT EXISTS idx_stock_receipt_expiry_date ON stock_receipt_line_expiry(expiry_date);
          CREATE INDEX IF NOT EXISTS idx_stock_receipt_expiry_line ON stock_receipt_line_expiry(receipt_line_id);
        `);
      },
    },
    {
      version: 78,
      name: 'stock_receipt_expiry_permission',
      up() {
        ensureColumn(db, 'user', 'can_access_stock_receipt_expiry', 'INTEGER DEFAULT 0');
        db.prepare(`UPDATE "user" SET can_access_stock_receipt_expiry = COALESCE(can_access_inventory, 0) WHERE can_access_stock_receipt_expiry IS NULL OR can_access_stock_receipt_expiry = 0`).run();
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
