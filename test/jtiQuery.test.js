// Contract tests for src/services/jti/jtiQuery.js
//
// The query is the integration boundary with Sage 300. We can't run
// real SQL in unit tests, but we CAN pin everything else:
//
//   - The SQL string itself: contains the right tables/joins/filters
//   - Parameter binding: dates → ints, vendor pattern hardcoded
//   - Date validation: bad input rejected loudly, not silently
//   - The queryJtiSales runner: builds → binds → executes → returns
//     recordset. Tested against a fake pool that records what was
//     called.

import { describe, it, expect, vi } from 'vitest';
import {
  buildJtiSql,
  queryJtiSales,
  toYyyymmddInt,
  validateOverrideSql,
  assertRecordsetShape,
  DEFAULT_JTI_SQL,
  JTI_REQUIRED_COLUMNS,
} from '../src/services/jti/jtiQuery.js';

describe('toYyyymmddInt', () => {
  it('converts a Date to integer YYYYMMDD (UTC anchored)', () => {
    expect(toYyyymmddInt(new Date(Date.UTC(2026, 3, 30)))).toBe(20260430);
    expect(toYyyymmddInt(new Date(Date.UTC(2026, 0, 1)))).toBe(20260101);
  });

  it('passes through valid integer YYYYMMDD', () => {
    expect(toYyyymmddInt(20260430)).toBe(20260430);
  });

  it('parses 8-digit string as YYYYMMDD', () => {
    expect(toYyyymmddInt('20260430')).toBe(20260430);
  });

  it('parses an ISO date string', () => {
    expect(toYyyymmddInt('2026-04-30T00:00:00.000Z')).toBe(20260430);
  });

  it('rejects out-of-range integers', () => {
    expect(() => toYyyymmddInt(123)).toThrow(RangeError);
    expect(() => toYyyymmddInt(99999999)).toThrow(RangeError);
  });

  it('rejects unparseable strings', () => {
    expect(() => toYyyymmddInt('not a date')).toThrow(RangeError);
  });

  // Regression: the 8-digit-string branch previously skipped the
  // plausibility checks that the integer branch enforced, so values
  // like '00000000' or '99999999' arrived in the SQL layer verbatim.
  // The malformed values then bypassed the date filter and effectively
  // expanded the export range across all of Sage history. POST
  // /api/jti/export takes from/to as JSON strings, so this was the
  // operative attack surface — not the integer branch.
  it('rejects "00000000" / "99999999" / other out-of-range 8-digit strings', () => {
    expect(() => toYyyymmddInt('00000000')).toThrow(/out of plausible YYYYMMDD range/);
    expect(() => toYyyymmddInt('99999999')).toThrow(/out of plausible YYYYMMDD range/);
    expect(() => toYyyymmddInt('18991231')).toThrow(/out of plausible YYYYMMDD range/);
    expect(() => toYyyymmddInt('21010101')).toThrow(/out of plausible YYYYMMDD range/);
  });

  it('rejects in-range 8-digit strings with bogus month or day components', () => {
    expect(() => toYyyymmddInt('20260001')).toThrow(/invalid month component/);
    expect(() => toYyyymmddInt('20261301')).toThrow(/invalid month component/);
    expect(() => toYyyymmddInt('20260100')).toThrow(/invalid day component/);
    expect(() => toYyyymmddInt('20260132')).toThrow(/invalid day component/);
  });

  it('rejects in-range integers with bogus month or day (parity with the string branch)', () => {
    expect(() => toYyyymmddInt(20260001)).toThrow(/invalid month component/);
    expect(() => toYyyymmddInt(20261301)).toThrow(/invalid month component/);
    expect(() => toYyyymmddInt(20260100)).toThrow(/invalid day component/);
  });

  it('UTC anchored — server timezone never shifts the day', () => {
    // Same instant, formatted via UTC components no matter what
    // Date the server's local timezone produces.
    const d = new Date('2026-04-30T22:00:00.000Z');
    expect(toYyyymmddInt(d)).toBe(20260430);
  });
});

