import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 77,
      name: 'add_price_list_permission',
      up(db) {
        // Price List module reads from Sage ICPRICP per-unit prices.
        // Separated from the generic Inventory permission so a sales
        // rep who only needs catalogue access can be granted exactly
        // that without seeing stock levels, costs, or dead stock.
        ensureColumn(db, 'user', 'can_access_price_list', 'INTEGER DEFAULT 0');
        db.prepare(`UPDATE "user" SET can_access_price_list = 1 WHERE role = 'admin'`).run();
      },
    };
