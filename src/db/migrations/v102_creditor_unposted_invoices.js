export default {
  version: 102,
  name: 'creditor_unposted_invoices',
  up(db) {
    // The other half of the unposted-batch problem (v101 covers payments):
    // vendor INVOICES captured in AP Invoice Entry whose batch has not been
    // posted. Until posting, APOBL doesn't list them — so vendor outstanding
    // was UNDERSTATED. Live data at build time: 17 ready-to-post batches
    // totalling R44.65M (one vendor alone R8.8M understated). Amounts are
    // stored SIGNED: invoices positive, credit notes negative — verified to
    // the cent against the Sage batch control totals.
    //
    // Full-refreshed every creditors sync, same lifecycle as the payments
    // table: rows vanish when their batch posts and APOBL takes over.
    db.exec(`
      CREATE TABLE IF NOT EXISTS creditor_ap_unposted_invoice (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        vendor_code    TEXT NOT NULL,
        invoice_number TEXT,
        doc_type       INTEGER,
        invoice_date   TEXT,
        due_date       TEXT,
        amount         REAL NOT NULL DEFAULT 0,
        batch_number   INTEGER,
        batch_status   INTEGER,
        synced_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_creditor_unposted_inv_vendor
        ON creditor_ap_unposted_invoice(vendor_code);
    `);

    const cols = db.prepare(`PRAGMA table_info(creditor_sync_settings)`).all().map((c) => c.name);
    if (!cols.includes('ap_unposted_invoice_sql_override')) {
      db.exec(`ALTER TABLE creditor_sync_settings ADD COLUMN ap_unposted_invoice_sql_override TEXT`);
    }
  },
};
