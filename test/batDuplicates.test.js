// Contract tests for src/services/bat/duplicates.js — pins the SQL
// behaviour of buildGlobalDuplicateIndex, the cross-recon dupe detector
// that drives the "duplicate invoice" badges in the BAT UI.
//
// What's pinned:
//   - Only invoices with >1 occurrence anywhere appear in the index
//   - Keys are UPPER(TRIM(extracted_invoice)) — case + whitespace fold
//   - NULL and empty/whitespace-only invoices are skipped (no '' bucket)
//   - Each entry carries count + per-occurrence (extraction_id,
//     reconciliation_id, week, year)
//   - Cross-recon: same number in different weeks IS a dupe (the whole
//     point of this query — within-recon-only checks miss the W19↔W22
//     "1234↔1334↔1234" misread chain)
//
// The service takes `db` as an explicit arg, so tests build a fresh
// in-memory SQLite per case — no module-level shimming needed.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { buildGlobalDuplicateIndex } from '../src/services/bat/duplicates.js';

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
      extracted_invoice TEXT
    );
  `);
});

function addRecon(week, year) {
  return db.prepare('INSERT INTO bat_reconciliations (week_number, year) VALUES (?, ?)')
    .run(week, year).lastInsertRowid;
}

function addExtraction(reconId, invoice) {
  return db.prepare('INSERT INTO bat_invoice_extractions (reconciliation_id, extracted_invoice) VALUES (?, ?)')
    .run(reconId, invoice).lastInsertRowid;
}

describe('buildGlobalDuplicateIndex', () => {
  it('returns an empty Map when no extractions exist', () => {
    const idx = buildGlobalDuplicateIndex({ db });
    expect(idx).toBeInstanceOf(Map);
    expect(idx.size).toBe(0);
  });

  it('omits invoices that appear only once (size-keeping invariant)', () => {
    const r = addRecon(1, 2026);
    addExtraction(r, 'AAA-100');
    addExtraction(r, 'AAA-200');
    addExtraction(r, 'AAA-300');
    const idx = buildGlobalDuplicateIndex({ db });
    expect(idx.size).toBe(0);
  });

  it('returns duplicates that appear within a single recon', () => {
    const r = addRecon(5, 2026);
    addExtraction(r, 'INV-1');
    addExtraction(r, 'INV-1');
    const idx = buildGlobalDuplicateIndex({ db });
    expect(idx.size).toBe(1);
    const entry = idx.get('INV-1');
    expect(entry.count).toBe(2);
    expect(entry.occurrences).toHaveLength(2);
    expect(entry.occurrences.every(o => o.reconciliation_id === r)).toBe(true);
  });

  it('detects CROSS-RECON duplicates — the whole reason this exists', () => {
    // The W19→W22 misread chain from the comment.
    const r19 = addRecon(19, 2026);
    const r22 = addRecon(22, 2026);
    addExtraction(r19, '1234');
    addExtraction(r22, '1234');
    const idx = buildGlobalDuplicateIndex({ db });
    const entry = idx.get('1234');
    expect(entry.count).toBe(2);
    const recons = entry.occurrences.map(o => o.reconciliation_id).sort();
    expect(recons).toEqual([r19, r22].sort());
    const weeks = entry.occurrences.map(o => o.week).sort();
    expect(weeks).toEqual([19, 22]);
  });

  it('uses UPPER(TRIM(...)) for the key — case + whitespace fold', () => {
    const r = addRecon(1, 2026);
    addExtraction(r, 'abc-1');
    addExtraction(r, 'ABC-1');
    addExtraction(r, '  abc-1  ');
    const idx = buildGlobalDuplicateIndex({ db });
    expect(idx.size).toBe(1);
    const entry = idx.get('ABC-1');
    expect(entry).toBeDefined();
    expect(entry.count).toBe(3);
  });

  it('skips NULL and empty/whitespace-only invoices', () => {
    const r = addRecon(1, 2026);
    addExtraction(r, null);
    addExtraction(r, null);
    addExtraction(r, '');
    addExtraction(r, '');
    addExtraction(r, '   ');
    addExtraction(r, '   ');
    const idx = buildGlobalDuplicateIndex({ db });
    // Despite multiple NULLs and blank rows, no bucket should exist —
    // the WHERE clause excludes them. A '' bucket would be a bug.
    expect(idx.has('')).toBe(false);
    expect(idx.has(null)).toBe(false);
    expect(idx.size).toBe(0);
  });

  it('attaches per-occurrence (extraction_id, reconciliation_id, week, year)', () => {
    const r19 = addRecon(19, 2025);
    const r22 = addRecon(22, 2026);
    const e1 = addExtraction(r19, 'X');
    const e2 = addExtraction(r22, 'X');
    const idx = buildGlobalDuplicateIndex({ db });
    const occ = idx.get('X').occurrences;
    // Order isn't guaranteed by the query, so look up by extraction_id.
    const byId = Object.fromEntries(occ.map(o => [o.extraction_id, o]));
    expect(byId[e1]).toEqual({ extraction_id: e1, reconciliation_id: r19, week: 19, year: 2025 });
    expect(byId[e2]).toEqual({ extraction_id: e2, reconciliation_id: r22, week: 22, year: 2026 });
  });

  it('handles a mix of singletons and duplicates without leaking singletons', () => {
    const r1 = addRecon(1, 2026);
    const r2 = addRecon(2, 2026);
    addExtraction(r1, 'DUP');
    addExtraction(r2, 'DUP');
    addExtraction(r1, 'SINGLE-A');
    addExtraction(r2, 'SINGLE-B');
    addExtraction(r2, 'SINGLE-C');
    const idx = buildGlobalDuplicateIndex({ db });
    expect(idx.size).toBe(1);
    expect(idx.get('DUP').count).toBe(2);
    expect(idx.has('SINGLE-A')).toBe(false);
    expect(idx.has('SINGLE-B')).toBe(false);
    expect(idx.has('SINGLE-C')).toBe(false);
  });
});
