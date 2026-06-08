// Tests for the shared open-item aging engine (src/services/aging.js).
//
// The engine duplicates this site's Sage 300 Aged Trial Balance: age each open
// document individually by DOCUMENT date, distribute an entity's balance across
// the periods Current (≤0) / 1–7 / 8–14 / 15–21 / Over 21, and age credit notes
// by their own date (not "As Current"). These tests pin the period boundaries,
// the document-vs-due basis, the missing-date fallback, and the credit-note
// behaviour so a refactor can't silently regress the financial output.

import { describe, it, expect } from 'vitest';
import { ageOpenItems, BUCKET_KEYS, AR_SCHEME, AP_SCHEME } from '../src/services/aging.js';

const AS_OF = new Date(2026, 5, 8); // 2026-06-08, local midnight

// 'YYYY-MM-DD' string for a date N days before AS_OF (the format the sync stores).
function daysBefore(n) {
  const d = new Date(2026, 5, 8);
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const doc = (over) => ({ entityCode: 'C1', entityName: 'Acme', outstanding: 100, ...over });
const age = (docs, opts) => ageOpenItems(docs, { asOf: AS_OF, ...opts });

describe('aging — Sage period boundaries (by document date)', () => {
  const cases = [
    [0, 'current'],
    [1, '1-7'],
    [7, '1-7'],
    [8, '8-14'],
    [14, '8-14'],
    [15, '15-21'],
    [21, '15-21'],
    [22, 'over-21'],
    [400, 'over-21'],
  ];
  for (const [days, bucket] of cases) {
    it(`document ${days} days old → ${bucket}`, () => {
      const r = age([doc({ date: daysBefore(days) })]);
      expect(r.entities[0].bucket_amounts[bucket]).toBe(100);
      expect(r.buckets[bucket]).toBe(100);
    });
  }

  it('future-dated document (≤0 days) → current', () => {
    const r = age([doc({ date: daysBefore(-5) })]);
    expect(r.entities[0].bucket_amounts.current).toBe(100);
  });

  it('default (AR) exposes the weekly buckets plus unknown', () => {
    expect(BUCKET_KEYS).toEqual(['current', '1-7', '8-14', '15-21', 'over-21', 'unknown']);
    expect(AR_SCHEME.basis).toBe('document');
  });
});

describe('aging — AP scheme (creditors): due date + monthly periods', () => {
  it('ages by DUE date into Current/1-30/31-60/61-90/over-90', () => {
    const cases = [
      [0, 'current'],
      [1, '1-30'], [30, '1-30'],
      [31, '31-60'], [60, '31-60'],
      [61, '61-90'], [90, '61-90'],
      [91, 'over-90'], [400, 'over-90'],
    ];
    for (const [days, bucket] of cases) {
      const r = age([doc({ dueDate: daysBefore(days), date: daysBefore(days + 5) })], { scheme: AP_SCHEME });
      expect(r.entities[0].bucket_amounts[bucket]).toBe(100);
    }
  });
  it('AP scheme defaults to the due-date basis', () => {
    // due 5 days ago (→1-30) but document 100 days ago (→over-90); due wins.
    const r = age([doc({ dueDate: daysBefore(5), date: daysBefore(100) })], { scheme: AP_SCHEME });
    expect(r.entities[0].bucket_amounts['1-30']).toBe(100);
    expect(AP_SCHEME.basis).toBe('due');
  });
});

describe('aging — basis: document (default) vs due', () => {
  // Dated 3 days ago but due 30 days ago (unusual, but proves which date wins).
  const d = doc({ date: daysBefore(3), dueDate: daysBefore(30) });

  it("default basis 'document' ages by the document date → 1-7", () => {
    expect(age([d]).entities[0].bucket_amounts['1-7']).toBe(100);
  });

  it("basis 'due' ages by the due date → over-21", () => {
    expect(age([d], { basis: 'due' }).entities[0].bucket_amounts['over-21']).toBe(100);
  });

  it('missing document date falls back to due date under document basis', () => {
    const r = age([doc({ date: null, dueDate: daysBefore(10) })]);
    expect(r.entities[0].bucket_amounts['8-14']).toBe(100);
  });
});

describe('aging — undated documents', () => {
  it('no usable date → unknown bucket', () => {
    const r = age([doc({ date: null, dueDate: null })]);
    expect(r.entities[0].bucket_amounts.unknown).toBe(100);
    expect(r.entities[0].oldest_age_days).toBeNull();
    expect(r.entities[0].primary_bucket).toBe('unknown');
  });
});

describe('aging — credit notes age by their own date', () => {
  it('an old credit note (negative) ages into Over 21, not Current', () => {
    const r = age([doc({ outstanding: -500, date: daysBefore(90) })]);
    expect(r.entities[0].bucket_amounts['over-21']).toBe(-500);
    expect(r.entities[0].bucket_amounts.current).toBe(0);
  });
  it('a recent credit note ages into its period', () => {
    const r = age([doc({ outstanding: -500, date: daysBefore(5) })]);
    expect(r.entities[0].bucket_amounts['1-7']).toBe(-500);
  });
});

describe('aging — per-entity distribution across buckets', () => {
  const r = age([
    doc({ outstanding: 100, date: daysBefore(3) }),   // 1-7
    doc({ outstanding: 200, date: daysBefore(10) }),  // 8-14
    doc({ outstanding: 300, date: daysBefore(30) }),  // over-21
  ]);
  const e = r.entities[0];

  it('distributes each document into its own bucket', () => {
    expect(e.bucket_amounts).toMatchObject({ current: 0, '1-7': 100, '8-14': 200, '15-21': 0, 'over-21': 300, unknown: 0 });
  });
  it('entity total is the sum of its documents', () => {
    expect(e.total).toBe(600);
  });
  it('primary_bucket and oldest_age_days reflect the oldest document', () => {
    expect(e.oldest_age_days).toBe(30);
    expect(e.primary_bucket).toBe('over-21');
  });
  it('top-level totals reconcile to the documents', () => {
    expect(r.total_outstanding).toBe(600);
    expect(BUCKET_KEYS.reduce((s, k) => s + r.buckets[k], 0)).toBe(600);
  });
});

describe('aging — per-bucket entity counts', () => {
  it('counts an entity once per bucket it touches, across multiple entities', () => {
    const r = age([
      { entityCode: 'A', outstanding: 100, date: daysBefore(3) },   // A 1-7
      { entityCode: 'A', outstanding: 100, date: daysBefore(30) },  // A over-21
      { entityCode: 'B', outstanding: 100, date: daysBefore(3) },   // B 1-7
    ]);
    expect(r.bucket_counts['1-7']).toBe(2); // A and B
    expect(r.bucket_counts['over-21']).toBe(1); // A only
    expect(r.entities).toHaveLength(2);
  });
});
