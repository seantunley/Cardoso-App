// Tests for makeIntervalGate (src/services/hubEtl.js) — the 30-minute gate on
// the hub's live-Sage aggregate pulls (AR document summary, invoice-profit
// totals). Runs the REAL helper against an in-memory hub_site_etl_state and
// drives it the way syncSite does: due() → pull → markPulled() only on success.
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
memDb.exec(`
  CREATE TABLE hub_site_etl_state (
    site_id TEXT NOT NULL, dataset TEXT NOT NULL, token TEXT, updated_at TEXT,
    PRIMARY KEY (site_id, dataset)
  );
`);
vi.mock('../src/db/index.js', () => ({ default: memDb, dbPath: ':memory:' }));
vi.mock('../src/hub/storage/runtime.js', () => ({ getHubStorageRuntime: () => ({}) }));
vi.mock('../src/lib/mainThreadWatch.js', () => ({ trackOp: () => () => {} }));

const { makeIntervalGate, SAGE_AGGREGATE_REFRESH_MS } = await import('../src/services/hubEtl.js');

const T0 = Date.parse('2026-11-08T08:00:00Z');
const MIN = 60 * 1000;

// One syncSite cycle for one dataset. Returns whether the pull ran.
function cycle(site, now, { ok = true, force = false } = {}) {
  const gate = makeIntervalGate(memDb, site, { now, force });
  if (!gate.due('ar_document_summary')) return false;
  if (ok) gate.markPulled('ar_document_summary');
  return true;
}

describe('makeIntervalGate', () => {
  it('interval is 30 minutes', () => {
    expect(SAGE_AGGREGATE_REFRESH_MS).toBe(30 * MIN);
  });

  it('pulls first cycle, skips within 30 min, pulls again after 30 min', () => {
    expect(cycle('s1', T0)).toBe(true);
    expect(cycle('s1', T0 + 5 * MIN)).toBe(false);
    expect(cycle('s1', T0 + 29 * MIN)).toBe(false);
    expect(cycle('s1', T0 + 30 * MIN)).toBe(true);
    expect(cycle('s1', T0 + 35 * MIN)).toBe(false);
  });

  it('a failed pull does not mark success, so the next cycle retries', () => {
    expect(cycle('s2', T0, { ok: false })).toBe(true);
    expect(cycle('s2', T0 + 5 * MIN, { ok: false })).toBe(true);
    expect(cycle('s2', T0 + 10 * MIN)).toBe(true);
    expect(cycle('s2', T0 + 15 * MIN)).toBe(false);
  });

  it('force bypasses the gate; gate is per site and per dataset', () => {
    expect(cycle('s3', T0)).toBe(true);
    expect(cycle('s3', T0 + MIN, { force: true })).toBe(true);
    expect(cycle('s4', T0 + MIN)).toBe(true);
    expect(makeIntervalGate(memDb, 's3', { now: T0 + 2 * MIN }).due('invoice_profit_totals')).toBe(true);
  });

  it('pulls when the stored time is in the future (clock went back)', () => {
    expect(cycle('s5', T0 + 60 * MIN)).toBe(true);
    expect(cycle('s5', T0)).toBe(true);
  });
});
