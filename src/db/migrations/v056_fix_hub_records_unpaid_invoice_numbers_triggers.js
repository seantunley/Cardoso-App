import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 56,
      name: 'fix_hub_records_unpaid_invoice_numbers_triggers',
      up(db) {
        // Same class of bug as migration 54, different pair of triggers.
        // hub_records_unpaid_invoice_numbers_ai / _au were created in
        // src/db/schema.js with `WHERE id = NEW.id` — copy-pasted from the
        // datarecord version, which has a single-column id PK. hub_records
        // uses a composite (site_id, record_id) PK, so SQLite refuses to
        // prepare ANY insert/update against hub_records with "no such
        // column: id" — exactly the failure mode the Sync Log surfaced
        // (every site flipping to status='error' the moment the trigger
        // got installed). Drop and recreate with the composite-key WHERE.
        try {
          const hubExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_records'`).get();
          if (!hubExists) return;
          const hubCols = db.prepare("PRAGMA table_info(hub_records)").all().map(c => c.name);
          if (!hubCols.includes('unpaid_invoice_numbers')) return;
          db.exec(`DROP TRIGGER IF EXISTS hub_records_unpaid_invoice_numbers_ai`);
          db.exec(`DROP TRIGGER IF EXISTS hub_records_unpaid_invoice_numbers_au`);
          db.exec(`
            CREATE TRIGGER hub_records_unpaid_invoice_numbers_ai
            AFTER INSERT ON hub_records
            WHEN NEW.unpaid_invoices IS NOT NULL
            BEGIN
              UPDATE hub_records
                 SET unpaid_invoice_numbers = COALESCE((
                   SELECT GROUP_CONCAT(UPPER(json_extract(value, '$.number')), ' ')
                     FROM json_each(NEW.unpaid_invoices)
                    WHERE json_extract(value, '$.number') IS NOT NULL
                 ), '')
               WHERE site_id = NEW.site_id AND record_id = NEW.record_id;
            END
          `);
          db.exec(`
            CREATE TRIGGER hub_records_unpaid_invoice_numbers_au
            AFTER UPDATE OF unpaid_invoices ON hub_records
            BEGIN
              UPDATE hub_records
                 SET unpaid_invoice_numbers = COALESCE((
                   SELECT GROUP_CONCAT(UPPER(json_extract(value, '$.number')), ' ')
                     FROM json_each(NEW.unpaid_invoices)
                    WHERE json_extract(value, '$.number') IS NOT NULL
                 ), '')
               WHERE site_id = NEW.site_id AND record_id = NEW.record_id;
            END
          `);
        } catch (err) {
          console.error('[migration 56] hub_records unpaid-invoice-numbers trigger repair failed:', err.message);
        }
      },
    };
