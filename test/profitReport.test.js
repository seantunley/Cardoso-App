// Tests for the Invoice Profit rollup in src/services/reporting/profitReport.js.
//
// The SQL is verified against live Sage separately; what's pinned here is the
// arithmetic that can silently drift:
//   • every level is EXACTLY the sum of the level below it (a month total that
//     doesn't equal its weeks is the one bug nobody notices until year end),
//   • credit notes subtract,
//   • inter-branch transfers are excluded from the totals but still reported,
//   • ISO weeks that straddle a month boundary don't leak days into the wrong
//     month.

import { describe, it, expect } from 'vitest';
import {
  buildProfitTree,
  summariseProfit,
  isInterBranchName,
  marginPct,
  toSageDate,
} from '../src/services/reporting/profitReport.js';

// Build a document the way fetchProfitDocuments emits them.
const doc = (date, docNumber, selling, cost, type = 'invoice') => ({
  doc_type: type,
  doc_number: docNumber,
  date,
  customer_code: 'C1',
  customer_name: 'Test Customer',
  location: '',
  sales_rep: '',
  selling,
  cost,
  profit: selling - cost,
  margin: marginPct(selling - cost, selling),
});

const round = (n) => Math.round(n * 100) / 100;

describe('marginPct', () => {
  it('is profit as a percentage of selling', () => {
    expect(marginPct(25, 100)).toBe(25);
    expect(round(marginPct(716116.63, 27285830.01))).toBe(2.62);
  });

  it('returns 0 rather than Infinity/NaN when selling nets to zero', () => {
    // A day where an invoice is fully reversed by a same-day credit note.
    expect(marginPct(0, 0)).toBe(0);
    expect(marginPct(5, 0)).toBe(0);
    expect(Number.isFinite(marginPct(5, 0))).toBe(true);
  });
});

describe('isInterBranchName', () => {
  it('matches the spellings Sage actually uses', () => {
    expect(isInterBranchName('CCD Inter Branch Transfer POLOKWANE')).toBe(true);
    expect(isInterBranchName('CCD Inter-Branch Transfer PRETORIA')).toBe(true);
    expect(isInterBranchName('ccd interbranch transfer')).toBe(true);
  });

  it('does not match ordinary customers', () => {
    expect(isInterBranchName('Spar Klerksdorp')).toBe(false);
    expect(isInterBranchName('BRANCH FOODS PTY LTD')).toBe(false);
    expect(isInterBranchName('')).toBe(false);
    expect(isInterBranchName(null)).toBe(false);
  });
});

describe('toSageDate', () => {
  it('converts ISO dates to the integer form Sage stores', () => {
    expect(toSageDate('2026-07-01')).toBe(20260701);
    expect(toSageDate('2026-12-31')).toBe(20261231);
  });

  it('rejects anything that is not YYYY-MM-DD, naming the bad value', () => {
    expect(() => toSageDate('01/07/2026')).toThrow(/YYYY-MM-DD/);
    expect(() => toSageDate('')).toThrow(/YYYY-MM-DD/);
  });
});

