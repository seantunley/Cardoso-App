// UI-2 — snapshot invoice aging must not be a day off on a non-UTC host.
// parseBalanceDate built UTC midnight while `today` is local midnight, so on a
// UTC+2 host a same-day invoice aged to -1 days and was dropped, shifting every
// bucket boundary a day late.

import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/db/index.js', () => ({ default: { prepare: vi.fn(() => ({ get: () => null, all: () => [] })) } }));

import { parseBalanceDate, getBalanceInvoiceAges, calendarDayAge } from '../src/routes/reporting.js';

const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

describe('parseBalanceDate (UI-2)', () => {
  it('parses YYYYMMDD at LOCAL midnight', () => {
    expect(parseBalanceDate('20260610').getTime()).toBe(new Date(2026, 5, 10).getTime());
  });

  it('parses D/M/YYYY at LOCAL midnight', () => {
    expect(parseBalanceDate('10/06/2026').getTime()).toBe(new Date(2026, 5, 10).getTime());
    expect(parseBalanceDate('1-6-2026').getTime()).toBe(new Date(2026, 5, 1).getTime());
  });

  it('parses YYYY-MM-DD (date-only ISO) at LOCAL midnight, not UTC', () => {
    expect(parseBalanceDate('2026-06-10').getTime()).toBe(new Date(2026, 5, 10).getTime());
    expect(parseBalanceDate('2026/6/1').getTime()).toBe(new Date(2026, 5, 1).getTime());
  });

  it('returns null for empty / unparseable input', () => {
    expect(parseBalanceDate('')).toBeNull();
    expect(parseBalanceDate(null)).toBeNull();
    expect(parseBalanceDate('not a date')).toBeNull();
  });
});

describe('calendarDayAge (UI-2 — DST-safe)', () => {
  it('counts whole calendar days across a DST spring-forward', () => {
    // In a DST-observing zone the 2026-03-08→09 local-midnight interval is 23h,
    // which Math.floor(ms/86400000) would round to 0. calendarDayAge uses
    // UTC-normalised components → exactly 1, regardless of host TZ.
    expect(calendarDayAge(new Date(2026, 2, 8), new Date(2026, 2, 9))).toBe(1);
  });

  it('same calendar day → 0; across a year boundary → 1', () => {
    expect(calendarDayAge(new Date(2026, 5, 10), new Date(2026, 5, 10))).toBe(0);
    expect(calendarDayAge(new Date(2025, 11, 31), new Date(2026, 0, 1))).toBe(1);
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
