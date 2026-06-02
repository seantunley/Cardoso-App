import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 75,
      name: 'stock_receipt_expiry',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS stock_receipt (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            site_id TEXT NOT NULL DEFAULT '',
            source_table TEXT NOT NULL,
            receipt_number TEXT NOT NULL,
            supplier_code TEXT,
            supplier_name TEXT,
            receipt_date TEXT,
            external_uid TEXT,
            imported_at TEXT DEFAULT CURRENT_TIMESTAMP,
            created_date TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_date TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(site_id, source_table, receipt_number)
          );
          CREATE INDEX IF NOT EXISTS idx_stock_receipt_number ON stock_receipt(receipt_number);
          CREATE INDEX IF NOT EXISTS idx_stock_receipt_date ON stock_receipt(receipt_date);

          CREATE TABLE IF NOT EXISTS stock_receipt_line (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            receipt_id INTEGER NOT NULL REFERENCES stock_receipt(id) ON DELETE CASCADE,
            line_no INTEGER,
            item_number TEXT NOT NULL,
            item_description TEXT,
            qty_received TEXT,
            uom TEXT,
            unit_cost TEXT,
            batch_or_lot TEXT,
            source_line_uid TEXT,
            created_date TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_date TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(receipt_id, line_no, item_number)
          );
          CREATE INDEX IF NOT EXISTS idx_stock_receipt_line_item ON stock_receipt_line(item_number);
          CREATE INDEX IF NOT EXISTS idx_stock_receipt_line_receipt ON stock_receipt_line(receipt_id);

          CREATE TABLE IF NOT EXISTS stock_receipt_line_expiry (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            receipt_line_id INTEGER NOT NULL REFERENCES stock_receipt_line(id) ON DELETE CASCADE,
            expiry_date TEXT NOT NULL,
            qty_at_expiry TEXT,
            entered_by TEXT,
            entry_source TEXT DEFAULT 'manual',
            notes TEXT,
            created_date TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_date TEXT DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_stock_receipt_expiry_date ON stock_receipt_line_expiry(expiry_date);
          CREATE INDEX IF NOT EXISTS idx_stock_receipt_expiry_line ON stock_receipt_line_expiry(receipt_line_id);

          CREATE TABLE IF NOT EXISTS hub_settings (
            key TEXT PRIMARY KEY,
            value TEXT
          );
        `);
        ensureColumn(db, 'user', 'can_access_stock_receipt_expiry', 'INTEGER DEFAULT 0');
        db.prepare(`UPDATE "user" SET can_access_stock_receipt_expiry = 1 WHERE role = 'admin'`).run();
      },
    };
