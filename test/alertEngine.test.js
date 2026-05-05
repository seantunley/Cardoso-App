// Tests for src/lib/alertEngine.js — the dedup/persistence half of the
// alert system. Rule logic lives in alertRules.js and is tested with
// the same in-memory shim. Same approach as jobRunner.test.js: vi.mock
// the db module and seed an in-memory SQLite with the migration v61
// schema.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
memDb.exec(`
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
  CREATE INDEX idx_alerts_fired ON alerts(fired_at DESC);
`);

vi.mock('../src/db/index.js', () => ({
  default: memDb,
  dbPath: ':memory:',
}));

const {
  fireAlert,
  resolveAlerts,
  acknowledgeAlert,
  getActiveAlerts,
  getAllAlerts,
  pruneResolvedAlerts,
} = await import('../src/lib/alertEngine.js');

beforeEach(() => {
  memDb.prepare('DELETE FROM alerts').run();
});

describe('fireAlert', () => {
  it('inserts a new active row on first fire', () => {
    const r = fireAlert({
      ruleName: 'sage-down',
      severity: 'critical',
      message: 'Sage unreachable',
      context: { downForMinutes: 6 },
      dedupKey: 'sage-down',
    });
    expect(r.deduped).toBe(false);
    expect(r.id).toBeGreaterThan(0);

    const rows = memDb.prepare('SELECT * FROM alerts').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].rule_name).toBe('sage-down');
    expect(rows[0].severity).toBe('critical');
    expect(rows[0].resolved_at).toBeNull();
    expect(JSON.parse(rows[0].context).downForMinutes).toBe(6);
  });

  it('is idempotent on dedup_key while an active row exists', () => {
    const a = fireAlert({ ruleName: 'sage-down', severity: 'critical', message: 'm1', dedupKey: 'sage-down' });
    const b = fireAlert({ ruleName: 'sage-down', severity: 'critical', message: 'm2', dedupKey: 'sage-down' });
    const c = fireAlert({ ruleName: 'sage-down', severity: 'critical', message: 'm3', dedupKey: 'sage-down' });
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(c.deduped).toBe(true);
    expect(memDb.prepare('SELECT COUNT(*) c FROM alerts').get().c).toBe(1);
  });

  it('fires a NEW row after the previous one is resolved', () => {
    fireAlert({ ruleName: 'sage-down', severity: 'critical', message: 'first outage', dedupKey: 'sage-down' });
    resolveAlerts('sage-down', 'auto');
    fireAlert({ ruleName: 'sage-down', severity: 'critical', message: 'second outage', dedupKey: 'sage-down' });

    const rows = memDb.prepare('SELECT * FROM alerts ORDER BY id').all();
    expect(rows).toHaveLength(2);
    expect(rows[0].resolved_at).toBeTruthy();
    expect(rows[1].resolved_at).toBeNull();
  });

  it('throws on invalid severity', () => {
    expect(() => fireAlert({ ruleName: 'x', severity: 'BANG', message: 'm', dedupKey: 'k' }))
      .toThrow(/Invalid alert severity/);
  });

  it('throws when dedupKey is missing', () => {
    expect(() => fireAlert({ ruleName: 'x', severity: 'critical', message: 'm' }))
      .toThrow(/without dedupKey/);
  });
});

describe('resolveAlerts', () => {
  it('marks all matching active alerts resolved with the given resolver', () => {
    fireAlert({ ruleName: 'sage-down', severity: 'critical', message: 'm', dedupKey: 'sage-down' });
    const changes = resolveAlerts('sage-down', 'auto');
    expect(changes).toBe(1);
    const row = memDb.prepare('SELECT * FROM alerts').get();
    expect(row.resolved_at).toBeTruthy();
    expect(row.resolved_by).toBe('auto');
  });

  it('is a no-op when no active alert matches', () => {
    expect(resolveAlerts('nonexistent', 'auto')).toBe(0);
  });

  it('does NOT touch already-resolved rows', () => {
    fireAlert({ ruleName: 'sage-down', severity: 'critical', message: 'm', dedupKey: 'sage-down' });
    resolveAlerts('sage-down', 'auto');
    const before = memDb.prepare('SELECT resolved_at FROM alerts').get();
    // Re-resolving shouldn't change resolved_at
    expect(resolveAlerts('sage-down', 'admin')).toBe(0);
    const after = memDb.prepare('SELECT resolved_at FROM alerts').get();
    expect(after.resolved_at).toBe(before.resolved_at);
  });
});

describe('acknowledgeAlert', () => {
  it('resolves a single alert by id with the provided resolver', () => {
    const { id } = fireAlert({ ruleName: 'x', severity: 'warning', message: 'm', dedupKey: 'k' });
    expect(acknowledgeAlert(id, 'admin:ops@cardoso.co.za')).toBe(1);
    const row = memDb.prepare('SELECT * FROM alerts WHERE id = ?').get(id);
    expect(row.resolved_at).toBeTruthy();
    expect(row.resolved_by).toBe('admin:ops@cardoso.co.za');
  });

  it('returns 0 when the id does not exist', () => {
    expect(acknowledgeAlert(99999, 'admin')).toBe(0);
  });
});

describe('getActiveAlerts / getAllAlerts', () => {
  it('getActiveAlerts returns only unresolved, newest first, with parsed context', () => {
    fireAlert({ ruleName: 'a', severity: 'info', message: 'm1', context: { x: 1 }, dedupKey: 'a' });
    fireAlert({ ruleName: 'b', severity: 'critical', message: 'm2', dedupKey: 'b' });
    resolveAlerts('a');

    const active = getActiveAlerts();
    expect(active).toHaveLength(1);
    expect(active[0].rule_name).toBe('b');
    expect(active[0].context).toBeNull();
  });

  it('getAllAlerts includes resolved within window and parses context', () => {
    fireAlert({ ruleName: 'a', severity: 'info', message: 'm', context: { foo: 'bar' }, dedupKey: 'a' });
    resolveAlerts('a');
    fireAlert({ ruleName: 'b', severity: 'critical', message: 'm', dedupKey: 'b' });

    const all = getAllAlerts();
    expect(all).toHaveLength(2);
    const found = all.find(a => a.rule_name === 'a');
    expect(found.context).toEqual({ foo: 'bar' });
    expect(found.resolved_at).toBeTruthy();
  });
});

describe('pruneResolvedAlerts', () => {
  it('drops resolved rows older than the cutoff, keeps active and recent resolved', () => {
    // Synthetic ancient resolved alert
    memDb.prepare(`
      INSERT INTO alerts (rule_name, severity, message, dedup_key, fired_at, resolved_at, resolved_by)
      VALUES ('ancient', 'info', 'old', 'ancient', '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z', 'auto')
    `).run();
    fireAlert({ ruleName: 'recent-active', severity: 'critical', message: 'm', dedupKey: 'recent-active' });
    fireAlert({ ruleName: 'recent-resolved', severity: 'info', message: 'm', dedupKey: 'recent-resolved' });
    resolveAlerts('recent-resolved');

    const pruned = pruneResolvedAlerts(30);
    expect(pruned).toBe(1);
    const remaining = memDb.prepare('SELECT rule_name FROM alerts ORDER BY rule_name').all().map(r => r.rule_name);
    expect(remaining).toEqual(['recent-active', 'recent-resolved']);
  });
});
