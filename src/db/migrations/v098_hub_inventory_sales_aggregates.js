// v097 — hub aggregate tables for the dashboard inventory tiles.
//
// The dashboard's Top Items / Dead Stock / Top Customers tiles run off the
// per-transaction sales table on a site (so inter-branch transfers can be
// excluded and customers aggregated). That table is far too granular to ship to
// the hub wholesale, so the ETL pulls pre-aggregated, inter-branch-excluded
// monthly rollups into these two tables instead:
//   - hub_inventory_item_sales: per item per month (units + revenue + the item
//     description), for Top Items (current month) and Dead Stock (last sale).
//   - hub_inventory_customer_sales: per customer per month (revenue + units),
//     for Top Customers over a selectable timeline.
// Both are keyed by site_id so the hub can consolidate or filter by branch.
export default {
  version: 98,
  name: 'hub_inventory_sales_aggregates',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hub_inventory_item_sales (
        site_id          TEXT NOT NULL,
        item_number      TEXT NOT NULL,
        item_description TEXT,
        period           TEXT NOT NULL,
        qty_sold         REAL DEFAULT 0,
        revenue          REAL DEFAULT 0,
        synced_at        TEXT,
        PRIMARY KEY (site_id, item_number, period)
      );
      CREATE TABLE IF NOT EXISTS hub_inventory_customer_sales (
        site_id       TEXT NOT NULL,
        customer_code TEXT NOT NULL,
        customer_name TEXT,
        period        TEXT NOT NULL,
        revenue       REAL DEFAULT 0,
        qty           REAL DEFAULT 0,
        synced_at     TEXT,
        PRIMARY KEY (site_id, customer_code, period)
      );
      CREATE INDEX IF NOT EXISTS idx_hub_item_sales_period ON hub_inventory_item_sales(period);
      CREATE INDEX IF NOT EXISTS idx_hub_cust_sales_period ON hub_inventory_customer_sales(period);
    `);
  },
};