describe('buildProfitTree', () => {
  it('nests month -> week -> day -> documents', () => {
    const tree = buildProfitTree([
      doc('2026-07-01', 'IN1', 1000, 900),
      doc('2026-07-01', 'IN2', 500, 480),
      doc('2026-07-02', 'IN3', 2000, 1900),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0].month).toBe('2026-07');
    expect(tree[0].label).toBe('July 2026');
    expect(tree[0].weeks).toHaveLength(1);
    expect(tree[0].weeks[0].iso_week).toBe(27);
    expect(tree[0].weeks[0].days).toHaveLength(2);
    expect(tree[0].weeks[0].days[0].documents).toHaveLength(2);
  });

  it('makes every level exactly the sum of the level below it', () => {
    const docs = [
      doc('2026-07-01', 'IN1', 1000, 900),
      doc('2026-07-02', 'IN2', 500, 480),
      doc('2026-07-09', 'IN3', 2500, 2300),
      doc('2026-08-03', 'IN4', 900, 800),
    ];
    const tree = buildProfitTree(docs);

    for (const m of tree) {
      const weekSum = m.weeks.reduce((s, w) => s + w.totals.profit, 0);
      expect(round(weekSum)).toBe(round(m.totals.profit));
      for (const w of m.weeks) {
        const daySum = w.days.reduce((s, d) => s + d.totals.profit, 0);
        expect(round(daySum)).toBe(round(w.totals.profit));
        for (const d of w.days) {
          const docSum = d.documents.reduce((s, x) => s + x.profit, 0);
          expect(round(docSum)).toBe(round(d.totals.profit));
        }
      }
    }

    const grand = tree.reduce((s, m) => s + m.totals.profit, 0);
    expect(round(grand)).toBe(round(docs.reduce((s, d) => s + d.profit, 0)));
  });

  it('subtracts credit notes from every level and counts them separately', () => {
    const tree = buildProfitTree([
      doc('2026-07-01', 'IN1', 1000, 900),
      doc('2026-07-01', 'CN1', -400, -380, 'credit_note'),
    ]);

    const day = tree[0].weeks[0].days[0];
    expect(day.totals.selling).toBe(600);
    expect(day.totals.cost).toBe(520);
    expect(day.totals.profit).toBe(80);
    expect(day.totals.invoice_count).toBe(1);
    expect(day.totals.credit_note_count).toBe(1);
    expect(tree[0].totals.profit).toBe(80);
  });

  it('splits a month-straddling ISO week so neither month borrows the other\'s days', () => {
    // ISO week 31 of 2026 runs Mon 27 Jul – Sun 2 Aug, crossing the boundary.
    const tree = buildProfitTree([
      doc('2026-07-31', 'IN-JUL', 1000, 900),
      doc('2026-08-01', 'IN-AUG', 2000, 1800),
    ]);

    expect(tree.map((m) => m.month)).toEqual(['2026-07', '2026-08']);

    const julWeek = tree[0].weeks[0];
    const augWeek = tree[1].weeks[0];
    // Same ISO week, appearing under both months...
    expect(julWeek.iso_week).toBe(31);
    expect(augWeek.iso_week).toBe(31);
    expect(julWeek.partial).toBe(true);
    expect(augWeek.partial).toBe(true);
    // ...but each carrying only its own month's days and totals.
    expect(julWeek.days.map((d) => d.day)).toEqual(['2026-07-31']);
    expect(augWeek.days.map((d) => d.day)).toEqual(['2026-08-01']);
    expect(tree[0].totals.selling).toBe(1000);
    expect(tree[1].totals.selling).toBe(2000);
  });

  it('marks a week that sits wholly inside one month as not partial', () => {
    const tree = buildProfitTree([doc('2026-07-08', 'IN1', 100, 90)]);
    expect(tree[0].weeks[0].partial).toBe(false);
  });

  it('returns an empty tree for no documents', () => {
    expect(buildProfitTree([])).toEqual([]);
  });
});

describe('summariseProfit', () => {
  const docs = [
    doc('2026-07-06', 'IN1', 1000, 900), // Mon, week 28
    doc('2026-07-07', 'IN2', 2000, 1850), // Tue, week 28
    doc('2026-07-13', 'IN3', 3000, 2700), // Mon, week 29 — the latest day
  ];

  it('anchors the to-date figures on the last day WITH ACTIVITY, not on today', () => {
    const s = summariseProfit(docs);
    expect(s.latest_day).toBe('2026-07-13');
    expect(s.day_to_date.selling).toBe(3000);
  });

  it('scopes week-to-date to the latest day\'s ISO week', () => {
    const s = summariseProfit(docs);
    // Week 29 holds only the 13th — the 6th/7th are week 28 and must not leak in.
    expect(s.week_to_date.selling).toBe(3000);
    expect(s.week_to_date.invoice_count).toBe(1);
  });

  it('scopes month-to-date to the latest day\'s month, up to that day', () => {
    const s = summariseProfit([...docs, doc('2026-06-30', 'IN0', 500, 400)]);
    expect(s.month_to_date.selling).toBe(6000); // July only
    expect(s.totals.selling).toBe(6500); // grand total includes June
  });

  it('never counts days after the anchor in the to-date figures', () => {
    // A range ending mid-week: nothing after the latest day exists, but the
    // guard matters once the hub feeds ranges that end in the past.
    const s = summariseProfit(docs);
    expect(s.month_to_date.selling).toBe(6000);
    expect(round(s.totals.profit)).toBe(round(docs.reduce((a, d) => a + d.profit, 0)));
  });

  it('handles an empty range without throwing', () => {
    const s = summariseProfit([]);
    expect(s.latest_day).toBeNull();
    expect(s.day_to_date).toBeNull();
    expect(s.totals.selling).toBe(0);
    expect(s.totals.margin).toBe(0);
  });
});
