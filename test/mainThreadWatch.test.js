// Tests for src/lib/mainThreadWatch.js — the boot-time freeze-marker check
// and the trackOp registry. The live watchdog worker is time-based and runs
// in CI only incidentally; the marker contract is what must stay pinned.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// errorLog writes through src/db — stub it so the test stays DB-free.
const logged = [];
vi.mock('../src/lib/errorLog.js', () => ({
  logError: (source, err, ctx, level) => { logged.push({ source, message: err.message, ctx, level }); },
}));

const {
  checkPreviousRunFreeze,
  freezeMarkerPath,
  _writeFreezeMarkerForTest,
  trackOp,
  getActiveOps,
} = await import('../src/lib/mainThreadWatch.js');

let dir;
let fakeDbPath;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mtw-'));
  fakeDbPath = path.join(dir, 'cardoso.db');
  logged.length = 0;
});
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp cleanup */ }
});

describe('checkPreviousRunFreeze', () => {
  it('returns null and stays silent when no marker exists', () => {
    expect(checkPreviousRunFreeze(fakeDbPath)).toBeNull();
    expect(logged.length).toBe(0);
  });

  it('reports an unrecovered freeze as error + critical alert, then archives the marker', () => {
    _writeFreezeMarkerForTest(fakeDbPath, {
      detected_at: '2026-06-10T04:31:00.000Z',
      frozen_for_ms: 45_000,
      active_operations: 'hub-etl:site3 (started 2026-06-10T04:30:12.000Z)',
    });
    const alerts = [];
    const parsed = checkPreviousRunFreeze(fakeDbPath, { fireAlert: (a) => alerts.push(a) });

    expect(parsed.frozen_for_ms).toBe(45_000);
    expect(logged[0].source).toBe('main_thread.freeze_previous_run');
    expect(logged[0].level).toBe('error');
    expect(logged[0].message).toContain('never recovered');
    expect(logged[0].message).toContain('hub-etl:site3');
    expect(alerts.length).toBe(1);
    expect(alerts[0].severity).toBe('critical');
    expect(alerts[0].message).toContain('hub-etl:site3');

    // Marker archived — a second boot must not re-report.
    expect(existsSync(freezeMarkerPath(fakeDbPath))).toBe(false);
    expect(readdirSync(dir).some((f) => f.includes('.archived.json'))).toBe(true);
    expect(checkPreviousRunFreeze(fakeDbPath)).toBeNull();
  });

  it('reports a RECOVERED freeze as a warning and fires no alert', () => {
    _writeFreezeMarkerForTest(fakeDbPath, {
      detected_at: '2026-06-10T04:31:00.000Z',
      recovered_at: '2026-06-10T04:32:10.000Z',
      frozen_for_ms: 70_000,
      active_operations: 'site-sync:connection-2 (started 2026-06-10T04:30:00.000Z)',
    });
    const alerts = [];
    checkPreviousRunFreeze(fakeDbPath, { fireAlert: (a) => alerts.push(a) });
    expect(logged[0].level).toBe('warn');
    expect(logged[0].message).toContain('recovered on its own');
    expect(alerts.length).toBe(0);
  });

  it('copes with an unparseable marker (still archives, still reports)', () => {
    writeFileSync(freezeMarkerPath(fakeDbPath), 'not json {{{');
    const parsed = checkPreviousRunFreeze(fakeDbPath, {});
    expect(parsed.unparseable).toBe(true);
    expect(logged.length).toBe(1);
    expect(existsSync(freezeMarkerPath(fakeDbPath))).toBe(false);
  });
});

describe('trackOp registry', () => {
  it('tracks and releases named operations', () => {
    const done = trackOp('test-op-alpha');
    expect(getActiveOps().some((o) => o.startsWith('test-op-alpha'))).toBe(true);
    done();
    expect(getActiveOps().some((o) => o.startsWith('test-op-alpha'))).toBe(false);
  });

  it('handles overlapping operations independently', () => {
    const d1 = trackOp('op-one');
    const d2 = trackOp('op-two');
    expect(getActiveOps().length).toBeGreaterThanOrEqual(2);
    d1();
    expect(getActiveOps().some((o) => o.startsWith('op-two'))).toBe(true);
    expect(getActiveOps().some((o) => o.startsWith('op-one'))).toBe(false);
    d2();
  });
});
