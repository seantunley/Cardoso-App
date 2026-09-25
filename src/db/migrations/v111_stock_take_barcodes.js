import { ensureColumn } from './_helpers.js';

export default {
  version: 111,
  name: 'stock_take_barcodes',
  up(db) {
    // Stock take, part 1 — the barcode map.
    //
    // Sage 300 has NO barcode field anywhere in the company database (every
    // column matching BAR/UPC/EAN/SCAN was checked: none exist, and no item
    // optional fields are defined). So the barcode-to-item map is ours to own
    // and it lives here, in cardoso.db. Nothing in this module ever writes to
    // Sage — Sage is read-only for the whole stock take feature, by design and
    // by operator instruction.
    //
    // A barcode identifies a product AND a pack size: the carton barcode and
    // the single barcode on the same cigarette brand are different numbers and
    // must map to different Sage units. Counting a carton as a single is
    // exactly the error class that corrupted the moving-average cost on items
    // 106/110/4010 at Polokwane, so the unit is part of the mapping, not an
    // afterthought.
    db.exec(`
      -- Item/unit cache, refreshed read-only from Sage (ICITEM + ICUNIT).
      -- One row per item per selling/stocking unit, because that is the grain
      -- a barcode maps to. CONVERSION is stocking units per this unit, so a
      -- counted quantity can always be expressed in the stocking unit that
      -- ICILOC.QTYONHAND uses.
      CREATE TABLE IF NOT EXISTS stocktake_item (
        item_number      TEXT NOT NULL,
        unit             TEXT NOT NULL,
        conversion       REAL NOT NULL DEFAULT 1,
        item_description TEXT,
        stock_unit       TEXT,
        category         TEXT,
        inactive         INTEGER NOT NULL DEFAULT 0,
        synced_at        TEXT,
        PRIMARY KEY (item_number, unit)
      );
      CREATE INDEX IF NOT EXISTS idx_stocktake_item_desc
        ON stocktake_item (item_description);

      -- The barcode map itself. One barcode = one item + one unit, so the
      -- barcode is unique. An item may carry many barcodes (single, carton,
      -- outer, a supplier's alternate label) — that is the normal case.
      CREATE TABLE IF NOT EXISTS item_barcode (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        barcode       TEXT NOT NULL UNIQUE,
        item_number   TEXT NOT NULL,
        unit          TEXT NOT NULL,
        created_by    TEXT,
        created_date  TEXT,
        updated_by    TEXT,
        updated_date  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_item_barcode_item
        ON item_barcode (item_number);
    `);

    // Who may open the stock take screens. Admins get it immediately; everyone
    // else is granted it deliberately, the same as every other module.
    ensureColumn(db, 'user', 'can_access_stock_take', 'INTEGER DEFAULT 0');
    db.prepare(`UPDATE "user" SET can_access_stock_take = 1 WHERE role = 'admin'`).run();
  },
};
