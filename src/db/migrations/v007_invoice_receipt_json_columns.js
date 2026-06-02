import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 7,
      name: 'invoice_receipt_json_columns',
      up(db) {
        // Add JSON array columns to datarecord
        ensureColumn(db, 'datarecord', 'unpaid_invoices', 'TEXT');
        ensureColumn(db, 'datarecord', 'receipts', 'TEXT');

        // Migrate existing numbered columns into JSON arrays
        const rows = db.prepare(`
          SELECT id,
            last_unpaid_invoice_1, last_unpaid_invoice_1_amount, last_unpaid_invoice_1_date,
            last_unpaid_invoice_2, last_unpaid_invoice_2_amount, last_unpaid_invoice_2_date,
            last_unpaid_invoice_3, last_unpaid_invoice_3_amount, last_unpaid_invoice_3_date,
            last_unpaid_invoice_4, last_unpaid_invoice_4_amount, last_unpaid_invoice_4_date,
            last_unpaid_invoice_5, last_unpaid_invoice_5_amount, last_unpaid_invoice_5_date,
            last_receipt_1, last_receipt_1_amount, last_receipt_1_date,
            last_receipt_2, last_receipt_2_amount, last_receipt_2_date,
            last_receipt_3, last_receipt_3_amount, last_receipt_3_date,
            last_receipt_4, last_receipt_4_amount, last_receipt_4_date,
            last_receipt_5, last_receipt_5_amount, last_receipt_5_date
          FROM datarecord WHERE unpaid_invoices IS NULL OR receipts IS NULL
        `).all();
        const updateStmt = db.prepare(`UPDATE datarecord SET unpaid_invoices = ?, receipts = ? WHERE id = ?`);
        const migrateRows = db.transaction(() => {
          for (const row of rows) {
            const invoices = [];
            const recs = [];
            for (let i = 1; i <= 5; i++) {
              const num = row[`last_unpaid_invoice_${i}`];
              const amt = row[`last_unpaid_invoice_${i}_amount`];
              const dt  = row[`last_unpaid_invoice_${i}_date`];
              if (num || amt || dt) invoices.push({ date: dt || '', number: num || '', amount: amt || '' });
              const rnum = row[`last_receipt_${i}`];
              const ramt = row[`last_receipt_${i}_amount`];
              const rdt  = row[`last_receipt_${i}_date`];
              if (rnum || ramt || rdt) recs.push({ date: rdt || '', number: rnum || '', amount: ramt || '' });
            }
            updateStmt.run(JSON.stringify(invoices), JSON.stringify(recs), row.id);
          }
        });
        migrateRows();
        if (rows.length > 0) console.log(`[migration 7] Migrated ${rows.length} datarecord rows to JSON invoice/receipt columns`);

        // Hub records migration (only if table exists — new DBs get correct schema from CREATE TABLE)
        if (process.env.HUB_MODE === 'true') {
          const hubExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='hub_records'`).get();
          if (hubExists) {
            ensureColumn(db, 'hub_records', 'unpaid_invoices', 'TEXT');
            ensureColumn(db, 'hub_records', 'receipts', 'TEXT');
            const hubRows = db.prepare(`
              SELECT site_id, record_id,
                last_unpaid_invoice_1, last_unpaid_invoice_1_amount, last_unpaid_invoice_1_date,
                last_unpaid_invoice_2, last_unpaid_invoice_2_amount, last_unpaid_invoice_2_date,
                last_unpaid_invoice_3, last_unpaid_invoice_3_amount, last_unpaid_invoice_3_date,
                last_unpaid_invoice_4, last_unpaid_invoice_4_amount, last_unpaid_invoice_4_date,
                last_unpaid_invoice_5, last_unpaid_invoice_5_amount, last_unpaid_invoice_5_date,
                last_receipt_1, last_receipt_1_amount, last_receipt_1_date,
                last_receipt_2, last_receipt_2_amount, last_receipt_2_date,
                last_receipt_3, last_receipt_3_amount, last_receipt_3_date,
                last_receipt_4, last_receipt_4_amount, last_receipt_4_date,
                last_receipt_5, last_receipt_5_amount, last_receipt_5_date
              FROM hub_records WHERE unpaid_invoices IS NULL OR receipts IS NULL
            `).all();
            const updateHub = db.prepare(`UPDATE hub_records SET unpaid_invoices = ?, receipts = ? WHERE site_id = ? AND record_id = ?`);
            const migrateHub = db.transaction(() => {
              for (const row of hubRows) {
                const invoices = [];
                const recs = [];
                for (let i = 1; i <= 5; i++) {
                  const num = row[`last_unpaid_invoice_${i}`];
                  const amt = row[`last_unpaid_invoice_${i}_amount`];
                  const dt  = row[`last_unpaid_invoice_${i}_date`];
                  if (num || amt || dt) invoices.push({ date: dt || '', number: num || '', amount: amt || '' });
                  const rnum = row[`last_receipt_${i}`];
                  const ramt = row[`last_receipt_${i}_amount`];
                  const rdt  = row[`last_receipt_${i}_date`];
                  if (rnum || ramt || rdt) recs.push({ date: rdt || '', number: rnum || '', amount: ramt || '' });
                }
                updateHub.run(JSON.stringify(invoices), JSON.stringify(recs), row.site_id, row.record_id);
              }
            });
            migrateHub();
            if (hubRows.length > 0) console.log(`[migration 7] Migrated ${hubRows.length} hub_records rows to JSON invoice/receipt columns`);
          }
        }
      },
    };
