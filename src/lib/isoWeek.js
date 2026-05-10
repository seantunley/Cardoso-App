// ISO 8601 week date helpers.
//
// Why this exists: the BAT reconciliation domain is keyed on
// (week_number, year) pairs from the supplier and from Sage credit
// notes. ISO weeks straddle calendar years — e.g. Mon Dec 29 2025
// belongs to ISO Week 1 of 2026, and ISO Week 53 of 2026 starts
// Mon Dec 28 2026 and ends Sun Jan 3 2027. Using `new Date().getFullYear()`
// for "current year" or doing ad-hoc week math leads to off-by-one
// errors in the last/first week of every year — the recon for the
// straddling week ends up filed under the wrong year, and the YTD
// totals lose the partial weeks at both edges.
//
// Single source of truth — every place that needs "what week/year is
// this date in?" or "what's today's week/year?" must come through here.
// Replace any new ad-hoc Date math with these helpers.
//
// All inputs accepted: Date, ISO string ('2026-01-01'), or Date-like
// timestamp number. Outputs are plain numbers (never strings) and the
// {year, week} pair always satisfies 1 <= week <= 53 and is the ISO
// year/week the date actually belongs to (NOT the calendar year).

/**
 * @typedef {Date | string | number} IsoDateInput
 * @typedef {{ year: number, month: number, day: number }} Ymd
 */

// Coerce the various accepted shapes into a {year, month, day} calendar
// triple. Different input shapes get different treatment so the calendar
// date never shifts across host timezones (Codex catch on PR #232:
// previously we always took UTC components, which moved a JHB-local
// 00:30 Dec 29 to UTC Dec 28 and returned the wrong ISO week).
//
//   - Bare YYYY-MM-DD strings: parse the digits directly. Skips the
//     Date round-trip entirely so '2025-12-29' always means Dec 29
//     regardless of what Date.parse would do with it on different hosts.
//   - Date objects / numeric timestamps: take LOCAL components
//     (getFullYear / getMonth / getDate). Assumes the host's local
//     timezone is the operator's intended timezone — true for our
//     JHB-deployed Cardoso installs. If a future deployment runs the
//     server in UTC while operators are in JHB, that's the only case
//     this still misattributes around midnight; documented above.
//   - Other ISO strings (with time/offset): parsed via Date and then
//     LOCAL components — for our UI, "what calendar day did this
//     happen on" is the operator-local day, which is what local
//     components give us.
/**
 * @param {IsoDateInput} input
 * @returns {Ymd}
 */
function _coerceToYmd(input) {
  if (typeof input === 'string') {
    // Bare YYYY-MM-DD (with optional T/time after) — parse directly so
    // the host timezone can't shift the calendar date.
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d|$)|$)/.exec(input);
    if (m) {
      const year = parseInt(m[1], 10);
      const month = parseInt(m[2], 10) - 1; // 0-indexed
      const day = parseInt(m[3], 10);
      // If a time component followed, fall through to Date-based parsing
      // (we want the LOCAL day at the given instant). The match group
      // m[4] is non-empty when a time digit is present.
      if (!m[4]) return { year, month, day };
    }
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) throw new Error(`isoWeek: unparseable input ${JSON.stringify(input)}`);
    return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
  }
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) throw new Error('isoWeek: invalid Date input');
    return { year: input.getFullYear(), month: input.getMonth(), day: input.getDate() };
  }
  if (typeof input === 'number') {
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) throw new Error(`isoWeek: unparseable input ${input}`);
    return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
  }
  throw new Error(`isoWeek: unsupported input type ${typeof input}`);
}

