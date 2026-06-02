import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 38,
      name: 'remove_sales_rep_from_inventory_tables',
      up(db) {
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
    };
