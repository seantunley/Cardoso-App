import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 76,
      name: 'split_inventory_movement_permission',
      up(db) {
        // Inventory Movement (sales velocity, dead stock, forecasting)
        // was previously gated by can_access_inventory — the same flag
        // controlling read-only browse of inventoryrecord. Splitting it
        // out so operations leads who own forecasting / ordering can be
        // granted access independently of general inventory browsing.
        // Existing inventory users keep access to preserve current behaviour.
        ensureColumn(db, 'user', 'can_access_inventory_movement', 'INTEGER DEFAULT 0');
        db.prepare(`UPDATE "user" SET can_access_inventory_movement = 1 WHERE can_access_inventory = 1 OR role = 'admin'`).run();
      },
    };
