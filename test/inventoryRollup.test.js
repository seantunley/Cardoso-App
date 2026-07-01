// Tests for rebuildInventorySalesRollups (src/services/inventoryMovement.js) —
// the per-period chunked + staged rebuild that replaced the single monolithic
// aggregation. Pins the SEMANTICS (correct per-entity/per-period sums,
// inter-branch exclusion, cache-preferred descriptions) so the chunking can't
// silently drift from the old one-pass result.
//
// In-memory SQLite mirroring the columns the rebuild touches. Real Date +
// setImmediate are used (no fake timers — they'd stall the yield), so periods
// are computed from the current month to stay inside the 3-years+YTD window
// regardless of when the suite runs.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
memDb.exec(`
  CREATE TABLE inventory_sales_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_number TEXT, transaction_date TEXT, order_number TEXT,
    customer_code TEXT, customer_name TEXT,
    qty_sold REAL, unit_price REAL, line_amount REAL
  );
  CREATE INDEX idx_txn_date ON inventory_sales_transactions(transaction_date);
  CREATE TABLE inventory_sales_cache (item_number TEXT, period TEXT, item_description TEXT);
  CREATE TABLE inventoryrecord (item_number TEXT, item_description TEXT, updated_date TEXT);
  CREATE TABLE inventory_item_sales_rollup (item_number TEXT, period TEXT, qty_sold REAL, revenue REAL, item_description TEXT);
  CREATE TABLE inventory_customer_sales_rollup (customer_code TEXT, period TEXT, revenue REAL, qty REAL, customer_name TEXT);
`);

vi.mock('../src/db/index.js', () => ({ default: memDb, dbPath: ':memory:' }));
vi.mock('../src/lib/mainThreadWatch.js', () => ({ trackOp: () => () => {} }));
vi.mock('../src/services/batReconciliation.js', () => ({ getSagePool: async () => ({}) }));
vi.mock('../src/services/sage/queryRegistry.js', () => ({ resolveSageQuery: () => '' }));
vi.mock('../src/lib/errorLog.js', () => ({ logError: () => {} }));

const { rebuildInventorySalesRollups } = await import('../src/services/inventoryMovement.js');

// Two recent, in-window periods (current month + previous month).
const now = new Date();
const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const P1 = ym(new Date(now.getFullYear(), now.getMonth() - 1, 15)); // last month
const P2 = ym(now);                                                 // this month

function txn({ item = 'ITM1', date, cust = 'C1', custName = 'Acme', qty = 1, amount = 100 }) {
  memDb.prepare(`INSERT INTO inventory_sales_transactions
    (item_number, transaction_date, customer_code, customer_name, qty_sold, line_amount)
    VALUES (?, ?, ?, ?, ?, ?)`).run(item, date, cust, custName, qty, amount);
}

beforeEach(() => {
  for (const t of ['inventory_sales_transactions', 'inventory_sales_cache', 'inventoryrecord', 'inventory_item_sales_rollup', 'inventory_customer_sales_rollup']) {
    memDb.prepare(`DELETE FROM ${t}`).run();
  }
});

