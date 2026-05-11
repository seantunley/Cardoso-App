// Tests for src/services/bat/reconTotals.js — drift detection +
// recompute primitive for BAT reconciliation supplier_total.
//
// Uses an in-memory SQLite DB with a minimal schema (just the two
// tables this module touches). The service module takes db as an
// explicit argument, so no module mock is needed — we just pass an
// in-memory connection in.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { findReconTotalDrift, recomputeReconTotals } from '../src/services/bat/reconTotals.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE bat_reconciliations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_number INTEGER NOT NULL,
      year INTEGER NOT NULL,
      supplier_total REAL,
      UNIQUE(week_number, year)
    );
    CREATE TABLE bat_invoice_extractions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_id INTEGER NOT NULL REFERENCES bat_reconciliations(id) ON DELETE CASCADE,
      pdf_url TEXT NOT NULL,
      order_amount REAL,
      is_exception INTEGER DEFAULT 0
    );
  `);
  return db;
}

function insertRecon(db, { year, week_number, supplier_total }) {
  return db.prepare(
    `INSERT INTO bat_reconciliations (year, week_number, supplier_total) VALUES (?, ?, ?)`
  ).run(year, week_number, supplier_total).lastInsertRowid;
}

function insertExt(db, reconId, { order_amount = null, is_exception = 0, pdf_url } = {}) {
  return db.prepare(
    `INSERT INTO bat_invoice_extractions (reconciliation_id, pdf_url, order_amount, is_exception) VALUES (?, ?, ?, ?)`
  ).run(reconId, pdf_url || `pdf-${Math.random()}`, order_amount, is_exception).lastInsertRowid;
}

describe('findReconTotalDrift', () => {
  let db;
  beforeEach(() => { db = freshDb(); });

  it('returns no mismatches when supplier_total matches non-exception order_amount sum', () => {
    const id = insertRecon(db, { year: 2026, week_number: 10, supplier_total: 300 });
    insertExt(db, id, { order_amount: 100 });
    insertExt(db, id, { order_amount: 200 });
    const result = findReconTotalDrift({ db });
    expect(result.scanned).toBe(1);
    expect(result.mismatches).toHaveLength(0);
    expect(result.skippedIncomplete).toHaveLength(0);
  });

  it('flags drift >= R 0.01 as a mismatch', () => {
    const id = insertRecon(db, { year: 2026, week_number: 10, supplier_total: 100 });
    insertExt(db, id, { order_amount: 250 });
    const result = findReconTotalDrift({ db });
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toMatchObject({
      id, year: 2026, week_number: 10,
      current_total: 100, derived_total: 250, diff: 150,
    });
  });

  it('treats sub-cent diff as floating-point noise (no mismatch)', () => {
    const id = insertRecon(db, { year: 2026, week_number: 10, supplier_total: 100.005 });
    insertExt(db, id, { order_amount: 100.001 });
    const result = findReconTotalDrift({ db });
    expect(result.mismatches).toHaveLength(0);
  });

  it('excludes exception rows from the derived sum', () => {
    const id = insertRecon(db, { year: 2026, week_number: 10, supplier_total: 100 });
    insertExt(db, id, { order_amount: 100 });
    insertExt(db, id, { order_amount: 999, is_exception: 1 }); // ignored
    const result = findReconTotalDrift({ db });
    expect(result.mismatches).toHaveLength(0);
    // sanity check: exception_count surfaced for the operator
    // we re-check via a drifted recon to introspect
  });

  it('skips recons with NULL order_amount on a non-exception row', () => {
    const id = insertRecon(db, { year: 2026, week_number: 10, supplier_total: 999 });
    insertExt(db, id, { order_amount: 100 });
    insertExt(db, id, { order_amount: null }); // missing
    const result = findReconTotalDrift({ db });
    expect(result.mismatches).toHaveLength(0);
    expect(result.skippedIncomplete).toHaveLength(1);
    expect(result.skippedIncomplete[0]).toMatchObject({
      id, year: 2026, week_number: 10,
      missing_amount_count: 1,
    });
    expect(result.skippedIncomplete[0].reason).toMatch(/no order_amount/);
  });

  it('exception rows with NULL order_amount do NOT trigger skippedIncomplete', () => {
    // The skip rule is per non-exception row only — an exception row
    // is intentionally allowed to carry a null amount.
    const id = insertRecon(db, { year: 2026, week_number: 10, supplier_total: 100 });
    insertExt(db, id, { order_amount: 100 });
    insertExt(db, id, { order_amount: null, is_exception: 1 });
    const result = findReconTotalDrift({ db });
    expect(result.mismatches).toHaveLength(0);
    expect(result.skippedIncomplete).toHaveLength(0);
  });

  it('handles a recon with ZERO PODs without false-positive skipped (LEFT JOIN synthetic-row guard)', () => {
    // A recon with no extractions left-joins to one synthetic NULL
    // row. Pre-fix on PR #275, that synthetic row tripped the
    // missing_amount_count check. Should report drift normally now.
    const id = insertRecon(db, { year: 2026, week_number: 10, supplier_total: 500 });
    const result = findReconTotalDrift({ db });
    expect(result.skippedIncomplete).toHaveLength(0);
    // 500 vs derived 0 → drift, gets bucketed as mismatch
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toMatchObject({ id, current_total: 500, derived_total: 0 });
  });

  it('orders results year DESC, week DESC', () => {
    insertRecon(db, { year: 2025, week_number: 50, supplier_total: 999 });
    insertRecon(db, { year: 2026, week_number: 5,  supplier_total: 999 });
    insertRecon(db, { year: 2026, week_number: 10, supplier_total: 999 });
    const result = findReconTotalDrift({ db });
    expect(result.mismatches.map(m => `${m.year}-${m.week_number}`)).toEqual([
      '2026-10', '2026-5', '2025-50',
    ]);
  });
});

describe('recomputeReconTotals', () => {
  let db;
  beforeEach(() => { db = freshDb(); });

  it('dryRun=true does NOT write', () => {
    const id = insertRecon(db, { year: 2026, week_number: 10, supplier_total: 100 });
    insertExt(db, id, { order_amount: 250 });
    const result = recomputeReconTotals({ db, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.mismatches).toHaveLength(1);
    expect(result.updated).toBe(0);
    // DB unchanged
    const after = db.prepare(`SELECT supplier_total FROM bat_reconciliations WHERE id = ?`).get(id);
    expect(after.supplier_total).toBe(100);
  });

  it('dryRun=false applies the updates and reports the count', () => {
    const id1 = insertRecon(db, { year: 2026, week_number: 10, supplier_total: 100 });
    insertExt(db, id1, { order_amount: 250 });
    const id2 = insertRecon(db, { year: 2026, week_number: 11, supplier_total: 999 });
    insertExt(db, id2, { order_amount: 50 });
    const result = recomputeReconTotals({ db, dryRun: false });
    expect(result.dryRun).toBe(false);
    expect(result.updated).toBe(2);
    expect(db.prepare(`SELECT supplier_total FROM bat_reconciliations WHERE id = ?`).get(id1).supplier_total).toBe(250);
    expect(db.prepare(`SELECT supplier_total FROM bat_reconciliations WHERE id = ?`).get(id2).supplier_total).toBe(50);
  });

  it('does NOT update skippedIncomplete recons even when dryRun=false', () => {
    const id = insertRecon(db, { year: 2026, week_number: 10, supplier_total: 999 });
    insertExt(db, id, { order_amount: 100 });
    insertExt(db, id, { order_amount: null });
    const result = recomputeReconTotals({ db, dryRun: false });
    expect(result.skippedIncomplete).toHaveLength(1);
    expect(result.updated).toBe(0);
    expect(db.prepare(`SELECT supplier_total FROM bat_reconciliations WHERE id = ?`).get(id).supplier_total).toBe(999);
  });

  it('default behaviour is dry-run (no dryRun arg)', () => {
    const id = insertRecon(db, { year: 2026, week_number: 10, supplier_total: 100 });
    insertExt(db, id, { order_amount: 250 });
    const result = recomputeReconTotals({ db });
    expect(result.dryRun).toBe(true);
    expect(result.updated).toBe(0);
    expect(db.prepare(`SELECT supplier_total FROM bat_reconciliations WHERE id = ?`).get(id).supplier_total).toBe(100);
  });

  it('mixed bucket: mismatches updated, skipped left alone, no-drift left alone', () => {
    const drift = insertRecon(db, { year: 2026, week_number: 10, supplier_total: 1 });
    insertExt(db, drift, { order_amount: 100 });
    const skipped = insertRecon(db, { year: 2026, week_number: 11, supplier_total: 50 });
    insertExt(db, skipped, { order_amount: null });
    const clean = insertRecon(db, { year: 2026, week_number: 12, supplier_total: 200 });
    insertExt(db, clean, { order_amount: 200 });

    const result = recomputeReconTotals({ db, dryRun: false });
    expect(result.scanned).toBe(3);
    expect(result.mismatches).toHaveLength(1);
    expect(result.skippedIncomplete).toHaveLength(1);
    expect(result.updated).toBe(1);
    // Verify each bucket landed where it should
    expect(db.prepare(`SELECT supplier_total FROM bat_reconciliations WHERE id = ?`).get(drift).supplier_total).toBe(100);
    expect(db.prepare(`SELECT supplier_total FROM bat_reconciliations WHERE id = ?`).get(skipped).supplier_total).toBe(50);
    expect(db.prepare(`SELECT supplier_total FROM bat_reconciliations WHERE id = ?`).get(clean).supplier_total).toBe(200);
  });
});
