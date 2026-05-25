import { describe, it, expect } from 'vitest';
import { normaliseIsoDate } from '../src/lib/normaliseIsoDate.js';

describe('normaliseIsoDate', () => {
  it('accepts a valid date', () => {
    expect(normaliseIsoDate('2026-03-15')).toBe('2026-03-15');
  });

  it('accepts year boundaries', () => {
    expect(normaliseIsoDate('2026-01-01')).toBe('2026-01-01');
    expect(normaliseIsoDate('2026-12-31')).toBe('2026-12-31');
  });

  it('accepts Feb 29 on a leap year', () => {
    expect(normaliseIsoDate('2028-02-29')).toBe('2028-02-29');
  });

  it('rejects Feb 29 on a non-leap year', () => {
    expect(normaliseIsoDate('2026-02-29')).toBeNull();
  });

  it('rejects month 0 and month 13', () => {
    expect(normaliseIsoDate('2026-00-15')).toBeNull();
    expect(normaliseIsoDate('2026-13-01')).toBeNull();
  });

  it('rejects day 0 and day 32', () => {
    expect(normaliseIsoDate('2026-01-00')).toBeNull();
    expect(normaliseIsoDate('2026-01-32')).toBeNull();
  });

  it('rejects empty / null / undefined', () => {
    expect(normaliseIsoDate('')).toBeNull();
    expect(normaliseIsoDate(null)).toBeNull();
    expect(normaliseIsoDate(undefined)).toBeNull();
  });

  it('rejects non-ISO formats', () => {
    expect(normaliseIsoDate('15/03/2026')).toBeNull();
    expect(normaliseIsoDate('March 15, 2026')).toBeNull();
    expect(normaliseIsoDate('2026-3-5')).toBeNull();
  });

  it('rejects dates with extra characters', () => {
    expect(normaliseIsoDate('2026-03-15T00:00:00')).toBeNull();
    expect(normaliseIsoDate(' 2026-03-15 ')).toBe('2026-03-15');
  });
});
