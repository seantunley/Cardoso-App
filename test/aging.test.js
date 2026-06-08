// Tests for the shared open-item aging engine (src/services/aging.js).
//
// The engine must duplicate Sage 300's Aged Trial Balance method: age each
// open document individually by due date, distribute an entity's balance across
// the weekly periods (Current / 7-13 / 14-20 / 21+), and treat credit notes as
// Current by default. These tests pin the period boundaries, the due-vs-document
// basis, the missing-date fallback, and the credit-note handling so a refactor
// can't silently regress the financial output.

import { describe, it, expect } from 'vitest';
import { ageOpenItems, WEEKLY_BUCKETS, BUCKET_KEYS } from '../src/services/aging.js';

const AS_OF = new Date(2026, 5, 8); // 2026-06-08, local midnight

// 'YYYY-MM-DD' string for a date N days before AS_OF (the format the sync stores).
function daysBefore(n) {
  const d = new Date(2026, 5, 8);
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const doc = (over) => ({ entityCode: 'C1', entityName: 'Acme', outstanding: 100, ...over });
const age = (docs, opts) => ageOpenItems(docs, { asOf: AS_OF, ...opts });

describe('aging — weekly bucket boundaries (by due date)', () => {
  const cases = [
    [6, 'current'],
    [7, '7-13'],
    [13, '7-13'],
    [14, '14-20'],
    [20, '14-20'],
    [21, '21+'],
    [400, '21+'],
  ];
  for (const [days, bucket] of cases) {
    it(`due ${days} days ago → ${bucket}`, () => {
      const r = age([doc({ dueDate: daysBefore(days) })]);
      expect(r.entities[0].bucket_amounts[bucket]).toBe(100);
      expect(r.buckets[bucket]).toBe(100);
    });
  }

  it('not yet due (due in the future) → current', () => {
    const r = age([doc({ dueDate: daysBefore(-30) })]);
    expect(r.entities[0].bucket_amounts.current).toBe(100);
  });

  it('default boundaries are [7,14,21]', () => {
    expect(WEEKLY_BUCKETS).toEqual([7, 14, 21]);
  });
});

describe('aging — basis: due vs document date', () => {
  // Document raised 30 days ago but only due 3 days ago.
  const d = doc({ date: daysBefore(30), dueDate: daysBefore(3) });

  it("basis 'due' (default) ages by the due date → current", () => {
    expect(age([d]).entities[0].bucket_amounts.current).toBe(100);
  });

  it("basis 'document' ages by the document date → 21+", () => {
    expect(age([d], { basis: 'document' }).entities[0].bucket_amounts['21+']).toBe(100);
  });

  it('missing due date falls back to document date even under due basis', () => {
    const r = age([doc({ date: daysBefore(25), dueDate: null })]);
    expect(r.entities[0].bucket_amounts['21+']).toBe(100);
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

describe('aging — credit notes (negative outstanding)', () => {
  const oldCredit = doc({ outstanding: -500, dueDate: daysBefore(90) });

  it("creditNoteMode 'current' (default) forces an old credit into current", () => {
    const r = age([oldCredit]);
    expect(r.entities[0].bucket_amounts.current).toBe(-500);
    expect(r.entities[0].bucket_amounts['21+']).toBe(0);
  });

  it("creditNoteMode 'age' ages the credit by its date", () => {
    const r = age([oldCredit], { creditNoteMode: 'age' });
    expect(r.entities[0].bucket_amounts['21+']).toBe(-500);
    expect(r.entities[0].bucket_amounts.current).toBe(0);
  });
});

describe('aging — per-entity distribution across buckets', () => {
  const r = age([
    doc({ outstanding: 100, dueDate: daysBefore(3) }),   // current
    doc({ outstanding: 200, dueDate: daysBefore(10) }),  // 7-13
    doc({ outstanding: 300, dueDate: daysBefore(25) }),  // 21+
  ]);
  const e = r.entities[0];

  it('distributes each document into its own bucket (not whole balance in one)', () => {
    expect(e.bucket_amounts).toMatchObject({ current: 100, '7-13': 200, '14-20': 0, '21+': 300, unknown: 0 });
  });
  it('entity total is the sum of its documents', () => {
    expect(e.total).toBe(600);
  });
  it('primary_bucket and oldest_age_days reflect the oldest document', () => {
    expect(e.oldest_age_days).toBe(25);
    expect(e.primary_bucket).toBe('21+');
  });
  it('top-level totals reconcile to the documents', () => {
    expect(r.total_outstanding).toBe(600);
    expect(BUCKET_KEYS.reduce((s, k) => s + r.buckets[k], 0)).toBe(600);
  });
});

describe('aging — per-bucket entity counts', () => {
  it('counts an entity once per bucket it touches, across multiple entities', () => {
    const r = age([
      { entityCode: 'A', outstanding: 100, dueDate: daysBefore(3) },   // A current
      { entityCode: 'A', outstanding: 100, dueDate: daysBefore(25) },  // A 21+
      { entityCode: 'B', outstanding: 100, dueDate: daysBefore(3) },   // B current
    ]);
    expect(r.bucket_counts.current).toBe(2); // A and B
    expect(r.bucket_counts['21+']).toBe(1);  // A only
    expect(r.entities).toHaveLength(2);
  });
});
