import { ensureColumn } from './_helpers.js';

export default {
  version: 112,
  name: 'stock_take_counting',
  up(db) {
    // Stock take, part 2 — counting.
    //
    // Sage stays read-only. A count produces a variance report; a person keys
    // any correction in Sage itself. Nothing here posts an adjustment, and one
    // mis-keyed adjustment is exactly what wrecked the cost on items 106, 110
    // and 4010 at Polokwane, so that line is not crossed automatically.
    //
    // Three rules the operator asked for, and how they are held:
    //
    //   BLIND COUNTING. A counter must never see what Sage expects, or the
    //   expected number is what comes back. Expected quantity and cost are
    //   withheld from anyone without can_supervise_stock_take — in the API,
    //   not just the screen.
    //
    //   ZONES. Free text, an aisle or a shelf, one owner each, so two people
    //   never count the same rack and hand back what looks like a surplus.
    //
    //   RECOUNT BY SOMEONE ELSE. A variance past the session's threshold must
    //   be recounted, and the second pass is refused if the same person does
    //   it.
    db.exec(`
      CREATE TABLE IF NOT EXISTS stocktake_session (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        name                    TEXT    NOT NULL,
        location                TEXT    NOT NULL,   -- the Sage location being counted
        status                  TEXT    NOT NULL DEFAULT 'open',  -- open | closed
        -- A variance at or above EITHER threshold must be recounted. Quantity
        -- catches a miscounted pallet of cheap stock; value catches one missing
        -- carton of something expensive.
        threshold_qty           REAL    NOT NULL DEFAULT 1,
        threshold_value         REAL    NOT NULL DEFAULT 500,
        opened_by               TEXT,
        opened_date             TEXT,
        closed_by               TEXT,
        closed_date             TEXT,
        notes                   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_stocktake_session_status
        ON stocktake_session (status, location);

      CREATE TABLE IF NOT EXISTS stocktake_zone (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id     INTEGER NOT NULL REFERENCES stocktake_session(id) ON DELETE CASCADE,
        name           TEXT    NOT NULL,   -- free text: "Aisle 3", "Shelf B, cold room"
        assigned_to    TEXT,               -- the one person counting it
        status         TEXT    NOT NULL DEFAULT 'open',  -- open | submitted
        created_by     TEXT,
        created_date   TEXT,
        submitted_by   TEXT,
        submitted_date TEXT,
        UNIQUE (session_id, name)
      );

      -- Scans are APPEND-ONLY and the count is their sum.
      --
      -- Never "set item 110 to 340": two phones doing that overwrite each
      -- other and the last one to find Wi-Fi wins. Appending also makes the
      -- offline queue safe — a phone retrying a batch cannot double-post,
      -- because client_id is unique and a repeat is ignored.
      --
      -- A scan of an unmapped barcode is still recorded, with item_number
      -- NULL. Losing a count because the map has a hole would be worse than
      -- the hole.
      CREATE TABLE IF NOT EXISTS stocktake_scan (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id     TEXT    NOT NULL UNIQUE,  -- generated on the device
        session_id    INTEGER NOT NULL REFERENCES stocktake_session(id) ON DELETE CASCADE,
        zone_id       INTEGER NOT NULL REFERENCES stocktake_zone(id) ON DELETE CASCADE,
        pass          INTEGER NOT NULL DEFAULT 1,  -- 1 = first count, 2 = recount
        barcode       TEXT,
        item_number   TEXT,                        -- NULL when the barcode is unmapped
        unit          TEXT,
        conversion    REAL    NOT NULL DEFAULT 1,
        qty           REAL    NOT NULL,            -- as counted, in the scanned unit
        stock_qty     REAL    NOT NULL,            -- qty * conversion, for comparison with Sage
        counted_by    TEXT    NOT NULL,
        counted_at    TEXT,                        -- device clock, may lag the server
        received_at   TEXT    NOT NULL,
        voided        INTEGER NOT NULL DEFAULT 0,  -- an undo; the row stays for the audit trail
        voided_by     TEXT,
        voided_date   TEXT,
        note          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_stocktake_scan_session_item
        ON stocktake_scan (session_id, item_number, pass);
      CREATE INDEX IF NOT EXISTS idx_stocktake_scan_zone
        ON stocktake_scan (zone_id);

      -- What Sage held when the count was opened. Taken once, so the variance
      -- is measured against a fixed point rather than a figure that moves
      -- while people are still counting.
      CREATE TABLE IF NOT EXISTS stocktake_session_snapshot (
        session_id   INTEGER NOT NULL REFERENCES stocktake_session(id) ON DELETE CASCADE,
        item_number  TEXT    NOT NULL,
        qty_on_hand  REAL    NOT NULL DEFAULT 0,
        total_cost   REAL    NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, item_number)
      );
    `);

    // Supervisors open and close counts, set the thresholds, and are the only
    // people who may see expected quantities, cost and variance.
    ensureColumn(db, 'user', 'can_supervise_stock_take', 'INTEGER DEFAULT 0');
    db.prepare(`UPDATE "user" SET can_supervise_stock_take = 1 WHERE role = 'admin'`).run();
  },
};
