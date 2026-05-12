// Contract tests for src/services/jti/jtiSpreadsheet.js — the linchpin
// of the JTI export module. The downstream data-science pipeline reads
// the .xlsx by column position, not by header lookup, so a single
// misaligned column silently breaks the consumer.
//
// Coverage philosophy: pin everything the pipeline could break on.
// Headers, sheet name, column count (even for empty cells), number
// formats, derived DocumentType, manual-fields propagation. Build →
// re-parse round-trip is the standard assertion shape: produce a
// buffer with the helper, parse it back, assert against expected
// structure.

import { describe, it, expect } from 'vitest';
import XLSX from 'xlsx';
import {
  buildJtiWorkbook,
  deriveDocumentType,
  JTI_HEADERS,
  JTI_SHEET_NAME,
} from '../src/services/jti/jtiSpreadsheet.js';

const SAMPLE_MANUAL = { townCity: 'ERMELO', region: 'MPUMALANGA', country: 'SOUTH AFRICA' };

const SAMPLE_ROW_1 = {
  TRANNUM: 'IN000428009',
  TRANDATE: 20260401,
  ITEM: '87',
  DESC: '  CAMEL CLASSIC **BOX**',
  CUSTOMER: '10',
  NAMECUST: 'LIQUOR CITY WHITERIVER',
  QTYSOLD: 2,
};

const SAMPLE_ROW_2 = {
  TRANNUM: 'IN000428009',
  TRANDATE: 20260401,
  ITEM: '65',
  DESC: '  CAMEL DOUBLE  & PURPLE',
  CUSTOMER: '10',
  NAMECUST: 'LIQUOR CITY WHITERIVER',
  QTYSOLD: 5,
};

// Helper — round-trip parse: build → write → re-read with the same
// xlsx config we'd use in the consumer. Returns the parsed worksheet
// PLUS the workbook so callers can assert sheet metadata too.
//
// buildJtiWorkbook is async (ExcelJS's writeBuffer is async).
async function buildAndParse({ rows, manual }) {
  const buf = await buildJtiWorkbook({ rows, manual });
  const wb = XLSX.read(buf, {
    cellStyles: true,
    cellFormula: true,
    cellNF: true,
    cellDates: true,
  });
  return {
    wb,
    sheetNames: wb.SheetNames,
    ws: wb.Sheets[wb.SheetNames[0]],
  };
}

describe('deriveDocumentType', () => {
  it('returns Invoice for documents containing "IN"', async () => {
    expect(deriveDocumentType('IN000428009')).toBe('Invoice');
    expect(deriveDocumentType('IN1')).toBe('Invoice');
  });

  it('matches case-insensitively (the macro uses Excel SEARCH which is)', async () => {
    expect(deriveDocumentType('in000428009')).toBe('Invoice');
    expect(deriveDocumentType('In12345')).toBe('Invoice');
  });

  it('returns Credit Note when "IN" is absent', async () => {
    expect(deriveDocumentType('CN000428009')).toBe('Credit Note');
    expect(deriveDocumentType('CR12345')).toBe('Credit Note');
    expect(deriveDocumentType('XYZ')).toBe('Credit Note');
  });

  it('returns Credit Note for null / undefined / non-string inputs (defensive)', async () => {
    expect(deriveDocumentType(null)).toBe('Credit Note');
    expect(deriveDocumentType(undefined)).toBe('Credit Note');
    expect(deriveDocumentType(123)).toBe('Credit Note');
    expect(deriveDocumentType({})).toBe('Credit Note');
  });

  it('returns Invoice if "IN" appears anywhere in the string (mirrors macro SEARCH)', async () => {
    // Synthetic edge case — in practice document numbers never contain
    // "IN" mid-string for non-invoices. Pinning macro semantics so a
    // future "tighten this to startsWith" doesn't slip in unnoticed.
    expect(deriveDocumentType('CRINxx')).toBe('Invoice');
  });
});

