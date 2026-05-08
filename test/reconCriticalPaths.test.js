// Contract tests for the BAT reconciliation module's critical paths.
// Pins the behaviours the module review (Batch B) called out as the
// biggest risk-coverage gap: refresh atomicity, SSE listener
// hygiene, retry-extraction.
//
// Tests run at the function level — same style as alertEngine /
// jobRunner / customerLookup tests. The service module imports `db`
// from src/db/index.js, so we shim that with an in-memory connection
// before importing.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// In-memory DB with the bat schema needed by the functions under test.
// Just the columns the refresh / retry / events code touches — full
// batSchema would pull in migration history that's not relevant.
const memDb = new Database(':memory:');
memDb.exec(`
  CREATE TABLE bat_reconciliations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_number INTEGER NOT NULL,
    year INTEGER NOT NULL,
    upload_filename TEXT,
    supplier_discount REAL,
    supplier_delivery REAL,
    supplier_pricing REAL,
    sage_discount REAL,
    sage_delivery REAL,
    sage_pricing REAL,
    sage_total REAL,
    sage_error TEXT,
    last_error TEXT,
    last_error_at TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(week_number, year)
  );
  CREATE TABLE bat_sage_credit_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reconciliation_id INTEGER REFERENCES bat_reconciliations(id) ON DELETE CASCADE,
    batch_number INTEGER,
    batch_description TEXT,
    batch_status TEXT,
    vendor_number TEXT,
    document_number TEXT,
    document_date TEXT,
    line_description TEXT,
    week_number INTEGER,
    fee_type TEXT,
    line_amount REAL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE bat_invoice_extractions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reconciliation_id INTEGER REFERENCES bat_reconciliations(id) ON DELETE CASCADE,
    pdf_url TEXT NOT NULL,
    store_name TEXT,
    extracted_invoice TEXT,
    extraction_status TEXT DEFAULT 'pending',
    extraction_attempts INTEGER DEFAULT 0,
    match_status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE bat_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE bat_sage_week_cache (
    year INTEGER NOT NULL,
    week_number INTEGER NOT NULL,
    delivery REAL,
    discount REAL,
    pricing REAL,
    total REAL,
    PRIMARY KEY (year, week_number)
  );
  CREATE TABLE error_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT,
    level TEXT,
    message TEXT,
    stack TEXT,
    context TEXT,
    occurred_at TEXT
  );
`);

vi.mock('../src/db/index.js', () => ({
  default: memDb,
  dbPath: ':memory:',
}));

// Import AFTER the mock so the service picks up our in-memory db.
const {
  replaceSageCreditNotes,
  storeSageCreditNotes,
  retryNotFound,
  extractionEvents,
} = await import('../src/services/batReconciliation.js');

const insertRecon = memDb.prepare(`
  INSERT INTO bat_reconciliations (week_number, year, upload_filename)
  VALUES (?, ?, ?)
`);
const insertExtraction = memDb.prepare(`
  INSERT INTO bat_invoice_extractions (reconciliation_id, pdf_url, store_name, extraction_status)
  VALUES (?, ?, ?, ?)
`);

beforeEach(() => {
  memDb.prepare('DELETE FROM bat_sage_credit_notes').run();
  memDb.prepare('DELETE FROM bat_invoice_extractions').run();
  memDb.prepare('DELETE FROM bat_reconciliations').run();
  memDb.prepare('DELETE FROM bat_settings').run();
  memDb.prepare('DELETE FROM bat_sage_week_cache').run();
  // Reset event listeners between tests so listener-count assertions
  // don't accumulate state across runs.
  extractionEvents.removeAllListeners();
});

// ── replaceSageCreditNotes — atomic refresh ─────────────────────────

