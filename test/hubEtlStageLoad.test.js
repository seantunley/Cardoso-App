// Tests for chunkedStageLoad (src/services/hubEtl.js) — the stage-and-swap
// pattern that replaced the single giant ETL transaction (the main-thread
// freeze fix). Runs the REAL helper against an in-memory DB, then performs
// the same swap the AR call site does, pinning the semantics that matter:
// full per-site refresh, other sites untouched, intra-feed duplicates
// collapse last-one-wins, and chunking yields between chunks.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// hubEtl imports the app db + hub runtime at module level — point its db at
// an in-memory instance and stub the heavies so importing it is cheap.
const memDb = new Database(':memory:');
memDb.function('now_local', () => '2026-06-11T08:00:00');
memDb.exec(`
  CREATE TABLE hub_debtor_ar_invoice (
    site_id TEXT, customer_code TEXT, reporting_account TEXT, document_number TEXT,
    document_type TEXT, document_date TEXT, due_date TEXT,
    original_amount REAL, outstanding_amount REAL, reference TEXT, synced_at TEXT,
    UNIQUE(site_id, customer_code, document_number)
  );
`);
vi.mock('../src/db/index.js', () => ({ default: memDb, dbPath: ':memory:' }));
vi.mock('../src/hub/storage/runtime.js', () => ({ getHubStorageRuntime: () => ({}) }));
vi.mock('../src/lib/mainThreadWatch.js', () => ({ trackOp: () => () => {} }));

const { chunkedStageLoad } = await import('../src/services/hubEtl.js');

const AR_STAGE = {
  ddl: `CREATE TEMP TABLE IF NOT EXISTS stage_debtor_ar (
    site_id TEXT, customer_code TEXT, reporting_account TEXT, document_number TEXT,
    document_type TEXT, document_date TEXT, due_date TEXT,
    original_amount REAL, outstanding_amount REAL, reference TEXT)`,
  clearSql: 'DELETE FROM stage_debtor_ar WHERE site_id = ?',
  insertSql: 'INSERT INTO stage_debtor_ar VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  mapRow: (r) => ['s1', r.customer_code, r.reporting_account || r.customer_code || null, r.document_number, r.document_type || null, r.document_date || null, r.due_date || null, r.original_amount || 0, r.outstanding_amount || 0, r.reference || null],
};

function swap(siteId) {
  memDb.transaction(() => {
    memDb.prepare('DELETE FROM hub_debtor_ar_invoice WHERE site_id = ?').run(siteId);
    memDb.prepare(`
      INSERT OR REPLACE INTO hub_debtor_ar_invoice
        (site_id, customer_code, reporting_account, document_number, document_type, document_date, due_date, original_amount, outstanding_amount, reference, synced_at)
      SELECT site_id, customer_code, reporting_account, document_number, document_type, document_date, due_date, original_amount, outstanding_amount, reference, now_local()
      FROM stage_debtor_ar WHERE site_id = ?
    `).run(siteId);
    memDb.prepare('DELETE FROM stage_debtor_ar WHERE site_id = ?').run(siteId);
  })();
}

const doc = (n, over = {}) => ({ customer_code: `C${n}`, document_number: `INV${n}`, outstanding_amount: n, ...over });

beforeEach(() => {
  memDb.exec('DELETE FROM hub_debtor_ar_invoice');
  try { memDb.exec('DELETE FROM stage_debtor_ar'); } catch { /* not created yet */ }
});

describe('chunkedStageLoad + swap', () => {
  it('full refresh: replaces the site rows, leaves other sites alone', async () => {
    memDb.prepare("INSERT INTO hub_debtor_ar_invoice (site_id, customer_code, document_number, outstanding_amount) VALUES ('s1','OLD','OLD1', 999)").run();
    memDb.prepare("INSERT INTO hub_debtor_ar_invoice (site_id, customer_code, document_number, outstanding_amount) VALUES ('s2','KEEP','K1', 5)").run();

    await chunkedStageLoad(memDb, { ...AR_STAGE, rows: [doc(1), doc(2)], siteId: 's1' });
    swap('s1');

    const s1 = memDb.prepare("SELECT customer_code FROM hub_debtor_ar_invoice WHERE site_id='s1' ORDER BY customer_code").all().map((r) => r.customer_code);
    expect(s1).toEqual(['C1', 'C2']); // OLD gone, new set in
    expect(memDb.prepare("SELECT COUNT(*) c FROM hub_debtor_ar_invoice WHERE site_id='s2'").get().c).toBe(1); // untouched
    expect(memDb.prepare("SELECT COUNT(*) c FROM stage_debtor_ar WHERE site_id='s1'").get().c).toBe(0); // stage cleared
  });

  it('handles sets far larger than one chunk (multiple yields)', async () => {
    const rows = Array.from({ length: 2_500 }, (_, i) => doc(i));
    await chunkedStageLoad(memDb, { ...AR_STAGE, rows, siteId: 's1' });
    swap('s1');
    expect(memDb.prepare("SELECT COUNT(*) c FROM hub_debtor_ar_invoice WHERE site_id='s1'").get().c).toBe(2_500);
  });

  it('intra-feed duplicates collapse last-one-wins (old upsert semantics)', async () => {
    const rows = [doc(1, { outstanding_amount: 100 }), doc(1, { outstanding_amount: 42 })];
    await chunkedStageLoad(memDb, { ...AR_STAGE, rows, siteId: 's1' });
    swap('s1');
    const got = memDb.prepare("SELECT outstanding_amount FROM hub_debtor_ar_invoice WHERE site_id='s1' AND document_number='INV1'").all();
    expect(got.length).toBe(1);
    expect(got[0].outstanding_amount).toBe(42);
  });

  it('reporting_account falls back to customer_code (v093 contract)', async () => {
    await chunkedStageLoad(memDb, { ...AR_STAGE, rows: [doc(7), doc(8, { reporting_account: 'PARENT' })], siteId: 's1' });
    swap('s1');
    expect(memDb.prepare("SELECT reporting_account FROM hub_debtor_ar_invoice WHERE customer_code='C7'").get().reporting_account).toBe('C7');
    expect(memDb.prepare("SELECT reporting_account FROM hub_debtor_ar_invoice WHERE customer_code='C8'").get().reporting_account).toBe('PARENT');
  });

  it('empty feed leaves the live table empty for that site (zero-open-items site)', async () => {
    memDb.prepare("INSERT INTO hub_debtor_ar_invoice (site_id, customer_code, document_number, outstanding_amount) VALUES ('s1','OLD','OLD1', 999)").run();
    await chunkedStageLoad(memDb, { ...AR_STAGE, rows: [], siteId: 's1' });
    swap('s1');
    expect(memDb.prepare("SELECT COUNT(*) c FROM hub_debtor_ar_invoice WHERE site_id='s1'").get().c).toBe(0);
  });
});
