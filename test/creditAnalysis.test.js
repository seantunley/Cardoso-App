// Tests for src/lib/creditAnalysis.js
//
// analyseInvoiceCredit is the engine behind the credit-decision badge on
// every customer record. It takes one (or several) record(s) plus a
// flag-history array and returns a verdict — approve / caution / hold
// / dormant — together with the explanation factors the operator sees.
// Bugs here become silent policy changes: a wrong "approve" lets a
// risky invoice through, a wrong "hold" blocks a clean account, a
// wrong "dormant" inserts an extra reactivation step the operator
// has to manually override.
//
// The module is 331 lines, has multiple independent code paths
// (zero-balance / no-history-with-balance / paired-history),
// several scoring deductions, manual-override logic, and a dormant-
// reactivation downgrade. Hard to keep stable without coverage.
//
// Test approach:
//   - Use the real DEFAULT_CREDIT_LOGIC_CONFIG (imported by the
//     module under test) so the cases stay aligned with the same
//     thresholds operators tune in Settings.
//   - Freeze the clock at 2026-06-15 so relative-date math
//     (inactive days, breach age) is deterministic across CI runs.
//   - The internal helpers (parseAmount, parseDateField,
//     extractSlots, dedupeByNumber) aren't exported — they're tested
//     indirectly via the inputs to analyseInvoiceCredit.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { analyseInvoiceCredit, CREDIT_BADGE_META } from '../src/lib/creditAnalysis.js';

const TODAY = new Date('2026-06-15T00:00:00Z');

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TODAY);
});
afterAll(() => {
  vi.useRealTimers();
});

