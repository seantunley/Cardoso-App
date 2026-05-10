// Tests for the ISO 8601 week-date helpers in src/lib/isoWeek.js.
//
// The whole point of these helpers is to handle the year-boundary cases
// correctly — naive (date.getFullYear() + dayOfYear/7) math gets every
// Dec 28 - Jan 4 wrong in years where Jan 1 doesn't fall on a Sunday.
// These tests pin the boundaries explicitly so a refactor can't silently
// regress one direction while fixing another.

import { describe, it, expect } from 'vitest';
import {
  isoWeek,
  isoYear,
  isoWeekNumber,
  weeksInIsoYear,
  dateFromIso,
} from '../src/lib/isoWeek.js';

describe('isoWeek — calendar/ISO year disagreement at year boundaries', () => {
  // 2025 starts Wed (Jan 1 = Wed) → ISO week 1 of 2025 starts Mon Dec 30 2024.
  // 2026 starts Thu (Jan 1 = Thu) → ISO week 1 of 2026 starts Mon Dec 29 2025.
  // 2027 starts Fri (Jan 1 = Fri) → ISO week 53 of 2026 spans Dec 28 2026 - Jan 3 2027.
  // 2024 was leap; Jan 1 2024 = Mon → ISO week 1 of 2024 starts Mon Jan 1 2024 (clean).

  it('Mon Dec 30 2024 belongs to ISO week 1 of 2025 (calendar year disagrees)', () => {
    expect(isoWeek('2024-12-30')).toEqual({ year: 2025, week: 1 });
  });

  it('Tue Dec 31 2024 belongs to ISO week 1 of 2025', () => {
    expect(isoWeek('2024-12-31')).toEqual({ year: 2025, week: 1 });
  });

  it('Wed Jan 1 2025 belongs to ISO week 1 of 2025 (matches calendar year)', () => {
    expect(isoWeek('2025-01-01')).toEqual({ year: 2025, week: 1 });
  });

  it('Sun Dec 28 2025 belongs to ISO week 52 of 2025', () => {
    expect(isoWeek('2025-12-28')).toEqual({ year: 2025, week: 52 });
  });

  it('Mon Dec 29 2025 belongs to ISO week 1 of 2026 (calendar year disagrees)', () => {
    expect(isoWeek('2025-12-29')).toEqual({ year: 2026, week: 1 });
  });

  it('Wed Dec 31 2025 belongs to ISO week 1 of 2026', () => {
    expect(isoWeek('2025-12-31')).toEqual({ year: 2026, week: 1 });
  });

  it('Thu Jan 1 2026 belongs to ISO week 1 of 2026 (matches calendar year)', () => {
    expect(isoWeek('2026-01-01')).toEqual({ year: 2026, week: 1 });
  });

  it('Sun Dec 27 2026 belongs to ISO week 52 of 2026', () => {
    expect(isoWeek('2026-12-27')).toEqual({ year: 2026, week: 52 });
  });

  it('Mon Dec 28 2026 belongs to ISO week 53 of 2026 (53-week year)', () => {
    expect(isoWeek('2026-12-28')).toEqual({ year: 2026, week: 53 });
  });

  it('Thu Dec 31 2026 belongs to ISO week 53 of 2026', () => {
    expect(isoWeek('2026-12-31')).toEqual({ year: 2026, week: 53 });
  });

  it('Fri Jan 1 2027 belongs to ISO week 53 of 2026 (calendar year disagrees, 53-week)', () => {
    expect(isoWeek('2027-01-01')).toEqual({ year: 2026, week: 53 });
  });

  it('Sun Jan 3 2027 belongs to ISO week 53 of 2026', () => {
    expect(isoWeek('2027-01-03')).toEqual({ year: 2026, week: 53 });
  });

  it('Mon Jan 4 2027 belongs to ISO week 1 of 2027', () => {
    expect(isoWeek('2027-01-04')).toEqual({ year: 2027, week: 1 });
  });
});

describe('isoWeek — middle-of-year sanity checks', () => {
  it('Wed Jul 16 2025 belongs to ISO week 29 of 2025', () => {
    expect(isoWeek('2025-07-16')).toEqual({ year: 2025, week: 29 });
  });

  it('Thu Apr 9 2026 belongs to ISO week 15 of 2026', () => {
    expect(isoWeek('2026-04-09')).toEqual({ year: 2026, week: 15 });
  });
});

