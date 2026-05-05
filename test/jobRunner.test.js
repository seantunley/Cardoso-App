// Tests for src/lib/jobRunner.js — the lifecycle wrapper for scheduled
// jobs. Uses an in-memory SQLite DB so we don't have to touch the real
// app database during tests. The helper imports `db` from src/db/index.js,
// so we shim it via a tiny module mock that returns an in-memory connection.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// Build a fresh in-memory DB with the migration v60 schema, then point
// the module under test at it before importing.
const memDb = new Database(':memory:');
memDb.exec(`
  CREATE TABLE job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('started','succeeded','failed')),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_ms INTEGER,
    error_message TEXT,
    context TEXT
  );
  CREATE INDEX idx_job_runs_name_started ON job_runs(name, started_at DESC);
  CREATE INDEX idx_job_runs_started ON job_runs(started_at DESC);
`);

vi.mock('../src/db/index.js', () => ({
  default: memDb,
  dbPath: ':memory:',
}));

// Import AFTER the mock so jobRunner picks up our in-memory db.
const { recordJob, getJobsSummary, pruneOldJobRuns } = await import('../src/lib/jobRunner.js');

beforeEach(() => {
  memDb.prepare('DELETE FROM job_runs').run();
});

describe('recordJob — happy path', () => {
  it('writes a started→succeeded row and returns the function result', async () => {
    const result = await recordJob('test-job', async () => 'ok');
    expect(result).toBe('ok');

    const rows = memDb.prepare('SELECT * FROM job_runs').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('test-job');
    expect(rows[0].status).toBe('succeeded');
    expect(rows[0].started_at).toBeTruthy();
    expect(rows[0].ended_at).toBeTruthy();
    expect(rows[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(rows[0].error_message).toBeNull();
  });

  it('attaches context from contextFn', async () => {
    await recordJob('counted', async () => ({ rows: 42 }), (r) => r);
    const row = memDb.prepare('SELECT * FROM job_runs').get();
    expect(JSON.parse(row.context)).toEqual({ rows: 42 });
  });

  it('swallows contextFn errors so they don\'t fail the job', async () => {
    await recordJob('boom-ctx', async () => 'ok', () => { throw new Error('ctx broke'); });
    const row = memDb.prepare('SELECT * FROM job_runs').get();
    expect(row.status).toBe('succeeded');
    expect(row.context).toBeNull();
  });
});

describe('recordJob — failure path', () => {
  it('writes a failed row, records the error message, and rethrows', async () => {
    await expect(
      recordJob('explodes', async () => { throw new Error('disk on fire'); }),
    ).rejects.toThrow('disk on fire');

    const row = memDb.prepare('SELECT * FROM job_runs').get();
    expect(row.status).toBe('failed');
    expect(row.error_message).toBe('disk on fire');
    expect(row.ended_at).toBeTruthy();
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('truncates very long error messages to 1000 chars', async () => {
    const long = 'x'.repeat(5000);
    await expect(recordJob('long-err', async () => { throw new Error(long); })).rejects.toBeDefined();
    const row = memDb.prepare('SELECT * FROM job_runs').get();
    expect(row.error_message.length).toBeLessThanOrEqual(1000);
  });
});

describe('getJobsSummary', () => {
  it('returns empty array when no rows', () => {
    expect(getJobsSummary()).toEqual([]);
  });

  it('returns latest run per job + failure count in window', async () => {
    await recordJob('A', async () => 'x');
    await recordJob('A', async () => { throw new Error('fail1'); }).catch(() => {});
    await recordJob('A', async () => 'y'); // latest is success
    await recordJob('B', async () => { throw new Error('fail2'); }).catch(() => {});

    const summary = getJobsSummary({ since: new Date(Date.now() - 60_000).toISOString() });
    const byName = Object.fromEntries(summary.map(s => [s.name, s]));

    expect(byName.A.last_status).toBe('succeeded');
    expect(byName.A.failures_in_window).toBe(1);
    expect(byName.A.total_in_window).toBe(3);

    expect(byName.B.last_status).toBe('failed');
    expect(byName.B.last_error).toBe('fail2');
    expect(byName.B.failures_in_window).toBe(1);
  });

  it('respects the `since` filter (older failures excluded)', async () => {
    // Insert a synthetic old failure
    memDb.prepare(`
      INSERT INTO job_runs (name, status, started_at, ended_at, duration_ms, error_message)
      VALUES ('old-fail', 'failed', '2024-01-01T00:00:00Z', '2024-01-01T00:00:01Z', 1000, 'ancient')
    `).run();
    await recordJob('old-fail', async () => 'recovered now');

    const summary = getJobsSummary({ since: '2025-01-01T00:00:00Z' });
    const oldFail = summary.find(s => s.name === 'old-fail');
    expect(oldFail.last_status).toBe('succeeded');
    expect(oldFail.failures_in_window).toBe(0); // ancient row excluded
    expect(oldFail.total_in_window).toBe(1);
  });
});

describe('pruneOldJobRuns', () => {
  it('deletes rows older than the cutoff', () => {
    memDb.prepare(`
      INSERT INTO job_runs (name, status, started_at)
      VALUES ('ancient', 'succeeded', '2020-01-01T00:00:00Z'),
             ('recent', 'succeeded', ?)
    `).run(new Date().toISOString());

    const deleted = pruneOldJobRuns(30);
    expect(deleted).toBe(1);
    expect(memDb.prepare('SELECT name FROM job_runs').all().map(r => r.name)).toEqual(['recent']);
  });
});
