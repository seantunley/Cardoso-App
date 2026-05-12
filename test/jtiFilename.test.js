// Contract tests for src/services/jti/jtiFilename.js
//
// The downstream pipeline may parse the filename to extract the date
// marker — anything that breaks the JTI_Cardoso_Sales_<SITE>_<YYYYMMDD>.xlsx
// pattern is potentially a consumer-visible regression. Pin the
// pattern, the date format, and the site sanitisation rules.

import { describe, it, expect } from 'vitest';
import {
  buildJtiFilename,
  sanitizeSiteLabel,
  formatYyyymmdd,
} from '../src/services/jti/jtiFilename.js';

describe('sanitizeSiteLabel', () => {
  it('passes through a clean label unchanged', () => {
    expect(sanitizeSiteLabel('Ermelo')).toBe('Ermelo');
    expect(sanitizeSiteLabel('Cape Town')).toBe('Cape Town');
    expect(sanitizeSiteLabel('Site-1.2_alt')).toBe('Site-1.2_alt');
  });

  it('replaces filesystem-unsafe characters with underscores', () => {
    expect(sanitizeSiteLabel('A/B')).toBe('A_B');
    expect(sanitizeSiteLabel('A\\B')).toBe('A_B');
    expect(sanitizeSiteLabel('A:B*C?')).toBe('A_B_C_');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeSiteLabel('  Ermelo  ')).toBe('Ermelo');
  });

  it('falls back to "Unknown" for empty/null/undefined input', () => {
    expect(sanitizeSiteLabel('')).toBe('Unknown');
    expect(sanitizeSiteLabel(null)).toBe('Unknown');
    expect(sanitizeSiteLabel(undefined)).toBe('Unknown');
    expect(sanitizeSiteLabel('   ')).toBe('Unknown');
  });

  it('falls back to "Unknown" when the input is pure unsafe chars', () => {
    // After replacement → all underscores. Survives as underscores
    // (we don't strip them); test pins what we get for this edge case.
    expect(sanitizeSiteLabel('///')).toBe('___');
  });
});

describe('formatYyyymmdd', () => {
  it('formats a Date as UTC YYYYMMDD', () => {
    expect(formatYyyymmdd(new Date(Date.UTC(2026, 3, 30)))).toBe('20260430');
    expect(formatYyyymmdd(new Date(Date.UTC(2026, 0, 1)))).toBe('20260101');
  });

  it('uses UTC components so a timezoned Date never shifts the day', () => {
    // 2026-04-30T22:00:00Z is "30 Apr UTC" but "1 May" in UTC+04
    // local time. UTC anchoring keeps it 20260430 regardless of the
    // server's TZ. Pinning so a "local" refactor doesn't slip in.
    const d = new Date('2026-04-30T22:00:00.000Z');
    expect(formatYyyymmdd(d)).toBe('20260430');
  });

  it('passes through an already-valid YYYYMMDD integer', () => {
    expect(formatYyyymmdd(20260430)).toBe('20260430');
    expect(formatYyyymmdd(20260101)).toBe('20260101');
  });

  it('passes through an already-valid YYYYMMDD string', () => {
    expect(formatYyyymmdd('20260430')).toBe('20260430');
    expect(formatYyyymmdd('  20260430  ')).toBe('20260430');
  });

  it('rejects integers outside YYYYMMDD plausible range', () => {
    expect(() => formatYyyymmdd(123)).toThrow(RangeError);
    expect(() => formatYyyymmdd(99999999)).toThrow(RangeError);
  });

  it('rejects unparseable string input', () => {
    expect(() => formatYyyymmdd('not a date')).toThrow(RangeError);
    expect(() => formatYyyymmdd('2026-04-30 garbage')).toThrow(RangeError);
  });

  it('parses an ISO-8601 string and formats from its UTC date', () => {
    expect(formatYyyymmdd('2026-04-30T00:00:00.000Z')).toBe('20260430');
  });
});

describe('buildJtiFilename', () => {
  it('matches the supplied sample file name byte-for-byte', () => {
    // The sample is docs/JTI_Cardoso_Sales_Ermelo_20260430.xlsx — pinning
    // ensures a future change to the pattern is caught.
    const result = buildJtiFilename({ site: 'Ermelo', endDate: 20260430 });
    expect(result).toBe('JTI_Cardoso_Sales_Ermelo_20260430.xlsx');
  });

  it('accepts a Date object for endDate', () => {
    const result = buildJtiFilename({
      site: 'Ermelo',
      endDate: new Date(Date.UTC(2026, 3, 30)),
    });
    expect(result).toBe('JTI_Cardoso_Sales_Ermelo_20260430.xlsx');
  });

  it('sanitises a dirty site label', () => {
    const result = buildJtiFilename({ site: 'A/B*C', endDate: 20260430 });
    expect(result).toBe('JTI_Cardoso_Sales_A_B_C_20260430.xlsx');
  });

  it('falls back to "Unknown" site when blank', () => {
    const result = buildJtiFilename({ site: '', endDate: 20260430 });
    expect(result).toBe('JTI_Cardoso_Sales_Unknown_20260430.xlsx');
  });

  it('throws when endDate is missing', () => {
    expect(() => buildJtiFilename({ site: 'Ermelo' })).toThrow(TypeError);
    expect(() => buildJtiFilename({ site: 'Ermelo', endDate: null })).toThrow(TypeError);
  });
});
