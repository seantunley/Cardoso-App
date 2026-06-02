import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 12,
      name: 'inventoryrecord_missing_columns',
      up(db) {
        // Sites upgraded from v2026.3.1 (monolithic server.js) may have had v4 recorded
        // before stocking_uom/commodity/inventory_value were added to it.
        // This migration ensures those columns exist unconditionally.
        ensureColumn(db, 'inventoryrecord', 'stocking_uom', 'TEXT');
        ensureColumn(db, 'inventoryrecord', 'commodity', 'TEXT');
        ensureColumn(db, 'inventoryrecord', 'inventory_value', 'TEXT');
      },
    };
