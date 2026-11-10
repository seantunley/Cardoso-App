// A hub older than stock take sends users without can_access_stock_take. The
// site must keep its own value then, not read the missing field as "revoke".
// Covers both update paths (with and without a real hub password).

import { it, expect, vi, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';

const memDb = new Database(':memory:');
memDb.function('now_local', () => new Date().toISOString());
vi.mock('../src/db/index.js', () => ({ default: memDb, dbPath: ':memory:' }));

let server, url;
beforeAll(async () => {
  delete process.env.HUB_MODE;
  process.env.REPORTING_TOKEN = 'test-token';
  (await import('../src/db/batSchema.js')).initBatSchema(memDb);
  (await import('../src/db/schema.js')).initSchema(memDb);
  (await import('../src/db/migrations.js')).runMigrations(memDb);
  const { createReceiveUsersRouter } = await import('../src/routes/hub.js');
  const app = express();
  app.use(express.json());
  app.use(createReceiveUsersRouter());
  await new Promise((r) => { server = app.listen(0, r); });
  url = `http://127.0.0.1:${server.address().port}/api/hub/receive-users`;
}, 30000);
afterAll(() => server?.close());

const push = (user) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-reporting-token': 'test-token' },
  body: JSON.stringify({ users: [{ role: 'user', is_active: true, ...user }] }),
}).then((r) => r.json());

const stockTake = (email) => memDb.prepare('SELECT can_access_stock_take AS v FROM "user" WHERE email = ?').get(email).v;

it.each([
  ['without a hub password', {}],
  ['with a real hub password', { password_hash: 'hash', must_change_password: 0 }],
])('keeps the site value when the hub omits the field (%s)', async (_label, extra) => {
  const email = `u${Math.random()}@site`;
  memDb.prepare('INSERT INTO "user" (email, full_name, role, password_hash, can_access_stock_take) VALUES (?, ?, ?, ?, 1)')
    .run(email, 'Counter', 'user', 'local');

  await push({ email, full_name: 'Counter', ...extra }); // old hub: no can_access_stock_take
  expect(stockTake(email)).toBe(1);

  await push({ email, full_name: 'Counter', ...extra, can_access_stock_take: false });
  expect(stockTake(email)).toBe(0);

  await push({ email, full_name: 'Counter', ...extra, can_access_stock_take: true });
  expect(stockTake(email)).toBe(1);
});
