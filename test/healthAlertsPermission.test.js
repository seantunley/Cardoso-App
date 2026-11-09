// GET /api/system/sage-health sends alert TEXT to admins only; other users get
// the counts (alert text can carry security detail, and the alert endpoints are
// admin-only). src/routes/system.js

import { it, expect, vi, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';

const memDb = new Database(':memory:');
memDb.function('now_local', () => new Date().toISOString().replace('T', ' ').slice(0, 19));
vi.mock('../src/db/index.js', () => ({ default: memDb, dbPath: ':memory:' }));
vi.mock('../src/lib/mainThreadWatch.js', () => ({ trackOp: () => () => {} }));

let base;
beforeAll(async () => {
  delete process.env.HUB_MODE;
  (await import('../src/db/batSchema.js')).initBatSchema(memDb);
  (await import('../src/db/schema.js')).initSchema(memDb);
  (await import('../src/db/migrations.js')).runMigrations(memDb);
  const { fireAlert } = await import('../src/lib/alertEngine.js');
  fireAlert({ ruleName: 'security-signals', severity: 'critical', message: 'Brute force from 10.0.0.9 against admin@x', dedupKey: 'sec:1' });
  fireAlert({ ruleName: 'customer-sync-stale', severity: 'warning', message: "Customer sync 'AR' is stale", dedupKey: 'css:1' });

  const { createSystemRouter } = await import('../src/routes/system.js');
  const asRole = (req, _res, next) => { req.currentUser = { id: 1, email: 'u@x', role: req.get('x-role') }; next(); };
  const requireAdmin = (req, res, next) => (req.currentUser.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' }));
  const app = express().use(createSystemRouter({ requireAuth: asRole, requireAdmin }));
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  return () => server.close();
});

const health = async (role) => (await fetch(`${base}/api/system/sage-health`, { headers: { 'x-role': role } })).json();

it('admins get the alert messages, critical first', async () => {
  const h = await health('admin');
  expect(h.activeAlerts).toBe(2);
  expect(h.alerts.map((a) => a.message)).toEqual(['Brute force from 10.0.0.9 against admin@x', "Customer sync 'AR' is stale"]);
});

it('other users get counts only — no alert text', async () => {
  const h = await health('user');
  expect(h.activeAlerts).toBe(2);
  expect(h.criticalAlerts).toBe(1);
  expect(h.alerts).toBeUndefined();
  expect(JSON.stringify(h)).not.toMatch(/10\.0\.0\.9|Brute force/);
});

it('acknowledging stays admin-only', async () => {
  const res = await fetch(`${base}/api/system/alerts/1/acknowledge`, { method: 'POST', headers: { 'x-role': 'user' } });
  expect(res.status).toBe(403);
});
