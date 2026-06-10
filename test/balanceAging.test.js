// UI-2 — snapshot invoice aging must not be a day off on a non-UTC host.
// parseBalanceDate built UTC midnight while `today` is local midnight, so on a
// UTC+2 host a same-day invoice aged to -1 days and was dropped, shifting every
// bucket boundary a day late.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/db/index.js', () => ({ default: { prepare: vi.fn(() => ({ get: () => null, all: () => [] })) } }));

import { parseBalanceDate, getBalanceInvoiceAges } from '../src/routes/reporting.js';

const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

describe('parseBalanceDate (UI-2)', () => {
  it('parses YYYYMMDD at LOCAL midnight', () => {
    expect(parseBalanceDate('20260610').getTime()).toBe(new Date(2026, 5, 10).getTime());
  });

  it('parses D/M/YYYY at LOCAL midnight', () => {
    expect(parseBalanceDate('10/06/2026').getTime()).toBe(new Date(2026, 5, 10).getTime());
    expect(parseBalanceDate('1-6-2026').getTime()).toBe(new Date(2026, 5, 1).getTime());
  });

  it('returns null for empty / unparseable input', () => {
    expect(parseBalanceDate('')).toBeNull();
    expect(parseBalanceDate(null)).toBeNull();
    expect(parseBalanceDate('not a date')).toBeNull();
  });
});

describe('getBalanceInvoiceAges (UI-2)', () => {
  it('ages a same-day invoice to 0 days, not -1 (and does not drop it)', () => {
    const today = new Date();
    const rec = { last_unpaid_invoice_1_amount: '100', last_unpaid_invoice_1_date: ymd(today) };
    expect(getBalanceInvoiceAges(rec)).toEqual([0]);
  });

  it('ages yesterday to 1 day', () => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const rec = { last_unpaid_invoice_1_amount: '100', last_unpaid_invoice_1_date: ymd(y) };
    expect(getBalanceInvoiceAges(rec)).toEqual([1]);
  });
});
