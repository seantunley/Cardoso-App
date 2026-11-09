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

let ruleCustomerSyncStale, syncWindowHoursBetween;
beforeAll(async () => {
  delete process.env.HUB_MODE;
  (await import('../src/db/batSchema.js')).initBatSchema(memDb);
  (await import('../src/db/schema.js')).initSchema(memDb);
  (await import('../src/db/migrations.js')).runMigrations(memDb);
  ({ ruleCustomerSyncStale, syncWindowHoursBetween } = await import('../src/lib/alertRules.js'));
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

  it('Friday → Monday: weekend hours do not count, Monday\'s own scheduled runs do', async () => {
    const sast = (iso) => new Date(`${iso}+02:00`); // SAST wall-clock → Date
    const MON_0815 = sast('2026-11-16T08:15:00');
    // Normal Monday: the scheduled runs since 06:00 succeeded (latest at 08:00) → fresh.
    const ok = addConn('Monday ran', { last_sync: sast('2026-11-16T08:00:30').toISOString() });
    await ruleCustomerSyncStale(MON_0815);
    expect(active()).toEqual([]);
    // No successful run since Friday 17:00 by 08:15 Monday = 0.5h Fri + 2.25h Mon of
    // missed scheduled time (Mon 06:00-08:00 runs all missing) → alert.
    memDb.prepare('UPDATE databaseconnection SET last_sync = ? WHERE id = ?').run(sast('2026-11-13T17:00:00').toISOString(), ok);
    await ruleCustomerSyncStale(MON_0815);
    expect(active()).toHaveLength(1);
  });

  it('overnight: Tuesday evening to Wednesday morning is not stale before the window has run for 2h', async () => {
    const sast = (iso) => new Date(`${iso}+02:00`);
    addConn('AR', { last_sync: sast('2026-11-10T17:00:00').toISOString() });
    await ruleCustomerSyncStale(sast('2026-11-11T07:45:00')); // before alert hours anyway
    await ruleCustomerSyncStale(sast('2026-11-11T08:00:00')); // 0.5h Tue + 2h Wed = 2.5h → stale
    expect(active()).toHaveLength(1);
  });

  it('counts only weekday 06:00–17:30 SAST', () => {
    const sast = (iso) => new Date(`${iso}+02:00`).getTime();
    const h = (a, b) => syncWindowHoursBetween(sast(a), sast(b), 1000);
    expect(h('2026-11-13T17:00:00', '2026-11-16T06:00:00')).toBe(0.5); // Fri 17:00 → Mon 06:00
    expect(h('2026-11-10T17:00:00', '2026-11-11T06:30:00')).toBe(1);   // Tue 17:00 → Wed 06:30
    expect(h('2026-11-09T09:00:00', '2026-11-09T12:00:00')).toBe(3);   // Mon 09:00 → 12:00
    expect(h('2026-11-14T00:00:00', '2026-11-15T23:55:00')).toBe(0);   // whole weekend
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
