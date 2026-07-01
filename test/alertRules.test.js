// Tests for src/lib/alertRules.js — rule-level fire/resolve transitions.
// Same vi.mock approach as alertEngine.test.js (in-memory SQLite) plus a
// stub for the Sage health probe to keep batReconciliation.js out of the
// test bundle.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// In-memory DB seeded with both v60 (job_runs) and v61 (alerts) schemas.
// Tests reset rows in beforeEach so each test starts clean.
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

  CREATE TABLE alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_name TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('critical','warning','info')),
    message TEXT NOT NULL,
    context TEXT,
    dedup_key TEXT NOT NULL,
    fired_at TEXT NOT NULL,
    resolved_at TEXT,
    resolved_by TEXT
  );
  CREATE INDEX idx_alerts_active_dedup ON alerts(dedup_key) WHERE resolved_at IS NULL;

  CREATE TABLE jti_archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_year INTEGER NOT NULL,
    period_month INTEGER NOT NULL,
    source TEXT NOT NULL,
    generated_at TEXT
  );
`);

vi.mock('../src/db/index.js', () => ({
  default: memDb,
  dbPath: ':memory:',
}));

// Stub batReconciliation.js — the only thing alertRules imports from it
// is getSageHealth. Tests can override the return value per-test.
let _sageHealthStub = { ok: null, attention: false, downForMinutes: 0, consecutiveFailures: 0, lastError: null, lastOkAt: null, lastFailAt: null, lastProbeAt: null };
vi.mock('../src/services/batReconciliation.js', () => ({
  getSageHealth: () => _sageHealthStub,
}));

// Stub backupHealth.js — ruleBackupArtifactStale reads the real filesystem via
// computeBackupHealth(), which would otherwise find no backups dir under the
// test's cwd and fire a spurious alert in every other rule's test. Default to
// a healthy verdict; the ruleBackupArtifactStale describe block overrides it.
let _backupHealthStub = { status: 'ok', reason: 'ok', message: 'Backup is current.', last_backup_at: new Date().toISOString(), age_hours: 1, file: 'cardoso-site.db', total_backups: 3 };
vi.mock('../src/lib/backupHealth.js', () => ({
  computeBackupHealth: () => _backupHealthStub,
}));

// Stub the Kopia status reader + hub storage runtime. ruleKopiaSiteStale reads
// these; default to "disabled" so the rule no-ops in every other rule's test.
let _kopiaStatusStub = { enabled: false, ok: false, repo: { ok: true }, sites: [], error: null, stale_hours: 26 };
vi.mock('../src/services/hub/kopiaStatus.js', () => ({
  getKopiaStatus: async () => _kopiaStatusStub,
  isKopiaEnabled: () => _kopiaStatusStub.enabled,
}));
vi.mock('../src/hub/storage/runtime.js', () => ({
  getHubStorageRuntime: () => ({
    repository: { listSitesForBackup: () => [] },
    sqliteDb: { prepare: () => ({ all: () => [] }) },
  }),
}));

const { evaluateAllRules } = await import('../src/lib/alertRules.js');

beforeEach(() => {
  memDb.prepare('DELETE FROM job_runs').run();
  memDb.prepare('DELETE FROM alerts').run();
  memDb.prepare('DELETE FROM jti_archive').run();
  _sageHealthStub = { ok: null, attention: false, downForMinutes: 0, consecutiveFailures: 0, lastError: null, lastOkAt: null, lastFailAt: null, lastProbeAt: null };
  _backupHealthStub = { status: 'ok', reason: 'ok', message: 'Backup is current.', last_backup_at: new Date().toISOString(), age_hours: 1, file: 'cardoso-site.db', total_backups: 3 };
  _kopiaStatusStub = { enabled: false, ok: false, repo: { ok: true }, sites: [], error: null, stale_hours: 26 };
});

// Helper: insert a job_run row with a precise ISO started_at.
function seedRun(name, status, isoStartedAt, error_message = null) {
  memDb.prepare(`
    INSERT INTO job_runs (name, status, started_at, ended_at, duration_ms, error_message)
    VALUES (?, ?, ?, ?, 1000, ?)
  `).run(name, status, isoStartedAt, isoStartedAt, error_message);
}

describe('ruleJobFailureSpike — regression: stale same-day failures must NOT count', () => {
  it('counts only failures within the last hour, not earlier-today rows', async () => {
    // Three "fresh" failures (within the last hour) → should trigger spike
    // alert. Three "stale-but-same-day" failures (e.g. midnight today) →
    // must NOT bleed into the spike count.
    //
    // The bug being pinned: the original query used `datetime('now',
    // '-1 hour')` which returns a SPACE-separated SQLite-format string,
    // while started_at is stored as ISO with a 'T' separator. Lexical
    // text-compare meant 'T' (0x54) > ' ' (0x20), so any same-day row
    // appeared "newer than the cutoff" regardless of actual time.
    const now = Date.now();
    const tenMinAgo = new Date(now - 10 * 60 * 1000).toISOString();
    const fiveHoursAgoButSameDay = (() => {
      // Pick a time 5 hours ago, but force same UTC date string as 'now'
      // to make the stale-row-leak case concrete. Use 5h to be safely
      // outside the 1h window but inside the same calendar day.
      const d = new Date(now - 5 * 60 * 60 * 1000);
      // If it crosses a UTC date boundary, just use 30 min into "today" UTC.
      const today = new Date(now);
      if (d.toISOString().slice(0, 10) !== today.toISOString().slice(0, 10)) {
        return new Date(Date.UTC(
          today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(),
          0, 30, 0,
        )).toISOString();
      }
      return d.toISOString();
    })();

    // Three fresh fails (in window).
    seedRun('credit-logic-sync', 'failed', tenMinAgo, 'transient');
    seedRun('credit-logic-sync', 'failed', tenMinAgo, 'transient');
    seedRun('credit-logic-sync', 'failed', tenMinAgo, 'transient');

    // Three stale fails (same-day, older than 1h). With the bug they would
    // bleed into the count. With the fix they're correctly excluded.
    seedRun('credit-logic-sync', 'failed', fiveHoursAgoButSameDay, 'old');
    seedRun('credit-logic-sync', 'failed', fiveHoursAgoButSameDay, 'old');
    seedRun('credit-logic-sync', 'failed', fiveHoursAgoButSameDay, 'old');

    await evaluateAllRules();

    const alert = memDb.prepare("SELECT * FROM alerts WHERE dedup_key = 'job-failure-spike:credit-logic-sync'").get();
    expect(alert).toBeDefined();
    const ctx = JSON.parse(alert.context);
    // Critical assertion: count is 3 (only fresh), NOT 6 (fresh + stale).
    expect(ctx.failures).toBe(3);
  });

  it('does not fire when fewer than 3 fresh failures (even with old failures present)', async () => {
    const now = Date.now();
    const tenMinAgo = new Date(now - 10 * 60 * 1000).toISOString();
    const yesterday = new Date(now - 25 * 60 * 60 * 1000).toISOString();

    // Only 2 fresh — under the threshold.
    seedRun('hub-sync', 'failed', tenMinAgo);
    seedRun('hub-sync', 'failed', tenMinAgo);
    // Plenty of yesterday's fails — must not contribute to today's count.
    for (let i = 0; i < 10; i += 1) seedRun('hub-sync', 'failed', yesterday);

    await evaluateAllRules();

    const active = memDb.prepare("SELECT * FROM alerts WHERE resolved_at IS NULL").all();
    expect(active.find(a => a.dedup_key === 'job-failure-spike:hub-sync')).toBeUndefined();
  });

  it('auto-resolves a previously-spiking job when its failures roll out of the window', async () => {
    // Pre-existing active spike alert
    memDb.prepare(`
      INSERT INTO alerts (rule_name, severity, message, dedup_key, fired_at)
      VALUES ('job-failure-spike', 'warning', 'Job sync failed 5 times', 'job-failure-spike:sync', ?)
    `).run(new Date(Date.now() - 30 * 60 * 1000).toISOString());

    // No fresh failures in window — only old ones.
    const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 5; i += 1) seedRun('sync', 'failed', yesterday);

    await evaluateAllRules();

    const alert = memDb.prepare("SELECT * FROM alerts WHERE dedup_key = 'job-failure-spike:sync'").get();
    expect(alert.resolved_at).toBeTruthy();
    expect(alert.resolved_by).toBe('auto');
  });
});

