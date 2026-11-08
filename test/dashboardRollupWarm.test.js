// Site dashboard cards read the monthly sales rollups. On an upgraded site the
// rollups can be empty until the next sales sync even though sales lines exist;
// the cards must warm them first instead of showing no customers / calling
// recently sold stock "dead" (src/routes/reporting.js).

import { it, expect, vi, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';

const memDb = new Database(':memory:');
memDb.function('now_local', () => new Date().toISOString());
vi.mock('../src/db/index.js', () => ({ default: memDb, dbPath: ':memory:' }));
vi.mock('../src/lib/mainThreadWatch.js', () => ({ trackOp: () => () => {} }));

let base;
beforeAll(async () => {
  delete process.env.HUB_MODE;
  (await import('../src/db/batSchema.js')).initBatSchema(memDb);
  (await import('../src/db/schema.js')).initSchema(memDb);
  (await import('../src/db/migrations.js')).runMigrations(memDb);
  const { createReportingRouter } = await import('../src/routes/reporting.js');
  const pass = (_req, _res, next) => next();
  const app = express().use(createReportingRouter({ requireAuth: pass, requirePermission: () => pass }));
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  return () => server.close();
});

it('warms empty rollups before serving the dashboard cards', async () => {
  const d = new Date();
  const thisMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-02`;
  memDb.prepare(`INSERT INTO inventory_sales_transactions (item_number, transaction_date, customer_code, customer_name, qty_sold, line_amount)
    VALUES ('ITM1', ?, 'C1', 'Acme', 2, 500)`).run(thisMonth);
  memDb.prepare(`INSERT INTO inventoryrecord (source_table, item_number, item_description, inventory_value)
    VALUES ('ic', 'ITM1', 'Widget', '1000')`).run();
  expect(memDb.prepare('SELECT COUNT(*) AS n FROM inventory_customer_sales_rollup').get().n).toBe(0);

  const top = await (await fetch(`${base}/api/reports/dashboard/top-customers?months=12`)).json();
  expect(top.rows.map((r) => [r.customer_code, r.revenue])).toEqual([['C1', 500]]);

  const dead = await (await fetch(`${base}/api/reports/dashboard/dead-stock-items`)).json();
  expect(dead.rows.map((r) => r.item_number)).not.toContain('ITM1'); // sold this month → not dead stock
});
