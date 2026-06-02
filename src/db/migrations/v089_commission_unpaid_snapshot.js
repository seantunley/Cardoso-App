// Per-period snapshot of sweets invoices that were unpaid at the end
// of a commission period. Populated by archiveCommissionReport when a
// period is archived; consumed by buildCommissionReport in the NEXT
// period to compute clawback for invoices still unpaid.
//
// We snapshot the rate at the time the commission was paid (not the
// current rate), so a rate change between periods doesn't move the
// clawback amount.
export default {
  version: 89,
  name: 'commission_unpaid_snapshot',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS commission_unpaid_snapshot (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        period_year   INTEGER NOT NULL,
        period_month  INTEGER NOT NULL,
        sales_rep     TEXT    NOT NULL,
        invoice_number TEXT   NOT NULL,
        customer_code  TEXT,
        customer_name  TEXT,
        invoice_date   TEXT,
        net_sweet_amount       REAL NOT NULL DEFAULT 0,
        outstanding_amount     REAL NOT NULL DEFAULT 0,
        sweets_rate_at_paid    REAL NOT NULL DEFAULT 0,
        reference_rate_at_paid REAL NOT NULL DEFAULT 0,
        sweet_commission_at_paid     REAL NOT NULL DEFAULT 0,
        reference_commission_at_paid REAL NOT NULL DEFAULT 0,
        archive_id INTEGER,
        created_at TEXT DEFAULT (now_local()),
        UNIQUE(period_year, period_month, invoice_number)
      );
      CREATE INDEX IF NOT EXISTS idx_commission_unpaid_snapshot_period
        ON commission_unpaid_snapshot(period_year, period_month, sales_rep);
      CREATE INDEX IF NOT EXISTS idx_commission_unpaid_snapshot_invoice
        ON commission_unpaid_snapshot(invoice_number);
    `);
  },
};