describe('ruleSageDown', () => {
  it('fires critical alert when health.attention is true', async () => {
    _sageHealthStub = {
      ok: false, attention: true, downForMinutes: 7, consecutiveFailures: 7,
      lastError: 'ECONNREFUSED', lastOkAt: null, lastFailAt: new Date().toISOString(), lastProbeAt: new Date().toISOString(),
    };

    await evaluateAllRules();

    const alert = memDb.prepare("SELECT * FROM alerts WHERE dedup_key = 'sage-down'").get();
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('critical');
    expect(alert.message).toMatch(/7 min/);
    expect(alert.message).toMatch(/ECONNREFUSED/);
  });

  it('auto-resolves when sage comes back', async () => {
    _sageHealthStub = { ok: false, attention: true, downForMinutes: 6, consecutiveFailures: 6, lastError: 'ECONNREFUSED' };
    await evaluateAllRules();
    expect(memDb.prepare("SELECT resolved_at FROM alerts WHERE dedup_key = 'sage-down'").get().resolved_at).toBeNull();

    _sageHealthStub = { ok: true, attention: false, downForMinutes: 0, consecutiveFailures: 0 };
    await evaluateAllRules();
    expect(memDb.prepare("SELECT resolved_at FROM alerts WHERE dedup_key = 'sage-down'").get().resolved_at).toBeTruthy();
  });

  it('does NOT touch alert state when health.ok is null (never probed)', async () => {
    _sageHealthStub = { ok: null, attention: false };
    await evaluateAllRules();
    expect(memDb.prepare("SELECT COUNT(*) c FROM alerts").get().c).toBe(0);
  });
});

