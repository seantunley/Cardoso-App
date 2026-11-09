// A failed customer sync sets the connection to 'error'. The schedulers must
// keep retrying it (every 30 min at most) instead of stopping for good
// (src/scheduler.js: isAutoSyncDue / SYNCABLE_CONNECTIONS_SQL).

import { describe, it, expect, vi, beforeAll } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
memDb.function('now_local', () => new Date().toISOString());
vi.mock('../src/db/index.js', () => ({ default: memDb, dbPath: ':memory:' }));

let isAutoSyncDue, ERROR_RETRY_MS, SYNCABLE_CONNECTIONS_SQL;
beforeAll(async () => {
  (await import('../src/db/batSchema.js')).initBatSchema(memDb);
  (await import('../src/db/schema.js')).initSchema(memDb);
  (await import('../src/db/migrations.js')).runMigrations(memDb);
  ({ isAutoSyncDue, ERROR_RETRY_MS, SYNCABLE_CONNECTIONS_SQL } = await import('../src/scheduler.js'));
});

const NOW = Date.parse('2026-11-08T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3.6e6).toISOString();
const sqliteUtc = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19); // CURRENT_TIMESTAMP format

describe('isAutoSyncDue', () => {
  it('active connection: due once its interval has passed', () => {
    expect(isAutoSyncDue({ status: 'active', last_sync: hoursAgo(0.5), sync_interval_hours: 1 }, NOW)).toBe(false);
    expect(isAutoSyncDue({ status: 'active', last_sync: hoursAgo(2), sync_interval_hours: 1 }, NOW)).toBe(true);
    expect(isAutoSyncDue({ status: 'active', last_sync: null, sync_interval_hours: 1 }, NOW)).toBe(true);
  });

  it('errored connection: retried, but not more often than ERROR_RETRY_MS', () => {
    const failedJustNow = { status: 'error', last_sync: hoursAgo(48), updated_date: sqliteUtc(NOW - 60_000), sync_interval_hours: 1 };
    const failedLongAgo = { ...failedJustNow, updated_date: sqliteUtc(NOW - ERROR_RETRY_MS - 1000) };
    expect(isAutoSyncDue(failedJustNow, NOW)).toBe(false);
    expect(isAutoSyncDue(failedLongAgo, NOW)).toBe(true);
  });
});

it('schedulers pick active and errored connections, not inactive or BAT-only', () => {
  const add = memDb.prepare(`INSERT INTO databaseconnection (name, host, port, database_name, username, status, is_bat_only)
    VALUES (?, 'h', 1433, 'd', 'u', ?, ?)`);
  add.run('ok', 'active', 0);
  add.run('failed', 'error', 0);
  add.run('off', 'inactive', 0);
  add.run('bat', 'error', 1);
  const src = memDb.prepare(`SELECT name FROM databaseconnection WHERE ${SYNCABLE_CONNECTIONS_SQL} ORDER BY name`).all();
  expect(src.map((r) => r.name)).toEqual(['failed', 'ok']);
});
