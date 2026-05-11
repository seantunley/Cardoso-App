// Contract tests for src/services/bat/matching.js — pins the
// matchCardosoToSupplier behaviour. This is the heart of the BAT
// reconciliation pipeline: every row the operator sees on the recon
// detail page (matched, auto-corrected, mismatched, unmatched
// supplier, unmatched Cardoso) flows through here.
//
// What's pinned:
//   - Exact match on normalised invoice (strip whitespace, uppercase)
//   - Amount diff calculation + 0.01 mismatch threshold
//   - 1-digit fuzzy auto-correct: applies, writes back to DB, sets
//     auto_corrected=true, increments stats.autoCorrections
//   - Fuzzy length floor: <4 chars never fuzzy-matches
//   - Fuzzy length match required: 4 vs 5 chars never fuzzy-matches
//   - Manual override is sacred: manual_override=1 rows skip fuzzy
//     even when a 1-digit candidate exists (regression-prone — easy
//     to silently undo an operator's deliberate fix)
//   - Cardoso rows with no supplier match appear as unmatched
//   - reconId scopes both extractions and Cardoso queries
//   - reconId=null spans all reconciliations (cross-recon match)
//   - Stats: total / matched / mismatches / autoCorrections /
//     unmatchedSupplier / unmatchedCardoso

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { matchCardosoToSupplier } from '../src/services/bat/matching.js';