describe('buildJtiWorkbook — sheet shape', () => {
  it('produces a single sheet named exactly "Sheet1"', async () => {
    const { sheetNames } = await buildAndParse({ rows: [SAMPLE_ROW_1], manual: SAMPLE_MANUAL });
    expect(sheetNames).toEqual([JTI_SHEET_NAME]);
    expect(JTI_SHEET_NAME).toBe('Sheet1');
  });

  it('emits exactly 14 columns in the header row, in the documented order', async () => {
    const { ws } = await buildAndParse({ rows: [SAMPLE_ROW_1], manual: SAMPLE_MANUAL });
    const headers = JTI_HEADERS.map((_, c) => {
      const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
      return cell ? cell.v : null;
    });
    expect(headers).toEqual([
      'DocumentType', 'DocumentNumber', 'Date', 'ProductCode', 'ProductName',
      'CustomerCode', 'CustomerName', 'TownCity', 'Region', 'Country',
      'Quantity', 'CostExVAT', 'NetValueExVAT', 'Currency',
    ]);
  });

  it('produces a header-only sheet when rows are empty (not a 404)', async () => {
    const { ws } = await buildAndParse({ rows: [], manual: SAMPLE_MANUAL });
    const range = XLSX.utils.decode_range(ws['!ref']);
    expect(range.e.r).toBe(0);     // only the header row
    expect(range.e.c).toBe(13);    // all 14 columns A..N still present
    expect(ws['A1'].v).toBe('DocumentType');
  });
});

describe('buildJtiWorkbook — data row layout', () => {
  it('places each source field in the correct column for row 2', async () => {
    const { ws } = await buildAndParse({ rows: [SAMPLE_ROW_1], manual: SAMPLE_MANUAL });
    expect(ws['A2'].v).toBe('Invoice');             // DocumentType derived
    expect(ws['B2'].v).toBe('IN000428009');         // DocumentNumber
    expect(ws['C2'].v).toBe(20260401);              // Date as number
    expect(ws['D2'].v).toBe('87');                  // ProductCode
    expect(ws['E2'].v).toBe('  CAMEL CLASSIC **BOX**');  // ProductName w/ leading whitespace preserved
    expect(ws['F2'].v).toBe('10');                  // CustomerCode
    expect(ws['G2'].v).toBe('LIQUOR CITY WHITERIVER'); // CustomerName
    expect(ws['H2'].v).toBe('ERMELO');              // TownCity (manual)
    expect(ws['I2'].v).toBe('MPUMALANGA');          // Region (manual)
    expect(ws['J2'].v).toBe('SOUTH AFRICA');        // Country (manual)
    expect(ws['K2'].v).toBe(2);                     // Quantity
  });

  it('preserves leading whitespace in ProductName (macro/Crystal artefact)', async () => {
    const row = { ...SAMPLE_ROW_1, DESC: '   GLAMOUR*SUPERSLIM* PINK' };
    const { ws } = await buildAndParse({ rows: [row], manual: SAMPLE_MANUAL });
    expect(ws['E2'].v).toBe('   GLAMOUR*SUPERSLIM* PINK');
  });

  it('keeps the row order from the input array (no internal sorting)', async () => {
    // Rows arrive sorted by date from the SQL ORDER BY; the builder
    // must not re-sort or it'd cause subtle inconsistencies on
    // ties (same-date rows could shuffle).
    const out_of_order = [
      { ...SAMPLE_ROW_1, ITEM: 'B', QTYSOLD: 99 },
      { ...SAMPLE_ROW_1, ITEM: 'A', QTYSOLD: 1 },
      { ...SAMPLE_ROW_1, ITEM: 'C', QTYSOLD: 2 },
    ];
    const { ws } = await buildAndParse({ rows: out_of_order, manual: SAMPLE_MANUAL });
    expect(ws['D2'].v).toBe('B');
    expect(ws['D3'].v).toBe('A');
    expect(ws['D4'].v).toBe('C');
  });

  it('applies the same TownCity/Region/Country to every row', async () => {
    const { ws } = await buildAndParse({ rows: [SAMPLE_ROW_1, SAMPLE_ROW_2], manual: SAMPLE_MANUAL });
    expect(ws['H2'].v).toBe('ERMELO');
    expect(ws['H3'].v).toBe('ERMELO');
    expect(ws['I2'].v).toBe('MPUMALANGA');
    expect(ws['I3'].v).toBe('MPUMALANGA');
    expect(ws['J2'].v).toBe('SOUTH AFRICA');
    expect(ws['J3'].v).toBe('SOUTH AFRICA');
  });

  it('coerces null manual fields to empty strings (defensive)', async () => {
    const { ws } = await buildAndParse({
      rows: [SAMPLE_ROW_1],
      manual: { townCity: null, region: undefined, country: '' },
    });
    expect(ws['H2']?.v ?? '').toBe('');
    expect(ws['I2']?.v ?? '').toBe('');
    expect(ws['J2']?.v ?? '').toBe('');
  });

  it('handles null NAMECUST without rendering "null" text (LEFT JOIN may produce null)', async () => {
    const orphan = { ...SAMPLE_ROW_1, NAMECUST: null };
    const { ws } = await buildAndParse({ rows: [orphan], manual: SAMPLE_MANUAL });
    // Cell either absent or empty string, NEVER literal "null"
    expect(ws['G2']?.v ?? '').toBe('');
  });
});