describe('ruleBackupVerifyFailed', () => {
  it('fires when latest backup-verify run is failed', async () => {
    seedRun('backup-verify', 'failed', new Date().toISOString(), 'integrity_check_failed');
    await evaluateAllRules();
    const alert = memDb.prepare("SELECT * FROM alerts WHERE dedup_key = 'backup-verify-failed'").get();
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('critical');
  });

  it('auto-resolves on the next successful run', async () => {
    seedRun('backup-verify', 'failed', new Date(Date.now() - 60_000).toISOString(), 'stale_latest');
    await evaluateAllRules();
    expect(memDb.prepare("SELECT resolved_at FROM alerts WHERE dedup_key = 'backup-verify-failed'").get().resolved_at).toBeNull();

    seedRun('backup-verify', 'succeeded', new Date().toISOString());
    await evaluateAllRules();
    expect(memDb.prepare("SELECT resolved_at FROM alerts WHERE dedup_key = 'backup-verify-failed'").get().resolved_at).toBeTruthy();
  });

  it('skips silently when job_runs has no backup-verify rows', async () => {
    await evaluateAllRules();
    expect(memDb.prepare("SELECT COUNT(*) c FROM alerts").get().c).toBe(0);
  });
});

describe('ruleBackupArtifactStale', () => {
  it('fires critical when no backups exist on disk', async () => {
    _backupHealthStub = { status: 'critical', reason: 'no_backups', message: 'No backup files exist.', last_backup_at: null, age_hours: null, file: null, total_backups: 0 };
    await evaluateAllRules();
    const alert = memDb.prepare("SELECT * FROM alerts WHERE dedup_key = 'backup-artifact-stale'").get();
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('critical');
    expect(alert.message).toMatch(/No backup files/);
  });

  it('fires critical when the newest backup is stale', async () => {
    _backupHealthStub = { status: 'critical', reason: 'stale', message: 'Newest backup is 30.0h old', last_backup_at: new Date().toISOString(), age_hours: 30, file: 'old.db', total_backups: 4 };
    await evaluateAllRules();
    const alert = memDb.prepare("SELECT * FROM alerts WHERE dedup_key = 'backup-artifact-stale'").get();
    expect(alert).toBeDefined();
    expect(JSON.parse(alert.context).reason).toBe('stale');
  });

  it('does NOT fire (and resolves) on a healthy verdict', async () => {
    // Seed an active alert, then a healthy verdict should auto-resolve it.
    _backupHealthStub = { status: 'critical', reason: 'no_backups', message: 'gone', total_backups: 0 };
    await evaluateAllRules();
    expect(memDb.prepare("SELECT resolved_at FROM alerts WHERE dedup_key = 'backup-artifact-stale'").get().resolved_at).toBeNull();

    _backupHealthStub = { status: 'ok', reason: 'ok', message: 'current', age_hours: 1, file: 'x.db', total_backups: 3 };
    await evaluateAllRules();
    expect(memDb.prepare("SELECT resolved_at FROM alerts WHERE dedup_key = 'backup-artifact-stale'").get().resolved_at).toBeTruthy();
  });

  it('does NOT fire on verify_failed (owned by ruleBackupVerifyFailed) or unverified warn', async () => {
    _backupHealthStub = { status: 'critical', reason: 'verify_failed', message: 'verify failed', age_hours: 1, file: 'x.db', total_backups: 3 };
    await evaluateAllRules();
    expect(memDb.prepare("SELECT COUNT(*) c FROM alerts WHERE dedup_key = 'backup-artifact-stale'").get().c).toBe(0);

    _backupHealthStub = { status: 'warn', reason: 'unverified', message: 'unverified', age_hours: 1, file: 'x.db', total_backups: 3 };
    await evaluateAllRules();
    expect(memDb.prepare("SELECT COUNT(*) c FROM alerts WHERE dedup_key = 'backup-artifact-stale'").get().c).toBe(0);
  });

  it('skips entirely on the hub', async () => {
    _backupHealthStub = { status: 'critical', reason: 'no_backups', message: 'gone', total_backups: 0 };
    const prev = process.env.HUB_MODE;
    process.env.HUB_MODE = 'true';
    try {
      await evaluateAllRules();
      expect(memDb.prepare("SELECT COUNT(*) c FROM alerts WHERE dedup_key = 'backup-artifact-stale'").get().c).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.HUB_MODE; else process.env.HUB_MODE = prev;
    }
  });
});

