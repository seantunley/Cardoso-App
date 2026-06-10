import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { pruneHubInventory } from '../src/services/hubEtl.js';

function seedDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE hub_inventory (site_id TEXT, item_number TEXT, qty REAL)');
  return db;
}

describe('pruneHubInventory (SYNC-4)', () => {
  it('prunes rows not in the synced set, keeps synced, leaves other sites alone', () => {
    const db = seedDb();
    const ins = db.prepare('INSERT INTO hub_inventory (site_id, item_number, qty) VALUES (?, ?, ?)');
    ins.run('S1', 'A', 1); ins.run('S1', 'B', 2); ins.run('S1', 'C', 3);
    ins.run('S2', 'A', 9); // different site — must be untouched
    pruneHubInventory(db, 'S1', ['A', 'C']);
    const rows = db.prepare('SELECT site_id, item_number FROM hub_inventory ORDER BY site_id, item_number').all();
    expect(rows).toEqual([
      { site_id: 'S1', item_number: 'A' },
      { site_id: 'S1', item_number: 'C' },
      { site_id: 'S2', item_number: 'A' },
    ]);
  });

  it('no-ops on an empty synced set (does not wipe the site)', () => {
    const db = seedDb();
    db.prepare('INSERT INTO hub_inventory (site_id, item_number, qty) VALUES (?, ?, ?)').run('S1', 'A', 1);
    pruneHubInventory(db, 'S1', []);
    expect(db.prepare('SELECT COUNT(*) AS n FROM hub_inventory').get().n).toBe(1);
  });

  it("handles a synced set far above SQLite's ~32,766 variable cap without throwing", () => {
    const db = seedDb();
    const ins = db.prepare('INSERT INTO hub_inventory (site_id, item_number, qty) VALUES (?, ?, ?)');
    ins.run('S1', 'KEEP', 1);
    ins.run('S1', 'GONE', 1);
    const items = Array.from({ length: 40000 }, (_, i) => `IT${i}`);
    items.push('KEEP');
    expect(() => pruneHubInventory(db, 'S1', items)).not.toThrow();
    const kept = db.prepare('SELECT item_number FROM hub_inventory WHERE site_id = ?').all('S1').map((r) => r.item_number);
    expect(kept).toEqual(['KEEP']); // GONE pruned, KEEP retained — the old NOT IN (?,…) would have thrown here
  });
});
