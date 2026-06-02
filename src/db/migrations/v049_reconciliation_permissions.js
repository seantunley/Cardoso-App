import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 49,
      name: 'reconciliation_permissions',
      up(db) {
        // New per-user permissions for the BAT Reconciliation modules added
        // in this release. Default 0 — admins always see them via the role
        // bypass in hasPermission() — opt-in for non-admin users.
        ensureColumn(db, 'user', 'can_access_reconciliation', 'INTEGER DEFAULT 0');
        ensureColumn(db, 'user', 'can_access_hub_reconciliation', 'INTEGER DEFAULT 0');
      },
    };