describe('rebuildInventorySalesRollups (chunked stage-and-swap)', () => {
  it('sums qty + revenue per (item, period) across many rows', async () => {
    txn({ item: 'ITM1', date: `${P1}-05`, qty: 2, amount: 100 });
    txn({ item: 'ITM1', date: `${P1}-20`, qty: 3, amount: 150 }); // same item+period → aggregates
    txn({ item: 'ITM1', date: `${P2}-10`, qty: 1, amount: 50 });  // different period → separate row
    txn({ item: 'ITM2', date: `${P1}-11`, qty: 4, amount: 400 });

    await rebuildInventorySalesRollups();

    const rows = memDb.prepare('SELECT item_number, period, qty_sold, revenue FROM inventory_item_sales_rollup ORDER BY item_number, period').all();
    expect(rows).toEqual([
      { item_number: 'ITM1', period: P1, qty_sold: 5, revenue: 250 },
      { item_number: 'ITM1', period: P2, qty_sold: 1, revenue: 50 },
      { item_number: 'ITM2', period: P1, qty_sold: 4, revenue: 400 },
    ]);
  });

  it('sums per (customer, period) and carries the customer name', async () => {
    txn({ cust: 'C1', custName: 'Acme', date: `${P1}-05`, qty: 2, amount: 100 });
    txn({ cust: 'C1', custName: 'Acme', date: `${P1}-25`, qty: 1, amount: 40 });
    txn({ cust: 'C2', custName: 'Beta', date: `${P2}-08`, qty: 5, amount: 500 });

    await rebuildInventorySalesRollups();

    const rows = memDb.prepare('SELECT customer_code, period, revenue, qty, customer_name FROM inventory_customer_sales_rollup ORDER BY customer_code, period').all();
    expect(rows).toEqual([
      { customer_code: 'C1', period: P1, revenue: 140, qty: 3, customer_name: 'Acme' },
      { customer_code: 'C2', period: P2, revenue: 500, qty: 5, customer_name: 'Beta' },
    ]);
  });

  it('EXCLUDES inter-branch transfers from both rollups', async () => {
    txn({ item: 'ITM1', cust: 'IB', custName: 'Inter Branch Transfer', date: `${P1}-05`, qty: 9, amount: 999 });
    txn({ item: 'ITM1', cust: 'C1', custName: 'Acme', date: `${P1}-06`, qty: 1, amount: 10 });

    await rebuildInventorySalesRollups();

    // Item rollup: only the real sale counts (inter-branch row dropped).
    const item = memDb.prepare('SELECT qty_sold, revenue FROM inventory_item_sales_rollup WHERE item_number = ? AND period = ?').get('ITM1', P1);
    expect(item).toEqual({ qty_sold: 1, revenue: 10 });
    // Customer rollup: no inter-branch customer row at all.
    const ib = memDb.prepare("SELECT COUNT(*) c FROM inventory_customer_sales_rollup WHERE customer_code = 'IB'").get();
    expect(ib.c).toBe(0);
  });

  it('prefers the sales-cache description, falls back to the item master, else null', async () => {
    txn({ item: 'CACHED', date: `${P1}-05` });
    txn({ item: 'MASTER', date: `${P1}-05` });
    txn({ item: 'NEITHER', date: `${P1}-05` });
    memDb.prepare("INSERT INTO inventory_sales_cache (item_number, period, item_description) VALUES ('CACHED', ?, 'From Cache')").run(P1);
    // CACHED is also in the item master — the cache value must still win.
    memDb.prepare("INSERT INTO inventoryrecord (item_number, item_description) VALUES ('CACHED', 'Ignored Master')").run();
    memDb.prepare("INSERT INTO inventoryrecord (item_number, item_description) VALUES ('MASTER', 'From Master')").run();

    await rebuildInventorySalesRollups();

    const desc = (item) => memDb.prepare('SELECT item_description FROM inventory_item_sales_rollup WHERE item_number = ?').get(item)?.item_description;
    expect(desc('CACHED')).toBe('From Cache');
    expect(desc('MASTER')).toBe('From Master');
    expect(desc('NEITHER')).toBeNull();
  });

  it('replaces prior rollup rows (atomic swap), not appends', async () => {
    // Pre-existing stale rollup rows that should be gone after a rebuild.
    memDb.prepare("INSERT INTO inventory_item_sales_rollup (item_number, period, qty_sold, revenue, item_description) VALUES ('OLD', '2020-01', 9, 9, 'x')").run();
    memDb.prepare("INSERT INTO inventory_customer_sales_rollup (customer_code, period, revenue, qty, customer_name) VALUES ('OLD', '2020-01', 9, 9, 'x')").run();
    txn({ item: 'ITM1', cust: 'C1', date: `${P2}-10`, qty: 1, amount: 100 });

    await rebuildInventorySalesRollups();

    expect(memDb.prepare("SELECT COUNT(*) c FROM inventory_item_sales_rollup WHERE item_number = 'OLD'").get().c).toBe(0);
    expect(memDb.prepare("SELECT COUNT(*) c FROM inventory_customer_sales_rollup WHERE customer_code = 'OLD'").get().c).toBe(0);
    expect(memDb.prepare("SELECT COUNT(*) c FROM inventory_item_sales_rollup").get().c).toBe(1);
  });

  it('coalesces concurrent rebuilds onto one in-flight run (no staging clash)', async () => {
    txn({ item: 'ITM1', cust: 'C1', date: `${P1}-05`, qty: 2, amount: 100 });
    // Fire two overlapping rebuilds — the in-flight guard must serialise them so
    // they don't corrupt the shared stage_* tables.
    await Promise.all([rebuildInventorySalesRollups(), rebuildInventorySalesRollups()]);
    const rows = memDb.prepare('SELECT item_number, period, qty_sold, revenue FROM inventory_item_sales_rollup').all();
    expect(rows).toEqual([{ item_number: 'ITM1', period: P1, qty_sold: 2, revenue: 100 }]);
  });
});
