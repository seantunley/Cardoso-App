export default {
  version: 107,
  name: 'bat_order_number_indexes',
  up(db) {
    // The BAT integrity checks correlate extractions to the Overview pivot on
    // (reconciliation_id, order_number) via NOT EXISTS subqueries
    // (src/services/bat/integrity.js), and order_number was unindexed on
    // bat_invoice_extractions (its only multi-col index is the UNIQUE on
    // reconciliation_id, pdf_url), so each check full-scanned it — multiplied by
    // every reconciliation, on the per-request /api/bat/integrity-report route
    // AND the nightly integrity sweep.
    //
    // bat_overview_orders is intentionally NOT indexed here: it already has a
    // UNIQUE(reconciliation_id, order_number) constraint (v072/v073), so SQLite
    // maintains a covering autoindex for that exact key — a second index would
    // only add write cost.
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_bat_extractions_recon_order
        ON bat_invoice_extractions(reconciliation_id, order_number);
    `);
  },
};
