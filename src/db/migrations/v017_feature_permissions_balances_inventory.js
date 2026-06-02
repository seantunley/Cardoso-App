import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 17,
      name: 'feature_permissions_balances_inventory',
      up(db) {
        ensureColumn(db, 'user', 'can_access_customer_balances', 'INTEGER DEFAULT 1');
        ensureColumn(db, 'user', 'can_access_inventory', 'INTEGER DEFAULT 1');
        // Grant to all existing users so no one loses access
        db.prepare(`UPDATE "user" SET can_access_customer_balances = 1 WHERE can_access_customer_balances = 0`).run();
        db.prepare(`UPDATE "user" SET can_access_inventory = 1 WHERE can_access_inventory = 0`).run();
      },
    };
