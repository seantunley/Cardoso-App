import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 39,
      name: 'datarecord_account_type_column',
      up(db) {
        // Add account_type to site customer table
        try { db.prepare('ALTER TABLE datarecord ADD COLUMN account_type TEXT').run(); } catch {}

        // Add account_type to hub aggregated customer table (Hub-only)
        if (process.env.HUB_MODE === 'true') {
          try { db.prepare('ALTER TABLE hub_records ADD COLUMN account_type TEXT').run(); } catch {}
        }
      },
    };
