// The hub pulls customer records incrementally: GET /api/reporting/records?since=ISO.
// updated_date is stored in two formats (ISO from JS, "YYYY-MM-DD HH:MM:SS" from
// SQLite CURRENT_TIMESTAMP). Compared as text, a same-day record in the space
// format sorts before the hub's ISO `since` and was never sent to the hub.
// Auto-flag apply/clear must also move updated_date so the hub sees the change.

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
  process.env.REPORTING_TOKEN = 'test-token';
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

const pull = async (since) => {
  const res = await fetch(`${base}/api/reporting/records?since=${encodeURIComponent(since)}`, {
    headers: { 'x-reporting-token': 'test-token' },
  });
  return (await res.json()).records.map((r) => r.customer_number);
};

it('sends same-day records whatever format updated_date is stored in', async () => {
  const ins = memDb.prepare('INSERT INTO datarecord (customer_number, customer_name, updated_date) VALUES (?, ?, ?)');
  ins.run('SPACE_NEW', 'Space format, after since', '2026-11-09 08:00:00');
  ins.run('ISO_NEW', 'ISO format, after since', '2026-11-09T08:30:00.000Z');
  ins.run('SPACE_OLD', 'Space format, before since', '2026-11-09 07:00:00');
  ins.run('ISO_OLD', 'ISO format, previous day', '2026-11-08T23:00:00.000Z');

  expect(await pull('2026-11-09T07:55:00.000Z')).toEqual(['SPACE_NEW', 'ISO_NEW']);
});

it('auto-flag apply and clear move updated_date forward', async () => {
  const { buildStatements } = await import('../src/db/statements.js');
  const stmts = buildStatements(memDb);
  const { lastInsertRowid: id } = memDb
    .prepare("INSERT INTO datarecord (customer_number, updated_date) VALUES ('FLAG1', '2020-01-01 00:00:00')")
    .run();
  const since = new Date(Date.now() - 1000).toISOString();

  stmts.updateAutoFlag.run('red', 'Over limit', id);
  expect(await pull(since)).toContain('FLAG1');

  memDb.prepare("UPDATE datarecord SET updated_date = '2020-01-01 00:00:00' WHERE id = ?").run(id);
  stmts.clearAutoFlag.run(id);
  expect(await pull(since)).toContain('FLAG1');
});
