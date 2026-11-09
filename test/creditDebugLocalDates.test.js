// Credit Debug must print each document's own date. Dates are parsed at local
// midnight (22:00Z the day before in SA), so toISOString().slice(0, 10) showed
// every invoice, receipt and the most recent transaction one day early.
// TZ is pinned so this fails on the old code even on a UTC CI runner.
process.env.TZ = 'Africa/Johannesburg';

import { it, expect, vi, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
memDb.function('now_local', () => new Date().toISOString());
vi.mock('../src/db/index.js', () => ({ default: memDb, dbPath: ':memory:' }));

beforeAll(async () => {
  delete process.env.HUB_MODE;
  (await import('../src/db/batSchema.js')).initBatSchema(memDb);
  (await import('../src/db/schema.js')).initSchema(memDb);
  (await import('../src/db/migrations.js')).runMigrations(memDb);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-09T08:00:00+02:00'));
});
afterAll(() => vi.useRealTimers());

it('shows invoice, receipt, pairing, unpaid and most-recent dates on their own SA day', async () => {
  memDb.prepare('INSERT INTO datarecord (customer_number, customer_name, outstanding_balance, unpaid_invoices, receipts) VALUES (?, ?, ?, ?, ?)').run(
    'C1', 'Acme', '5000',
    JSON.stringify([{ number: 'IN1', amount: '5000', date: '20260909' }, { number: 'IN0', amount: '1000', date: '20260801' }]),
    JSON.stringify([{ number: 'PY1', amount: '1000', date: '20260815' }]),
  );
  const { debugCreditForCustomer } = await import('../src/services/creditDebug.js');
  const out = JSON.stringify(debugCreditForCustomer('C1'));

  for (const day of ['2026-09-09', '2026-08-01', '2026-08-15']) expect(out).toContain(`"${day}"`);
  for (const wrong of ['2026-09-08', '2026-07-31', '2026-08-14']) expect(out).not.toContain(wrong);
  expect(out).toContain('"mostRecentTransaction":"2026-09-09"');
});
