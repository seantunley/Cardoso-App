export default {
  version: 107,
  name: 'bat_order_number_indexes',
  up(db) {
    // The BAT integrity checks join extractions to the Overview pivot on
    // (reconciliation_id, order_number) via correlated NOT EXISTS subqueries
    // (src/services/bat/integrity.js). order_number was unindexed on BOTH tables,
    // so each check full-scans them — multiplied by every reconciliation, on the
    // per-request /api/bat/integrity-report route AND the nightly integrity
    // sweep. Index both sides of that join. (reconciliation_id alone is already
    // indexed on extractions, but not the order_number it correlates on.)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_bat_extractions_recon_order
        ON bat_invoice_extractions(reconciliation_id, order_number);
      CREATE INDEX IF NOT EXISTS idx_bat_overview_recon_order
        ON bat_overview_orders(reconciliation_id, order_number);
    `);
  },
};
