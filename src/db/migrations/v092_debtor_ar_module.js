// Debtor AR open-item ledger — the per-document accounts-receivable data the
// Aged Debtors report needs to age the Sage way. Mirrors the creditor module
// (v087) but for AR: open AR documents synced from Sage AROBL into a flat
// per-document table, so each invoice/credit note can be aged individually by
// its due date instead of dumping a whole customer balance into one bucket.
//
// Site-mode (synced from Sage by services/debtorSync.js):
//   debtor_ar_invoice        — open AR documents (AROBL)
//   debtor_sync_meta         — last-sync bookkeeping
//   debtor_sync_settings     — operator SQL override + history window
//
// Hub-mode (populated by hub ETL pulling from sites, PR3):
//   hub_debtor_ar_invoice    — same, keyed by site_id
//
// Customer master data (name, sales rep, account type, terms) already lives in
// datarecord — this table only carries the open documents and joins back to it
// on customer_number. No new permission: AR aging stays under can_access_reports.
export default {
  version: 92,
  name: 'debtor_ar_module',
  up(db) {
    db.exec(`
      -- ===== Site-mode =====
      CREATE TABLE IF NOT EXISTS debtor_ar_invoice (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_table TEXT NOT NULL,            -- 'AROBL'
        customer_code TEXT NOT NULL,
        document_number TEXT NOT NULL,
        document_type TEXT,
        document_date TEXT,
        due_date TEXT,
        original_amount REAL DEFAULT 0,
        outstanding_amount REAL DEFAULT 0,
        reference TEXT,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source_table, customer_code, document_number)
      );
      CREATE INDEX IF NOT EXISTS idx_debtor_ar_invoice_customer ON debtor_ar_invoice(customer_code, due_date);

      CREATE TABLE IF NOT EXISTS debtor_sync_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_synced_at TEXT,
        last_synced_to TEXT,
        rows_synced INTEGER DEFAULT 0
      );
      INSERT OR IGNORE INTO debtor_sync_meta (id) VALUES (1);

      CREATE TABLE IF NOT EXISTS debtor_sync_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ar_invoice_sql_override TEXT,
        history_months INTEGER DEFAULT 24
      );
      INSERT OR IGNORE INTO debtor_sync_settings (id) VALUES (1);

      -- ===== Hub-mode mirror (populated by hub ETL in PR3) =====
      CREATE TABLE IF NOT EXISTS hub_debtor_ar_invoice (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id TEXT NOT NULL,
        customer_code TEXT NOT NULL,
        document_number TEXT NOT NULL,
        document_type TEXT,
        document_date TEXT,
        due_date TEXT,
        original_amount REAL DEFAULT 0,
        outstanding_amount REAL DEFAULT 0,
        reference TEXT,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(site_id, customer_code, document_number)
      );
      CREATE INDEX IF NOT EXISTS idx_hub_debtor_ar_invoice_customer ON hub_debtor_ar_invoice(site_id, customer_code, due_date);
    `);
  },
};
