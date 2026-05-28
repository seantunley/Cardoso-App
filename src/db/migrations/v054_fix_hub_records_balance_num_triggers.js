import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 54,
      name: 'fix_hub_records_balance_num_triggers',
      up(db) {
        // Repair the broken triggers from migration 47. Hub_records has a
        // composite PK (site_id, record_id), but the earlier trigger body
        // referenced `id` (copy-pasted from the datarecord trigger). Every
        // INSERT/UPDATE against hub_records on a migrated Hub fails to even
        // prepare with "no such column: id", silently breaking the entire
        // customer-records ETL — the Hub Reconciliation page shows
        // "Awaiting data" forever for those sites.
        //
        // Drop both triggers if present and re-create with the correct
        // composite-key WHERE clause. Idempotent + safe on Hubs that never
        // had hub_records (the inner CREATE silently no-ops because the
        // column-existence guard above only fires when the table exists).
        try {
          const hubExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_records'`).get();
          if (!hubExists) return;
          const hubCols = db.prepare("PRAGMA table_info(hub_records)").all().map(c => c.name);
          if (!hubCols.includes('outstanding_balance_num')) return;
          db.exec(`DROP TRIGGER IF EXISTS trg_hub_records_balance_num_ins`);
          db.exec(`DROP TRIGGER IF EXISTS trg_hub_records_balance_num_upd`);
          db.exec(`
            CREATE TRIGGER trg_hub_records_balance_num_ins
            AFTER INSERT ON hub_records
            BEGIN
              UPDATE hub_records SET outstanding_balance_num = CASE
                WHEN NEW.outstanding_balance IS NULL OR NEW.outstanding_balance = '' OR NEW.outstanding_balance = '0'
                  THEN NULL
                ELSE CAST(REPLACE(REPLACE(NEW.outstanding_balance, ',', ''), ' ', '') AS REAL)
              END WHERE site_id = NEW.site_id AND record_id = NEW.record_id;
            END
          `);
          db.exec(`
            CREATE TRIGGER trg_hub_records_balance_num_upd
            AFTER UPDATE OF outstanding_balance ON hub_records
            BEGIN
              UPDATE hub_records SET outstanding_balance_num = CASE
                WHEN NEW.outstanding_balance IS NULL OR NEW.outstanding_balance = '' OR NEW.outstanding_balance = '0'
                  THEN NULL
                ELSE CAST(REPLACE(REPLACE(NEW.outstanding_balance, ',', ''), ' ', '') AS REAL)
              END WHERE site_id = NEW.site_id AND record_id = NEW.record_id;
            END
          `);
        } catch (err) {
          console.error('[migration 54] hub_records trigger repair failed:', err.message);
        }
      },
    };
