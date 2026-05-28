import { describe, it, expect } from 'vitest';
import { parseDescription } from '../src/services/bat/sageCorrections.js';

describe('parseDescription', () => {
  it('parses a valid delivery fee description', () => {
    const r = parseDescription('DELIVERY FEE WEEK 13 - BAT');
    expect(r.weekNumber).toBe(13);
    expect(r.feeType).toBe('DELIVERY FEE');
    expect(r.isValid).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it('parses a valid discount fee description', () => {
    const r = parseDescription('DISCOUNT FEE WEEK 1 - BAT');
    expect(r.weekNumber).toBe(1);
    expect(r.feeType).toBe('DISCOUNT FEE');
    expect(r.isValid).toBe(true);
  });

  it('parses pricing adjustment variants', () => {
    expect(parseDescription('PRICING ADJ WEEK 52').feeType).toBe('PRICING ADJ');
    expect(parseDescription('PRICE ADJ WEEK 52').feeType).toBe('PRICING ADJ');
  });

  it('detects missing week number', () => {
    const r = parseDescription('DISCOUNT FEE WEEK - BAT');
    expect(r.weekNumber).toBeNull();
    expect(r.feeType).toBe('DISCOUNT FEE');
    expect(r.isValid).toBe(false);
    expect(r.problems).toContain('No week number found (expected "WEEK <number>")');
  });

  it('detects unrecognised fee type', () => {
    const r = parseDescription('SOMETHING ELSE WEEK 10');
    expect(r.weekNumber).toBe(10);
    expect(r.feeType).toBe('OTHER');
    expect(r.isValid).toBe(false);
  });

  it('rejects week 0', () => {
    const r = parseDescription('DELIVERY FEE WEEK 0 - BAT');
    expect(r.weekNumber).toBeNull();
    expect(r.isValid).toBe(false);
  });

  it('rejects week 54', () => {
    const r = parseDescription('DELIVERY FEE WEEK 54 - BAT');
    expect(r.weekNumber).toBeNull();
    expect(r.isValid).toBe(false);
  });

  it('accepts week 53', () => {
    const r = parseDescription('DELIVERY FEE WEEK 53 - BAT');
    expect(r.weekNumber).toBe(53);
    expect(r.isValid).toBe(true);
  });

  it('rejects empty string', () => {
    const r = parseDescription('');
    expect(r.isValid).toBe(false);
    expect(r.problems.length).toBeGreaterThan(0);
  });

  it('rejects null/undefined', () => {
    expect(parseDescription(null).isValid).toBe(false);
    expect(parseDescription(undefined).isValid).toBe(false);
  });

  it('flags description exceeding 60 chars', () => {
    const long = 'DELIVERY FEE WEEK 13 - BAT SOME EXTRA TEXT THAT PUSHES OVER LIMIT';
    const r = parseDescription(long);
    expect(r.problems.some(p => p.includes('60 character'))).toBe(true);
    expect(r.isValid).toBe(false);
  });

  it('rejects non-ASCII characters (en dash, curly quotes, etc.)', () => {
    const enDash = parseDescription('DELIVERY FEE WEEK 13 – BAT');
    expect(enDash.isValid).toBe(false);
    expect(enDash.problems.some(p => p.includes('non-ASCII'))).toBe(true);

    const curly = parseDescription('DELIVERY FEE WEEK 13 ‘BAT’');
    expect(curly.isValid).toBe(false);
  });

  it('is case-insensitive for week extraction', () => {
    const r = parseDescription('Delivery Fee week 5 - bat');
    expect(r.weekNumber).toBe(5);
    expect(r.feeType).toBe('DELIVERY FEE');
    expect(r.isValid).toBe(true);
  });
});