describe('buildJtiWorkbook — number formats', () => {
  it('Date column (C) is a number cell with format "0"', async () => {
    const { ws } = await buildAndParse({ rows: [SAMPLE_ROW_1], manual: SAMPLE_MANUAL });
    expect(ws['C2'].t).toBe('n');
    expect(ws['C2'].z).toBe('0');
  });

  it('Quantity column (K) is a number cell with format "#,##0.00"', async () => {
    const { ws } = await buildAndParse({ rows: [SAMPLE_ROW_1], manual: SAMPLE_MANUAL });
    expect(ws['K2'].t).toBe('n');
    expect(ws['K2'].z).toBe('#,##0.00');
  });

  it('does NOT format the header row (matches macro behaviour — header stays General)', async () => {
    const { ws } = await buildAndParse({ rows: [SAMPLE_ROW_1], manual: SAMPLE_MANUAL });
    expect(ws['C1'].z === undefined || ws['C1'].z === 'General').toBe(true);
    expect(ws['K1'].z === undefined || ws['K1'].z === 'General').toBe(true);
  });

  it('Date stays as integer YYYYMMDD, NOT converted to an Excel date value', async () => {
    const { ws } = await buildAndParse({ rows: [SAMPLE_ROW_1], manual: SAMPLE_MANUAL });
    // If we accidentally treated 20260401 as an Excel date serial, it
    // would round-trip as a Date object. Asserting it's still a plain
    // number locks in the integer-date-as-int contract.
    expect(typeof ws['C2'].v).toBe('number');
    expect(ws['C2'].v).toBe(20260401);
    expect(ws['C2'].v instanceof Date).toBe(false);
  });
});

describe('buildJtiWorkbook — placeholder columns L/M/N', () => {
  it('CostExVAT / NetValueExVAT / Currency cells are absent (not blank strings)', async () => {
    // The supplied sample shows those cells as entirely absent in the
    // sheet — meaning the consumer pipeline tolerates either, but the
    // sample's format is "no cell entry" and we mirror that. Asserting
    // here so a future change to write '' (which xlsx would emit as a
    // cell entry) is caught.
    const { ws } = await buildAndParse({ rows: [SAMPLE_ROW_1], manual: SAMPLE_MANUAL });
    expect(ws['L2']).toBeUndefined();
    expect(ws['M2']).toBeUndefined();
    expect(ws['N2']).toBeUndefined();
  });

  it('column count of the sheet stays at 14 even though L/M/N are absent', async () => {
    // The column count is inferred from the header row, which DOES
    // populate all 14. Guarantees the consumer sees a 14-column sheet.
    const { ws } = await buildAndParse({ rows: [SAMPLE_ROW_1], manual: SAMPLE_MANUAL });
    const range = XLSX.utils.decode_range(ws['!ref']);
    expect(range.e.c).toBe(13);
  });
});

