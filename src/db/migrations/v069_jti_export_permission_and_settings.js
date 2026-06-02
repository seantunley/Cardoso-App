import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      // JTI export module — a vendor-scoped Sales report against Accpac
      // (Sage 300) that replaces an existing Crystal-report-plus-Excel-
      // macro workflow. Adds:
      //   - can_access_jti permission flag on the user table (defaults
      //     OFF for existing users; UserPermissionsModal exposes a
      //     toggle so admins can grant it)
      //   - jti_settings key/value table for the operator-supplied
      //     defaults (TownCity / Region / Country) that get pre-filled
      //     into every export. These are static per install; changing
      //     them is a once-per-deployment operation done via the JTI
      //     page's Defaults panel.
      //
      // The defaults live in the DB rather than env vars because they're
      // operator-editable from the UI; env vars would force a restart.
      version: 69,
      name: 'jti_export_permission_and_settings',
      up(db) {
        ensureColumn(db, 'user', 'can_access_jti', 'INTEGER DEFAULT 0');
        db.exec(`
          CREATE TABLE IF NOT EXISTS jti_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
          )
        `);
      },
    };
