// Customers that drop out of Sage's results get their balance, aging and open
// invoices cleared (record, flags and notes kept), behind a guard against a
// broken query; and every run reports what actually changed
// (src/services/syncEngine.js: clearMissingCustomers / describeSyncResult).

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

const memDb = new Database(':memory:');
memDb.function('now_local', () => new Date().toISOString());

let sageRows = [];
vi.mock('mssql', () => {
  class ConnectionPool {
    async connect() { return this; }
    request() { return { query: async () => ({ recordset: sageRows.map((r) => ({ ...r })) }) }; }
    async close() {}
  }
  return { default: { ConnectionPool }, ConnectionPool };
});
vi.mock('../src/db/index.js', () => ({ default: memDb, dbPath: ':memory:' }));
vi.mock('../src/services/encryption.js', () => ({ decryptPassword: () => '' }));
vi.mock('../src/lib/mainThreadWatch.js', () => ({ trackOp: () => () => {} }));
vi.mock('../src/lib/errorLog.js', () => ({ logError: () => {} }));

let runConnectionImport, connId;
beforeAll(async () => {
  (await import('../src/db/batSchema.js')).initBatSchema(memDb);
  (await import('../src/db/schema.js')).initSchema(memDb);
  (await import('../src/db/migrations.js')).runMigrations(memDb);
  ({ runConnectionImport } = await import('../src/services/syncEngine.js'));
});
beforeEach(() => {
  memDb.exec('DELETE FROM datarecord; DELETE FROM databaseconnection;');
  connId = memDb.prepare(`INSERT INTO databaseconnection (name, host, port, database_name, username, sync_query, query_index_field)
    VALUES ('AR', 'fake', 1433, 'fake', 'fake', 'SELECT * FROM customers WHERE 1=1', 'customer_number')`).run().lastInsertRowid;
});

const cust = (num, bal) => ({
  customer_number: num, customer_name: `Cust ${num}`, outstanding_balance: String(bal),
  unpaid_invoices: bal ? JSON.stringify([{ number: `IN-${num}`, amount: String(bal), date: '20261101' }]) : '[]',
});
const rec = (num) => memDb.prepare('SELECT outstanding_balance, outstanding_balance_num, unpaid_invoices, flag_color, note, updated_date FROM datarecord WHERE customer_number = ?').get(num);
const sync = async () => { await new Promise((r) => setTimeout(r, 5)); return runConnectionImport(connId); };

