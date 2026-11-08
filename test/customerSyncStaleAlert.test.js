// Alert when a customer connection hasn't synced successfully for too long
// during business hours (src/lib/alertRules.js: ruleCustomerSyncStale).

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
memDb.function('now_local', () => new Date().toISOString());
vi.mock('../src/db/index.js', () => ({ default: memDb, dbPath: ':memory:' }));
vi.mock('../src/services/batReconciliation.js', () => ({ getSageHealth: () => ({}) }));
vi.mock('../src/lib/backupHealth.js', () => ({ computeBackupHealth: () => ({}) }));
vi.mock('../src/services/hub/kopiaStatus.js', () => ({ getKopiaStatus: async () => ({}), isKopiaEnabled: () => false }));

let ruleCustomerSyncStale;
beforeAll(async () => {
  delete process.env.HUB_MODE;
  (await import('../src/db/batSchema.js')).initBatSchema(memDb);
  (await import('../src/db/schema.js')).initSchema(memDb);
  (await import('../src/db/migrations.js')).runMigrations(memDb);
  ({ ruleCustomerSyncStale } = await import('../src/lib/alertRules.js'));
});
beforeEach(() => { memDb.exec('DELETE FROM databaseconnection; DELETE FROM alerts;'); });

// Wed 12 Nov 2026 10:00 SAST (08:00 UTC) = business hours; Sat = quiet.
const WED_10 = new Date('2026-11-11T08:00:00Z');
const SAT_10 = new Date('2026-11-14T08:00:00Z');
const hoursBefore = (d, h) => new Date(d.getTime() - h * 3.6e6).toISOString();
const addConn = (name, { status = 'active', last_sync = null, last_error = null, bat = 0, type = 'customer', created = '2026-01-01 00:00:00' } = {}) =>
  memDb.prepare(`INSERT INTO databaseconnection (name, host, port, database_name, username, status, last_sync, last_error, is_bat_only, record_type, created_date)
    VALUES (?, 'h', 1433, 'd', 'u', ?, ?, ?, ?, ?, ?)`).run(name, status, last_sync, last_error, bat, type, created).lastInsertRowid;
const active = () => memDb.prepare('SELECT dedup_key, message FROM alerts WHERE resolved_at IS NULL ORDER BY dedup_key').all();

describe('customer sync stale alert', () => {
  it('fires for a failing connection in business hours, with the reason', async () => {
    const id = addConn('Customer CARDAT', { status: 'error', last_sync: hoursBefore(WED_10, 30), last_error: "SQL Server didn't respond in time [ETIMEOUT]" });
    addConn('Fresh', { last_sync: hoursBefore(WED_10, 0.5) });
    addConn('BAT only', { status: 'error', last_sync: null, bat: 1 });
    addConn('Switched off', { status: 'inactive', last_sync: null });
    addConn('Stock', { type: 'inventory', last_sync: null });
    await ruleCustomerSyncStale(WED_10);
    const a = active();
    expect(a.map((r) => r.dedup_key)).toEqual([`customer-sync-stale:${id}`]);
    expect(a[0].message).toMatch(/'Customer CARDAT' last synced successfully 30\.0 hours ago/);
    expect(a[0].message).toMatch(/ETIMEOUT/);
  });

  it('stays quiet at the weekend but keeps an alert already raised; resolves after a successful sync', async () => {
    const id = addConn('AR', { status: 'error', last_sync: hoursBefore(WED_10, 50) }); // stale on both days
    await ruleCustomerSyncStale(SAT_10);
    expect(active()).toEqual([]); // no new alert on a Saturday

    await ruleCustomerSyncStale(WED_10); // weekday: raised
    expect(active()).toHaveLength(1);
    await ruleCustomerSyncStale(SAT_10); // still stale at the weekend: kept
    expect(active()).toHaveLength(1);

    memDb.prepare('UPDATE databaseconnection SET status = ?, last_sync = ? WHERE id = ?').run('active', hoursBefore(WED_10, 0.1), id);
    await ruleCustomerSyncStale(WED_10);
    expect(active()).toEqual([]);
  });

  it('a connection that has never synced alerts only once it has existed past the threshold; switching it off resolves', async () => {
    const id = addConn('New', { created: hoursBefore(WED_10, 1) });
    await ruleCustomerSyncStale(WED_10);
    expect(active()).toEqual([]);
    memDb.prepare('UPDATE databaseconnection SET created_date = ? WHERE id = ?').run(hoursBefore(WED_10, 5), id);
    await ruleCustomerSyncStale(WED_10);
    expect(active()[0].message).toMatch(/'New' has never synced successfully/);
    memDb.prepare("UPDATE databaseconnection SET status = 'inactive' WHERE id = ?").run(id);
    await ruleCustomerSyncStale(WED_10);
    expect(active()).toEqual([]);
  });
});