// Compute ISO 8601 week number AND ISO year for a given date.
//
// Algorithm: anchor on UTC midnight of the input's local calendar date,
// shift to the Thursday of that ISO week, then:
//   - ISO year = calendar year of that Thursday (because every ISO
//     week's Thursday is unambiguously in one calendar year, even
//     when Mon/Sun are in adjacent calendar years).
//   - ISO week = number of weeks from week 1 of that ISO year, where
//     week 1 contains Jan 4 (equivalently, the year's first Thursday).
//
// Why local-then-UTC: if we took UTC components from a non-UTC input
// (the previous bug), JHB-local Dec 29 00:30 became UTC Dec 28 22:30
// and yielded W52/2025 instead of W1/2026. Local components capture
// the operator's intended calendar day; once we have that triple, the
// week-shift math runs in UTC so DST and tz arithmetic don't bite.
/**
 * @param {IsoDateInput} input
 * @returns {{ year: number, week: number }}
 */
export function isoWeek(input) {
  const { year, month, day } = _coerceToYmd(input);
  const d = new Date(Date.UTC(year, month, day));
  // Shift to Thursday of this ISO week. ISO weekday: Mon=1..Sun=7.
  // JS getUTCDay() returns Sun=0..Sat=6; convert via (getUTCDay() || 7).
  const isoDay = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - isoDay);
  const isoYear = d.getUTCFullYear();
  // Week number: days from Jan 1 of ISO year to this Thursday, divided
  // by 7, plus 1 (week 1 contains Jan 4).
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const weekNumber = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: isoYear, week: weekNumber };
}

// Convenience: just the ISO year of a date. Use this in place of
// `getFullYear()` whenever the value will be compared against a
// week_number or fed into a (week, year)-keyed query — calendar year
// and ISO year disagree on Dec 29-31 of years where Jan 1 falls on
// Mon-Wed (e.g. Dec 31 2025 has ISO year 2026).
/** @param {IsoDateInput} input */
export function isoYear(input) {
  return isoWeek(input).year;
}

// Convenience: just the ISO week number of a date.
/** @param {IsoDateInput} input */
export function isoWeekNumber(input) {
  return isoWeek(input).week;
}

// Current ISO year/week, as of now. Used by UI defaults that previously
// called `new Date().getFullYear()`.
export function currentIsoWeek() {
  return isoWeek(new Date());
}

// Number of ISO weeks in a given ISO year. Returns 52 in most years
// and 53 in years where Jan 1 falls on Thursday OR (leap year and Jan 1
// falls on Wed). Used by report generators that need to enumerate
// weeks of a year — without this, naively assuming 52 misses the W53
// in years like 2026 and creates a silent gap.
/** @param {number} year */
export function weeksInIsoYear(year) {
  // ISO trick: Dec 28 is always in the last week of its ISO year.
  // (Equivalently: Dec 28's ISO week count IS the year's max week.)
  // Pass a bare YYYY-MM-DD so the calendar day can't shift across
  // host timezones via Date construction.
  return isoWeek(`${year}-12-28`).week;
}

// Reverse helper: given ISO (year, week, weekday=1..7 Mon-first), return
// the calendar Date. Useful for "give me the Monday of W23/2026" style
// computations in report generators. Defaults to weekday=1 (Monday).
//
// Algorithm: Jan 4 is always in ISO week 1. Find the Monday of week 1,
// then add (week-1)*7 + (weekday-1) days.
/**
 * @param {number} year
 * @param {number} week
 * @param {number} [weekday]
 */
export function dateFromIso(year, week, weekday = 1) {
  if (!Number.isFinite(year) || !Number.isFinite(week) || week < 1 || week > 53) {
    throw new Error(`dateFromIso: invalid (year=${year}, week=${week})`);
  }
  if (!Number.isFinite(weekday) || weekday < 1 || weekday > 7) {
    throw new Error(`dateFromIso: invalid weekday=${weekday}`);
  }
  // Week 1's Thursday is the first Thursday of the year. Find Jan 4's
  // ISO weekday and back off to that week's Monday.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Iso = jan4.getUTCDay() || 7; // 1..7
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Iso - 1));
  // Add (week-1) weeks + (weekday-1) days from week 1's Monday.
  const result = new Date(week1Monday);
  result.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7 + (weekday - 1));
  return result;
}
