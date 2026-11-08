// Customer sync writes in batches with event-loop yields between them
// (src/services/syncEngine.js, SYNC_WRITE_BATCH). Runs the real
// runConnectionImport against the full schema in memory and a fake SQL Server.

import { it, expect, vi, beforeAll } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
memDb.function('now_local', () => new Date().toISOString());

let sageRows = [];
vi.mock('mssql', () => {
  class ConnectionPool {
    async connect() { return this; }
    request() { return { query: async () => ({ recordset: sageRows.map((r) => ({ ...r })) }) }; }
    async close() {}
  }
  return { default: { ConnectionPool }, ConnectionPool };
});
vi.mock('../src/db/index.js', () => ({ default: memDb, dbPath: ':memory:' }));
vi.mock('../src/services/encryption.js', () => ({ decryptPassword: () => '' }));
vi.mock('../src/lib/mainThreadWatch.js', () => ({ trackOp: () => () => {} }));
vi.mock('../src/lib/errorLog.js', () => ({ logError: () => {} }));

let runConnectionImport;
let connId;
beforeAll(async () => {
  (await import('../src/db/batSchema.js')).initBatSchema(memDb);
  (await import('../src/db/schema.js')).initSchema(memDb);
  (await import('../src/db/migrations.js')).runMigrations(memDb);
  ({ runConnectionImport } = await import('../src/services/syncEngine.js'));
  connId = memDb.prepare(`INSERT INTO databaseconnection (name, host, port, database_name, username, sync_query, query_index_field)
    VALUES ('AR', 'fake', 1433, 'fake', 'fake', 'SELECT * FROM customers WHERE 1=1', 'customer_number')`).run().lastInsertRowid;
});

const N = 1200; // > 2 batches
const customers = (balance) => Array.from({ length: N }, (_, i) => ({ customer_number: `C${i}`, customer_name: `Cust ${i}`, outstanding_balance: String(balance) }));

it('writes every customer once, yields between batches, and keeps edits made mid-sync', async () => {
  sageRows = [...customers(100), { customer_number: 'C5', customer_name: 'dup', outstanding_balance: '1' }]; // duplicate in a later batch
  await runConnectionImport(connId);
  expect(memDb.prepare('SELECT COUNT(*) AS n FROM datarecord').get().n).toBe(N);
  expect(memDb.prepare("SELECT customer_name FROM datarecord WHERE customer_number = 'C5'").get().customer_name).toBe('Cust 5');

  // Second sync with new balances; a user flags C1100 (last batch) while the sync is running.
  sageRows = customers(200);
  let ticks = 0;
  let running = true;
  const syncDone = runConnectionImport(connId).finally(() => { running = false; });
  await new Promise((resolve) => {
    const tick = () => {
      ticks++;
      if (ticks === 2) memDb.prepare("UPDATE datarecord SET flag_color = 'red', flag_created_by = 'user@x' WHERE customer_number = 'C1100'").run();
      if (running) setImmediate(tick); else resolve();
    };
    setImmediate(tick);
  });
  await syncDone;

  expect(ticks).toBeGreaterThan(2); // the loop got control back during the sync
  expect(memDb.prepare("SELECT COUNT(*) AS n FROM datarecord WHERE outstanding_balance = '200'").get().n).toBe(N);
  expect(memDb.prepare("SELECT flag_color, flag_created_by FROM datarecord WHERE customer_number = 'C1100'").get())
    .toEqual({ flag_color: 'red', flag_created_by: 'user@x' });
});