let db;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE bat_reconciliations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_number INTEGER NOT NULL,
      year INTEGER NOT NULL
    );
    CREATE TABLE bat_invoice_extractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_id INTEGER REFERENCES bat_reconciliations(id) ON DELETE CASCADE,
      extracted_invoice TEXT,
      order_amount REAL,
      supplier_discount REAL,
      supplier_del_fee REAL,
      supplier_pricing REAL,
      delivery_date TEXT,
      is_exception INTEGER DEFAULT 0,
      manual_override INTEGER DEFAULT 0
    );
    CREATE TABLE bat_cardoso_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_id INTEGER REFERENCES bat_reconciliations(id) ON DELETE CASCADE,
      invoice_number TEXT NOT NULL,
      amount REAL,
      price_diff REAL,
      discount REAL,
      del_fee REAL
    );
  `);
});

function addRecon(week, year) {
  return db.prepare('INSERT INTO bat_reconciliations (week_number, year) VALUES (?, ?)')
    .run(week, year).lastInsertRowid;
}

function addExtraction(reconId, fields) {
  const cols = ['reconciliation_id', ...Object.keys(fields)];
  const vals = [reconId, ...Object.values(fields)];
  const placeholders = cols.map(() => '?').join(',');
  return db.prepare(`INSERT INTO bat_invoice_extractions (${cols.join(',')}) VALUES (${placeholders})`)
    .run(...vals).lastInsertRowid;
}

function addCardoso(reconId, fields) {
  const cols = ['reconciliation_id', ...Object.keys(fields)];
  const vals = [reconId, ...Object.values(fields)];
  const placeholders = cols.map(() => '?').join(',');
  return db.prepare(`INSERT INTO bat_cardoso_invoices (${cols.join(',')}) VALUES (${placeholders})`)
    .run(...vals).lastInsertRowid;
}

describe('matchCardosoToSupplier — exact match', () => {
  it('matches identical invoice numbers and computes the diff', () => {
    const r = addRecon(1, 2026);
    addExtraction(r, { extracted_invoice: 'INV-100', order_amount: 250.00 });
    addCardoso(r, { invoice_number: 'INV-100', amount: 250.00 });

    const { results, stats } = matchCardosoToSupplier({ db, reconId: r });
    expect(stats.total).toBe(1);
    expect(stats.matched).toBe(1);
    expect(stats.mismatches).toBe(0);
    expect(results[0].matched).toBe(true);
    expect(results[0].difference).toBe(0);
    expect(results[0].amount_mismatch).toBe(false);
  });

  it('flags amount_mismatch when |diff| > 0.01', () => {
    const r = addRecon(1, 2026);
    addExtraction(r, { extracted_invoice: 'X', order_amount: 100.00 });
    addCardoso(r, { invoice_number: 'X', amount: 99.50 });
    const { results, stats } = matchCardosoToSupplier({ db, reconId: r });
    expect(results[0].matched).toBe(true);
    expect(results[0].amount_mismatch).toBe(true);
    expect(stats.mismatches).toBe(1);
  });

  it('does NOT flag mismatch for sub-cent floating-point noise (<0.01)', () => {
    const r = addRecon(1, 2026);
    addExtraction(r, { extracted_invoice: 'X', order_amount: 100.005 });
    addCardoso(r, { invoice_number: 'X', amount: 100.00 });
    const { results } = matchCardosoToSupplier({ db, reconId: r });
    expect(results[0].amount_mismatch).toBe(false);
  });

  it('normalises whitespace and case when matching', () => {
    const r = addRecon(1, 2026);
    addExtraction(r, { extracted_invoice: '  inv 100  ', order_amount: 50 });
    addCardoso(r, { invoice_number: 'INV100', amount: 50 });
    const { stats } = matchCardosoToSupplier({ db, reconId: r });
    expect(stats.matched).toBe(1);
  });
});

describe('matchCardosoToSupplier — fuzzy auto-correct', () => {
  it('auto-corrects 1-digit OCR errors and writes the fix back to the DB', () => {
    const r = addRecon(1, 2026);
    const extId = addExtraction(r, { extracted_invoice: '12345', order_amount: 100 });
    addCardoso(r, { invoice_number: '12349', amount: 100 });

    const { results, stats } = matchCardosoToSupplier({ db, reconId: r });
    expect(stats.matched).toBe(1);
    expect(stats.autoCorrections).toBe(1);
    expect(results[0].auto_corrected).toBe(true);
    expect(results[0].invoice_number).toBe('12349');

    const persisted = db.prepare('SELECT extracted_invoice FROM bat_invoice_extractions WHERE id = ?').get(extId);
    expect(persisted.extracted_invoice).toBe('12349');
  });

  it('refuses to fuzzy-match when keys are <4 chars (false-positive guard)', () => {
    const r = addRecon(1, 2026);
    addExtraction(r, { extracted_invoice: '123', order_amount: 100 });
    addCardoso(r, { invoice_number: '124', amount: 100 });
    const { stats } = matchCardosoToSupplier({ db, reconId: r });
    expect(stats.matched).toBe(0);
    expect(stats.autoCorrections).toBe(0);
  });

  it('refuses to fuzzy-match across different lengths (4 vs 5 chars)', () => {
    const r = addRecon(1, 2026);
    addExtraction(r, { extracted_invoice: '1234', order_amount: 100 });
    addCardoso(r, { invoice_number: '12345', amount: 100 });
    const { stats } = matchCardosoToSupplier({ db, reconId: r });
    expect(stats.matched).toBe(0);
    expect(stats.autoCorrections).toBe(0);
  });

  it('refuses to fuzzy-match when 2+ digits differ', () => {
    const r = addRecon(1, 2026);
    addExtraction(r, { extracted_invoice: '12345', order_amount: 100 });
    addCardoso(r, { invoice_number: '12399', amount: 100 });
    const { stats } = matchCardosoToSupplier({ db, reconId: r });
    expect(stats.matched).toBe(0);
    expect(stats.autoCorrections).toBe(0);
  });

  it('SACRED: manual_override=1 rows are NEVER fuzzy-corrected', () => {
    // Operator's manual fix MUST NOT be silently undone by the next
    // matching pass — this test pins that guarantee.
    const r = addRecon(1, 2026);
    const extId = addExtraction(r, {
      extracted_invoice: '12345',
      order_amount: 100,
      manual_override: 1,
    });
    addCardoso(r, { invoice_number: '12349', amount: 100 });

    const { results, stats } = matchCardosoToSupplier({ db, reconId: r });
    expect(stats.matched).toBe(0);
    expect(stats.autoCorrections).toBe(0);
    expect(results[0].auto_corrected).toBeUndefined();

    // The DB row stays untouched.
    const persisted = db.prepare('SELECT extracted_invoice FROM bat_invoice_extractions WHERE id = ?').get(extId);
    expect(persisted.extracted_invoice).toBe('12345');
  });
});

describe('matchCardosoToSupplier — unmatched rows', () => {
  it('emits an unmatched-supplier row when no Cardoso invoice exists', () => {
    const r = addRecon(1, 2026);
    addExtraction(r, { extracted_invoice: 'NOPE', order_amount: 50 });
    const { results, stats } = matchCardosoToSupplier({ db, reconId: r });
    expect(stats.matched).toBe(0);
    expect(stats.unmatchedSupplier).toBe(1);
    expect(results[0].matched).toBe(false);
    expect(results[0].cardoso_id).toBeNull();
    expect(results[0].extraction_id).not.toBeNull();
  });

  it('emits an unmatched-Cardoso row when no supplier extraction exists', () => {
    const r = addRecon(1, 2026);
    addCardoso(r, { invoice_number: 'ORPHAN', amount: 75 });
    const { results, stats } = matchCardosoToSupplier({ db, reconId: r });
    expect(stats.matched).toBe(0);
    expect(stats.unmatchedCardoso).toBe(1);
    expect(results[0].matched).toBe(false);
    expect(results[0].extraction_id).toBeNull();
    expect(results[0].cardoso_id).not.toBeNull();
    expect(results[0].cardoso_amount).toBe(75);
  });
});

describe('matchCardosoToSupplier — scoping', () => {
  it('reconId scopes BOTH extractions and Cardoso queries', () => {
    const r1 = addRecon(1, 2026);
    const r2 = addRecon(2, 2026);
    addExtraction(r1, { extracted_invoice: 'A', order_amount: 10 });
    addCardoso(r1, { invoice_number: 'A', amount: 10 });
    addExtraction(r2, { extracted_invoice: 'B', order_amount: 20 });
    addCardoso(r2, { invoice_number: 'B', amount: 20 });

    const r1Result = matchCardosoToSupplier({ db, reconId: r1 });
    expect(r1Result.stats.total).toBe(1);
    expect(r1Result.results[0].invoice_number).toBe('A');

    const r2Result = matchCardosoToSupplier({ db, reconId: r2 });
    expect(r2Result.stats.total).toBe(1);
    expect(r2Result.results[0].invoice_number).toBe('B');
  });

  it('reconId=null spans ALL reconciliations (cross-recon match)', () => {
    const r1 = addRecon(1, 2026);
    const r2 = addRecon(2, 2026);
    addExtraction(r1, { extracted_invoice: 'A', order_amount: 10 });
    addCardoso(r1, { invoice_number: 'A', amount: 10 });
    addExtraction(r2, { extracted_invoice: 'B', order_amount: 20 });
    addCardoso(r2, { invoice_number: 'B', amount: 20 });

    const { stats } = matchCardosoToSupplier({ db, reconId: null });
    expect(stats.total).toBe(2);
    expect(stats.matched).toBe(2);
  });

  it('reconId=null is the default', () => {
    const r = addRecon(1, 2026);
    addExtraction(r, { extracted_invoice: 'A', order_amount: 10 });
    addCardoso(r, { invoice_number: 'A', amount: 10 });
    const { stats } = matchCardosoToSupplier({ db });
    expect(stats.matched).toBe(1);
  });
});
