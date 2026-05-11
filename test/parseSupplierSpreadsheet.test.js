// Tests for parseSupplierSpreadsheet — the load-bearing validation gate
// for BAT supplier spreadsheets. A regression here silently corrupts
// reconciliations, so this is the first module getting test coverage.
//
// Strategy: every fixture is built programmatically with xlsx.utils so
// we don't have to maintain binary .xlsx files in the repo. Each test
// builds a workbook, writes it to a temp dir, parses it, asserts.
//
// Focus is on the VALIDATION paths (missing sheets, bad filenames,
// empty data) — these are where money-correctness lives. The full
// happy-path parse (with valid pivot table structure) is a larger
// fixture exercise; covered separately when the parser is touched.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import XLSX from 'xlsx';
import {
  parseSupplierSpreadsheet,
  SpreadsheetValidationError,
} from '../src/services/bat/parser.js';

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-supplier-test-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper — build a workbook from a `{ sheetName: [[row1col1, ...], ...] }`
// map and write it to a temp file. Returns the path.
function makeWorkbook(sheets, filename) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  const filePath = path.join(tmpDir, filename);
  XLSX.writeFile(wb, filePath);
  return filePath;
}

describe('parseSupplierSpreadsheet — validation', () => {
  it('rejects when filename has no detectable week number', () => {
    const filePath = makeWorkbook(
      {
        Overview: [['Row Labels']],
        'Delivery POD': [[]],
      },
      'NoWeekHere.xlsx',
    );
    expect(() => parseSupplierSpreadsheet(filePath, 'NoWeekHere.xlsx'))
      .toThrow(SpreadsheetValidationError);

    try {
      parseSupplierSpreadsheet(filePath, 'NoWeekHere.xlsx');
    } catch (err) {
      expect(err.reasons.some(r => /week number/i.test(r))).toBe(true);
      expect(err.fileName).toBe('NoWeekHere.xlsx');
    }
  });

  it('accepts both "Week_19_..." and "Week 19 ..." filename formats', () => {
    // Both formats should pass the filename check (the spreadsheet itself
    // will fail on missing required sheets — that's a different error path).
    // (We include a dummy sheet so XLSX.writeFile doesn't reject an
    // empty workbook.)
    for (const name of ['Week_19_supplier.xlsx', 'Week 19 supplier.xlsx']) {
      const filePath = makeWorkbook({ Dummy: [['x']] }, name);
      try {
        parseSupplierSpreadsheet(filePath, name);
      } catch (err) {
        expect(err.reasons.some(r => /week number/i.test(r))).toBe(false);
      }
    }
  });

  it('rejects when "Overview" sheet is missing', () => {
    const filePath = makeWorkbook(
      {
        'Delivery POD': [[]],
      },
      'Week_05_supplier.xlsx',
    );
    try {
      parseSupplierSpreadsheet(filePath, 'Week_05_supplier.xlsx');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SpreadsheetValidationError);
      expect(err.reasons.some(r => /Overview.*missing/i.test(r))).toBe(true);
    }
  });

  it('rejects when "Delivery POD" sheet is missing', () => {
    const filePath = makeWorkbook(
      {
        Overview: [['Row Labels']],
      },
      'Week_05_supplier.xlsx',
    );
    try {
      parseSupplierSpreadsheet(filePath, 'Week_05_supplier.xlsx');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SpreadsheetValidationError);
      expect(err.reasons.some(r => /Delivery POD.*missing/i.test(r))).toBe(true);
    }
  });

  it('collects MULTIPLE reasons before throwing — bad filename + both sheets missing', () => {
    // Design intent: the operator should see every problem in one go,
    // not be forced to fix one, retry, fix the next, retry again.
    const filePath = makeWorkbook(
      {
        // No Overview, no Delivery POD
        SomethingElse: [[]],
      },
      'no_week_here.xlsx',
    );
    try {
      parseSupplierSpreadsheet(filePath, 'no_week_here.xlsx');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SpreadsheetValidationError);
      // Should have ALL THREE reasons: bad filename + missing Overview + missing PODs.
      expect(err.reasons.length).toBeGreaterThanOrEqual(3);
      expect(err.reasons.some(r => /week number/i.test(r))).toBe(true);
      expect(err.reasons.some(r => /Overview/i.test(r))).toBe(true);
      expect(err.reasons.some(r => /Delivery POD/i.test(r))).toBe(true);
    }
  });

  it('rejects when Overview has no ODR-pattern rows', () => {
    // Overview present but no recognisable order rows in the pivot.
    // Delivery POD is empty too (so we get both errors collected).
    const filePath = makeWorkbook(
      {
        Overview: [['Row Labels'], ['Total']],
        'Delivery POD': [['Header']],
      },
      'Week_22_supplier.xlsx',
    );
    try {
      parseSupplierSpreadsheet(filePath, 'Week_22_supplier.xlsx');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SpreadsheetValidationError);
      expect(err.reasons.some(r => /No order rows.*ODR/i.test(r))).toBe(true);
    }
  });

  it('rejects when Delivery POD sheet has no PDF URLs', () => {
    const filePath = makeWorkbook(
      {
        Overview: [
          ['Row Labels', 'Discount', 'Delivery Fee Excl NC', 'Price Adjustment'],
          ['ODR-12345', 100, 50, 25],
        ],
        'Delivery POD': [['Just', 'plain', 'text', 'no', 'links']],
      },
      'Week_22_supplier.xlsx',
    );
    try {
      parseSupplierSpreadsheet(filePath, 'Week_22_supplier.xlsx');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SpreadsheetValidationError);
      expect(err.reasons.some(r => /No POD URLs/i.test(r))).toBe(true);
    }
  });

  it('rejects on a non-existent file path', () => {
    // xlsx is surprisingly permissive about garbage *contents* (a plain
    // text file gets coerced into a dummy "Sheet1" workbook), but a
    // non-existent path is unambiguous — the readFile call throws ENOENT
    // and we want that to surface as a clean SpreadsheetValidationError
    // rather than crash the request handler.
    const missingPath = path.join(tmpDir, 'does-not-exist.xlsx');
    try {
      parseSupplierSpreadsheet(missingPath, 'Week_01_missing.xlsx');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SpreadsheetValidationError);
      expect(err.reasons[0]).toMatch(/Could not open file/i);
    }
  });
});

describe('SpreadsheetValidationError shape', () => {
  it('carries reasons array and fileName for the route to forward to UI', () => {
    const err = new SpreadsheetValidationError(['a', 'b', 'c'], 'foo.xlsx');
    expect(err.name).toBe('SpreadsheetValidationError');
    expect(err.reasons).toEqual(['a', 'b', 'c']);
    expect(err.fileName).toBe('foo.xlsx');
    expect(err.message).toMatch(/3 issues/);
  });

  it('uses singular "issue" for a single reason', () => {
    const err = new SpreadsheetValidationError(['one thing'], 'bar.xlsx');
    expect(err.message).toMatch(/\(1 issue\)/);
    expect(err.message).not.toMatch(/issues/);
  });
});
