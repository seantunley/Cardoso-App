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
