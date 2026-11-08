// End-to-end customer sync (runConnectionImport, query mode) against the real
// schema in memory and a fake SQL Server: auto-flags are written only when they
// change, unchanged flagged rows aren't re-sent to the hub, and an auto-flag is
// cleared once its rule stops matching. Manual flags are never touched.

import { describe, it, expect, vi, beforeAll } from 'vitest';
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
  memDb.prepare(`INSERT INTO autoflagrule (rule_name, conditions, logic, flag_color, is_active, priority)
    VALUES ('Big balance', ?, 'AND', 'red', 1, 1)`).run(JSON.stringify([{ field: 'outstanding_balance', condition_type: 'greater_than', condition_value: '1000' }]));
});

const rec = (num) => memDb.prepare('SELECT flag_color, auto_flagged, flag_created_by, updated_date FROM datarecord WHERE TRIM(customer_number) = ?').get(num);
const sync = async () => {
  await new Promise((r) => setTimeout(r, 5)); // distinct sync timestamps
  const res = await runConnectionImport(connId);
  expect(res.success).not.toBe(false);
};

describe('customer sync auto-flags', () => {
  it('flags, leaves unchanged rows alone, and clears when the rule stops matching', async () => {
    sageRows = [
      { customer_number: 'A', customer_name: 'Alpha', outstanding_balance: '5000' },
      { customer_number: 'B', customer_name: 'Bravo', outstanding_balance: '5000' },
    ];
    await sync();
    expect(rec('A')).toMatchObject({ flag_color: 'red', auto_flagged: 1 });

    // B gets a manual flag from a user — the sync must never override it.
    memDb.prepare("UPDATE datarecord SET flag_color = 'green', auto_flagged = 0, flag_created_by = 'user@x' WHERE TRIM(customer_number) = 'B'").run();

    const before = rec('A').updated_date;
    await sync(); // identical data
    expect(rec('A').updated_date).toBe(before); // not re-sent to the hub

    sageRows[0].outstanding_balance = '500';
    sageRows[1].outstanding_balance = '500';
    await sync();
    expect(rec('A')).toMatchObject({ flag_color: null, auto_flagged: 0 }); // stale auto-flag cleared
    expect(rec('B')).toMatchObject({ flag_color: 'green', auto_flagged: 0, flag_created_by: 'user@x' }); // manual flag kept
  });
});