describe('buildJtiSql — SQL shape', () => {
  function build() {
    return buildJtiSql({ fromDate: 20260401, toDate: 20260430 });
  }

  it('selects the seven columns the spreadsheet builder consumes', () => {
    const { sql } = build();
    // Match against the alias side only; the source side may be
    // wrapped in RTRIM(...) for string columns to strip Sage CHAR
    // padding. Tight enough to catch column drops; loose enough to
    // allow the wrapper.
    expect(sql).toMatch(/AS\s+TRANNUM\b/);
    expect(sql).toMatch(/AS\s+TRANDATE\b/);
    expect(sql).toMatch(/AS\s+ITEM\b/);
    expect(sql).toMatch(/AS\s+\[DESC\]/);
    expect(sql).toMatch(/AS\s+CUSTOMER\b/);
    expect(sql).toMatch(/AS\s+NAMECUST\b/);
    expect(sql).toMatch(/AS\s+QTYSOLD\b/);
  });

  it('trims string columns: LTRIM+RTRIM on identifiers/names, RTRIM-only on DESC', () => {
    // Trailing space padding from Sage CHAR fields breaks downstream
    // equality. A small number of records also have leading-space
    // data-entry slips. LTRIM+RTRIM strips both. ICITEM.[DESC] is
    // RTRIM-only because some product names have INTENTIONAL leading
    // whitespace (e.g. "  CAMEL CLASSIC **BOX**") that the consumer
    // pipeline depends on — stripping it would diverge from the
    // macro's reference output.
    const { sql } = build();
    expect(sql).toMatch(/LTRIM\(RTRIM\(OESHDT\.TRANNUM\)\)/);
    expect(sql).toMatch(/LTRIM\(RTRIM\(OESHDT\.ITEM\)\)/);
    expect(sql).toMatch(/LTRIM\(RTRIM\(OESHDT\.CUSTOMER\)\)/);
    expect(sql).toMatch(/LTRIM\(RTRIM\(ARCUS\.NAMECUST\)\)/);
    // DESC: RTRIM only, NOT wrapped in LTRIM.
    expect(sql).toMatch(/RTRIM\(ICITEM\.\[DESC\]\)/);
    expect(sql).not.toMatch(/LTRIM\(RTRIM\(ICITEM\.\[DESC\]\)\)/);
    // Numeric columns stay un-wrapped — TRIM on a number is a no-op
    // and would just confuse the recordset shape.
    expect(sql).not.toMatch(/[LR]TRIM\(OESHDT\.TRANDATE\)/);
    expect(sql).not.toMatch(/[LR]TRIM\(OESHDT\.QTYSOLD\)/);
  });

  it('LEFT JOINs ARCUS so rows survive when the customer master is missing', () => {
    const { sql } = build();
    expect(sql).toMatch(/LEFT JOIN ARCUS/);
    expect(sql).not.toMatch(/INNER JOIN ARCUS/);
  });

  it('uses EXISTS (not INNER JOIN) for the JTI vendor filter to dedupe multi-vendor items', () => {
    // INNER JOIN ICITMV would multiply rows when an item has multiple
    // JTI vendor codes. EXISTS gives one row per shipment line.
    const { sql } = build();
    expect(sql).toMatch(/EXISTS\s*\([^)]*ICITMV/);
    expect(sql).not.toMatch(/INNER JOIN ICITMV/);
  });

  it('parameterises the date range and the vendor pattern', () => {
    const { sql } = build();
    expect(sql).toMatch(/OESHDT\.TRANDATE BETWEEN @from AND @to/);
    expect(sql).toMatch(/ICITMV\.VENDNUM LIKE @vendor/);
  });

  it('orders by TRANDATE ASC ONLY — no tiebreakers (matches macro/Crystal output)', () => {
    // Tiebreakers were initially added to make output deterministic,
    // but they put alphabetical 'CN…' rows before 'IN…' rows within
    // a single day, which diverges from the macro's ordering.
    // Operator chose to drop the tiebreakers and rely on Sage's
    // natural row order for same-day rows.
    const { sql } = build();
    expect(sql).toMatch(/ORDER BY OESHDT\.TRANDATE ASC/);
    expect(sql).not.toMatch(/OESHDT\.TRANNUM ASC/);
    expect(sql).not.toMatch(/OESHDT\.ITEM ASC/);
  });
});

