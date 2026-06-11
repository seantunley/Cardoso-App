export default {
  version: 101,
  name: 'creditor_unposted_payments',
  up(db) {
    // Cheques captured in Sage AP Payment Entry whose BATCH has not been
    // posted yet (APBTA.POSTSEQNBR = 0 and not deleted). Accounts captures
    // payments for days/weeks before posting the batch (live data showed
    // R16M–R43M batches posting in bulk after long gaps), and until posting,
    // APOBL still shows the paid invoices as open — so vendor outstanding
    // figures were overstated by every captured-but-unposted cheque.
    //
    // Full-refreshed on every creditors sync (the set is small and statuses
    // change as batches post — rows vanish from here once posted, at which
    // point APOBL reflects them instead). The Creditor Balances page nets
    // SUM(amount) per vendor off the APOBL outstanding.
    db.exec(`
      CREATE TABLE IF NOT EXISTS creditor_ap_unposted_payment (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        vendor_code       TEXT NOT NULL,
        payment_number    TEXT,
        payment_date      TEXT,
        amount            REAL NOT NULL DEFAULT 0,
        batch_number      INTEGER,
        batch_status      INTEGER,
        batch_description TEXT,
        synced_at         TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_creditor_unposted_vendor
        ON creditor_ap_unposted_payment(vendor_code);
    `);

    // Operator override slot for the Sage query, same safety valve as the
    // other creditor sources (vendor/invoice/payment/PO overrides).
    const cols = db.prepare(`PRAGMA table_info(creditor_sync_settings)`).all().map((c) => c.name);
    if (!cols.includes('ap_unposted_sql_override')) {
      db.exec(`ALTER TABLE creditor_sync_settings ADD COLUMN ap_unposted_sql_override TEXT`);
    }
  },
};
