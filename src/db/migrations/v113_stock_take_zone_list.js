import { ensureColumn } from './_helpers.js';

export default {
  version: 113,
  name: 'stock_take_zone_list',
  up(db) {
    // Zones become a standing list per branch, owned by supervisors.
    //
    // They were free text, typed by whoever was counting. That fills up with
    // "Aisle 3", "aisle3" and "asile 3" inside two counts, and then the same
    // rack looks like three different places and nothing can be compared month
    // to month. The aisles of a branch are a fixed fact about the building, so
    // they are set up once and reused.
    //
    // Counters pick from the list and claim one. Only a supervisor adds to it.
    db.exec(`
      CREATE TABLE IF NOT EXISTS stocktake_location_zone (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        location     TEXT    NOT NULL,   -- the Sage branch these aisles are in
        name         TEXT    NOT NULL,
        active       INTEGER NOT NULL DEFAULT 1,  -- retired, not deleted: old counts still name it
        sort_order   INTEGER NOT NULL DEFAULT 0,
        created_by   TEXT,
        created_date TEXT,
        UNIQUE (location, name)
      );
      CREATE INDEX IF NOT EXISTS idx_stocktake_location_zone_loc
        ON stocktake_location_zone (location, active);
    `);

    // Which standing zone a count's zone came from. Nullable: zones created
    // before this migration have no parent, and they stay exactly as counted.
    ensureColumn(db, 'stocktake_zone', 'location_zone_id', 'INTEGER');
  },
};