describe('buildJtiSql — params', () => {
  it('returns the dates as integers and vendor as %JTI%', () => {
    const { params } = buildJtiSql({ fromDate: 20260401, toDate: 20260430 });
    expect(params).toEqual({ from: 20260401, to: 20260430, vendor: '%JTI%' });
  });

  it('coerces Date objects to integer YYYYMMDD', () => {
    const { params } = buildJtiSql({
      fromDate: new Date(Date.UTC(2026, 3, 1)),
      toDate: new Date(Date.UTC(2026, 3, 30)),
    });
    expect(params.from).toBe(20260401);
    expect(params.to).toBe(20260430);
  });
});

describe('buildJtiSql — input validation', () => {
  it('throws TypeError when either date is missing', () => {
    expect(() => buildJtiSql({ toDate: 20260430 })).toThrow(TypeError);
    expect(() => buildJtiSql({ fromDate: 20260401 })).toThrow(TypeError);
    expect(() => buildJtiSql({})).toThrow(TypeError);
  });

  it('throws when fromDate > toDate (bad range)', () => {
    expect(() => buildJtiSql({ fromDate: 20260430, toDate: 20260401 })).toThrow(/must not be after/);
  });

  it('rejects unparseable dates', () => {
    expect(() => buildJtiSql({ fromDate: 'garbage', toDate: 20260430 })).toThrow(RangeError);
  });

  it('accepts equal dates (single-day range)', () => {
    expect(() => buildJtiSql({ fromDate: 20260415, toDate: 20260415 })).not.toThrow();
  });
});

describe('queryJtiSales — execution against a fake pool', () => {
  // Build a mock mssql pool that records inputs + the final SQL.
  function makeFakePool({ recordset = [] } = {}) {
    const inputs = {};
    let executedSql = null;
    const request = {
      input(name, value) {
        inputs[name] = value;
        return request;
      },
      async query(sql) {
        executedSql = sql;
        return { recordset };
      },
    };
    return {
      pool: { request: () => request },
      capture: { inputs, get sql() { return executedSql; } },
    };
  }

  it('binds from/to/vendor inputs and executes the built SQL', async () => {
    const { pool, capture } = makeFakePool();
    await queryJtiSales({ pool, fromDate: 20260401, toDate: 20260430 });
    expect(capture.inputs).toEqual({ from: 20260401, to: 20260430, vendor: '%JTI%' });
    expect(capture.sql).toMatch(/FROM OESHDT/);
    expect(capture.sql).toMatch(/EXISTS/);
  });

  it('returns the recordset rows verbatim', async () => {
    const fakeRows = [
      { TRANNUM: 'IN000428009', TRANDATE: 20260401, ITEM: '87', DESC: '  CAMEL CLASSIC',
        CUSTOMER: '10', NAMECUST: 'LIQUOR CITY WHITERIVER', QTYSOLD: 2 },
    ];
    const { pool } = makeFakePool({ recordset: fakeRows });
    const rows = await queryJtiSales({ pool, fromDate: 20260401, toDate: 20260430 });
    expect(rows).toEqual(fakeRows);
  });

  it('returns an empty array when Sage returns no rows', async () => {
    const { pool } = makeFakePool({ recordset: [] });
    const rows = await queryJtiSales({ pool, fromDate: 20260401, toDate: 20260430 });
    expect(rows).toEqual([]);
  });

  it('returns an empty array when recordset is undefined (mssql edge case)', async () => {
    const pool = { request: () => ({
      input() { return this; },
      async query() { return {}; },
    }) };
    const rows = await queryJtiSales({ pool, fromDate: 20260401, toDate: 20260430 });
    expect(rows).toEqual([]);
  });

  it('throws TypeError when pool is missing or wrong shape', async () => {
    await expect(queryJtiSales({ fromDate: 20260401, toDate: 20260430 })).rejects.toThrow(TypeError);
    await expect(queryJtiSales({ pool: {}, fromDate: 20260401, toDate: 20260430 })).rejects.toThrow(TypeError);
  });

  it('propagates date-validation errors before touching the pool', async () => {
    const requestSpy = vi.fn();
    const pool = { request: requestSpy };
    await expect(queryJtiSales({ pool, fromDate: 'garbage', toDate: 20260430 })).rejects.toThrow(RangeError);
    expect(requestSpy).not.toHaveBeenCalled();
  });
});

