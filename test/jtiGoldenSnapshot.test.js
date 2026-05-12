// Golden snapshot test for the JTI export against the supplied sample
// docs/JTI_Cardoso_Sales_Ermelo_20260430.xlsx. Asserts that the
// builder produces the same STRUCTURAL shape — sheet name, headers,
// per-column types and number formats — that the existing macro-
// produced file has.
//
// We can't byte-compare .xlsx files (zip metadata varies; any change
// to xlsx-lib internals would break the test). Instead we re-parse
// both files and assert on the structure the downstream pipeline
// actually reads.
//
// The sample file is gitignored (see docs/*.xlsx in .gitignore — it
// contains real customer/shipment data and shouldn't be in source).
// This test therefore SKIPS when the sample is absent, so CI without
// the sample still passes. Run locally with the file present to
// validate against reality.

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';
import { buildJtiWorkbook } from '../src/services/jti/jtiSpreadsheet.js';

const SAMPLE_PATH = path.join(process.cwd(), 'docs', 'JTI_Cardoso_Sales_Ermelo_20260430.xlsx');

const samplePresent = fs.existsSync(SAMPLE_PATH);

const describeIfSample = samplePresent ? describe : describe.skip;

describeIfSample('JTI golden snapshot — structural equivalence with the supplied sample', () => {
  let goldenWb;
  let goldenWs;
  let goldenRange;

  beforeAll(() => {
    goldenWb = XLSX.readFile(SAMPLE_PATH, {
      cellStyles: true,
      cellFormula: true,
      cellNF: true,
      cellDates: true,
    });
    goldenWs = goldenWb.Sheets[goldenWb.SheetNames[0]];
    goldenRange = XLSX.utils.decode_range(goldenWs['!ref']);
  });

  it('the golden file has exactly one sheet named "Sheet1"', async () => {
    expect(goldenWb.SheetNames).toEqual(['Sheet1']);
  });

  it('the golden file has 14 columns A..N', async () => {
    expect(goldenRange.e.c).toBe(13);
  });

  it('the golden header row matches our JTI_HEADERS constant exactly', async () => {
    const expectedHeaders = [
      'DocumentType', 'DocumentNumber', 'Date', 'ProductCode', 'ProductName',
      'CustomerCode', 'CustomerName', 'TownCity', 'Region', 'Country',
      'Quantity', 'CostExVAT', 'NetValueExVAT', 'Currency',
    ];
    const actual = expectedHeaders.map((_, c) => {
      const cell = goldenWs[XLSX.utils.encode_cell({ r: 0, c })];
      return cell ? cell.v : null;
    });
    expect(actual).toEqual(expectedHeaders);
  });

  it('the Date column (C) uses number format "0" in the golden', async () => {
    // First data row at r=1 (r=0 is header)
    const cell = goldenWs[XLSX.utils.encode_cell({ r: 1, c: 2 })];
    expect(cell?.t).toBe('n');
    expect(cell?.z).toBe('0');
  });

  it('the Quantity column (K) uses number format "#,##0.00" in the golden', async () => {
    const cell = goldenWs[XLSX.utils.encode_cell({ r: 1, c: 10 })];
    expect(cell?.t).toBe('n');
    expect(cell?.z).toBe('#,##0.00');
  });

  // ---- Now verify our builder produces a structurally-equivalent file ----

  async function buildOurs() {
    // A representative row matching the sample's first data row.
    const row = {
      TRANNUM: 'IN000428009',
      TRANDATE: 20260401,
      ITEM: '87',
      DESC: '  CAMEL CLASSIC **BOX**',
      CUSTOMER: '10',
      NAMECUST: 'LIQUOR CITY WHITERIVER',
      QTYSOLD: 2,
    };
    const buf = await buildJtiWorkbook({
      rows: [row],
      manual: { townCity: 'ERMELO', region: 'MPUMALANGA', country: 'SOUTH AFRICA' },
    });
    const wb = XLSX.read(buf, {
      cellStyles: true,
      cellFormula: true,
      cellNF: true,
      cellDates: true,
    });
    return { wb, ws: wb.Sheets[wb.SheetNames[0]] };
  }

  it('our builder produces a workbook with the same single sheet name "Sheet1"', async () => {
    const { wb } = await buildOurs();
    expect(wb.SheetNames).toEqual(goldenWb.SheetNames);
  });

  it('our builder produces the same 14 headers in the same order', async () => {
    const { ws } = await buildOurs();
    const ourHeaders = Array.from({ length: 14 }, (_, c) => {
      const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
      return cell ? cell.v : null;
    });
    const goldenHeaders = Array.from({ length: 14 }, (_, c) => {
      const cell = goldenWs[XLSX.utils.encode_cell({ r: 0, c })];
      return cell ? cell.v : null;
    });
    expect(ourHeaders).toEqual(goldenHeaders);
  });

  it('our builder applies the same number format on the Date column', async () => {
    const { ws } = await buildOurs();
    const ourDate = ws[XLSX.utils.encode_cell({ r: 1, c: 2 })];
    const goldenDate = goldenWs[XLSX.utils.encode_cell({ r: 1, c: 2 })];
    expect(ourDate.t).toBe(goldenDate.t);
    expect(ourDate.z).toBe(goldenDate.z);
  });

  it('our builder applies the same number format on the Quantity column', async () => {
    const { ws } = await buildOurs();
    const ourQty = ws[XLSX.utils.encode_cell({ r: 1, c: 10 })];
    const goldenQty = goldenWs[XLSX.utils.encode_cell({ r: 1, c: 10 })];
    expect(ourQty.t).toBe(goldenQty.t);
    expect(ourQty.z).toBe(goldenQty.z);
  });

  it('our row 2 cell values match the golden row 2 cell values for all populated cols (A..K)', async () => {
    const { ws } = await buildOurs();
    for (let c = 0; c <= 10; c++) {
      const ourCell = ws[XLSX.utils.encode_cell({ r: 1, c })];
      const goldenCell = goldenWs[XLSX.utils.encode_cell({ r: 1, c })];
      // Both should be defined and have equal .v
      expect(ourCell?.v, `column ${String.fromCharCode(65 + c)}`).toBe(goldenCell?.v);
    }
  });
});
