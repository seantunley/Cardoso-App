// v099 — site-side precomputed rollup cache for the hub's inventory-sales pulls.
//
// The hub ETL pulls per-item and per-customer monthly sales rollups from each
// site via /api/reporting/inventory-item-sales and /inventory-customer-sales.
// Those endpoints originally aggregated 24 months of inventory_sales_transactions
// on demand (a SUM…GROUP BY plus a ROW_NUMBER() window over the whole
// inventoryrecord table) on every paginated request. better-sqlite3 is
// synchronous, so each call froze the site's event loop for seconds, starving
// the hub's health/KPIs fetches → they timed out → the hub marked the site
// 'error' → its tile flip-flopped Offline.
//
// These tables hold the rollup precomputed once per inventory-sales sync (off
// the hub-request path), so the endpoints become cheap indexed SELECTs. See
// rebuildInventorySalesRollups() in services/inventoryMovement.js — the single
// source of the aggregation. The cache fills on the next sales sync after this
// migration; until then the endpoints return empty (the hub tiles populate
// after the first post-deploy sync).
export default {
  version: 99,
  name: 'inventory_sales_rollup_cache',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS inventory_item_sales_rollup (
        item_number      TEXT NOT NULL,
        period           TEXT NOT NULL,   -- 'YYYY-MM'
        qty_sold         REAL,
        revenue          REAL,
        item_description TEXT,
        PRIMARY KEY (item_number, period)
      );
      CREATE INDEX IF NOT EXISTS idx_item_sales_rollup_period
        ON inventory_item_sales_rollup (period, item_number);

      CREATE TABLE IF NOT EXISTS inventory_customer_sales_rollup (
        customer_code TEXT NOT NULL,
        period        TEXT NOT NULL,   -- 'YYYY-MM'
        revenue       REAL,
        qty           REAL,
        customer_name TEXT,
        PRIMARY KEY (customer_code, period)
      );
      CREATE INDEX IF NOT EXISTS idx_customer_sales_rollup_period
        ON inventory_customer_sales_rollup (period, customer_code);
    `);
  },
};
