export default {
  version: 104,
  name: 'inventory_movement_history',
  up(db) {
    // Inventory movement history ("stock card") — operator request. Synced from
    // Sage I/C transaction history (ICHIST): every posted movement (sale,
    // purchase receipt, customer credit/return, adjustment, write-off, transfer)
    // as one row per item/location, with the quantity converted to the item's
    // stocking unit (ICUNIT.CONVERSION) so the running balance is meaningful.
    //
    // Reconciliation: Sage purges old transaction history (live: history starts
    // 2016-03-01), so a running balance summed from zero does NOT equal current
    // on-hand — the pre-history opening is gone. The ledger therefore ANCHORS to
    // the authoritative on-hand (inventory_location_onhand, from ICILOC) and
    // derives the opening as on_hand − Σ(movements shown). It reconciles by
    // construction. Per-branch (LOCATION); a hub roll-up is a later follow-up.
    db.exec(`
      CREATE TABLE IF NOT EXISTS inventory_movement (
        source_table      TEXT    NOT NULL DEFAULT 'ICHIST',
        item_number       TEXT    NOT NULL,
        location          TEXT    NOT NULL,
        acctset           TEXT    NOT NULL DEFAULT '',
        transaction_date  TEXT,                 -- ISO yyyy-mm-dd (from TRANSDATE int)
        fiscal_year       TEXT,
        fiscal_period     INTEGER,
        dayend_seq        INTEGER NOT NULL DEFAULT 0,  -- monotonic; incremental sync key
        entry_seq         INTEGER NOT NULL DEFAULT 0,
        line_no           INTEGER NOT NULL DEFAULT 0,
        app               TEXT,                 -- source app: OE / PO / IC
        transtype         INTEGER,              -- Sage transaction-type code
        movement_type     TEXT,                 -- mapped label (Sale, Receipt, Adjustment, ...)
        doc_number        TEXT,
        quantity          REAL,                 -- raw signed qty in the transaction unit
        unit              TEXT,
        stock_qty         REAL,                 -- signed qty in the item's STOCKING unit (for the balance)
        cost              REAL,                 -- HOMEEXTCST (home-currency extended cost)
        category          TEXT,
        synced_at         TEXT,
        UNIQUE (item_number, location, acctset, fiscal_year, fiscal_period, transaction_date, dayend_seq, entry_seq, line_no)
      );
      CREATE INDEX IF NOT EXISTS idx_inv_movement_item_loc_date
        ON inventory_movement (item_number, location, transaction_date);
      CREATE INDEX IF NOT EXISTS idx_inv_movement_dayend
        ON inventory_movement (dayend_seq);

      -- On-hand anchor, per item/location, from Sage ICILOC.QTYONHAND.
      CREATE TABLE IF NOT EXISTS inventory_location_onhand (
        item_number   TEXT NOT NULL,
        location      TEXT NOT NULL,
        qty_on_hand   REAL,
        total_cost    REAL,
        synced_at     TEXT,
        PRIMARY KEY (item_number, location)
      );

      -- Sync bookkeeping (single row).
      CREATE TABLE IF NOT EXISTS inventory_movement_sync_meta (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        last_dayend_seq INTEGER DEFAULT 0,   -- highest DAYENDSEQ pulled so far (incremental cursor)
        last_synced_at  TEXT,
        movement_rows   INTEGER DEFAULT 0,
        onhand_rows     INTEGER DEFAULT 0,
        history_from    TEXT,                -- earliest TRANSDATE included (window start)
        last_error      TEXT
      );
      INSERT OR IGNORE INTO inventory_movement_sync_meta (id, last_dayend_seq) VALUES (1, 0);

      -- Operator-overridable settings (mirrors the other Sage modules).
      CREATE TABLE IF NOT EXISTS inventory_movement_sync_settings (
        id                     INTEGER PRIMARY KEY CHECK (id = 1),
        history_years          INTEGER DEFAULT 3,   -- how many years of ICHIST to keep
        movement_sql_override  TEXT,
        onhand_sql_override    TEXT
      );
      INSERT OR IGNORE INTO inventory_movement_sync_settings (id, history_years) VALUES (1, 3);
    `);
  },
};