describe('ruleNightlySyncStale', () => {
  const HOURS = 3_600_000;

  it('fires when the last success is older than 26h and the latest attempt failed', async () => {
    seedRun('creditors-sync', 'succeeded', new Date(Date.now() - 29 * HOURS).toISOString());
    seedRun('creditors-sync', 'failed', new Date(Date.now() - 5 * HOURS).toISOString(), 'Sage pool timeout');
    await evaluateAllRules();
    const alert = memDb.prepare("SELECT * FROM alerts WHERE dedup_key = 'nightly-sync-stale:creditors-sync'").get();
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('warning');
    expect(alert.message).toContain('Sage pool timeout');
    expect(alert.message).toContain('29.0 hours ago');
  });

  it('fires for the machine-off case — old success, no attempt since', async () => {
    // Only one row: a success 29h ago. No failed row exists because the
    // 4am cron never fired (machine off) — the exact case job-failure
    // rules can never see.
    seedRun('debtors-sync', 'succeeded', new Date(Date.now() - 29 * HOURS).toISOString());
    await evaluateAllRules();
    const alert = memDb.prepare("SELECT * FROM alerts WHERE dedup_key = 'nightly-sync-stale:debtors-sync'").get();
    expect(alert).toBeDefined();
    expect(alert.message).toContain('never fired');
  });

  it('does not fire when the data is fresh, and auto-resolves an active alert', async () => {
    seedRun('creditors-sync', 'succeeded', new Date(Date.now() - 29 * HOURS).toISOString());
    await evaluateAllRules();
    expect(memDb.prepare("SELECT resolved_at FROM alerts WHERE dedup_key = 'nightly-sync-stale:creditors-sync'").get().resolved_at).toBeNull();

    // A retry (or catch-up) succeeds → data fresh → alert resolves.
    seedRun('creditors-sync', 'succeeded', new Date().toISOString());
    await evaluateAllRules();
    expect(memDb.prepare("SELECT resolved_at FROM alerts WHERE dedup_key = 'nightly-sync-stale:creditors-sync'").get().resolved_at).toBeTruthy();
  });

  it('never-attempted jobs (fresh install) do not alert', async () => {
    await evaluateAllRules();
    expect(memDb.prepare("SELECT COUNT(*) c FROM alerts WHERE dedup_key LIKE 'nightly-sync-stale:%'").get().c).toBe(0);
  });

  it('skips entirely on the hub (site-mode jobs)', async () => {
    seedRun('creditors-sync', 'succeeded', new Date(Date.now() - 40 * HOURS).toISOString());
    const prev = process.env.HUB_MODE;
    process.env.HUB_MODE = 'true';
    try {
      await evaluateAllRules();
      expect(memDb.prepare("SELECT COUNT(*) c FROM alerts WHERE dedup_key LIKE 'nightly-sync-stale:%'").get().c).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.HUB_MODE; else process.env.HUB_MODE = prev;
    }
  });
});

