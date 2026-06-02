import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      // bat_overview_orders: persistent record of every ODR that
      // appeared in BAT's Overview-tab pivot tables (normal + exception)
      // at upload time, regardless of whether a matching POD existed in
      // the same upload's Delivery POD sheet.
      //
      // Why: BAT's claim summary at the top of the Overview tab (which
      // becomes the recon's supplier_delivery/discount/pricing — the
      // headline BAT TOTAL) sums the Overview pivot, including orders
      // BAT didn't ship a POD for. We only created extraction rows for
      // orders that had a PDF in the Delivery POD sheet, so for any
      // POD-less Overview entry, the operator had no visibility — the
      // amount was rolled into the BAT TOTAL but invisible per-row.
      //
      // After this migration, every upload writes the full Overview
      // pivot ODR list here. The per-week tile's "Missing PODs"
      // indicator, the EXCEPTIONS tab on the per-invoice audit page,
      // and the new Missing PODs tab all read this table to find ODRs
      // present in BAT's Overview but absent from
      // bat_invoice_extractions (NOT EXISTS by order_number within the
      // same reconciliation).
      //
      // is_exception distinguishes the two pivots BAT ships side-by-
      // side: the normal pivot drives the claim summary, the exception
      // pivot is a separate population (PoD-not-signed,
      // incorrect-delivery-status etc.) that needs to balance against
      // its own pivot total.
      //
      // Older recons created before this migration have no rows here;
      // the operator can backfill by re-uploading the same spreadsheet.
      // The UI shows an explicit "re-upload to populate" hint per recon
      // when bat_overview_orders is empty for that recon_id.
      version: 72,
      name: 'bat_overview_orders_for_pod_coverage',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS bat_overview_orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            reconciliation_id INTEGER NOT NULL REFERENCES bat_reconciliations(id) ON DELETE CASCADE,
            order_number TEXT NOT NULL,
            is_exception INTEGER NOT NULL DEFAULT 0 CHECK (is_exception IN (0, 1)),
            order_amount REAL NOT NULL DEFAULT 0,
            supplier_discount REAL DEFAULT 0,
            supplier_delivery REAL DEFAULT 0,
            supplier_pricing  REAL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(reconciliation_id, order_number)
          )
        `);
        // The "missing PODs" query is NOT EXISTS by (reconciliation_id,
        // order_number) against bat_invoice_extractions, so the natural
        // index is the same composite the UNIQUE already creates above.
        // A second index on (reconciliation_id, is_exception) speeds the
        // tab-grouping queries (EXCEPTIONS tab needs only is_exception=1).
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_bat_overview_orders_recon_exc
          ON bat_overview_orders(reconciliation_id, is_exception)
        `);
      },
    };
