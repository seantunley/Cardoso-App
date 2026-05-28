import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 28,
      name: 'feature_permission_network_devices',
      up(db) {
        ensureColumn(db, 'user', 'can_access_network_devices', 'INTEGER DEFAULT 0');
        db.prepare(`UPDATE "user" SET can_access_network_devices = 1 WHERE role = 'admin'`).run();
      },
    };
