import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 55,
      name: 'admin_module_visibility',
      up(db) {
        // Existing admins were assumed to have implicit access to every
        // module via the `if (user.role === 'admin') return true` bypass
        // in lib/permissions.js. That bypass now respects an explicit `0`
        // on a permission column, enabling per-admin module visibility
        // (e.g., a BAT-only admin who shouldn't see Network Devices).
        //
        // Existing admins may have permission columns at 0 (the
        // `ensureColumn DEFAULT 0` migration default for any column added
        // after the user row was created). Without this migration they'd
        // suddenly lose access to those modules under the new logic.
        //
        // Set every admin's permission columns to 1 to preserve current
        // "admins see everything" default. From here on, an operator can
        // explicitly turn OFF specific modules per admin via the User
        // Management modal.
        try {
          const cols = [
            'can_access_customer_search',
            'can_access_customer_balances',
            'can_access_collections',
            'can_access_inventory',
            'can_access_network_devices',
            'can_access_hub_metrics',
            'can_access_hub_backups',
            'can_access_hub_trends',
            'can_access_hub_audit_log',
            'can_access_records',
            'can_access_reports',
            'can_access_connections',
            'can_access_reconciliation',
            'can_access_hub_reconciliation',
            'can_access_settings',
            'can_manage_users',
            'can_manage_rules',
            'can_edit_records',
            'can_flag_records',
          ];
          // Filter to columns that actually exist on this DB (older sites
          // may not have every permission column yet — ensureColumn
          // migrations earlier add them lazily).
          const userCols = db.prepare("PRAGMA table_info(\"user\")").all().map(c => c.name);
          const present = cols.filter(c => userCols.includes(c));
          if (present.length > 0) {
            const setClause = present.map(c => `${c} = 1`).join(', ');
            db.prepare(`UPDATE "user" SET ${setClause} WHERE role = 'admin'`).run();
          }
        } catch (err) {
          console.error('[migration 55] admin permission backfill failed:', err.message);
        }
      },
    };
