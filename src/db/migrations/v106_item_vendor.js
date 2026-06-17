export default {
  version: 106,
  name: 'item_vendor',
  up(db) {
    // Item -> vendor master, synced from Sage ICITMV (the item/vendor table),
    // primary vendor per item (lowest VENDTYPE). Replaces the clunky, incomplete
    // "latest stock-receipt supplier" inference for vendor attribution in the
    // Sales-by-Vendor report and the inventory Top Movers / Dead Stock filters.
    // vendor_code is the AP vendor code (APVEN / creditor.vendor_code), so vendor
    // identity is consistent with creditors. hub_item_vendor mirrors it per site
    // for the head-office reports.
    db.exec(`
      CREATE TABLE IF NOT EXISTS item_vendor (
        item_number  TEXT PRIMARY KEY,
        vendor_code  TEXT,
        vendor_name  TEXT,
        synced_at    TEXT
      );
      CREATE TABLE IF NOT EXISTS hub_item_vendor (
        site_id      TEXT NOT NULL,
        item_number  TEXT NOT NULL,
        vendor_code  TEXT,
        vendor_name  TEXT,
        synced_at    TEXT,
        PRIMARY KEY (site_id, item_number)
      );
    `);
  },
};
