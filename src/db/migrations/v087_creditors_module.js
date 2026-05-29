import { ensureColumn, ensureTable } from './_helpers.js';

// Creditors module — vendor master + AP transactions + PO lines synced
// from Sage 300. Mirrors the Customers module shape (datarecord +
// hub_records) but for AP/PO.
//
// Site-mode tables (synced from Sage by services/creditorSync.js):
//   creditor                   — vendor master (one row per Sage APVEN)
//   creditor_ap_invoice        — open AP invoices (APOBL)
//   creditor_ap_payment        — payments made to vendors (APCHK/APIBT)
//   creditor_po_header         — issued purchase orders (POPORH)
//   creditor_po_line           — PO lines (POPORL)
//
// Hub-mode tables (populated by hub ETL pulling from sites):
//   hub_creditor               — { site_id + vendor_code } vendor rows
//   hub_creditor_ap_invoice    — same with site_id
//   hub_creditor_ap_payment    — same with site_id
//   hub_creditor_po_header     — same with site_id
//   hub_creditor_po_line       — same with site_id
//
// Goods receipts are already in stock_receipt — the Creditor module's
// drilldown joins to that table for the receipts tab, no duplicate
// storage.
//
// One permission gates the whole module — finer split can come later
// if anyone needs it.
export default {
  version: 87,
  name: 'creditors_module',
  up(db) {
    db.exec(`
      -- ===== Site-mode =====
      CREATE TABLE IF NOT EXISTS creditor (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_table TEXT NOT NULL,
        vendor_code TEXT NOT NULL,
        vendor_name TEXT,
        terms TEXT,
        contact TEXT,
        phone TEXT,
        email TEXT,
        is_active INTEGER DEFAULT 1,
        last_receipt_date TEXT,
        last_payment_date TEXT,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source_table, vendor_code)
      );
      CREATE INDEX IF NOT EXISTS idx_creditor_vendor_code ON creditor(vendor_code);
      CREATE INDEX IF NOT EXISTS idx_creditor_vendor_name ON creditor(vendor_name);

      CREATE TABLE IF NOT EXISTS creditor_ap_invoice (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_table TEXT NOT NULL,
        vendor_code TEXT NOT NULL,
        document_number TEXT NOT NULL,
        document_type TEXT,
        document_date TEXT,
        due_date TEXT,
        original_amount REAL DEFAULT 0,
        outstanding_amount REAL DEFAULT 0,
        reference TEXT,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source_table, vendor_code, document_number)
      );
      CREATE INDEX IF NOT EXISTS idx_creditor_ap_invoice_vendor ON creditor_ap_invoice(vendor_code, document_date DESC);

      CREATE TABLE IF NOT EXISTS creditor_ap_payment (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_table TEXT NOT NULL,
        vendor_code TEXT NOT NULL,
        payment_number TEXT NOT NULL,
        payment_date TEXT,
        payment_method TEXT,
        amount REAL DEFAULT 0,
        reference TEXT,
        bank_code TEXT,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source_table, vendor_code, payment_number)
      );
      CREATE INDEX IF NOT EXISTS idx_creditor_ap_payment_vendor ON creditor_ap_payment(vendor_code, payment_date DESC);

      CREATE TABLE IF NOT EXISTS creditor_po_header (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_table TEXT NOT NULL,
        po_number TEXT NOT NULL,
        vendor_code TEXT,
        vendor_name TEXT,
        po_date TEXT,
        expected_date TEXT,
        status TEXT,
        total_amount REAL DEFAULT 0,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source_table, po_number)
      );
      CREATE INDEX IF NOT EXISTS idx_creditor_po_header_vendor ON creditor_po_header(vendor_code, po_date DESC);
      CREATE INDEX IF NOT EXISTS idx_creditor_po_header_number ON creditor_po_header(po_number);

      CREATE TABLE IF NOT EXISTS creditor_po_line (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        po_id INTEGER NOT NULL REFERENCES creditor_po_header(id) ON DELETE CASCADE,
        line_no INTEGER,
        item_number TEXT,
        item_description TEXT,
        qty_ordered REAL DEFAULT 0,
        qty_received REAL DEFAULT 0,
        unit_cost REAL DEFAULT 0,
        extended_cost REAL DEFAULT 0,
        UNIQUE(po_id, line_no)
      );
      CREATE INDEX IF NOT EXISTS idx_creditor_po_line_po ON creditor_po_line(po_id);
      CREATE INDEX IF NOT EXISTS idx_creditor_po_line_item ON creditor_po_line(item_number);

      CREATE TABLE IF NOT EXISTS creditor_sync_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_synced_at TEXT,
        last_synced_to TEXT,
        rows_synced INTEGER DEFAULT 0
      );
      INSERT OR IGNORE INTO creditor_sync_meta (id) VALUES (1);

      CREATE TABLE IF NOT EXISTS creditor_sync_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        vendor_sql_override TEXT,
        ap_invoice_sql_override TEXT,
        ap_payment_sql_override TEXT,
        po_header_sql_override TEXT,
        po_line_sql_override TEXT,
        history_months INTEGER DEFAULT 24
      );
      INSERT OR IGNORE INTO creditor_sync_settings (id) VALUES (1);

      -- ===== Hub-mode mirror =====
      CREATE TABLE IF NOT EXISTS hub_creditor (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id TEXT NOT NULL,
        vendor_code TEXT NOT NULL,
        vendor_name TEXT,
        terms TEXT,
        contact TEXT,
        phone TEXT,
        email TEXT,
        is_active INTEGER DEFAULT 1,
        last_receipt_date TEXT,
        last_payment_date TEXT,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(site_id, vendor_code)
      );
      CREATE INDEX IF NOT EXISTS idx_hub_creditor_site ON hub_creditor(site_id, vendor_code);
      CREATE INDEX IF NOT EXISTS idx_hub_creditor_name ON hub_creditor(vendor_name);

      CREATE TABLE IF NOT EXISTS hub_creditor_ap_invoice (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id TEXT NOT NULL,
        vendor_code TEXT NOT NULL,
        document_number TEXT NOT NULL,
        document_type TEXT,
        document_date TEXT,
        due_date TEXT,
        original_amount REAL DEFAULT 0,
        outstanding_amount REAL DEFAULT 0,
        reference TEXT,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(site_id, vendor_code, document_number)
      );
      CREATE INDEX IF NOT EXISTS idx_hub_creditor_ap_invoice_vendor ON hub_creditor_ap_invoice(site_id, vendor_code, document_date DESC);

      CREATE TABLE IF NOT EXISTS hub_creditor_ap_payment (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id TEXT NOT NULL,
        vendor_code TEXT NOT NULL,
        payment_number TEXT NOT NULL,
        payment_date TEXT,
        payment_method TEXT,
        amount REAL DEFAULT 0,
        reference TEXT,
        bank_code TEXT,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(site_id, vendor_code, payment_number)
      );
      CREATE INDEX IF NOT EXISTS idx_hub_creditor_ap_payment_vendor ON hub_creditor_ap_payment(site_id, vendor_code, payment_date DESC);

      CREATE TABLE IF NOT EXISTS hub_creditor_po_header (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id TEXT NOT NULL,
        po_number TEXT NOT NULL,
        vendor_code TEXT,
        vendor_name TEXT,
        po_date TEXT,
        expected_date TEXT,
        status TEXT,
        total_amount REAL DEFAULT 0,
        synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(site_id, po_number)
      );
      CREATE INDEX IF NOT EXISTS idx_hub_creditor_po_header_vendor ON hub_creditor_po_header(site_id, vendor_code, po_date DESC);

      CREATE TABLE IF NOT EXISTS hub_creditor_po_line (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        po_id INTEGER NOT NULL REFERENCES hub_creditor_po_header(id) ON DELETE CASCADE,
        line_no INTEGER,
        item_number TEXT,
        item_description TEXT,
        qty_ordered REAL DEFAULT 0,
        qty_received REAL DEFAULT 0,
        unit_cost REAL DEFAULT 0,
        extended_cost REAL DEFAULT 0,
        UNIQUE(po_id, line_no)
      );
      CREATE INDEX IF NOT EXISTS idx_hub_creditor_po_line_po ON hub_creditor_po_line(po_id);
    `);

    // Single permission gates the whole module. Admins get it by default.
    ensureColumn(db, 'user', 'can_access_creditors', 'INTEGER DEFAULT 0');
    db.prepare(`UPDATE "user" SET can_access_creditors = 1 WHERE role = 'admin'`).run();
  },
};