describe('replaceSageCreditNotes — atomic refresh contract', () => {
  it('replaces existing rows with the new set', () => {
    const reconId = insertRecon.run(15, 2026, 'wk15.xlsx').lastInsertRowid;
    // Seed two existing rows that should be wiped by the refresh.
    storeSageCreditNotes(reconId, [
      makeNote({ document_number: 'OLD-1', fee_type: 'DELIVERY FEE', line_amount: 100 }),
      makeNote({ document_number: 'OLD-2', fee_type: 'DISCOUNT FEE', line_amount: 50 }),
    ]);
    expect(countNotes(reconId)).toBe(2);

    replaceSageCreditNotes(reconId, [
      makeNote({ document_number: 'NEW-1', fee_type: 'DELIVERY FEE', line_amount: 200 }),
    ]);

    const after = memDb.prepare('SELECT document_number FROM bat_sage_credit_notes WHERE reconciliation_id = ?').all(reconId);
    expect(after.map(r => r.document_number)).toEqual(['NEW-1']);
  });

  it('clears sage_error on successful refresh', () => {
    const reconId = insertRecon.run(16, 2026, 'wk16.xlsx').lastInsertRowid;
    memDb.prepare('UPDATE bat_reconciliations SET sage_error = ? WHERE id = ?').run('previous error', reconId);

    replaceSageCreditNotes(reconId, [makeNote({ document_number: 'CN-1' })]);

    const recon = memDb.prepare('SELECT sage_error FROM bat_reconciliations WHERE id = ?').get(reconId);
    expect(recon.sage_error).toBeNull();
  });

  it('updates the recon totals to match the new credit-note set', () => {
    const reconId = insertRecon.run(17, 2026, 'wk17.xlsx').lastInsertRowid;

    replaceSageCreditNotes(reconId, [
      makeNote({ fee_type: 'DELIVERY FEE', line_amount: 100 }),
      makeNote({ fee_type: 'DISCOUNT FEE', line_amount: 50 }),
      makeNote({ fee_type: 'PRICING ADJ', line_amount: 25 }),
    ]);

    const recon = memDb.prepare('SELECT sage_delivery, sage_discount, sage_pricing, sage_total FROM bat_reconciliations WHERE id = ?').get(reconId);
    expect(recon.sage_delivery).toBe(100);
    expect(recon.sage_discount).toBe(50);
    expect(recon.sage_pricing).toBe(25);
    expect(recon.sage_total).toBe(175);
  });

  it('handles empty credit-note list (DELETE-only path)', () => {
    const reconId = insertRecon.run(18, 2026, 'wk18.xlsx').lastInsertRowid;
    storeSageCreditNotes(reconId, [makeNote({ document_number: 'CN-1' })]);

    replaceSageCreditNotes(reconId, []);

    expect(countNotes(reconId)).toBe(0);
    // The totals UPDATE still runs through storeSageCreditNotes;
    // empty input yields all-zeros.
    const recon = memDb.prepare('SELECT sage_total FROM bat_reconciliations WHERE id = ?').get(reconId);
    expect(recon.sage_total).toBe(0);
  });

  it('rolls back on insert failure — pre-refresh state preserved', () => {
    const reconId = insertRecon.run(19, 2026, 'wk19.xlsx').lastInsertRowid;
    storeSageCreditNotes(reconId, [
      makeNote({ document_number: 'OLD-1', fee_type: 'DELIVERY FEE', line_amount: 100 }),
    ]);
    memDb.prepare('UPDATE bat_reconciliations SET sage_error = ? WHERE id = ?').run('previous error', reconId);

    // Force a failure mid-insert by passing a row that will throw —
    // null reconciliation_id violates the schema's NOT NULL on the
    // FK column? Actually it allows NULL since it's only a REFERENCES.
    // Use a non-string fee_type Buffer that better-sqlite3 will reject.
    const bad = makeNote({ document_number: 'BAD-1' });
    bad.line_amount = { not: 'a number' }; // can't bind an object as REAL

    expect(() => {
      replaceSageCreditNotes(reconId, [
        makeNote({ document_number: 'NEW-1', fee_type: 'DELIVERY FEE', line_amount: 50 }),
        bad,
      ]);
    }).toThrow();

    // Pre-refresh state must be intact: original row, original error.
    const after = memDb.prepare('SELECT document_number FROM bat_sage_credit_notes WHERE reconciliation_id = ?').all(reconId);
    expect(after.map(r => r.document_number)).toEqual(['OLD-1']);
    const recon = memDb.prepare('SELECT sage_error FROM bat_reconciliations WHERE id = ?').get(reconId);
    expect(recon.sage_error).toBe('previous error');
  });
});

// ── extractionEvents — SSE listener hygiene ─────────────────────────

