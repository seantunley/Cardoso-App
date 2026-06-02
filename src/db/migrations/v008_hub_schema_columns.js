import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 8,
      name: 'hub_schema_columns',
      up(db) {
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
    };
