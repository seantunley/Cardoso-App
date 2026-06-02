import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 2,
      name: 'invoice_receipt_numbered_columns',
      up(db) {
        for (let i = 1; i <= 5; i++) {
          ensureColumn(db, 'datarecord', `last_unpaid_invoice_${i}`, 'TEXT');
          ensureColumn(db, 'datarecord', `last_unpaid_invoice_${i}_amount`, 'TEXT');
          ensureColumn(db, 'datarecord', `last_unpaid_invoice_${i}_date`, 'TEXT');
          ensureColumn(db, 'datarecord', `last_receipt_${i}`, 'TEXT');
          ensureColumn(db, 'datarecord', `last_receipt_${i}_amount`, 'TEXT');
          ensureColumn(db, 'datarecord', `last_receipt_${i}_date`, 'TEXT');
        }
        // One-time data migration: copy old singular field names into new _1 slots
        const colNames = db.prepare('PRAGMA table_info(datarecord)').all().map(c => c.name);
        const renames = [
          ['last_unpaid_invoice_date', 'last_unpaid_invoice_1_date'],
          ['last_receipt_number', 'last_receipt_1'],
          ['last_receipt_amount', 'last_receipt_1_amount'],
          ['last_receipt_date', 'last_receipt_1_date'],
        ];
        for (const [oldCol, newCol] of renames) {
          if (colNames.includes(oldCol) && colNames.includes(newCol)) {
            try {
              db.exec(`UPDATE datarecord SET ${newCol} = ${oldCol} WHERE (${newCol} IS NULL OR ${newCol} = '') AND (${oldCol} IS NOT NULL AND ${oldCol} != '')`);
            } catch(e) { console.warn('Migration skip:', oldCol, '->', newCol, e.message); }
          }
        }
      },
    };
