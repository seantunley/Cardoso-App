// Contract test for acquireHubAgedDebtorRows (SYNC-5).
//
// The hub Aged Debtors source rows must use a PER-SITE ledger/snapshot
// decision: a site whose AR open-item ETL hasn't landed yet must NOT vanish
// from the report just because another site has already synced. The earlier
// GLOBAL ledger-ready check switched every site to the ledger the moment ONE
// site had open-item rows, silently dropping all not-yet-synced sites.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// reporting.js imports the real app DB via ../db/index.js at module load — stub
// it so the test never touches the filesystem DB. acquireHubAgedDebtorRows uses
// only the `prep` we pass in, never the module-level db.
vi.mock('../src/db/index.js', () => ({ default: { prepare: vi.fn() } }));

import { acquireHubAgedDebtorRows } from '../src/routes/reporting.js';

const memDb = new Database(':memory:');
memDb.exec(`
  CREATE TABLE hub_sites (id TEXT PRIMARY KEY, name TEXT);
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
  memDb.exec('DELETE FROM hub_sites; DELETE FROM hub_debtor_ar_invoice; DELETE FROM hub_records;');
  memDb.prepare("INSERT INTO hub_sites VALUES ('A','Alpha'),('B','Bravo')").run();
  // Site A (Alpha): AR open-item ETL has landed → ledger rows (+ a hub_records
  // row that the ledger joins to for name/rep, and that must NOT also produce a
  // separate snapshot row).
  memDb.prepare(`INSERT INTO hub_debtor_ar_invoice
    (site_id, customer_code, reporting_account, document_number, document_type, document_date, due_date, outstanding_amount, reference)
    VALUES ('A','C1','C1','INV001','IN','2026-01-01','2026-02-01',1000,'ref1')`).run();
  memDb.prepare(`INSERT INTO hub_records
    (site_id, customer_number, customer_name, sales_rep, account_type, terms, outstanding_balance_num, unpaid_invoices)
    VALUES ('A','C1','Cust One','Rep1','National','30',1000,'[]')`).run();
  // Site B (Bravo): NO ledger rows yet — only the hub_records snapshot.
  memDb.prepare(`INSERT INTO hub_records
    (site_id, customer_number, customer_name, sales_rep, account_type, terms, outstanding_balance_num, unpaid_invoices)
    VALUES ('B','C2','Cust Two','Rep2','Local','30',500,'[{"date":"2026-03-01"}]')`).run();
});

describe('acquireHubAgedDebtorRows — per-site ledger/snapshot (SYNC-5)', () => {
  it('keeps a snapshot-only site visible when another site has ledger data', () => {
    const { rows, sites } = acquireHubAgedDebtorRows(prep, 'all');
    // The not-yet-synced site (Bravo) does NOT vanish — this is the bug fix.
    expect(sites).toEqual(['Alpha', 'Bravo']);
    const alpha = rows.filter((r) => r.site_name === 'Alpha');
    const bravo = rows.filter((r) => r.site_name === 'Bravo');
    expect(alpha).toHaveLength(1);
    expect(bravo).toHaveLength(1);
    // Alpha is aged from the LEDGER (real document number + due date).
    expect(alpha[0].document_number).toBe('INV001');
    expect(alpha[0].due_date).toBe('2026-02-01');
    expect(alpha[0].outstanding_amount).toBe(1000);
    // Bravo is the SNAPSHOT pseudo-document (oldest unpaid date as its due date).
    expect(bravo[0].outstanding_amount).toBe(500);
    expect(bravo[0].due_date).toBe('2026-03-01');
    expect(bravo[0].document_type).toBe('');
  });

  it('does not double-count a ledger site under the snapshot source', () => {
    const { rows } = acquireHubAgedDebtorRows(prep, 'all');
    // Site A has a hub_records row too, but must appear ONLY via the ledger.
    expect(rows.filter((r) => r.site_name === 'Alpha')).toHaveLength(1);
  });

  it('site filter resolves each site to its own source', () => {
    expect(acquireHubAgedDebtorRows(prep, 'Bravo').rows.map((r) => r.site_name)).toEqual(['Bravo']);
    expect(acquireHubAgedDebtorRows(prep, 'Alpha').rows.map((r) => r.document_number)).toEqual(['INV001']);
  });

  it('falls back to snapshot for ALL sites when no ledger data exists yet', () => {
    memDb.exec('DELETE FROM hub_debtor_ar_invoice');
    const { rows, sites } = acquireHubAgedDebtorRows(prep, 'all');
    expect(sites).toEqual(['Alpha', 'Bravo']);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.document_type === '')).toBe(true);
  });
});