describe('buildJtiSql — sqlOverride', () => {
  it('uses the override when a non-empty string is supplied', () => {
    const override = 'SELECT 1 AS X FROM Y WHERE Z = @from AND W = @to';
    const { sql, params } = buildJtiSql({
      fromDate: 20260401, toDate: 20260430, sqlOverride: override,
    });
    expect(sql).toBe(override);
    // Params still bound the same way — operator's override uses the
    // same @-named placeholders.
    expect(params).toEqual({ from: 20260401, to: 20260430, vendor: '%JTI%' });
  });

  it('falls back to DEFAULT_JTI_SQL when override is undefined', () => {
    const { sql } = buildJtiSql({ fromDate: 20260401, toDate: 20260430 });
    expect(sql).toBe(DEFAULT_JTI_SQL);
  });

  it('falls back to DEFAULT_JTI_SQL when override is empty / whitespace', () => {
    expect(buildJtiSql({ fromDate: 20260401, toDate: 20260430, sqlOverride: '' }).sql).toBe(DEFAULT_JTI_SQL);
    expect(buildJtiSql({ fromDate: 20260401, toDate: 20260430, sqlOverride: '   ' }).sql).toBe(DEFAULT_JTI_SQL);
  });
});

describe('validateOverrideSql', () => {
  const goodOverride = `
    SELECT TRANNUM, TRANDATE, ITEM, [DESC], CUSTOMER, NAMECUST, QTYSOLD
    FROM OESHDT
    WHERE TRANDATE BETWEEN @from AND @to
      AND ITEM IN (SELECT ITEMNO FROM ICITMV WHERE VENDNUM LIKE @vendor)
  `;

  it('empty / whitespace override is valid (means "no override")', () => {
    expect(validateOverrideSql('').errors).toEqual([]);
    expect(validateOverrideSql('   ').errors).toEqual([]);
    expect(validateOverrideSql(null).errors).toEqual([]);
  });

  it('happy path: well-formed override returns zero errors', () => {
    const r = validateOverrideSql(goodOverride);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('rejects non-SELECT statements', () => {
    const r = validateOverrideSql(`UPDATE OESHDT SET QTYSOLD = 0`);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.errors)).toMatch(/SELECT/);
  });

  it('rejects mutating keywords even when SELECT comes first', () => {
    const r = validateOverrideSql(`SELECT 1; DROP TABLE OESHDT`);
    expect(JSON.stringify(r.errors)).toMatch(/mutating keyword/i);
  });

  it('rejects when @from is missing', () => {
    const noFrom = goodOverride.replace('@from', 'GETDATE()');
    const r = validateOverrideSql(noFrom);
    expect(JSON.stringify(r.errors)).toMatch(/@from/);
  });

  it('rejects when @to is missing', () => {
    const noTo = goodOverride.replace('@to', 'GETDATE()');
    const r = validateOverrideSql(noTo);
    expect(JSON.stringify(r.errors)).toMatch(/@to/);
  });

  it('warns (not errors) when @vendor is missing — operator may have hardcoded it', () => {
    const noVendor = goodOverride.replace(/AND ITEM IN \([^)]*\)/, '');
    const r = validateOverrideSql(noVendor);
    expect(r.errors).toEqual([]);
    expect(JSON.stringify(r.warnings)).toMatch(/@vendor/);
  });

  it('rejects when any required column is missing from the SELECT', () => {
    const noQty = goodOverride.replace('QTYSOLD', '');
    const r = validateOverrideSql(noQty);
    expect(r.errors.some(e => e.includes('QTYSOLD'))).toBe(true);
  });

  it('accepts CTEs (WITH … AS … SELECT)', () => {
    const cte = `
      WITH src AS (SELECT * FROM OESHDT WHERE TRANDATE BETWEEN @from AND @to)
      SELECT TRANNUM, TRANDATE, ITEM, [DESC], CUSTOMER, NAMECUST, QTYSOLD
      FROM src WHERE ITEM IN (SELECT ITEMNO FROM ICITMV WHERE VENDNUM LIKE @vendor)
    `;
    const r = validateOverrideSql(cte);
    expect(r.errors).toEqual([]);
  });
});

