// Tests for src/lib/format.js amount parsing/formatting (UI-1).
//
// The amount-search input accepted SA comma-decimal ("11710,66") but the old
// parser stripped the comma, searching for R 1 171 066 — 100x too large — and
// could not round-trip its own formatAmount output ("1 234,50").

import { describe, it, expect } from 'vitest';
import { parseAmount, formatAmount } from '../src/lib/format.js';

describe('parseAmount', () => {
  it('reads SA comma-decimal correctly (the UI-1 bug)', () => {
    expect(parseAmount('11710,66')).toBeCloseTo(11710.66, 2);
    expect(parseAmount('1 234,50')).toBeCloseTo(1234.5, 2);
    expect(parseAmount('R 1 234 567,80')).toBeCloseTo(1234567.8, 2);
  });

  it('reads dot-decimal / comma-thousands too', () => {
    expect(parseAmount('11710.66')).toBeCloseTo(11710.66, 2);
    expect(parseAmount('1,234.50')).toBeCloseTo(1234.5, 2);
    expect(parseAmount('1.234.567,80')).toBeCloseTo(1234567.8, 2); // EU
  });

  it('treats a lone separator with 3 trailing digits as thousands grouping', () => {
    expect(parseAmount('1,234')).toBe(1234);
    expect(parseAmount('1.234.567')).toBe(1234567);
  });

  it('handles plain numbers, negatives, and junk', () => {
    expect(parseAmount(1234.5)).toBeCloseTo(1234.5, 2);
    expect(parseAmount('1234')).toBe(1234);
    expect(parseAmount('-1234.50')).toBeCloseTo(-1234.5, 2);
    expect(parseAmount('')).toBe(0);
    expect(parseAmount(null)).toBe(0);
    expect(parseAmount('abc')).toBe(0);
  });

  it('round-trips its own formatAmount output', () => {
    for (const n of [0, 1.5, 11710.66, 1234.5, 1234567.8, 0.05]) {
      expect(parseAmount(formatAmount(n))).toBeCloseTo(n, 2);
    }
  });
});
