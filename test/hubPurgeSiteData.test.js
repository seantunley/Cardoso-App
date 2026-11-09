// Removing a site must clear every hub table that holds its pulled data, or
// its figures stay in combined totals (src/hub/purgeSiteData.js). Runs on the
// full hub schema so a new hub_* table keyed by site_id is checked too.

import { it, expect, vi, beforeAll } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
memDb.function('now_local', () => new Date().toISOString());
vi.mock('../src/db/index.js', () => ({ default: memDb, dbPath: ':memory:' }));

const KEPT = ['hub_jti_archive', 'hub_commission_archive'];
let siteTables;
beforeAll(async () => {
  process.env.HUB_MODE = 'true';
  (await import('../src/db/batSchema.js')).initBatSchema(memDb);
  (await import('../src/db/schema.js')).initSchema(memDb);
  (await import('../src/db/migrations.js')).runMigrations(memDb);
  delete process.env.HUB_MODE;
  siteTables = memDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'hub\\_%' ESCAPE '\\'").all()
    .map((r) => r.name)
    .filter((t) => memDb.prepare(`PRAGMA table_info("${t}")`).all().some((c) => c.name === 'site_id'));
});

// Insert one row for a site, filling NOT NULL columns with throwaway values.
function seed(table, siteId) {
  memDb.pragma('foreign_keys = OFF');
  memDb.pragma('ignore_check_constraints = ON');
  const all = memDb.prepare(`PRAGMA table_info("${table}")`).all();
  const rowidPk = all.filter((c) => c.pk).length === 1 && all.some((c) => c.pk && /INT/i.test(c.type));
  const cols = all.filter((c) => c.name === 'site_id'
    || ((c.notnull || c.pk) && c.dflt_value == null && !(c.pk && rowidPk)));
  const vals = cols.map((c) => (c.name === 'site_id' ? siteId : c.type.toUpperCase().includes('INT') || c.type.toUpperCase().includes('REAL') ? 1 : `${table}-${siteId}-${Math.random()}`));
  memDb.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c.name}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
}
const count = (t, siteId) => memDb.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE site_id = ?`).get(siteId).n;

it('clears every site-keyed hub table for the removed site only, keeping filed archives', async () => {
  const { purgeSiteData } = await import('../src/hub/purgeSiteData.js');
  expect(siteTables.length).toBeGreaterThan(15);
  for (const s of ['gone', 'stays']) {
    memDb.prepare("INSERT INTO hub_sites (id, slug, name, url) VALUES (?, ?, ?, 'http://x')").run(s, s, s);
    for (const t of siteTables) seed(t, s);
  }
  const header = memDb.prepare("SELECT id FROM hub_creditor_po_header WHERE site_id = 'gone'").get().id;
  memDb.prepare('INSERT INTO hub_creditor_po_line (po_id) VALUES (?)').run(header);

  purgeSiteData(memDb, 'gone');

  for (const t of siteTables) {
    expect(count(t, 'gone'), t).toBe(KEPT.includes(t) ? 1 : 0);
    expect(count(t, 'stays'), t).toBe(1);
  }
  expect(memDb.prepare('SELECT COUNT(*) AS n FROM hub_creditor_po_line WHERE po_id = ?').get(header).n).toBe(0);
  expect(memDb.prepare("SELECT id FROM hub_sites ORDER BY id").all().map((r) => r.id)).toEqual(['stays']);
});
