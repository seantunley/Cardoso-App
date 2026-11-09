// At-risk customers insight: spend in the last 30 days at least halved vs the
// prior 30 (src/services/insights.js). The query carries planner hints for
// speed; this checks the grouping still gives the right customers.

import { it, expect, vi, beforeAll } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
memDb.function('now_local', () => new Date().toISOString());
vi.mock('../src/db/index.js', () => ({ default: memDb, dbPath: ':memory:' }));
vi.mock('../src/lib/mainThreadWatch.js', () => ({ trackOp: () => () => {} }));

beforeAll(async () => {
  delete process.env.HUB_MODE;
  (await import('../src/db/batSchema.js')).initBatSchema(memDb);
  (await import('../src/db/schema.js')).initSchema(memDb);
  (await import('../src/db/migrations.js')).runMigrations(memDb);
});

it('flags customers whose spend at least halved, and only them', async () => {
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const ins = memDb.prepare('INSERT INTO inventory_sales_transactions (item_number, transaction_date, customer_code, customer_name, qty_sold, line_amount) VALUES (?, ?, ?, ?, 1, ?)');
  ins.run('I1', day(45), 'DROP', 'Dropping Co', 5000); // prior 5000 → recent 1000
  ins.run('I1', day(10), 'DROP', 'Dropping Co', 1000);
  ins.run('I1', day(45), 'STEADY', 'Steady Co', 5000); // prior 5000 → recent 4000
  ins.run('I1', day(10), 'STEADY', 'Steady Co', 4000);
  ins.run('I1', day(45), 'SMALL', 'Small Co', 1000); // below the R2,000 floor
  ins.run('I1', day(90), 'OLD', 'Old Co', 9000); // outside the 60-day window

  const { computeInsights } = await import('../src/services/insights.js');
  const res = computeInsights();
  expect(res.metrics.at_risk_customer_count).toBe(1);
  expect(JSON.stringify(res)).toContain('Dropping Co');
});
