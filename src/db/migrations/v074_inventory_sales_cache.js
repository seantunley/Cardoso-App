import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 74,
      name: 'inventory_sales_cache',
      up(db) {
        db.exec(`
          CREATE TABLE IF NOT EXISTS inventory_sales_cache (
            item_number   TEXT    NOT NULL,
            period        TEXT    NOT NULL,
            qty_sold      REAL    NOT NULL DEFAULT 0,
            revenue       REAL    NOT NULL DEFAULT 0,
            order_count   INTEGER NOT NULL DEFAULT 0,
            last_sale_date TEXT,
            PRIMARY KEY (item_number, period)
          );
          CREATE INDEX IF NOT EXISTS idx_inv_sales_period
            ON inventory_sales_cache(period);
          CREATE INDEX IF NOT EXISTS idx_inv_sales_item
            ON inventory_sales_cache(item_number);

          CREATE TABLE IF NOT EXISTS inventory_sales_sync_meta (
            id    INTEGER PRIMARY KEY CHECK (id = 1),
            last_synced_at TEXT,
            last_synced_to TEXT,
            rows_synced    INTEGER DEFAULT 0
          );
          INSERT OR IGNORE INTO inventory_sales_sync_meta (id) VALUES (1);

          CREATE TABLE IF NOT EXISTS inventory_sales_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_number      TEXT NOT NULL,
            transaction_date TEXT NOT NULL,
            order_number     TEXT,
            customer_code    TEXT,
            customer_name    TEXT,
            qty_sold         REAL NOT NULL DEFAULT 0,
            unit_price       REAL,
            line_amount      REAL,
            synced_at        TEXT DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_inv_txn_item_date
            ON inventory_sales_transactions(item_number, transaction_date);
          CREATE INDEX IF NOT EXISTS idx_inv_txn_date
            ON inventory_sales_transactions(transaction_date);
          CREATE INDEX IF NOT EXISTS idx_inv_txn_customer
            ON inventory_sales_transactions(customer_code);

          CREATE TABLE IF NOT EXISTS inventory_forecast (
            item_number         TEXT PRIMARY KEY,
            avg_daily_demand    REAL,
            demand_std_dev      REAL,
            weighted_avg_3m     REAL,
            weighted_avg_6m     REAL,
            seasonality_index   REAL DEFAULT 1.0,
            adjusted_demand     REAL,
            safety_stock        REAL,
            reorder_point       REAL,
            days_of_stock       REAL,
            suggested_order_qty REAL,
            abc_class           TEXT,
            computed_at         TEXT
          );

          CREATE TABLE IF NOT EXISTS inventory_forecast_config (
            item_number      TEXT PRIMARY KEY DEFAULT '__global__',
            lead_time_days   INTEGER DEFAULT 7,
            order_cycle_days INTEGER DEFAULT 14,
            service_level    REAL DEFAULT 0.95,
            min_order_qty    REAL DEFAULT 0
          );
          INSERT OR IGNORE INTO inventory_forecast_config (item_number) VALUES ('__global__');
        `);
      },
    };
