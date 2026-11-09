// Customer sync retries temporary SQL Server failures (timeouts, dropped
// connections) inside the run instead of failing the whole sync, and still
// fails fast on real errors (src/services/syncEngine.js: withSqlRetry).

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
memDb.function('now_local', () => new Date().toISOString());

// Scripted fake SQL Server: each connect()/query() call takes the next outcome.
const script = { connect: [], query: [] };
const sqlErr = (code, message = `fake ${code}`) => Object.assign(new Error(message), { code });
const next = (list) => { const o = list.shift(); if (o instanceof Error) throw o; return o; };
vi.mock('mssql', () => {
  class ConnectionPool {
    async connect() { next(script.connect); return this; }
    request() { return { query: async () => ({ recordset: next(script.query) }) }; }
    async close() {}
  }
  return { default: { ConnectionPool }, ConnectionPool };
});
vi.mock('../src/db/index.js', () => ({ default: memDb, dbPath: ':memory:' }));
vi.mock('../src/services/encryption.js', () => ({ decryptPassword: () => '' }));
vi.mock('../src/lib/mainThreadWatch.js', () => ({ trackOp: () => () => {} }));
vi.mock('../src/lib/errorLog.js', () => ({ logError: () => {} }));

let runConnectionImport, sqlRetry, isTransientSqlError, connId;
beforeAll(async () => {
  (await import('../src/db/batSchema.js')).initBatSchema(memDb);
  (await import('../src/db/schema.js')).initSchema(memDb);
  (await import('../src/db/migrations.js')).runMigrations(memDb);
  ({ runConnectionImport, sqlRetry, isTransientSqlError } = await import('../src/services/syncEngine.js'));
  sqlRetry.delaysMs = [0, 0];
  connId = memDb.prepare(`INSERT INTO databaseconnection (name, host, port, database_name, username, sync_query, query_index_field)
    VALUES ('AR', 'fake', 1433, 'fake', 'fake', 'SELECT * FROM customers WHERE 1=1', 'customer_number')`).run().lastInsertRowid;
});
beforeEach(() => { script.connect = []; script.query = []; });

const rows = [{ customer_number: 'A', customer_name: 'Alpha', outstanding_balance: '10' }];
const status = () => memDb.prepare('SELECT status, last_error FROM databaseconnection WHERE id = ?').get(connId);

describe('transient SQL Server failures', () => {
  it('recognises the usual tedious/mssql codes, nested or not', () => {
    expect(isTransientSqlError(sqlErr('ETIMEOUT'))).toBe(true);
    expect(isTransientSqlError({ originalError: { code: 'ESOCKET' } })).toBe(true);
    expect(isTransientSqlError(sqlErr('ELOGIN'))).toBe(false);
    expect(isTransientSqlError(new Error('Invalid column name'))).toBe(false);
  });

  it('a timed-out connect and a dropped query are retried and the sync succeeds', async () => {
    script.connect = [sqlErr('ETIMEOUT'), undefined];
    script.query = [sqlErr('ECONNRESET'), rows];
    const res = await runConnectionImport(connId);
    expect(res.success).toBe(true);
    expect(status().status).toBe('active');
    expect(script.connect.length + script.query.length).toBe(0); // every scripted outcome was used
  });

  it('gives up after three temporary failures and marks the connection as failed', async () => {
    script.connect = [undefined];
    script.query = [sqlErr('ETIMEOUT'), sqlErr('ETIMEOUT'), sqlErr('ETIMEOUT'), rows];
    await expect(runConnectionImport(connId)).rejects.toThrow(/ETIMEOUT/);
    expect(status().status).toBe('error');
    expect(script.query).toEqual([rows]); // the 4th attempt never happened
  });

  it('stops retrying if the server starts shutting down during the pause', async () => {
    let shuttingDown = false;
    sqlRetry.delaysMs = [30, 30];
    script.connect = [undefined];
    script.query = [sqlErr('ETIMEOUT'), rows];
    setTimeout(() => { shuttingDown = true; }, 10); // shutdown begins mid-backoff
    try {
      await expect(runConnectionImport(connId, { isShuttingDown: () => shuttingDown })).rejects.toThrow(/ETIMEOUT/);
      expect(script.query).toEqual([rows]); // no second query attempt after shutdown began
    } finally { sqlRetry.delaysMs = [0, 0]; }
  });

  it('does not retry a real error such as a bad login', async () => {
    script.connect = [sqlErr('ELOGIN', 'Login failed for user'), undefined];
    await expect(runConnectionImport(connId)).rejects.toThrow(/Login failed/);
    expect(script.connect.length).toBe(1); // no second connect attempt
  });
});