describe('assertRecordsetShape', () => {
  function row(overrides) {
    return {
      TRANNUM: 'IN1', TRANDATE: 20260401, ITEM: 'X', DESC: 'Y',
      CUSTOMER: 'C', NAMECUST: 'N', QTYSOLD: 1,
      ...overrides,
    };
  }

  it('passes when rows have every required column', () => {
    expect(() => assertRecordsetShape([row()])).not.toThrow();
  });

  it('passes for an empty recordset (no rows = no contract to break)', () => {
    expect(() => assertRecordsetShape([])).not.toThrow();
  });

  it('throws naming the missing column(s)', () => {
    const partial = { TRANNUM: 'IN1', TRANDATE: 20260401 };  // missing 5 cols
    expect(() => assertRecordsetShape([partial])).toThrow(/ITEM/);
    expect(() => assertRecordsetShape([partial])).toThrow(/DESC/);
    expect(() => assertRecordsetShape([partial])).toThrow(/QTYSOLD/);
  });

  it('throws TypeError when input is not an array', () => {
    expect(() => assertRecordsetShape(null)).toThrow(TypeError);
    expect(() => assertRecordsetShape({})).toThrow(TypeError);
  });

  it('JTI_REQUIRED_COLUMNS lists the seven aliases the spreadsheet builder reads', () => {
    expect(JTI_REQUIRED_COLUMNS).toEqual([
      'TRANNUM', 'TRANDATE', 'ITEM', 'DESC', 'CUSTOMER', 'NAMECUST', 'QTYSOLD',
    ]);
  });
});

describe('queryJtiSales — column contract via assertRecordsetShape', () => {
  function makePool(recordset) {
    return {
      request: () => ({
        input() { return this; },
        async query() { return { recordset }; },
      }),
    };
  }

  it('throws if the recordset is missing required columns (operator override that drops a column)', async () => {
    const pool = makePool([{ TRANNUM: 'X', TRANDATE: 20260401 }]);
    await expect(queryJtiSales({ pool, fromDate: 20260401, toDate: 20260430 }))
      .rejects.toThrow(/missing required columns/);
  });

  it('passes for a well-shaped recordset', async () => {
    const pool = makePool([{
      TRANNUM: 'X', TRANDATE: 20260401, ITEM: 'A', DESC: 'B',
      CUSTOMER: 'C', NAMECUST: 'D', QTYSOLD: 1,
    }]);
    const rows = await queryJtiSales({ pool, fromDate: 20260401, toDate: 20260430 });
    expect(rows.length).toBe(1);
  });
});