describe('buildJtiWorkbook — input validation', () => {
  it('rejects with TypeError when rows is not an array', async () => {
    // buildJtiWorkbook is async — synchronous throws inside become
    // promise rejections. expect(...).rejects.toThrow is the right
    // assertion shape.
    await expect(buildJtiWorkbook({ rows: null, manual: SAMPLE_MANUAL })).rejects.toThrow(TypeError);
    await expect(buildJtiWorkbook({ rows: 'oops', manual: SAMPLE_MANUAL })).rejects.toThrow(TypeError);
  });

  it('rejects with TypeError when manual fields are missing', async () => {
    await expect(buildJtiWorkbook({ rows: [], manual: null })).rejects.toThrow(TypeError);
    await expect(buildJtiWorkbook({ rows: [] })).rejects.toThrow(TypeError);
  });
});

describe('buildJtiWorkbook — font (Arial 10)', () => {
  // Pin that the output uses Arial 10 throughout — matches the macro's
  // reference output. The default xlsx-CE library silently dropped
  // font settings; we use ExcelJS specifically to honour them.
  //
  // ExcelJS keeps a default Calibri 11 entry as font 0 in the styles
  // table (Excel's universal default). It then defines Arial 10 as
  // font 1 and points every cellXf at it. So the right assertion is
  // "Arial 10 is defined AND the cells reference a non-default xfId"
  // — verified by re-reading the buffer via ExcelJS, which tells us
  // each cell's effective font directly.
  it('every populated cell reports Arial size 10 when read back via ExcelJS', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const buf = await buildJtiWorkbook({ rows: [SAMPLE_ROW_1], manual: SAMPLE_MANUAL });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.getWorksheet(1);
    let inspected = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        inspected++;
        expect(cell.font?.name, `${cell.address} font name`).toBe('Arial');
        expect(cell.font?.size, `${cell.address} font size`).toBe(10);
      });
    });
    // Header (14) + data row (11 populated, L/M/N absent) = 25 cells.
    expect(inspected).toBeGreaterThanOrEqual(20);
  });

  it('Arial 10 is registered in styles.xml (independent verification)', async () => {
    const buf = await buildJtiWorkbook({ rows: [SAMPLE_ROW_1], manual: SAMPLE_MANUAL });
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(buf);
    const stylesXml = await zip.file('xl/styles.xml').async('string');
    // ExcelJS will retain its default Calibri 11 as font 0 even when
    // no cell uses it. We only require that an Arial 10 font be
    // present somewhere in the table — the per-cell inspection above
    // confirms cells actually point to it.
    expect(stylesXml).toMatch(/<sz val="10"\/><name val="Arial"\/>/i);
  });
});

describe('buildJtiWorkbook — DocumentType edge cases', () => {
  it('emits Credit Note for a credit-note document', async () => {
    const cn = { ...SAMPLE_ROW_1, TRANNUM: 'CN000123456' };
    const { ws } = await buildAndParse({ rows: [cn], manual: SAMPLE_MANUAL });
    expect(ws['A2'].v).toBe('Credit Note');
  });

  it('emits Credit Note when DocumentNumber is empty', async () => {
    const orphan = { ...SAMPLE_ROW_1, TRANNUM: '' };
    const { ws } = await buildAndParse({ rows: [orphan], manual: SAMPLE_MANUAL });
    expect(ws['A2'].v).toBe('Credit Note');
  });
});
