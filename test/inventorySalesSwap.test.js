// Tests for the per-month swap in syncSalesFromSage (src/services/inventoryMovement.js):
// only months whose Sage lines changed are rewritten, and the end result is
// still exactly the Sage window (incl. duplicate lines and deletions).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
memDb.function('now_local', () => '2026-01-01 00:00:00');
memDb.exec(`
  CREATE TABLE inventory_sales_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_number TEXT NOT NULL, transaction_date TEXT NOT NULL, order_number TEXT,
    customer_code TEXT, customer_name TEXT,
    qty_sold REAL NOT NULL DEFAULT 0, unit_price REAL, line_amount REAL
  );
  CREATE INDEX idx_txn_date ON inventory_sales_transactions(transaction_date);
  CREATE TABLE inventory_sales_cache (item_number TEXT, period TEXT, qty_sold REAL, revenue REAL, order_count INTEGER, last_sale_date TEXT, item_description TEXT);
  CREATE TABLE inventory_sales_sync_meta (id INTEGER PRIMARY KEY, last_synced_at TEXT, last_synced_to TEXT, rows_synced INTEGER);
  INSERT INTO inventory_sales_sync_meta (id) VALUES (1);
  CREATE TABLE inventoryrecord (item_number TEXT, item_description TEXT);
  CREATE TABLE inventory_item_sales_rollup (item_number TEXT, period TEXT, qty_sold REAL, revenue REAL, item_description TEXT);
  CREATE TABLE inventory_customer_sales_rollup (customer_code TEXT, period TEXT, revenue REAL, qty REAL, customer_name TEXT);
  CREATE TABLE item_vendor (item_number TEXT PRIMARY KEY, vendor_code TEXT, vendor_name TEXT, synced_at TEXT);
`);

let sageTxn = [];
let vendorFails = false;
const fakePool = {
  request() {
    const req = { input: () => req, query: async (key) => {
      if (key === 'inventory.item_vendor' && vendorFails) throw new Error('ICITMV timed out');
      return { recordset: key === 'inventory.sales_txn' ? sageTxn : [] };
    } };
    return req;
  },
};

vi.mock('../src/db/index.js', () => ({ default: memDb, dbPath: ':memory:' }));
vi.mock('../src/lib/mainThreadWatch.js', () => ({ trackOp: () => () => {} }));
vi.mock('../src/services/batReconciliation.js', () => ({ getSagePool: async () => fakePool }));
vi.mock('../src/services/sage/queryRegistry.js', () => ({ resolveSageQuery: (key) => key }));
vi.mock('../src/lib/errorLog.js', () => ({ logError: () => {} }));

const { syncSalesFromSage, monthRanges } = await import('../src/services/inventoryMovement.js');

const now = new Date();
const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const A = ym(new Date(now.getFullYear(), now.getMonth() - 2, 15)); // unchanged month
const B = ym(new Date(now.getFullYear(), now.getMonth() - 1, 15)); // changed month
const OLD = `${now.getFullYear() - 5}-06-01`;                       // outside the window

const sage = (item, date, qty, order = '1001') => ({
  item_number: item, transaction_date_int: Number(date.replace(/-/g, '')), order_number: order,
  customer_code: 'C1', customer_name: 'Acme', qty_sold: qty, unit_price: 10, line_amount: qty * 10,
});
const live = (item, date, qty, order = '1001') => memDb.prepare(`INSERT INTO inventory_sales_transactions
  (item_number, transaction_date, order_number, customer_code, customer_name, qty_sold, unit_price, line_amount)
  VALUES (?, ?, ?, 'C1', 'Acme', ?, 10, ?)`).run(item, date, order, qty, qty * 10);
const rows = () => memDb.prepare('SELECT id, item_number, transaction_date, qty_sold FROM inventory_sales_transactions ORDER BY transaction_date, item_number, id').all();

beforeEach(() => { memDb.exec('DELETE FROM inventory_sales_transactions'); });

describe('monthRanges', () => {
  it('clips the first and last month to the window', () => {
    expect(monthRanges('2025-11-15', '2026-01-10')).toEqual([
      ['2025-11-15', '2025-11-31'], ['2025-12-01', '2025-12-31'], ['2026-01-01', '2026-01-10'],
    ]);
  });
});

describe('syncSalesFromSage per-month swap', () => {
  it('rewrites only changed months and ends up equal to Sage', async () => {
    live('ITM1', `${A}-05`, 2);          // A: identical in Sage (identical in Sage)
    live('ITM1', `${B}-05`, 2);          // B: qty corrected in Sage
    live('GONE', `${B}-06`, 1);          // B: line deleted in Sage
    live('ITM9', OLD, 7);                // outside window: never touched
    const idA = rows().find((r) => r.transaction_date === `${A}-05`).id;

    sageTxn = [sage('ITM1', `${A}-05`, 2), sage('ITM1', `${B}-05`, 3)];
    await syncSalesFromSage();

    const after = rows();
    expect(after.map(({ item_number, transaction_date, qty_sold }) => [item_number, transaction_date, qty_sold])).toEqual([
      ['ITM9', OLD, 7], ['ITM1', `${A}-05`, 2], ['ITM1', `${B}-05`, 3],
    ]);
    expect(after.find((r) => r.transaction_date === `${A}-05`).id).toBe(idA); // unchanged month not rewritten
  });

  it('detects a duplicate line count change in an otherwise identical month', async () => {
    live('ITM1', `${A}-05`, 1);
    live('ITM1', `${A}-05`, 1);
    live('ITM2', `${A}-06`, 1);
    sageTxn = [sage('ITM1', `${A}-05`, 1), sage('ITM2', `${A}-06`, 1), sage('ITM2', `${A}-06`, 1)];
    await syncSalesFromSage();
    expect(rows().map((r) => r.item_number)).toEqual(['ITM1', 'ITM2', 'ITM2']);
  });

  it('leaves live data untouched when a Sage line has no date', async () => {
    live('ITM1', `${A}-05`, 2);
    sageTxn = [sage('ITM1', `${B}-05`, 3), { ...sage('BAD', `${B}-06`, 1), transaction_date_int: null }];
    await expect(syncSalesFromSage()).rejects.toThrow(/no usable transaction date/);
    expect(rows().map((r) => r.item_number)).toEqual(['ITM1']);
  });
});

describe('partial failures are reported, not recorded as success', () => {
  it('a failed rollup rebuild or vendor-map refresh shows in sources and warnings', async () => {
    sageTxn = [sage('ITM1', `${B}-03`, 1)];
    const clean = await syncSalesFromSage();
    expect(clean.warnings).toEqual([]);
    expect(Object.values(clean.sources).some((x) => x.error)).toBe(false);

    vendorFails = true;
    memDb.exec('ALTER TABLE inventory_item_sales_rollup RENAME TO broken_rollup');
    try {
      const res = await syncSalesFromSage();
      expect(res.sources.rollups.error).toBeTruthy();
      expect(res.sources.item_vendors.error).toBe('ICITMV timed out');
      expect(res.warnings).toHaveLength(2);
      expect(res.warnings[0]).toMatch(/monthly sales totals failed/);
    } finally {
      vendorFails = false;
      memDb.exec('ALTER TABLE broken_rollup RENAME TO inventory_item_sales_rollup');
    }
  });
});
