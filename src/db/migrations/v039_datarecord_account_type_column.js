import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 39,
      name: 'datarecord_account_type_column',
      up(db) {
        // Add account_type to site customer table
        try { db.prepare('ALTER TABLE datarecord ADD COLUMN account_type TEXT').run(); }
        catch (e) { if (!/duplicate column name/i.test(e.message)) console.error('[migration.v039.add_datarecord_account_type]', e.message); }

        // Add account_type to hub aggregated customer table (Hub-only)
        if (process.env.HUB_MODE === 'true') {
          try { db.prepare('ALTER TABLE hub_records ADD COLUMN account_type TEXT').run(); }
          catch (e) { if (!/duplicate column name/i.test(e.message)) console.error('[migration.v039.add_hub_records_account_type]', e.message); }
        }
      },
    };
