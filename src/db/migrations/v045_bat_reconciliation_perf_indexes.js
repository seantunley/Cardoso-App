import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 45,
      name: 'bat_reconciliation_perf_indexes',
      up(db) {
        // c_overwritten is filtered in replicateSupplierIntoCardoso() and
        // counted in the post-replicate summary. Without this index those
        // queries scan the full bat_cardoso_invoices table.
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_bat_cardoso_inv_overwritten
          ON bat_cardoso_invoices(c_overwritten)
        `);
        // extracted_invoice is the join key on every cross-ref query against
        // bat_cardoso_invoices (UPPER/REPLACE wraps mean the index is only
        // partially usable, but it still helps the IS NOT NULL / IS NULL passes
        // in listReconciliations and getDashboardData).
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_bat_extractions_invoice
          ON bat_invoice_extractions(extracted_invoice)
          WHERE extracted_invoice IS NOT NULL
        `);
      },
    };
