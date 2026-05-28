import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 51,
      name: 'normalise_unpaid_invoice_numbers',
      up(db) {
        // Backed-by column that holds the unpaid invoice numbers as a single
        // uppercase space-joined TEXT. Lets `customer-by-invoice` filter
        // against ~50-200 chars per row instead of LIKE-scanning the 1–3 KB
        // JSON blob in `unpaid_invoices`. SQLite triggers maintain it on
        // every insert/update of unpaid_invoices, no app-code changes needed.
        const sql = (table) => `
          UPDATE ${table}
             SET unpaid_invoice_numbers = (
               SELECT COALESCE(GROUP_CONCAT(UPPER(json_extract(value, '$.number')), ' '), '')
                 FROM json_each(${table}.unpaid_invoices)
                WHERE json_extract(value, '$.number') IS NOT NULL
             )
           WHERE unpaid_invoices IS NOT NULL
             AND unpaid_invoices != ''
             AND unpaid_invoices != '[]'
        `;
        const trigger = (table, suffix, when) => `
          CREATE TRIGGER IF NOT EXISTS ${table}_unpaid_invoice_numbers_${suffix}
          AFTER ${when} ON ${table}
          ${when === 'INSERT' ? 'WHEN NEW.unpaid_invoices IS NOT NULL' : ''}
          BEGIN
            UPDATE ${table}
               SET unpaid_invoice_numbers = COALESCE((
                 SELECT GROUP_CONCAT(UPPER(json_extract(value, '$.number')), ' ')
                   FROM json_each(NEW.unpaid_invoices)
                  WHERE json_extract(value, '$.number') IS NOT NULL
               ), '')
             WHERE id = NEW.id;
          END
        `;

        // datarecord
        const drCols = db.prepare('PRAGMA table_info(datarecord)').all().map(c => c.name);
        if (!drCols.includes('unpaid_invoice_numbers')) {
          db.exec('ALTER TABLE datarecord ADD COLUMN unpaid_invoice_numbers TEXT');
        }
        db.exec(sql('datarecord'));
        db.exec(`CREATE INDEX IF NOT EXISTS idx_datarecord_unpaid_invoice_numbers
                 ON datarecord(unpaid_invoice_numbers)`);
        db.exec(trigger('datarecord', 'ai', 'INSERT'));
        db.exec(trigger('datarecord', 'au', 'UPDATE OF unpaid_invoices'));

        // hub_records is created in schema.js AFTER runMigrations on hub
        // installs, so the column + index + triggers for it live there
        // (mirrored at src/db/schema.js, search for unpaid_invoice_numbers).
      },
    };
