// v111: "Paid in full" records that 2026.5.14 created when the sync cleared a
// customer Sage stopped returning are corrected, but ONLY with positive evidence
// of that clear. Timing alone is not used: a clear can come minutes after the
// last Sage update, and a real payment can be found by a delayed Collections
// scan. Anything that only partly looks like a clear is left alone and reported.

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
  m111 = (await import('../src/db/migrations/v111_collections_relabel_sync_cleared_payments.js')).default;
});

// What the clear writes, vs what a Sage-returned zero-balance customer looks like.
const CLEARED = { outstanding_balance: '0', age_current: '0', age_7_days: '0', age_14_days: '0', age_21_days: '0', age_analysis: '', unpaid_invoices: '[]' };
const SAGE_ZERO = { outstanding_balance: '0', age_current: '', age_7_days: '', age_14_days: '', age_21_days: '', age_analysis: '', unpaid_invoices: '[]' };

const syncRun = (start, end, message) => memDb.prepare("INSERT INTO syncrun (connection_id, started_at, completed_at, status, message) VALUES (1, ?, ?, 'completed', ?)").run(start, end, message);

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
  return asg;
}
const acts = (asg) => memDb.prepare('SELECT kind, amount, previous_balance, notes FROM collection_activity WHERE assignment_id = ? ORDER BY id').all(asg);
const asgRow = (asg) => memDb.prepare('SELECT status, closed_reason FROM collection_assignment WHERE id = ?').get(asg);
const untouched = (asg) => {
  expect(asgRow(asg).status).toBe('collected');
  expect(acts(asg)[0]).toMatchObject({ kind: 'payment_received', amount: 5000 });
};

it('corrects only proven false payments; leaves and reports uncertain ones', () => {
  syncRun('2026-11-09T08:05:00.000Z', '2026-11-09T08:05:09.000Z', 'Synced 6 590 customer rows from Sage: 0 new, 3 updated, 6 586 unchanged, 1 no longer in Sage (balances cleared).');
  syncRun('2026-11-09T08:30:00.000Z', '2026-11-09T08:30:09.000Z', 'Synced 6 589 customer rows from Sage: 0 new, 1 updated, 6 587 unchanged, 1 no longer in Sage (balances cleared).');

  // A. False payment, cleared only 5 minutes after Sage last updated the customer.
  const a = oldAutoCollect('A', CLEARED, { syncedAt: '2026-11-09T08:00:01.000Z', updatedAt: '2026-11-09T08:05:01.000Z', paidAt: '2026-11-09 08:05:09' });
  // B. Real payment, Sage returned the customer at 08:00; found by the Collections button 2.5h later.
  const b = oldAutoCollect('B', SAGE_ZERO, { syncedAt: '2026-11-09T08:00:02.000Z', updatedAt: '2026-11-09T08:00:02.000Z', paidAt: '2026-11-09 10:30:00' });
  // C. Real payment found late; the row's updated_date was later moved by an auto-flag change inside a run that cleared someone else.
  const c = oldAutoCollect('C', SAGE_ZERO, { syncedAt: '2026-11-09T08:00:02.000Z', updatedAt: '2026-11-09T08:30:01.000Z', paidAt: '2026-11-09 10:30:00' });
  // D. Looks exactly like a clear, but no sync run record covers it (e.g. history pruned).
  const d = oldAutoCollect('D', CLEARED, { syncedAt: '2026-11-08T08:00:00.000Z', updatedAt: '2026-11-09T12:00:01.000Z', paidAt: '2026-11-09 12:00:09' });
  // E. Before 2026.5.14 shipped.
  const e = oldAutoCollect('E', CLEARED, { syncedAt: '2026-11-01T08:00:00.000Z', updatedAt: '2026-11-08T09:00:00.000Z', paidAt: '2026-11-08 09:00:05' });

  m111.up(memDb);

  expect(asgRow(a)).toMatchObject({ status: 'closed', closed_reason: expect.stringMatching(/no longer in Sage/) });
  expect(acts(a)).toMatchObject([
    { kind: 'note', amount: null, previous_balance: 5000, notes: expect.stringMatching(/no payment was made/) },
    { kind: 'status_changed', notes: expect.stringMatching(/^active → closed: Customer no longer in Sage/) },
  ]);
  for (const asg of [b, c, d, e]) untouched(asg);

  const report = memDb.prepare("SELECT level, message, context FROM error_log WHERE source = 'migration.v111.collections_review'").all();
  expect(report).toHaveLength(1);
  expect(report[0].level).toBe('warn');
  const listed = JSON.parse(report[0].context).map((r) => r.customer_number);
  expect(listed.sort()).toEqual(['C', 'D']); // uncertain ones; the plain real payment B isn't flagged
});
