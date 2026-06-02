import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 33,
      name: 'perf_indexes_hub_inventory_and_records',
      up(db) {
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
    };
