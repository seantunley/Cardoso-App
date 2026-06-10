// SYNC-1 — the hub's incremental records pull stamps `since` from the previous
// run's started_at minus a safety margin, NOT its completed_at. completed_at is
// stamped after the 30-60s sync, so a record the site updates mid-sync (or under
// clock skew) would have updated_date < completed_at and never be re-pulled.

import { describe, it, expect, vi } from 'vitest';

// hubEtl opens the hub storage runtime at module load — stub it.
vi.mock('../src/hub/storage/runtime.js', () => ({
  getHubStorageRuntime: () => ({
    sqliteDb: { prepare: () => ({ get: () => null, all: () => [], run: () => {} }) },
    repository: {},
  }),
}));

import { incrementalSinceParam } from '../src/services/hubEtl.js';

describe('incrementalSinceParam (SYNC-1)', () => {
  it('returns "" for a first/full pull (no prior run)', () => {
    expect(incrementalSinceParam(null)).toBe('');
    expect(incrementalSinceParam(undefined)).toBe('');
    expect(incrementalSinceParam('')).toBe('');
  });

  it('returns "" for an unparseable timestamp', () => {
    expect(incrementalSinceParam('not-a-date')).toBe('');
  });

  it('stamps since from started_at minus the safety margin', () => {
    const startedAt = '2026-06-10T12:00:00.000Z';
    const expected = new Date(Date.parse(startedAt) - 5 * 60 * 1000).toISOString();
    expect(incrementalSinceParam(startedAt)).toBe(`?since=${encodeURIComponent(expected)}`);
  });

  it('uses started_at, not completed_at — a mid-sync update is still re-pulled', () => {
    // Sync ran 12:00:00 (start) → 12:00:45 (completed). A record updated at
    // 12:00:30 (during the window) must be re-pulled: `since` has to be at or
    // before 12:00:30, i.e. derived from started_at minus margin — NOT
    // completed_at (12:00:45), which would skip it.
    const sinceFrag = incrementalSinceParam('2026-06-10T12:00:00.000Z');
    const since = decodeURIComponent(sinceFrag.replace('?since=', ''));
    expect(Date.parse(since)).toBeLessThan(Date.parse('2026-06-10T12:00:30.000Z'));
  });

  it('respects a custom margin', () => {
    const startedAt = '2026-06-10T12:00:00.000Z';
    const expected = new Date(Date.parse(startedAt) - 1000).toISOString();
    expect(incrementalSinceParam(startedAt, 1000)).toBe(`?since=${encodeURIComponent(expected)}`);
  });
});
