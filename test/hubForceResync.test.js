// Force-resync must forget the site's ETL change-detection tokens, otherwise the
// next hub cycle sees an unchanged inventory token and skips re-pulling the
// inventory the route just deleted (src/routes/hub.js).

import { it, expect, vi, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';

const memDb = new Database(':memory:');
memDb.function('now_local', () => new Date().toISOString());
vi.mock('../src/db/index.js', () => ({ default: memDb, dbPath: ':memory:' }));
vi.mock('../src/services/hubEtl.js', async (orig) => ({ ...(await orig()), syncAllSites: vi.fn(async () => {}) }));
vi.mock('../src/lib/audit.js', () => ({ logAudit: () => {} }));

let base;
beforeAll(async () => {
  process.env.HUB_MODE = 'true';
  (await import('../src/db/batSchema.js')).initBatSchema(memDb);
  (await import('../src/db/schema.js')).initSchema(memDb);
  (await import('../src/db/migrations.js')).runMigrations(memDb);
  const { createHubRouter } = await import('../src/routes/hub.js');
  const pass = (_req, _res, next) => next();
  const app = express().use(createHubRouter({ requireAuth: pass, requireAdmin: pass, requirePermission: () => pass }));
  const server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  return () => server.close();
});

const tokens = (site) => memDb.prepare('SELECT dataset FROM hub_site_etl_state WHERE site_id = ? ORDER BY dataset').all(site).map((r) => r.dataset);

it('per-site force-resync clears only that site\'s ETL tokens', async () => {
  const put = memDb.prepare("INSERT INTO hub_site_etl_state (site_id, dataset, token, updated_at) VALUES (?, ?, 't1', 'x')");
  for (const site of ['s1', 's2']) for (const ds of ['inventory', 'inventory_sales']) put.run(site, ds);

  const res = await fetch(`${base}/api/hub/force-resync/s1`, { method: 'POST' });
  expect(res.status).toBe(202);
  expect(tokens('s1')).toEqual([]);
  expect(tokens('s2')).toEqual(['inventory', 'inventory_sales']);
});
