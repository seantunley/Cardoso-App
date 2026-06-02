import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 15,
      name: 'datarecord_complete_schema',
      up(db) {
        // Force-add all columns that should exist on datarecord but may be missing
        // on installs that created the table before these columns were in CREATE TABLE.
        // safe to re-run — duplicate-column errors are expected; everything else is logged.
        const forceAdd = (table, col, def) => {
          try { db.exec(`ALTER TABLE "${table}" ADD COLUMN ${col} ${def}`); }
          catch (e) {
            if (!/duplicate column name/i.test(e.message)) {
              console.error('[migration.v15.force_add] ALTER TABLE failed', { table, col }, e.message);
            }
          }
        };
        forceAdd('datarecord', 'outstanding_balance', 'TEXT');
        forceAdd('datarecord', 'unpaid_invoices', 'TEXT');
        forceAdd('datarecord', 'receipts', 'TEXT');
        forceAdd('datarecord', 'flag_source', 'TEXT DEFAULT NULL');
        forceAdd('datarecord', 'terms', 'TEXT');
      },
    };
