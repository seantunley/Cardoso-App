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
    // Match against substrings we depend on. Loose matching to allow
    // whitespace changes; tight enough to catch column drops.
    expect(sql).toMatch(/OESHDT\.TRANNUM\s+AS\s+TRANNUM/);
    expect(sql).toMatch(/OESHDT\.TRANDATE\s+AS\s+TRANDATE/);
    expect(sql).toMatch(/OESHDT\.ITEM\s+AS\s+ITEM/);
    expect(sql).toMatch(/ICITEM\.\[DESC\]\s+AS\s+\[DESC\]/);
    expect(sql).toMatch(/OESHDT\.CUSTOMER\s+AS\s+CUSTOMER/);
    expect(sql).toMatch(/ARCUS\.NAMECUST\s+AS\s+NAMECUST/);
    expect(sql).toMatch(/OESHDT\.QTYSOLD\s+AS\s+QTYSOLD/);
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

  it('orders by TRANDATE ASC (with stable secondary keys to break ties)', () => {
    const { sql } = build();
    expect(sql).toMatch(/ORDER BY OESHDT\.TRANDATE ASC/);
    expect(sql).toMatch(/OESHDT\.TRANNUM ASC/);
    expect(sql).toMatch(/OESHDT\.ITEM ASC/);
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