describe('isoWeek — input flexibility', () => {
  it('accepts a bare YYYY-MM-DD string (parsed directly, host-tz-independent)', () => {
    // Bare date strings are the recommended input shape for tests and
    // any caller that wants to express a calendar date without a tz
    // commitment. Same answer on every host regardless of TZ.
    expect(isoWeek('2025-12-29')).toEqual({ year: 2026, week: 1 });
  });

  it('accepts a Date object using its LOCAL calendar components', () => {
    // Construct at midday UTC mid-July to dodge the TZ window where
    // local and UTC days differ — the test outcome should hold on any
    // reasonable host timezone (-12..+14).
    const d = new Date(Date.UTC(2025, 6, 16, 12, 0, 0));
    expect(isoWeek(d)).toEqual({ year: 2025, week: 29 });
  });

  it('accepts a numeric timestamp using its LOCAL calendar components', () => {
    const ts = Date.UTC(2025, 6, 16, 12, 0, 0);
    expect(isoWeek(ts)).toEqual({ year: 2025, week: 29 });
  });

  it('throws on an invalid Date', () => {
    expect(() => isoWeek(new Date('not-a-date'))).toThrow(/invalid Date/);
  });

  it('throws on an unparseable string', () => {
    expect(() => isoWeek('this is not a date')).toThrow(/unparseable/);
  });

  it('throws on a non-Date, non-string, non-number', () => {
    expect(() => isoWeek({})).toThrow(/unsupported input type/);
    expect(() => isoWeek(null)).toThrow(/unsupported input type/);
    expect(() => isoWeek(undefined)).toThrow(/unsupported input type/);
  });
});

describe('isoWeek — timezone-portability regression (Codex P-level on PR #232)', () => {
  // Earlier version took UTC components from the input, which shifted
  // local-midnight dates by the host's UTC offset. For a JHB user
  // (UTC+2) at 00:30 local on Dec 29, UTC components returned Dec 28
  // and yielded the wrong ISO week. These tests pin the fix:
  // bare date strings parse directly without tz round-trip, and Date
  // inputs use local components.

  it('bare date string is host-tz-independent for boundary dates', () => {
    expect(isoWeek('2025-12-29')).toEqual({ year: 2026, week: 1 });
    expect(isoWeek('2025-12-28')).toEqual({ year: 2025, week: 52 });
    expect(isoWeek('2026-12-28')).toEqual({ year: 2026, week: 53 });
    expect(isoWeek('2027-01-01')).toEqual({ year: 2026, week: 53 });
  });

  it('weeksInIsoYear is host-tz-independent (uses bare date string internally)', () => {
    expect(weeksInIsoYear(2026)).toBe(53);
    expect(weeksInIsoYear(2025)).toBe(52);
  });
});

describe('isoYear / isoWeekNumber convenience accessors', () => {
  it('isoYear returns just the year', () => {
    expect(isoYear('2025-12-31')).toBe(2026);
    expect(isoYear('2026-01-01')).toBe(2026);
  });

  it('isoWeekNumber returns just the week', () => {
    expect(isoWeekNumber('2025-12-31')).toBe(1);
    expect(isoWeekNumber('2026-12-28')).toBe(53);
  });
});

describe('weeksInIsoYear', () => {
  it('returns 52 for a typical year', () => {
    expect(weeksInIsoYear(2025)).toBe(52);
    expect(weeksInIsoYear(2027)).toBe(52);
  });

  it('returns 53 for a 53-week year (2026 starts on Thursday)', () => {
    expect(weeksInIsoYear(2026)).toBe(53);
  });

  it('returns 53 for 2020 (leap year starting Wed)', () => {
    expect(weeksInIsoYear(2020)).toBe(53);
  });

  it('returns 52 for 2024 (leap year starting Mon — clean alignment)', () => {
    expect(weeksInIsoYear(2024)).toBe(52);
  });
});

describe('dateFromIso — round-trip with isoWeek', () => {
  it('Monday of W1 2025 = Dec 30 2024', () => {
    const d = dateFromIso(2025, 1, 1);
    expect(d.toISOString().slice(0, 10)).toBe('2024-12-30');
  });

  it('Monday of W1 2026 = Dec 29 2025', () => {
    const d = dateFromIso(2026, 1, 1);
    expect(d.toISOString().slice(0, 10)).toBe('2025-12-29');
  });

  it('Sunday of W53 2026 = Jan 3 2027', () => {
    const d = dateFromIso(2026, 53, 7);
    expect(d.toISOString().slice(0, 10)).toBe('2027-01-03');
  });

  it('Round-trips: isoWeek(dateFromIso(y, w, 1)).year/week === y/w', () => {
    for (const year of [2024, 2025, 2026, 2027, 2028]) {
      const max = weeksInIsoYear(year);
      for (const week of [1, 2, max - 1, max]) {
        const d = dateFromIso(year, week, 1);
        const back = isoWeek(d);
        expect(back).toEqual({ year, week });
      }
    }
  });

  it('rejects invalid week numbers', () => {
    expect(() => dateFromIso(2026, 0)).toThrow();
    expect(() => dateFromIso(2026, 54)).toThrow();
  });

  it('rejects invalid weekdays', () => {
    expect(() => dateFromIso(2026, 1, 0)).toThrow();
    expect(() => dateFromIso(2026, 1, 8)).toThrow();
  });
});
