import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 6,
      name: 'user_permissions',
      up(db) {
        ensureColumn(db, 'user', 'password_hash', 'TEXT');
        ensureColumn(db, 'user', 'must_change_password', 'INTEGER DEFAULT 0');
        ensureColumn(db, 'user', 'is_active', 'INTEGER DEFAULT 1');
        ensureColumn(db, 'user', 'can_access_customer_search', 'INTEGER DEFAULT 1');
        ensureColumn(db, 'user', 'can_access_records', 'INTEGER DEFAULT 0');
        ensureColumn(db, 'user', 'can_access_reports', 'INTEGER DEFAULT 0');
        ensureColumn(db, 'user', 'can_access_connections', 'INTEGER DEFAULT 0');
        ensureColumn(db, 'user', 'can_access_settings', 'INTEGER DEFAULT 0');
        ensureColumn(db, 'user', 'can_manage_users', 'INTEGER DEFAULT 0');
        ensureColumn(db, 'user', 'can_manage_rules', 'INTEGER DEFAULT 0');
        db.prepare(`UPDATE "user" SET can_manage_rules = 1 WHERE role = 'admin' AND can_manage_rules = 0`).run();
        ensureColumn(db, 'user', 'can_edit_records', 'INTEGER DEFAULT 1');
        ensureColumn(db, 'user', 'can_flag_records', 'INTEGER DEFAULT 1');
        ensureColumn(db, 'user', 'hub_redirect', 'INTEGER DEFAULT 0');
      },
    };
