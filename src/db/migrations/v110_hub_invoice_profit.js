export default {
  version: 110,
  name: 'hub_invoice_profit',
  up(db) {
    // Per-site profit totals BY DAY, pulled by the hub ETL from each branch's
    // /api/reporting/invoice-profit-totals.
    //
    // Days only, deliberately. Week, month and year are derived from these rows
    // when the hub renders them, so a rollup can never disagree with the days it
    // is made of, and a late-posted invoice corrects every level at once. Storing
    // four parallel period tables would have made that a reconciliation problem.
    //
    // No invoices either: a branch raises ~2,500 documents a month and the
    // per-invoice detail is only ever wanted one period at a time. The hub shows
    // totals and links back to the branch that raised the documents, so there is
    // exactly one copy of the detail and it lives where it was created.
    //
    // Synced incrementally — the ETL re-pulls a trailing window each run (late
    // postings move older days), so rows outside that window persist.
    // Harmless/empty on a site install.
    db.exec(`
      CREATE TABLE IF NOT EXISTS hub_invoice_profit_day (
        site_id           TEXT NOT NULL,
        day               TEXT NOT NULL,
        selling           REAL DEFAULT 0,
        cost              REAL DEFAULT 0,
        profit            REAL DEFAULT 0,
        invoice_count     INTEGER DEFAULT 0,
        credit_note_count INTEGER DEFAULT 0,
        synced_at         TEXT,
        PRIMARY KEY (site_id, day)
      );
      CREATE INDEX IF NOT EXISTS idx_hub_invoice_profit_day
        ON hub_invoice_profit_day (day);
    `);
  },
};
