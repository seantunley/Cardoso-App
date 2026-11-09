// "Sage down for N min" must count from the first failed probe of the outage.
// It used to count from the LATEST failed probe (which runs every minute), so it
// always read ~0 and the health rollup's "down > 5 min" never went critical.

import { it, expect, vi, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
let sageUp = false;
vi.mock('mssql', () => {
  class ConnectionPool {
    constructor() { this.connected = true; }
    async connect() { return this; }
    request() { return { query: async () => { if (!sageUp) throw new Error('ETIMEOUT'); return { recordset: [{ ok: 1 }] }; } }; }
    async close() {}
  }
  return { default: { ConnectionPool }, ConnectionPool };
});
vi.mock('../src/db/index.js', () => ({ default: memDb, dbPath: ':memory:' }));
vi.mock('../src/lib/errorLog.js', () => ({ logError: () => {} }));

beforeAll(async () => {
  memDb.function('now_local', () => new Date().toISOString());
  (await import('../src/db/batSchema.js')).initBatSchema(memDb);
  (await import('../src/db/schema.js')).initSchema(memDb);
  (await import('../src/db/migrations.js')).runMigrations(memDb);
  process.env.SAGE_HOST = 'fake';
  vi.useFakeTimers();
});
afterAll(() => { delete process.env.SAGE_HOST; vi.useRealTimers(); });

it('counts minutes from the start of the outage and resets when Sage is back', async () => {
  const { probeSageHealth, getSageHealth } = await import('../src/services/batReconciliation.js');
  vi.setSystemTime(new Date('2026-11-09T08:00:00Z'));
  await probeSageHealth();
  for (let i = 0; i < 10; i++) { // a failed probe every minute
    vi.setSystemTime(new Date(Date.now() + 60_000));
    await probeSageHealth();
  }
  expect(getSageHealth()).toMatchObject({ ok: false, consecutiveFailures: 11, downForMinutes: 10, lastError: 'ETIMEOUT' });

  sageUp = true;
  await probeSageHealth();
  expect(getSageHealth()).toMatchObject({ ok: true, downForMinutes: 0 });

  sageUp = false;
  await probeSageHealth(); // a new outage starts counting from zero
  vi.setSystemTime(new Date(Date.now() + 2 * 60_000));
  await probeSageHealth();
  expect(getSageHealth().downForMinutes).toBe(2);
});