describe('extractionEvents — listener hygiene', () => {
  it('has the documented max-listener cap of 50', () => {
    expect(extractionEvents.getMaxListeners()).toBe(50);
  });

  it('emits update:<reconId> events scoped per recon', () => {
    const got = [];
    extractionEvents.on('update:42', () => got.push(42));
    extractionEvents.on('update:43', () => got.push(43));

    extractionEvents.emit('update:42');
    extractionEvents.emit('update:43');
    extractionEvents.emit('update:42');
    expect(got).toEqual([42, 43, 42]);
  });

  it('emit on a recon with no listeners is a no-op (no throw)', () => {
    expect(() => extractionEvents.emit('update:999')).not.toThrow();
  });

  it('listeners are correctly removed via removeListener', () => {
    const handler = () => {};
    extractionEvents.on('update:100', handler);
    expect(extractionEvents.listenerCount('update:100')).toBe(1);
    extractionEvents.removeListener('update:100', handler);
    expect(extractionEvents.listenerCount('update:100')).toBe(0);
  });

  it('warns when more than maxListeners are added (Node default behaviour)', () => {
    const warnSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const cap = extractionEvents.getMaxListeners();
    for (let i = 0; i <= cap; i++) {
      extractionEvents.on('update:overload', () => {});
    }
    // Adding the (cap + 1)-th listener emits a MaxListenersExceededWarning.
    // We don't assert the exact warning shape — Node varies — just that
    // some warning fired, which is enough to anchor the cap's purpose.
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ── retryNotFound — retry-extraction flow ────────────────────────────

describe('retryNotFound — retry flow', () => {
  it('returns "nothing to retry" when no failed/not_found rows exist', () => {
    const reconId = insertRecon.run(20, 2026, 'wk20.xlsx').lastInsertRowid;
    insertExtraction.run(reconId, 'https://example.com/a.pdf', 'Store A', 'found');
    insertExtraction.run(reconId, 'https://example.com/b.pdf', 'Store B', 'pending');

    const result = retryNotFound(reconId);
    expect(result).toEqual({ message: 'Nothing to retry', requeued: 0 });
  });

  it('queues only not_found and failed rows; ignores found/pending', () => {
    const reconId = insertRecon.run(21, 2026, 'wk21.xlsx').lastInsertRowid;
    insertExtraction.run(reconId, 'https://example.com/a.pdf', 'A', 'not_found');
    insertExtraction.run(reconId, 'https://example.com/b.pdf', 'B', 'failed');
    insertExtraction.run(reconId, 'https://example.com/c.pdf', 'C', 'found');
    insertExtraction.run(reconId, 'https://example.com/d.pdf', 'D', 'pending');

    const result = retryNotFound(reconId);
    expect(result.requeued).toBe(2);
    expect(result.message).toMatch(/Retrying 2 extractions/);
  });

  it('scopes the retry to the requested reconciliation_id', () => {
    const a = insertRecon.run(22, 2026, 'wk22.xlsx').lastInsertRowid;
    const b = insertRecon.run(23, 2026, 'wk23.xlsx').lastInsertRowid;
    insertExtraction.run(a, 'https://example.com/a-1.pdf', 'A1', 'not_found');
    insertExtraction.run(b, 'https://example.com/b-1.pdf', 'B1', 'not_found');
    insertExtraction.run(b, 'https://example.com/b-2.pdf', 'B2', 'failed');

    expect(retryNotFound(a).requeued).toBe(1);
    expect(retryNotFound(b).requeued).toBe(2);
  });
});

// ── helpers ──────────────────────────────────────────────────────────

function makeNote(overrides = {}) {
  return {
    batch_number: 1,
    batch_description: 'Week 15',
    batch_status: 'Posted',
    vendor_number: 'BAT001',
    document_number: 'CN-default',
    document_date: '2026-04-15',
    line_description: 'Delivery fee',
    week_number: 15,
    fee_type: 'DELIVERY FEE',
    line_amount: 100,
    ...overrides,
  };
}

function countNotes(reconId) {
  return memDb.prepare('SELECT COUNT(*) AS c FROM bat_sage_credit_notes WHERE reconciliation_id = ?').get(reconId).c;
}
