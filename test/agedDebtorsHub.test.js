// Contract test for acquireHubAgedDebtorRows (SYNC-5).
//
// The hub Aged Debtors source rows use a PER-SITE ledger/snapshot decision keyed
// on AR-sync COMPLETION (hub_debtor_ar_sync), NOT on the presence of ledger rows:
//   - A site whose AR ETL hasn't run yet must fall back to its hub_records
//     snapshot (and must NOT vanish just because another site synced).
//   - A site that HAS synced but is fully paid up (zero open items) must show an
//     empty ledger — NOT its possibly-stale hub_records snapshot.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// reporting.js opens the real app DB via ../db/index.js at module load — stub it.
// acquireHubAgedDebtorRows uses only the `prep` we pass in.
vi.mock('../src/db/index.js', () => ({ default: { prepare: vi.fn() } }));

import { acquireHubAgedDebtorRows } from '../src/routes/reporting.js';

const memDb = new Database(':memory:');
memDb.exec(`
  CREATE TABLE hub_sites (id TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE hub_debtor_ar_sync (site_id TEXT PRIMARY KEY, synced_at TEXT);
  CREATE TABLE hub_debtor_ar_invoice (
    site_id TEXT, customer_code TEXT, reporting_account TEXT, document_number TEXT,
    document_type TEXT, document_date TEXT, due_date TEXT, outstanding_amount REAL, reference TEXT
  );
  CREATE TABLE hub_records (
    site_id TEXT, customer_number TEXT, customer_name TEXT, sales_rep TEXT,
    account_type TEXT, terms TEXT, outstanding_balance_num REAL, unpaid_invoices TEXT
  );
`);
const prep = (sql) => memDb.prepare(sql);

beforeEach(() => {
  memDb.exec('DELETE FROM hub_sites; DELETE FROM hub_debtor_ar_sync; DELETE FROM hub_debtor_ar_invoice; DELETE FROM hub_records;');
  memDb.prepare("INSERT INTO hub_sites VALUES ('A','Alpha'),('B','Bravo'),('C','Charlie')").run();
  // A (Alpha): synced, HAS open items → ledger. (+ a hub_records row the ledger
  // joins to, which must NOT also become a separate snapshot row.)
  memDb.prepare("INSERT INTO hub_debtor_ar_sync VALUES ('A','2026-06-09')").run();
  memDb.prepare(`INSERT INTO hub_debtor_ar_invoice
    (site_id, customer_code, reporting_account, document_number, document_type, document_date, due_date, outstanding_amount, reference)
    VALUES ('A','C1','C1','INV001','IN','2026-01-01','2026-02-01',1000,'ref1')`).run();
  memDb.prepare(`INSERT INTO hub_records
    (site_id, customer_number, customer_name, sales_rep, account_type, terms, outstanding_balance_num, unpaid_invoices)
    VALUES ('A','C1','Cust One','Rep1','National','30',1000,'[]')`).run();
  // B (Bravo): NOT synced — only a hub_records snapshot.
  memDb.prepare(`INSERT INTO hub_records
    (site_id, customer_number, customer_name, sales_rep, account_type, terms, outstanding_balance_num, unpaid_invoices)
    VALUES ('B','C2','Cust Two','Rep2','Local','30',500,'[{"date":"2026-03-01"}]')`).run();
  // C (Charlie): synced but fully PAID UP — marker set, ZERO ledger rows, yet a
  // STALE non-zero hub_records snapshot. Must show nothing, not the stale 777.
  memDb.prepare("INSERT INTO hub_debtor_ar_sync VALUES ('C','2026-06-09')").run();
  memDb.prepare(`INSERT INTO hub_records
    (site_id, customer_number, customer_name, sales_rep, account_type, terms, outstanding_balance_num, unpaid_invoices)
    VALUES ('C','C3','Cust Three','Rep3','Local','30',777,'[{"date":"2026-02-01"}]')`).run();
});

describe('acquireHubAgedDebtorRows — per-site ledger/snapshot (SYNC-5)', () => {
  it('shows a synced-but-fully-paid site nothing, not its stale snapshot', () => {
    const { rows, sites } = acquireHubAgedDebtorRows(prep, 'all');
    // Charlie synced (marker) with zero open items → must NOT appear, and its
    // stale 777 snapshot balance must NOT leak in.
    expect(rows.some((r) => r.site_name === 'Charlie')).toBe(false);
    expect(rows.some((r) => r.outstanding_amount === 777)).toBe(false);
    // Bravo (never synced) is sourced from its snapshot; Alpha from its ledger.
    expect(sites).toEqual(['Alpha', 'Bravo']);
    const alpha = rows.filter((r) => r.site_name === 'Alpha');
    const bravo = rows.filter((r) => r.site_name === 'Bravo');
    expect(alpha).toHaveLength(1);
    expect(alpha[0].document_number).toBe('INV001');
    expect(alpha[0].due_date).toBe('2026-02-01');
    expect(bravo).toHaveLength(1);
    expect(bravo[0].outstanding_amount).toBe(500);
    expect(bravo[0].document_type).toBe('');
  });

  it('does not double-count a ledger site under the snapshot source', () => {
    const { rows } = acquireHubAgedDebtorRows(prep, 'all');
    expect(rows.filter((r) => r.site_name === 'Alpha')).toHaveLength(1);
  });

  it('site filter resolves each site to its own source', () => {
    expect(acquireHubAgedDebtorRows(prep, 'Bravo').rows.map((r) => r.site_name)).toEqual(['Bravo']);
    expect(acquireHubAgedDebtorRows(prep, 'Alpha').rows.map((r) => r.document_number)).toEqual(['INV001']);
    // A synced-but-fully-paid site filtered explicitly still shows nothing.
    expect(acquireHubAgedDebtorRows(prep, 'Charlie').rows).toEqual([]);
  });

  it('reports ledgerReady from sync markers, not row count', () => {
    // all-sites: at least one site has synced → ready.
    expect(acquireHubAgedDebtorRows(prep, 'all').ledgerReady).toBe(true);
    // Charlie synced but fully paid (zero rows) → STILL ready (the fix: no false
    // "no AR data yet" warning for a fully-paid branch).
    expect(acquireHubAgedDebtorRows(prep, 'Charlie').ledgerReady).toBe(true);
    // Bravo never synced → not ready (snapshot fallback; warning is correct).
    expect(acquireHubAgedDebtorRows(prep, 'Bravo').ledgerReady).toBe(false);
  });

  it('falls back to snapshot for ALL sites when none have synced yet', () => {
    memDb.exec('DELETE FROM hub_debtor_ar_sync');
    const { rows, sites, ledgerReady } = acquireHubAgedDebtorRows(prep, 'all');
    expect(ledgerReady).toBe(false);
    expect(sites).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.document_type === '')).toBe(true);
  });
});
