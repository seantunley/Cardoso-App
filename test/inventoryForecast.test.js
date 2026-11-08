// Pins the daily-demand std dev in computeAllForecasts (src/services/inventoryForecast.js):
// population std dev of per-DAY totals over the days an item sold.

import { it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
memDb.function('now_local', () => '2026-01-01 00:00:00');
memDb.exec(`
  CREATE TABLE inventory_sales_transactions (item_number TEXT, transaction_date TEXT, qty_sold REAL);
  CREATE TABLE inventory_sales_cache (item_number TEXT, period TEXT, qty_sold REAL, revenue REAL);
  CREATE TABLE inventoryrecord (item_number TEXT, qty_on_hand TEXT);
  CREATE TABLE inventory_forecast_config (item_number TEXT, lead_time_days REAL, order_cycle_days REAL, service_level REAL, min_order_qty REAL);
  CREATE TABLE inventory_forecast (
    item_number TEXT PRIMARY KEY, avg_daily_demand REAL, demand_std_dev REAL, weighted_avg_3m REAL, weighted_avg_6m REAL,
    seasonality_index REAL, adjusted_demand REAL, safety_stock REAL, reorder_point REAL, days_of_stock REAL,
    suggested_order_qty REAL, abc_class TEXT, computed_at TEXT
  );
`);
vi.mock('../src/db/index.js', () => ({ default: memDb }));
vi.mock('../src/lib/errorLog.js', () => ({ logError: () => {} }));
const { computeAllForecasts } = await import('../src/services/inventoryForecast.js');

it('std dev is over daily totals, not individual lines', () => {
  const txn = memDb.prepare('INSERT INTO inventory_sales_transactions VALUES (?, ?, ?)');
  txn.run('A', '2025-01-02', 1);
  txn.run('A', '2025-01-03', 1); // same day as the next line → day total 4
  txn.run('A', '2025-01-03', 3);
  txn.run('A', '2025-01-04', 7); // daily totals 1, 4, 7 → mean 4, population std dev √6
  txn.run('B', '2025-01-02', 5); // single sale day → no std dev
  for (const item of ['A', 'B']) {
    memDb.prepare("INSERT INTO inventory_sales_cache VALUES (?, '2025-01', 10, 100)").run(item);
    memDb.prepare("INSERT INTO inventoryrecord VALUES (?, '0')").run(item);
  }

  computeAllForecasts();

  const sd = Object.fromEntries(memDb.prepare('SELECT item_number, demand_std_dev FROM inventory_forecast').all().map((r) => [r.item_number, r.demand_std_dev]));
  expect(sd).toEqual({ A: Math.round(Math.sqrt(6) * 100) / 100, B: 0 });
});
