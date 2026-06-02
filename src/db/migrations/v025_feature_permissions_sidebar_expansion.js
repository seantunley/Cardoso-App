import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 25,
      name: 'feature_permissions_sidebar_expansion',
      up(db) {
        ensureColumn(db, 'user', 'can_access_collections', 'INTEGER DEFAULT 1');
        ensureColumn(db, 'user', 'can_access_hub_metrics', 'INTEGER DEFAULT 0');
        ensureColumn(db, 'user', 'can_access_hub_backups', 'INTEGER DEFAULT 0');
        ensureColumn(db, 'user', 'can_access_hub_trends', 'INTEGER DEFAULT 0');
        ensureColumn(db, 'user', 'can_access_hub_audit_log', 'INTEGER DEFAULT 0');

        db.prepare(`
          UPDATE "user"
          SET can_access_collections = COALESCE(can_access_customer_balances, 1)
          WHERE can_access_collections IS NULL
             OR can_access_collections = 0
        `).run();
      },
    };
