// v112: on the hub, data left by sites removed before #609 is cleared; live
// sites (matched by id OR slug) and the filed archives are untouched; with no
// hub_sites rows at all it does nothing.

import { it, expect, vi, beforeAll } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
memDb.function('now_local', () => new Date().toISOString());
vi.mock('../src/db/index.js', () => ({ default: memDb, dbPath: ':memory:' }));

let m112;
beforeAll(async () => {
  process.env.HUB_MODE = 'true';
  (await import('../src/db/batSchema.js')).initBatSchema(memDb);
  (await import('../src/db/schema.js')).initSchema(memDb);
  (await import('../src/db/migrations.js')).runMigrations(memDb);
  delete process.env.HUB_MODE;
  m112 = (await import('../src/db/migrations/v112_hub_purge_removed_site_data.js')).default;
});

const rec = (site, n) => memDb.prepare("INSERT INTO hub_records (site_id, record_id, customer_number) VALUES (?, ?, 'C')").run(site, n);
const count = (t, site) => memDb.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE site_id = ?`).get(site).n;

it('does nothing when no sites are registered', () => {
  rec('site-x', 1);
  m112.up(memDb);
  expect(count('hub_records', 'site-x')).toBe(1);
  memDb.exec('DELETE FROM hub_records');
});

it('clears leftovers of removed sites only', () => {
  memDb.prepare("INSERT INTO hub_sites (id, slug, name, url) VALUES ('site-pta', 'pretoria', 'Pretoria', 'http://p'), ('site-jhb', 'johannesburg', 'JHB', 'http://j')").run();
  rec('site-pta', 1);
  rec('pretoria', 2); // a row keyed by slug must count as a live site
  rec('site-old', 3); // removed before #609
  rec('site-old', 4);
  memDb.prepare("INSERT INTO hub_sync_log (site_id, status, started_at) VALUES ('site-old', 'ok', '2026-01-01')").run();
  memDb.prepare(`INSERT INTO hub_jti_archive (site_id, period_year, period_month, generated_at, source, filename, file_path, byte_size, sha256, row_count, received_via)
    VALUES ('site-old', 2026, 1, '2026-02-01', 'scheduled', 'f.csv', 'x/f.csv', 1, 'x', 1, 'push')`).run();

  m112.up(memDb);
  m112.up(memDb); // safe to run twice

  expect(count('hub_records', 'site-old')).toBe(0);
  expect(count('hub_sync_log', 'site-old')).toBe(0);
  expect(count('hub_jti_archive', 'site-old')).toBe(1); // filed archive kept
  expect(count('hub_records', 'site-pta')).toBe(1);
  expect(count('hub_records', 'pretoria')).toBe(1);
  expect(memDb.prepare('SELECT COUNT(*) AS n FROM hub_sites').get().n).toBe(2);
});