describe('ruleKopiaSiteStale (hub-only)', () => {
  let prevHub;
  beforeEach(() => { prevHub = process.env.HUB_MODE; process.env.HUB_MODE = 'true'; });
  afterEach(() => { if (prevHub === undefined) delete process.env.HUB_MODE; else process.env.HUB_MODE = prevHub; });

  it('does nothing when Kopia is disabled', async () => {
    _kopiaStatusStub = { enabled: false, sites: [], error: null, stale_hours: 26 };
    await evaluateAllRules();
    expect(memDb.prepare("SELECT COUNT(*) c FROM alerts").get().c).toBe(0);
  });

  it('does nothing on the site (HUB_MODE != true)', async () => {
    process.env.HUB_MODE = 'false';
    _kopiaStatusStub = { enabled: true, error: null, stale_hours: 26, sites: [
      { site: 'Ermelo', site_id: 'tok1', site_name: 'Ermelo', status: 'critical', reason: 'stale', age_hours: 40, count: 1 },
    ] };
    await evaluateAllRules();
    expect(memDb.prepare("SELECT COUNT(*) c FROM alerts WHERE dedup_key LIKE 'kopia-%'").get().c).toBe(0);
  });

  it('fires per stale site, leaves healthy sites alone', async () => {
    _kopiaStatusStub = { enabled: true, error: null, stale_hours: 26, sites: [
      { site: 'Ermelo', site_id: 'tok1', site_name: 'Ermelo', status: 'critical', reason: 'stale', age_hours: 40, last_snapshot_at: '2026-06-28T00:00:00Z', count: 3 },
      { site: 'JHB', site_id: 'tok2', site_name: 'JHB', status: 'ok', reason: 'ok', age_hours: 2, count: 5 },
    ] };
    await evaluateAllRules();
    const a = memDb.prepare("SELECT * FROM alerts WHERE dedup_key = 'kopia-site-stale:tok1'").get();
    expect(a).toBeDefined();
    expect(a.severity).toBe('critical');
    expect(memDb.prepare("SELECT COUNT(*) c FROM alerts WHERE dedup_key='kopia-site-stale:tok2'").get().c).toBe(0);
  });

  it('reports a never-snapshotted site distinctly', async () => {
    _kopiaStatusStub = { enabled: true, error: null, stale_hours: 26, sites: [
      { site: 'Newcastle', site_id: 'tok3', site_name: 'Newcastle', status: 'critical', reason: 'never', age_hours: null, count: 0 },
    ] };
    await evaluateAllRules();
    const a = memDb.prepare("SELECT * FROM alerts WHERE dedup_key = 'kopia-site-stale:tok3'").get();
    expect(a.message).toMatch(/ever reached the hub/);
    expect(JSON.parse(a.context).reason).toBe('never');
  });

  it('auto-resolves a site that becomes healthy again', async () => {
    _kopiaStatusStub = { enabled: true, error: null, stale_hours: 26, sites: [
      { site: 'Ermelo', site_id: 'tok1', site_name: 'Ermelo', status: 'critical', reason: 'stale', age_hours: 40, count: 1 },
    ] };
    await evaluateAllRules();
    expect(memDb.prepare("SELECT resolved_at FROM alerts WHERE dedup_key='kopia-site-stale:tok1'").get().resolved_at).toBeNull();

    _kopiaStatusStub = { enabled: true, error: null, stale_hours: 26, sites: [
      { site: 'Ermelo', site_id: 'tok1', site_name: 'Ermelo', status: 'ok', reason: 'ok', age_hours: 2, count: 2 },
    ] };
    await evaluateAllRules();
    expect(memDb.prepare("SELECT resolved_at FROM alerts WHERE dedup_key='kopia-site-stale:tok1'").get().resolved_at).toBeTruthy();
  });

  it('fires kopia-repo-error when the repo/binary is unreachable', async () => {
    _kopiaStatusStub = { enabled: true, error: 'kopia snapshot list failed: connection refused', sites: [], stale_hours: 26 };
    await evaluateAllRules();
    const a = memDb.prepare("SELECT * FROM alerts WHERE dedup_key = 'kopia-repo-error'").get();
    expect(a).toBeDefined();
    expect(a.severity).toBe('critical');
  });

  it('does NOT alert on a stale unknown-host row (retired site leftovers)', async () => {
    // site_id=null = a host in the repo that is no longer a known site (retired).
    // Its old snapshots aging out must not fire a perpetual alert.
    _kopiaStatusStub = { enabled: true, error: null, stale_hours: 26, sites: [
      { site: 'oldshop', site_id: null, site_name: null, status: 'critical', reason: 'stale', age_hours: 200, count: 2 },
    ] };
    await evaluateAllRules();
    expect(memDb.prepare("SELECT COUNT(*) c FROM alerts WHERE dedup_key LIKE 'kopia-site-stale:%'").get().c).toBe(0);
  });
});

