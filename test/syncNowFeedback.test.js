// "Sync now" / "Sync all" tell the truth: a sync already running is a 409 with
// a plain message (not a green "0 records" toast), a BAT-only connection is
// refused without being marked broken, and Sync all skips BAT-only/switched-off
// connections and carries on past a failure.

import { describe, it, expect, vi, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';

const memDb = new Database(':memory:');
memDb.function('now_local', () => new Date().toISOString());
vi.mock('../src/db/index.js', () => ({ default: memDb, dbPath: ':memory:' }));
vi.mock('../src/services/encryption.js', () => ({ decryptPassword: () => '' }));
vi.mock('../src/lib/mainThreadWatch.js', () => ({ trackOp: () => () => {} }));
vi.mock('../src/lib/errorLog.js', () => ({ logError: () => {} }));
vi.mock('../src/lib/audit.js', () => ({ logAudit: () => {} }));

let base, engine, syncAll;
beforeAll(async () => {
  (await import('../src/db/batSchema.js')).initBatSchema(memDb);
  (await import('../src/db/schema.js')).initSchema(memDb);
  (await import('../src/db/migrations.js')).runMigrations(memDb);
  engine = await import('../src/services/syncEngine.js');
  syncAll = await import('../src/lib/syncAll.js');
  const { createConnectionsRouter } = await import('../src/routes/connections.js');
  const pass = (_req, _res, next) => next();
  const app = express().use(express.json()).use(createConnectionsRouter({
    db: memDb, requireAuth: pass, requirePermission: () => pass, isShuttingDown: () => false,
  }));
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  return () => server.close();
});

const addConn = (name, extra = {}) => memDb.prepare(`INSERT INTO databaseconnection (name, host, port, database_name, username, status, is_bat_only, sync_query, query_index_field)
  VALUES (?, 'h', 1433, 'd', 'u', ?, ?, 'SELECT 1 WHERE 1=1', 'customer_number')`).run(name, extra.status || 'active', extra.bat || 0).lastInsertRowid;

describe('Sync now', () => {
  it('answers 409 with a plain message while a sync of that connection is running', async () => {
    const id = addConn('AR running');
    engine.acquireSyncLock(id); // the scheduled sync holds it
    try {
      const res = await fetch(`${base}/api/import/${id}`, { method: 'POST' });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/"AR running" is already running/);
    } finally { engine.releaseSyncLock(id); }
  });

  it('refuses a BAT-only connection with 400 and leaves its status alone', async () => {
    const id = addConn('Sage 300 (BAT)', { bat: 1 });
    const res = await fetch(`${base}/api/import/${id}`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/BAT-only/);
    expect(memDb.prepare('SELECT status, last_error FROM databaseconnection WHERE id = ?').get(id)).toEqual({ status: 'active', last_error: null });
  });
});

describe('Sync all', () => {
  it('skips BAT-only and switched-off connections and keeps going past a failure', async () => {
    const conns = [
      { id: 1, name: 'BAT', is_bat_only: 1, status: 'active' },
      { id: 2, name: 'Customers', is_bat_only: 0, status: 'error' },
      { id: 3, name: 'Off', is_bat_only: 0, status: 'inactive' },
      { id: 4, name: 'Stock', is_bat_only: 0, status: 'active' },
    ];
    const calls = [];
    const results = await syncAll.syncAllConnections(conns, async (id) => {
      calls.push(id);
      if (id === 2) throw new Error('timeout');
      return { imported: 5, message: 'ok' };
    });
    expect(calls).toEqual([2, 4]);
    expect(results.map((r) => [r.conn.name, r.ok])).toEqual([['Customers', false], ['Stock', true]]);
  });
});