describe('customers no longer in Sage', () => {
  it('clears their balance but keeps the record, flags and notes; a returning customer is updated', async () => {
    sageRows = [cust('A', 100), cust('B', 200), cust('C', 300)];
    await sync();
    memDb.prepare("UPDATE datarecord SET flag_color = 'red', note = 'call Friday' WHERE customer_number = 'C'").run();

    sageRows = [cust('A', 100), cust('B', 250)]; // C deleted in Sage / rolled into a national account
    const res = await sync();
    // (the balance trigger stores '0' as a NULL numeric copy, same as any zero-balance customer)
    expect(rec('C')).toMatchObject({ outstanding_balance: '0', outstanding_balance_num: null, unpaid_invoices: '[]', flag_color: 'red', note: 'call Friday' });
    expect(memDb.prepare('SELECT SUM(outstanding_balance_num) AS t FROM datarecord').get().t).toBe(350); // totals match Sage again
    expect(res.message).toBe('Synced 2 customer rows from Sage: 0 new, 1 updated, 1 unchanged, 1 no longer in Sage (balances cleared).');
    expect(res.counts).toMatchObject({ inserted: 0, updated: 1, unchanged: 1, cleared: 1 });

    const touched = rec('C').updated_date;
    const again = await sync(); // already cleared → not rewritten (and not re-sent to the hub)
    expect(rec('C').updated_date).toBe(touched);
    expect(again.counts.cleared).toBe(0);

    sageRows = [cust('A', 100), cust('B', 250), cust('C', 40)];
    await sync();
    expect(rec('C')).toMatchObject({ outstanding_balance: '40', flag_color: 'red' });
  });

  it('holds off for one run when Sage suddenly returns far fewer customers, then accepts a lasting drop', async () => {
    sageRows = Array.from({ length: 300 }, (_, i) => cust(`K${i}`, 10));
    await sync();
    const withBalance = () => memDb.prepare("SELECT COUNT(*) AS n FROM datarecord WHERE outstanding_balance = '10'").get().n;
    sageRows = sageRows.slice(0, 100); // sudden 67% drop → looks like a broken query, not deletions
    const res = await sync();
    expect(withBalance()).toBe(300);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toMatch(/Sage returned 100 customers, 67% fewer than the 300 in the last successful sync/);
    expect(res.message).toMatch(/Did not clear customers missing from Sage/);

    const next = await sync(); // still 100 → genuine
    expect(withBalance()).toBe(100);
    expect(next.counts.cleared).toBe(200);
    expect(next.warnings).toEqual([]);
  });

  it('clears a large backlog in one go when Sage\'s count is steady', async () => {
    sageRows = Array.from({ length: 300 }, (_, i) => cust(`K${i}`, 10));
    await sync();
    // Sage has really returned 100 for a while (e.g. 200 customers long since rolled into national accounts)
    memDb.prepare('UPDATE databaseconnection SET record_count = 100 WHERE id = ?').run(connId);
    sageRows = sageRows.slice(0, 100);
    const res = await sync();
    expect(res.counts.cleared).toBe(200);
    expect(res.warnings).toEqual([]);
  });

  it('clears nothing when Sage returns no customers at all', async () => {
    sageRows = [cust('A', 100)];
    await sync();
    sageRows = [];
    const res = await sync();
    expect(rec('A').outstanding_balance).toBe('100');
    expect(res.message).toBe('Synced — Sage returned no rows. Did not clear customers missing from Sage for AR: Sage returned no customers at all, so nothing was cleared.');
    expect(res.warnings).toHaveLength(1);
  });
});

it('the first sync reports new customers and duplicate rows', async () => {
  sageRows = [cust('A', 1), cust('B', 2), cust('B', 2)];
  const res = await sync();
  expect(res.message).toBe('Synced 3 customer rows from Sage: 2 new, 0 updated, 0 unchanged, 1 duplicate rows skipped.');
});

it('Collections does not record a cleared balance as a payment; a real drop still is', async () => {
  const { processCollectionBalanceDelta } = await import('../src/services/collectionsService.js');
  sageRows = [cust('P', 100), cust('Q', 300)];
  await sync();
  const wl = memDb.prepare("INSERT INTO collection_worklist (name) VALUES ('Overdue')").run().lastInsertRowid;
  const assign = memDb.prepare("INSERT INTO collection_assignment (worklist_id, customer_id, last_known_balance) SELECT ?, id, ? FROM datarecord WHERE customer_number = ?");
  const aP = assign.run(wl, 100, 'P').lastInsertRowid;
  const aQ = assign.run(wl, 300, 'Q').lastInsertRowid;

  sageRows = [cust('P', 40)]; // P paid 60; Q is no longer returned by Sage
  await sync();
  processCollectionBalanceDelta(); // the manual "check balances" path must agree too

  const acts = (id) => memDb.prepare('SELECT kind, amount, notes FROM collection_activity WHERE assignment_id = ? ORDER BY id').all(id);
  const status = (id) => memDb.prepare('SELECT status FROM collection_assignment WHERE id = ?').get(id).status;
  expect(acts(aQ).map((a) => a.kind)).toEqual(['note']);
  expect(acts(aQ)[0].notes).toMatch(/not a payment/);
  expect(status(aQ)).toBe('active');
  expect(acts(aP)).toMatchObject([{ kind: 'payment_received', amount: 60 }]);
  expect(status(aP)).toBe('active');
});