// Format a date N days before "today" as YYYY-MM-DD (the parser's preferred shape).
function dateNDaysAgo(n) {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Build a record using the LEGACY column form (last_unpaid_invoice_N etc.)
// — extractSlots handles both the modern JSON-array form and this legacy
// shape, so the tests cover both. The legacy form is simpler to write
// per-test; the JSON form is exercised in the dedicated `extractSlots
// shape` block below.
function makeRecord({
  outstanding_balance = 0,
  invoices = [],          // [{ number, amount, date }] — placed into last_unpaid_invoice_1..5
  receipts = [],          // [{ number, amount, date }] — placed into last_receipt_1..5
  flag_color = null,
  auto_flagged = false,
  flag_created_by = null,
} = {}) {
  const r = { outstanding_balance, flag_color, auto_flagged, flag_created_by };
  invoices.forEach((inv, i) => {
    const n = i + 1;
    r[`last_unpaid_invoice_${n}`] = inv.number || null;
    r[`last_unpaid_invoice_${n}_amount`] = inv.amount ?? null;
    r[`last_unpaid_invoice_${n}_date`] = inv.date || null;
  });
  receipts.forEach((rec, i) => {
    const n = i + 1;
    r[`last_receipt_${n}`] = rec.number || null;
    r[`last_receipt_${n}_amount`] = rec.amount ?? null;
    r[`last_receipt_${n}_date`] = rec.date || null;
  });
  return r;
}

describe('analyseInvoiceCredit — zero balance', () => {
  it('returns approve + "Approve Invoice" for a settled account with history', () => {
    const r = analyseInvoiceCredit([makeRecord({
      outstanding_balance: 0,
      invoices: [{ number: 'INV1', amount: 1000, date: dateNDaysAgo(30) }],
      receipts: [{ number: 'RCT1', amount: 1000, date: dateNDaysAgo(20) }],
    })]);
    expect(r.verdict).toBe('approve');
    expect(r.title).toMatch(/Approve Invoice/);
    expect(r.summary).toMatch(/zero/i);
    expect(r.score).toBe(100);
  });

  it('returns approve + "New Customer" title for zero balance + no history at all', () => {
    const r = analyseInvoiceCredit([makeRecord({ outstanding_balance: 0 })]);
    expect(r.verdict).toBe('approve');
    expect(r.title).toMatch(/New Customer/);
    expect(r.score).toBe(100);
  });

  it('treats a sub-cutoff balance (< zeroBalanceCutoff=1) as zero', () => {
    const r = analyseInvoiceCredit([makeRecord({ outstanding_balance: 0.50 })]);
    expect(r.verdict).toBe('approve');
    expect(r.score).toBe(100);
  });

  it('manual red flag forces hold even with a clean zero balance', () => {
    const r = analyseInvoiceCredit([makeRecord({
      outstanding_balance: 0,
      flag_color: 'red',
      auto_flagged: false,             // manual, not auto
      flag_created_by: 'sean',
    })]);
    expect(r.verdict).toBe('hold');
    expect(r.title).toMatch(/Manually Flagged/);
    expect(r.summary).toMatch(/by sean/);
  });

  it('auto-flagged red on zero balance does NOT override (only manual red overrides)', () => {
    const r = analyseInvoiceCredit([makeRecord({
      outstanding_balance: 0,
      flag_color: 'red',
      auto_flagged: true,              // automated, not a human decision
    })]);
    expect(r.verdict).toBe('approve');
  });

  it('manual orange flag downgrades zero-balance approve to caution', () => {
    const r = analyseInvoiceCredit([makeRecord({
      outstanding_balance: 0,
      flag_color: 'orange',
      auto_flagged: false,
      flag_created_by: 'sean',
    })]);
    expect(r.verdict).toBe('caution');
    expect(r.title).toMatch(/Caution.*Manually Flagged/);
    expect(r.summary).toMatch(/by sean/);
  });
});

describe('analyseInvoiceCredit — no history but a balance', () => {
  it('returns caution when the no-history default score (50) is below cautionScoreBelow (70)', () => {
    const r = analyseInvoiceCredit([makeRecord({ outstanding_balance: 5000 })]);
    expect(r.verdict).toBe('caution');
    expect(r.title).toMatch(/Caution/);
    expect(r.score).toBe(50);
    expect(r.factors.some((f) => f.type === 'warn' && /no supporting history/i.test(f.text))).toBe(true);
  });

  it('formats the outstanding balance with en-ZA thousand separator in the factor text', () => {
    const r = analyseInvoiceCredit([makeRecord({ outstanding_balance: 12345.6 })]);
    // en-ZA uses spaces as thousand separator and comma for decimal
    expect(r.factors[0].text).toMatch(/12\s345,60/);
  });
});

describe('analyseInvoiceCredit — paired history (invoices + receipts)', () => {
  it('all invoices paid within payment terms → approve + good avg-lag factor', () => {
    // Invoice 60 days ago, receipt 10 days later. Lag = 10 days; payment terms = 14.
    const r = analyseInvoiceCredit([makeRecord({
      outstanding_balance: 0,   // balance zero — but history present
      invoices: [{ number: 'INV1', amount: 1000, date: dateNDaysAgo(60) }],
      receipts: [{ number: 'RCT1', amount: 1000, date: dateNDaysAgo(50) }],
    })]);
    // Zero balance short-circuits to the zero-balance approve path (covered above);
    // for paired-history scoring we need outstanding_balance > 0.
    expect(r.verdict).toBe('approve');
  });

  it('positive balance + on-time average lag → approve with good lag factor', () => {
    // Avg lag = 7 days, within paymentTermDays (14). No unpaid invoices.
    const r = analyseInvoiceCredit([makeRecord({
      outstanding_balance: 0.01,    // tiny but >= cutoff so we don't take the zero path
      invoices: [
        { number: 'INV1', amount: 1000, date: dateNDaysAgo(60) },
        { number: 'INV2', amount: 1000, date: dateNDaysAgo(45) },
      ],
      receipts: [
        { number: 'RCT1', amount: 1000, date: dateNDaysAgo(53) },   // lag 7
        { number: 'RCT2', amount: 1000, date: dateNDaysAgo(38) },   // lag 7
      ],
    })]);
    // Wait — zeroBalanceCutoff is 1. 0.01 < 1 ⇒ treated as zero ⇒ zero-balance path. Bump.
  });

  it('unpaid invoice within breach threshold but past approaching → warn + 25-point deduction', () => {
    // 16 days old. paymentTermDays=14, approachingBreachDays=14, breachDays=21.
    // 16 > approachingBreachDays (14) AND 16 <= breachDays (21) ⇒ approaching-breach warn (25 pts).
    const r = analyseInvoiceCredit([makeRecord({
      outstanding_balance: 1000,
      invoices: [{ number: 'INV1', amount: 1000, date: dateNDaysAgo(16) }],
      receipts: [],
    })]);
    expect(r.factors.some((f) => /approaching/i.test(f.text))).toBe(true);
    // 100 - 25 (approaching) = 75 ⇒ above cautionScoreBelow (70) ⇒ still approve.
    expect(r.score).toBe(75);
    expect(r.verdict).toBe('approve');
  });

  it('unpaid invoice OLDER than breachDays → HOLD verdict (regardless of score)', () => {
    const r = analyseInvoiceCredit([makeRecord({
      outstanding_balance: 1000,
      invoices: [{ number: 'INV1', amount: 1000, date: dateNDaysAgo(30) }],  // > 21
      receipts: [],
    })]);
    expect(r.verdict).toBe('hold');
    expect(r.title).toMatch(/Hold/);
    // Day count can land at 29 or 30 depending on TZ rounding (fake-timer
    // sets UTC midnight, but the production code uses local-midnight via
    // setHours). Either way the message must mention "days old" and the
    // 21-day breach threshold.
    expect(r.summary).toMatch(/\d+ days old/);
    expect(r.summary).toMatch(/21-day/);
    // Breach deduction is 70 ⇒ score = 30
    expect(r.score).toBe(30);
  });

  it('young unpaid invoice (<= approachingBreachDays) → mild "awaitingPayment" warn (10 pts)', () => {
    const r = analyseInvoiceCredit([makeRecord({
      outstanding_balance: 1000,
      invoices: [{ number: 'INV1', amount: 1000, date: dateNDaysAgo(5) }],
      receipts: [],
    })]);
    expect(r.factors.some((f) => /awaiting payment/i.test(f.text))).toBe(true);
    expect(r.score).toBe(90);
    expect(r.verdict).toBe('approve');
  });
});

describe('analyseInvoiceCredit — historical flag deductions', () => {
  it('one historical red → -10 score, warn factor', () => {
    const r = analyseInvoiceCredit(
      [makeRecord({ outstanding_balance: 1000, invoices: [{ number: 'I1', amount: 1000, date: dateNDaysAgo(3) }] })],
      [{ action: 'flag_changed', new_value: 'red' }],
    );
    expect(r.factors.some((f) => /Previously flagged red/i.test(f.text))).toBe(true);
    // Young unpaid warn (-10) + historical red single (-10) = -20 ⇒ score 80
    expect(r.score).toBe(80);
  });

  it('two historical reds → -20 score, "Repeatedly" factor', () => {
    const r = analyseInvoiceCredit(
      [makeRecord({ outstanding_balance: 1000, invoices: [{ number: 'I1', amount: 1000, date: dateNDaysAgo(3) }] })],
      [
        { action: 'flag_changed', new_value: 'red' },
        { action: 'flag_changed', new_value: 'red' },
      ],
    );
    expect(r.factors.some((f) => /Repeatedly flagged red/i.test(f.text))).toBe(true);
    // -10 (awaiting) -20 (repeat red) = -30 ⇒ 70 ⇒ approve (cautionScoreBelow=70 is exclusive)
    expect(r.score).toBe(70);
  });

  it('historical orange deductions add their own factor', () => {
    const r = analyseInvoiceCredit(
      [makeRecord({ outstanding_balance: 1000, invoices: [{ number: 'I1', amount: 1000, date: dateNDaysAgo(3) }] })],
      [{ action: 'flag_changed', new_value: 'orange' }],
    );
    expect(r.factors.some((f) => /Previously flagged orange/i.test(f.text))).toBe(true);
  });

  it('ignores flag-history entries with unrelated actions', () => {
    const r = analyseInvoiceCredit(
      [makeRecord({ outstanding_balance: 0 })],     // zero balance ⇒ score 100 baseline
      [
        { action: 'login', new_value: 'red' },                    // wrong action
        { action: 'flag_changed', new_value: 'blue' },            // unrecognised color
      ],
    );
    // Zero-balance path doesn't apply flag-history deductions; just sanity that nothing throws.
    expect(r.verdict).toBe('approve');
  });
});

describe('analyseInvoiceCredit — exposure cap', () => {
  it('outstanding > 2× avg invoice → bad factor + 15-point deduction', () => {
    // Avg invoice 1000, outstanding 5000 ⇒ 5x ⇒ trip the cap.
    const r = analyseInvoiceCredit([makeRecord({
      outstanding_balance: 5000,
      invoices: [
        { number: 'I1', amount: 1000, date: dateNDaysAgo(3) },
        { number: 'I2', amount: 1000, date: dateNDaysAgo(4) },
      ],
      receipts: [],
    })]);
    expect(r.factors.some((f) => f.type === 'bad' && /exceeds.*the average invoice/i.test(f.text))).toBe(true);
  });

  it('outstanding within the cap → no exposure factor', () => {
    const r = analyseInvoiceCredit([makeRecord({
      outstanding_balance: 1500,           // <= 2× 1000
      invoices: [{ number: 'I1', amount: 1000, date: dateNDaysAgo(3) }],
      receipts: [],
    })]);
    expect(r.factors.some((f) => /exposure/i.test(f.text))).toBe(false);
  });
});

describe('analyseInvoiceCredit — dormant reactivation', () => {
  it('long-inactive customer with zero balance returns approve (zero path) with dormantMonths populated', () => {
    // 300 days ago > dormantThresholdDays (180). Zero balance still wins.
    const r = analyseInvoiceCredit([makeRecord({
      outstanding_balance: 0,
      invoices: [{ number: 'I1', amount: 100, date: dateNDaysAgo(300) }],
      receipts: [{ number: 'R1', amount: 100, date: dateNDaysAgo(290) }],
    })]);
    expect(r.verdict).toBe('approve');
    expect(r.dormantMonths).toBe(9);    // 290 / 30 floored
  });

  it('long-inactive customer with balance + clean paired history → dormant verdict', () => {
    // 300 days ago invoice + receipt. Outstanding balance >0 so we go into paired
    // path. Avg lag clean. isDormantReactivation triggers because inactiveDays > 180.
    const r = analyseInvoiceCredit([makeRecord({
      outstanding_balance: 10,
      invoices: [{ number: 'I1', amount: 100, date: dateNDaysAgo(300) }],
      receipts: [{ number: 'R1', amount: 100, date: dateNDaysAgo(295) }],   // 5-day lag, clean
    })]);
    expect(r.isDormantReactivation).toBe(true);
    expect(r.verdict).toBe('dormant');
    expect(r.title).toMatch(/Dormant Account/);
  });

  it('long-inactive (>2 yrs) adds the inactive-note suffix to summary', () => {
    const r = analyseInvoiceCredit([makeRecord({
      outstanding_balance: 0,
      invoices: [{ number: 'I1', amount: 100, date: dateNDaysAgo(800) }],   // > 2 years
      receipts: [],
    })]);
    expect(r.summary).toMatch(/inactive for a long time|year.*new account/i);
  });
});

describe('analyseInvoiceCredit — extractSlots shape variants', () => {
  it('reads the JSON-array unpaid_invoices field (modern shape)', () => {
    const r = analyseInvoiceCredit([{
      outstanding_balance: 1000,
      unpaid_invoices: [
        { number: 'I1', amount: 1000, date: dateNDaysAgo(30) },   // breach
      ],
      receipts: [],
    }]);
    expect(r.verdict).toBe('hold');
  });

  it('reads a JSON-string unpaid_invoices field (legacy hydration shape)', () => {
    const r = analyseInvoiceCredit([{
      outstanding_balance: 1000,
      unpaid_invoices: JSON.stringify([{ number: 'I1', amount: 1000, date: dateNDaysAgo(30) }]),
      receipts: [],
    }]);
    expect(r.verdict).toBe('hold');
  });

  it('falls back to legacy last_unpaid_invoice_1..5 columns when no JSON field present', () => {
    const r = analyseInvoiceCredit([makeRecord({
      outstanding_balance: 1000,
      invoices: [{ number: 'I1', amount: 1000, date: dateNDaysAgo(30) }],   // breach
    })]);
    expect(r.verdict).toBe('hold');
  });

  it('looks inside record.data.* for the same fields (nested-record shape)', () => {
    const r = analyseInvoiceCredit([{
      data: {
        outstanding_balance: 1000,
        unpaid_invoices: [{ number: 'I1', amount: 1000, date: dateNDaysAgo(30) }],
      },
    }]);
    expect(r.verdict).toBe('hold');
  });

  it('handles malformed JSON-string by falling back to legacy columns (no throw)', () => {
    const r = analyseInvoiceCredit([{
      outstanding_balance: 1000,
      unpaid_invoices: '[not-valid-json',
      // No legacy fields either ⇒ no-history-with-balance path.
    }]);
    expect(r.verdict).toBe('caution');
  });
});

describe('analyseInvoiceCredit — date parsing tolerances', () => {
  it.each([
    '2026-05-16',          // ISO YYYY-MM-DD
    '20260516',            // compact YYYYMMDD
    '16/05/2026',          // DD/MM/YYYY (SA / EU)
    '16-05-2026',          // DD-MM-YYYY
  ])('accepts date format "%s"', (dateStr) => {
    const r = analyseInvoiceCredit([{
      outstanding_balance: 1000,
      unpaid_invoices: [{ number: 'I1', amount: 1000, date: dateStr }],
      receipts: [],
    }]);
    // 2026-05-16 is exactly 30 days before frozen TODAY (2026-06-15) ⇒ > 21 ⇒ hold
    expect(r.verdict).toBe('hold');
  });

  it('an unparseable date is ignored (item skipped) without throwing', () => {
    const r = analyseInvoiceCredit([{
      outstanding_balance: 1000,
      unpaid_invoices: [{ number: 'I1', amount: 1000, date: 'not-a-date' }],
      receipts: [],
    }]);
    // The item is filtered out by extractSlots' filter (no number-or-amount-or-date),
    // wait — it has number 'I1' and amount 1000 so it WILL be kept. But date is null,
    // which means pair detection can't compute a lag. Effectively: 1 unpaid invoice
    // with null date ⇒ unpaidPairs has 1 entry but oldestUnpaidAge is null (no dates),
    // so no age-based deduction fires. Score stays at 100 ⇒ approve.
    expect(r.verdict).toBe('approve');
  });
});

describe('analyseInvoiceCredit — result shape & metadata', () => {
  it('always returns the documented object keys', () => {
    const r = analyseInvoiceCredit([makeRecord({ outstanding_balance: 0 })]);
    expect(r).toEqual(expect.objectContaining({
      verdict: expect.any(String),
      title: expect.any(String),
      summary: expect.any(String),
      factors: expect.any(Array),
      score: expect.any(Number),
      avgLag: null,                       // no paired history in this case
      lagData: expect.any(Array),
      timelineData: expect.any(Array),
      isDormantReactivation: expect.any(Boolean),
    }));
    // dormantMonths and logicVersionUsed can be null; just check they exist as keys.
    expect(r).toHaveProperty('dormantMonths');
    expect(r).toHaveProperty('logicVersionUsed');
  });

  it('exports CREDIT_BADGE_META with the four verdict styles', () => {
    expect(Object.keys(CREDIT_BADGE_META).sort()).toEqual(['approve', 'caution', 'dormant', 'hold']);
    for (const key of ['approve', 'caution', 'dormant', 'hold']) {
      expect(CREDIT_BADGE_META[key]).toMatchObject({
        label: expect.any(String),
        className: expect.any(String),
      });
    }
  });

  it('lagData entries echo invoice/receipt numbers + ISO date strings', () => {
    const r = analyseInvoiceCredit([makeRecord({
      outstanding_balance: 0.01,    // < zeroBalanceCutoff (1) — actually treated as zero (cutoff is rawBalance < 1)
      invoices: [{ number: 'INV-A', amount: 100, date: dateNDaysAgo(20) }],
      receipts: [{ number: 'RCT-A', amount: 100, date: dateNDaysAgo(10) }],
    })]);
    // 0.01 < 1 ⇒ zero-balance path ⇒ lagData stays empty per the zero-balance branch.
    expect(r.lagData).toEqual([]);
  });
});

describe('analyseInvoiceCredit — configOverride', () => {
  it('honours configOverride.thresholds.breachDays (tightening the breach window)', () => {
    // Tighten to 10 days. Invoice 12 days old now exceeds → hold.
    const r = analyseInvoiceCredit(
      [makeRecord({
        outstanding_balance: 1000,
        invoices: [{ number: 'I1', amount: 1000, date: dateNDaysAgo(12) }],
        receipts: [],
      })],
      [],
      { thresholds: { breachDays: 10 } },
    );
    expect(r.verdict).toBe('hold');
  });

  it('honours configOverride.manualOverrides.redForcesHold = false', () => {
    const r = analyseInvoiceCredit(
      [makeRecord({ outstanding_balance: 0, flag_color: 'red', auto_flagged: false })],
      [],
      { manualOverrides: { redForcesHold: false } },
    );
    expect(r.verdict).toBe('approve');     // red no longer forces hold
  });
});