describe('ruleJtiExportMissing', () => {
  // Pin the clock so previousMonth is deterministic (June 2026) and we're past
  // the 1st-of-month heal window. Mid-month 08:00 local.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T08:00:00'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Seed a jti_archive row. generated_at is a fixed past timestamp; only
  // (period_year, period_month, source) matter to the rule.
  function seedArchive(year, month, source = 'scheduled') {
    memDb.prepare(
      "INSERT INTO jti_archive (period_year, period_month, source, generated_at) VALUES (?, ?, ?, '2026-01-01 00:00:00')",
    ).run(year, month, source);
  }

  it('fires a warning when the previous month has no scheduled archive on a JTI site', async () => {
    // Site IS a JTI site (has produced scheduled archives before) but June is missing.
    seedArchive(2026, 5, 'scheduled'); // May present → proves this is a JTI site
    await evaluateAllRules();
    const alert = memDb.prepare("SELECT * FROM alerts WHERE dedup_key = 'jti-export-missing' AND resolved_at IS NULL").get();
    expect(alert).toBeDefined();
    expect(alert.severity).toBe('warning');
    expect(alert.message).toMatch(/2026-06/);
    expect(JSON.parse(alert.context).period).toBe('2026-06');
  });

  it('surfaces the skip reason from the most recent generation attempt', async () => {
    seedArchive(2026, 5, 'scheduled');
    // A generation attempt that "succeeded" as a job but skipped on pool_unavailable —
    // the reason rides in the run context. This is the silent-skip the rule exists to unmask.
    memDb.prepare(`
      INSERT INTO job_runs (name, status, started_at, ended_at, context)
      VALUES ('jti-generation-retry', 'succeeded', '2026-07-15T07:00:00.000Z', '2026-07-15T07:00:01.000Z', ?)
    `).run(JSON.stringify({ failed: { year: 2026, month: 6, error: 'pool_unavailable: ECONNREFUSED' } }));
    await evaluateAllRules();
    const alert = memDb.prepare("SELECT * FROM alerts WHERE dedup_key = 'jti-export-missing' AND resolved_at IS NULL").get();
    expect(alert).toBeDefined();
    expect(alert.message).toMatch(/pool_unavailable: ECONNREFUSED/);
  });

  it('does NOT fire (and auto-resolves) when the previous month IS archived', async () => {
    seedArchive(2026, 5, 'scheduled');
    seedArchive(2026, 6, 'scheduled'); // June present
    // Pre-existing active alert to prove auto-resolve.
    memDb.prepare(`
      INSERT INTO alerts (rule_name, severity, message, dedup_key, fired_at)
      VALUES ('jti-export-missing', 'warning', 'stale', 'jti-export-missing', '2026-07-10T00:00:00.000Z')
    `).run();
    await evaluateAllRules();
    const alert = memDb.prepare("SELECT * FROM alerts WHERE dedup_key = 'jti-export-missing'").get();
    expect(alert.resolved_at).toBeTruthy();
    expect(alert.resolved_by).toBe('auto');
  });

  it('does NOT fire on a site that has never produced a scheduled archive (not a JTI site)', async () => {
    // jti_archive empty → not a JTI site / brand new. No nagging.
    await evaluateAllRules();
    expect(memDb.prepare("SELECT COUNT(*) c FROM alerts WHERE dedup_key = 'jti-export-missing'").get().c).toBe(0);
  });

  it('holds off during the 1st-of-month heal window (before 10:00 on the 1st)', async () => {
    vi.setSystemTime(new Date('2026-07-01T08:00:00')); // 1st, pre-heal-window
    seedArchive(2026, 5, 'scheduled'); // June (prev month) genuinely missing, but too early to complain
    await evaluateAllRules();
    expect(memDb.prepare("SELECT COUNT(*) c FROM alerts WHERE dedup_key = 'jti-export-missing'").get().c).toBe(0);
  });
});
