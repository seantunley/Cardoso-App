// v111 REPORTS suspect "Paid in full" records from 2026.5.14 and changes
// nothing. 5.14 didn't record which customers it cleared, so no evidence left in
// the database can prove a specific record wasn't a real payment (see the
// reviewer's case R below, which passes every check yet is a real payment).

import { it, expect, vi, beforeAll } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
memDb.function('now_local', () => new Date().toISOString());
vi.mock('../src/db/index.js', () => ({ default: memDb, dbPath: ':memory:' }));

let m111;
beforeAll(async () => {
  delete process.env.HUB_MODE;
  (await import('../src/db/batSchema.js')).initBatSchema(memDb);
  (await import('../src/db/schema.js')).initSchema(memDb);
  (await import('../src/db/migrations.js')).runMigrations(memDb);
  m111 = (await import('../src/db/migrations/v111_collections_review_sync_cleared_payments.js')).default;
});

const CLEARED = { outstanding_balance: '0', age_current: '0', age_7_days: '0', age_14_days: '0', age_21_days: '0', age_analysis: '', unpaid_invoices: '[]' };
const SAGE_ZERO = { ...CLEARED, age_current: '', age_7_days: '', age_14_days: '', age_21_days: '' };

const syncRun = (start, end) => memDb.prepare("INSERT INTO syncrun (connection_id, started_at, completed_at, status, message) VALUES (1, ?, ?, 'completed', ?)")
  .run(start, end, 'Synced 6 590 customer rows from Sage: 0 new, 3 updated, 6 586 unchanged, 1 no longer in Sage (balances cleared).');

// A customer plus the rows 2026.5.14 wrote when its balance reached zero.
function oldAutoCollect(num, row, { syncedAt, updatedAt, paidAt }) {
  const cust = memDb.prepare(`INSERT INTO datarecord (customer_number, customer_name, outstanding_balance, age_current, age_7_days, age_14_days, age_21_days,
      age_analysis, unpaid_invoices, synced_at, updated_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(num, `Cust ${num}`, row.outstanding_balance, row.age_current, row.age_7_days, row.age_14_days, row.age_21_days, row.age_analysis, row.unpaid_invoices, syncedAt, updatedAt).lastInsertRowid;
  const wl = memDb.prepare("INSERT INTO collection_worklist (name) VALUES ('Overdue')").run().lastInsertRowid;
  const asg = memDb.prepare("INSERT INTO collection_assignment (worklist_id, customer_id, status, closed_at, last_known_balance) VALUES (?, ?, 'collected', ?, 0)")
    .run(wl, String(cust), paidAt).lastInsertRowid;
  memDb.prepare(`INSERT INTO collection_activity (customer_id, assignment_id, kind, amount, previous_balance, new_balance, notes, source, at)
    VALUES (?, ?, 'payment_received', 5000, 5000, 0, 'Paid in full (auto-detected from sync)', 'sync', ?)`).run(String(cust), asg, paidAt);
  memDb.prepare(`INSERT INTO collection_activity (customer_id, assignment_id, kind, notes, source, at)
    VALUES (?, ?, 'status_changed', 'Auto-collected — balance reached zero', 'sync', ?)`).run(String(cust), asg, paidAt);
}
const snapshot = () => JSON.stringify([
  memDb.prepare('SELECT * FROM collection_activity ORDER BY id').all(),
  memDb.prepare('SELECT * FROM collection_assignment ORDER BY id').all(),
]);

it('lists suspect records for review and changes nothing', () => {
  syncRun('2026-11-09T08:05:00.000Z', '2026-11-09T08:05:09.000Z');
  syncRun('2026-11-09T08:30:00.000Z', '2026-11-09T08:30:09.000Z');

  // A. False payment: cleared 5 minutes after Sage last updated the customer.
  oldAutoCollect('A', CLEARED, { syncedAt: '2026-11-09T08:00:01.000Z', updatedAt: '2026-11-09T08:05:01.000Z', paidAt: '2026-11-09 08:05:09' });
  // R. Reviewer's case, a REAL payment: Sage returned a zero balance with all-zero buckets; a later run that cleared
  //    a different customer changed R's auto-flag (updated_date moves, synced_at doesn't); a delayed check logs the payment.
  oldAutoCollect('R', CLEARED, { syncedAt: '2026-11-09T08:00:02.000Z', updatedAt: '2026-11-09T08:30:01.000Z', paidAt: '2026-11-09 10:30:00' });
  // B. Ordinary real payment found late by the Collections button.
  oldAutoCollect('B', SAGE_ZERO, { syncedAt: '2026-11-09T08:00:02.000Z', updatedAt: '2026-11-09T08:00:02.000Z', paidAt: '2026-11-09 10:30:00' });
  // D. Looks cleared, but no sync run covers it.
  oldAutoCollect('D', CLEARED, { syncedAt: '2026-11-08T08:00:00.000Z', updatedAt: '2026-11-09T12:00:01.000Z', paidAt: '2026-11-09 12:00:09' });
  // E. Before 2026.5.14 shipped.
  oldAutoCollect('E', CLEARED, { syncedAt: '2026-11-01T08:00:00.000Z', updatedAt: '2026-11-08T09:00:00.000Z', paidAt: '2026-11-08 09:00:05' });

  const before = snapshot();
  m111.up(memDb);
  expect(snapshot()).toBe(before); // no Collections record changed, not even the false one

  const report = memDb.prepare("SELECT level, message, context FROM error_log WHERE source = 'migration.v111.collections_review'").all();
  expect(report).toHaveLength(1);
  expect(report[0].level).toBe('warn');
  expect(report[0].message).toMatch(/Nothing was changed automatically/);
  const byGroup = JSON.parse(report[0].context).reduce((m, r) => ({ ...m, [r.group]: [...(m[r.group] || []), r.customer_number].sort() }), {});
  expect(byGroup).toEqual({ likely: ['A', 'R'], possible: ['D'] }); // B (plain real payment) and E (pre-5.14) not listed
});

it('writes nothing when there is nothing to check', () => {
  memDb.exec("DELETE FROM collection_activity; DELETE FROM error_log WHERE source = 'migration.v111.collections_review';");
  m111.up(memDb);
  expect(memDb.prepare("SELECT COUNT(*) AS n FROM error_log WHERE source = 'migration.v111.collections_review'").get().n).toBe(0);
});
