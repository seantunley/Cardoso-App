import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 11,
      name: 'hub_inventory_value_column',
      up(db) {
        // Add inventory_value to hub_inventory — not gated on HUB_MODE so it runs wherever the table exists
        const hubInventoryExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_inventory'`).get();
        if (hubInventoryExists) {
          ensureColumn(db, 'hub_inventory', 'inventory_value', 'TEXT');
        }
      },
    };
