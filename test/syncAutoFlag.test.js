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
vi.mock('../src/services/encryption.js', () => ({ decryptPassword: () => '', encryptPassword: (s) => s, getEncryptionKey: () => 'k' }));
vi.mock('../src/lib/mainThreadWatch.js', () => ({ trackOp: () => () => {} }));
vi.mock('../src/lib/errorLog.js', () => ({ logError: () => {} }));

let runConnectionImport;
let connId;
let api; // base URL of the real Records router (PUT /api/:table/:id)
beforeAll(async () => {
  (await import('../src/db/batSchema.js')).initBatSchema(memDb);
  (await import('../src/db/schema.js')).initSchema(memDb);
  (await import('../src/db/migrations.js')).runMigrations(memDb);
  ({ runConnectionImport } = await import('../src/services/syncEngine.js'));
  connId = memDb.prepare(`INSERT INTO databaseconnection (name, host, port, database_name, username, sync_query, query_index_field)
    VALUES ('AR', 'fake', 1433, 'fake', 'fake', 'SELECT * FROM customers WHERE 1=1', 'customer_number')`).run().lastInsertRowid;
  memDb.prepare(`INSERT INTO autoflagrule (rule_name, conditions, logic, flag_color, is_active, priority)
    VALUES ('Big balance', ?, 'AND', 'red', 1, 1)`).run(JSON.stringify([{ field: 'outstanding_balance', condition_type: 'greater_than', condition_value: '1000' }]));

  const express = (await import('express')).default;
  const { createRecordsRouter } = await import('../src/routes/records.js');
  const { buildStatements } = await import('../src/db/statements.js');
  const asUser = (req, _res, next) => { req.currentUser = { email: 'person@x', role: 'admin' }; next(); };
  const pass = (_req, _res, next) => next();
  const app = express().use(express.json()).use(createRecordsRouter({
    db: memDb, stmts: buildStatements(memDb), requireAuth: asUser, requireAdmin: pass,
    requirePermission: () => pass, checkTableAccess: () => ({ ok: true }),
  }));
  const server = app.listen(0);
  api = `http://127.0.0.1:${server.address().port}`;
  return () => server.close();
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

  it('a user re-flagging an auto-flagged customer via the Records API survives the next sync', async () => {
    sageRows = [{ customer_number: 'M', customer_name: 'Mike', outstanding_balance: '5000' }];
    await sync();
    expect(rec('M')).toMatchObject({ flag_color: 'red', auto_flagged: 1 });

    const id = memDb.prepare("SELECT id FROM datarecord WHERE customer_number = 'M'").get().id;
    const res = await fetch(`${api}/api/datarecord/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flag_color: 'green', flag_reason: 'Paid in person' }), // what the Records page sends
    });
    expect(res.status).toBe(200);
    expect(rec('M')).toMatchObject({ flag_color: 'green', auto_flagged: 0, flag_created_by: 'person@x' });

    await sync(); // rule still matches the balance
    expect(rec('M')).toMatchObject({ flag_color: 'green', auto_flagged: 0, flag_created_by: 'person@x' });
  });

  it('clears auto-flags when the last active rule is disabled, keeping manual flags', async () => {
    sageRows = [
      { customer_number: 'A', customer_name: 'Alpha', outstanding_balance: '5000' },
      { customer_number: 'B', customer_name: 'Bravo', outstanding_balance: '5000' },
    ];
    await sync();
    expect(rec('A')).toMatchObject({ flag_color: 'red', auto_flagged: 1 });
    expect(rec('B')).toMatchObject({ flag_color: 'green', flag_created_by: 'user@x' }); // still manual from the test above

    memDb.prepare('UPDATE autoflagrule SET is_active = 0').run(); // no active rules left
    await sync(); // same data
    expect(rec('A')).toMatchObject({ flag_color: null, auto_flagged: 0 });
    expect(rec('B')).toMatchObject({ flag_color: 'green', auto_flagged: 0, flag_created_by: 'user@x' });
  });
});
