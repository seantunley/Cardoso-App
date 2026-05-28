import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 35,
      name: 'inventory_sales_rep_column',
      up(db) {
        // Historical migration kept for compatibility. A later cleanup migration
        // removes sales_rep from inventory ownership entirely.
        try { db.prepare('ALTER TABLE inventoryrecord ADD COLUMN sales_rep TEXT').run(); } catch {}
        try { db.prepare('ALTER TABLE hub_inventory ADD COLUMN sales_rep TEXT').run(); } catch {}
      },
    };
