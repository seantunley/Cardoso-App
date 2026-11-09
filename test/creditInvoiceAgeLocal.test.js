// Invoice ages in the credit engine must be whole calendar days in SA time.
// Dates used to parse as UTC midnight (02:00 SAST) against a local-midnight
// "today", so every age came out one day short and a Hold triggered a day late.
// TZ is pinned so this fails on the old code even on a UTC CI runner.
process.env.TZ = 'Africa/Johannesburg';

import { it, expect, vi, afterAll } from 'vitest';
import { analyseInvoiceCredit, parseDateField } from '../src/lib/creditAnalysis.js';

afterAll(() => vi.useRealTimers());

it('parses every date shape to local midnight of that day', () => {
  for (const v of ['20261101', '01/11/2026', '2026-11-01', '2026-11-01T00:00:00.000Z']) {
    const d = parseDateField(v);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], v).toEqual([2026, 10, 1, 0]);
  }
  expect(parseDateField('19991231')).toBeNull(); // Sage's "no date" placeholder
});

it('an invoice from 61 days ago is 61 days old', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-09T08:00:00+02:00'));
  const record = {
    outstanding_balance: 5000,
    last_unpaid_invoice_1: 'IN1',
    last_unpaid_invoice_1_amount: 5000,
    last_unpaid_invoice_1_date: '20260909', // 61 calendar days before 9 Nov
  };
  const res = analyseInvoiceCredit([record]);
  expect(JSON.stringify(res)).toContain('61 days old');
  expect(JSON.stringify(res)).not.toContain('60 days old');
});
