import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 35,
      name: 'inventory_sales_rep_column',
      up(db) {
        // Historical migration kept for compatibility. A later cleanup migration
        // removes sales_rep from inventory ownership entirely.
        try { db.prepare('ALTER TABLE inventoryrecord ADD COLUMN sales_rep TEXT').run(); }
        catch (e) { if (!/duplicate column name/i.test(e.message)) console.error('[migration.v035.add_inventoryrecord_sales_rep]', e.message); }
        try { db.prepare('ALTER TABLE hub_inventory ADD COLUMN sales_rep TEXT').run(); }
        catch (e) { if (!/duplicate column name/i.test(e.message)) console.error('[migration.v035.add_hub_inventory_sales_rep]', e.message); }
      },
    };
