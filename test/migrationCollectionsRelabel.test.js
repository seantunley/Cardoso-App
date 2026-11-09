// v111: on sites that ran 2026.5.14 before #607, "Paid in full" records created
// when the sync cleared a customer Sage stopped returning become notes, and the
// assignment goes from Collected to Closed. Real payments are left alone.

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

// What 2026.5.14 wrote when a balance reached zero in a sync.
function oldAutoCollect(customerNumber, { syncedAt, at, balance }) {
  const cust = memDb.prepare("INSERT INTO datarecord (customer_number, outstanding_balance, unpaid_invoices, synced_at) VALUES (?, ?, '[]', ?)")
    .run(customerNumber, balance, syncedAt).lastInsertRowid;
  const wl = memDb.prepare("INSERT INTO collection_worklist (name) VALUES ('Overdue')").run().lastInsertRowid;
  const asg = memDb.prepare("INSERT INTO collection_assignment (worklist_id, customer_id, status, closed_at, last_known_balance) VALUES (?, ?, 'collected', ?, 0)")
    .run(wl, String(cust), at).lastInsertRowid;
  const act = memDb.prepare(`INSERT INTO collection_activity (customer_id, assignment_id, kind, amount, previous_balance, new_balance, notes, source, at)
    VALUES (?, ?, 'payment_received', 5000, 5000, 0, 'Paid in full (auto-detected from sync)', 'sync', ?)`);
  act.run(String(cust), asg, at);
  memDb.prepare(`INSERT INTO collection_activity (customer_id, assignment_id, kind, notes, source, at)
    VALUES (?, ?, 'status_changed', 'Auto-collected — balance reached zero', 'sync', ?)`).run(String(cust), asg, at);
  return asg;
}
const acts = (asg) => memDb.prepare('SELECT kind, amount, previous_balance, notes FROM collection_activity WHERE assignment_id = ? ORDER BY id').all(asg);
const asgRow = (asg) => memDb.prepare('SELECT status, closed_reason FROM collection_assignment WHERE id = ?').get(asg);

it('relabels false payments from cleared customers and leaves real payments alone', () => {
  // Cleared: Sage last returned this customer 3 days before the "payment".
  const cleared = oldAutoCollect('GONE', { syncedAt: '2026-11-06T08:00:00.000Z', at: '2026-11-09 08:05:12', balance: '0' });
  // Real: paid in the same sync that saw it (synced_at seconds before the payment row).
  const paid = oldAutoCollect('PAID', { syncedAt: '2026-11-09T08:05:05.000Z', at: '2026-11-09 08:05:12', balance: '0' });
  // Before 5.14 shipped: not touched even though it looks similar.
  const older = oldAutoCollect('OLD', { syncedAt: '2026-10-01T08:00:00.000Z', at: '2026-11-08 09:00:00', balance: '0' });

  m111.up(memDb);
  m111.up(memDb); // safe to run twice

  expect(asgRow(cleared)).toMatchObject({ status: 'closed', closed_reason: expect.stringMatching(/no longer in Sage/) });
  expect(acts(cleared)).toMatchObject([
    { kind: 'note', amount: null, previous_balance: 5000, notes: expect.stringMatching(/no payment was made/) },
    { kind: 'status_changed', notes: expect.stringMatching(/^active → closed: Customer no longer in Sage/) },
  ]);

  for (const asg of [paid, older]) {
    expect(asgRow(asg).status).toBe('collected');
    expect(acts(asg)[0]).toMatchObject({ kind: 'payment_received', amount: 5000 });
  }
});
