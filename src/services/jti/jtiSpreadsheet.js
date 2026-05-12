// JTI export — Excel spreadsheet builder.
//
// Replaces the existing Crystal-report-plus-Excel-macro workflow. The
// downstream data-science pipeline expects a SPECIFIC layout — same
// sheet name, same 14 columns, same headers, same number formats —
// and a single misaligned column silently breaks the consumer.
//
// This module is intentionally pure: takes an array of pre-fetched
// rows from Accpac plus three operator-supplied address strings, and
// returns an .xlsx Buffer. No DB, no Sage pool, no I/O. The route
// handler owns fetching the rows and writing the buffer to the wire.
//
// Test surface:
//  - test/jtiSpreadsheet.test.js pins the layout exhaustively
//  - test/jtiGoldenSnapshot.test.js reads the supplied sample
//    docs/JTI_Cardoso_Sales_Ermelo_20260430.xlsx and asserts that
//    the builder produces the same shape for an equivalent input
//
// Anything that the downstream pipeline could break on (header
// strings, sheet name, format codes, blank cells, row order) MUST
// be pinned in those tests. If you change anything in this file,
// the tests will tell you whether the change is safe.

import ExcelJS from 'exceljs';

// Final output column structure. Order is load-bearing — the down-
// stream pipeline indexes by position, not by header name. Comments
// document each column's origin so a future reviewer can map back to
// the macro this replaces.
//
// IMPORTANT: 14 columns, single sheet named "Sheet1" exactly. Both
// constraints come from the macro and the consumer pipeline.
export const JTI_HEADERS = [
  'DocumentType',     // A — derived from DocumentNumber prefix ("IN…" → Invoice, else Credit Note)
  'DocumentNumber',   // B — OESHDT.TRANNUM verbatim (Sage 300 stores it pre-formatted as "IN000428009")
  'Date',             // C — OESHDT.TRANDATE as INTEGER YYYYMMDD (NOT an Excel date type)
  'ProductCode',      // D — OESHDT.ITEM
  'ProductName',      // E — ICITEM.DESC (preserve leading whitespace if present)
  'CustomerCode',     // F — OESHDT.CUSTOMER
  'CustomerName',     // G — ARCUS.NAMECUST
  'TownCity',         // H — operator-supplied per-export (same value for every row)
  'Region',           // I — operator-supplied per-export
  'Country',          // J — operator-supplied per-export
  'Quantity',         // K — OESHDT.QTYSOLD as number, format #,##0.00
  'CostExVAT',        // L — always blank (placeholder the downstream pipeline expects)
  'NetValueExVAT',    // M — always blank (placeholder)
  'Currency',         // N — always blank (placeholder)
];

export const JTI_SHEET_NAME = 'Sheet1';

// Excel number format codes. "0" makes the integer date display as
// 20260401 (no decimals, no scientific notation). "#,##0.00" is the
// quantity format the macro applies.
const FMT_DATE_INT = '0';
const FMT_QUANTITY = '#,##0.00';

// Default font for every cell. Matches the macro's output (Arial 10).
// Applied via ExcelJS — the prior xlsx-CE library silently ignored
// font settings on write, so we switched away from it for this module.
const DEFAULT_FONT = { name: 'Arial', size: 10 };

/**
 * Determine the DocumentType from the DocumentNumber prefix. The macro
 * does this with `=IF(ISNUMBER(SEARCH("IN", B2)), "Invoice", "Credit Note")`
 * — meaning ANY occurrence of "IN" in the document number registers
 * as Invoice. We honour the same wording even though "Credit Note"
 * comes through with a "CN" prefix in practice; the pipeline reads
 * this column literally.
 *
 * @param {string|null|undefined} documentNumber
 * @returns {'Invoice' | 'Credit Note'}
 */
export function deriveDocumentType(documentNumber) {
  if (typeof documentNumber !== 'string') return 'Credit Note';
  // Case-insensitive substring match — the macro uses Excel's SEARCH
  // which is case-insensitive. Don't tighten this without checking
  // a real CN-prefixed sample first.
  return documentNumber.toUpperCase().includes('IN') ? 'Invoice' : 'Credit Note';
}

/**
 * Build the JTI export workbook.
 *
 * @typedef {Object} JtiRow
 * @property {string} TRANNUM         document number (already pre-formatted)
 * @property {number} TRANDATE        integer YYYYMMDD
 * @property {string} ITEM            product code
 * @property {string} DESC            product name
 * @property {string} CUSTOMER        customer code
 * @property {string|null} NAMECUST   customer name (LEFT JOIN — may be null for orphan customers)
 * @property {number} QTYSOLD         quantity
 *
 * @typedef {Object} JtiManualFields
 * @property {string} townCity
 * @property {string} region
 * @property {string} country
 *
 * @param {{ rows: JtiRow[], manual: JtiManualFields }} args
 * @returns {Buffer}  the .xlsx file as a Node Buffer (route handler streams it back to the client)
 */
export async function buildJtiWorkbook({ rows, manual }) {
  if (!Array.isArray(rows)) throw new TypeError('buildJtiWorkbook: rows must be an array');
  if (!manual || typeof manual !== 'object') {
    throw new TypeError('buildJtiWorkbook: manual fields object is required');
  }
  // Coerce the manual inputs to strings so a missing field can't end
  // up rendering as `undefined` text in the cells. Empty string is
  // the right empty for an Excel text cell.
  const townCity = manual.townCity == null ? '' : String(manual.townCity);
  const region   = manual.region   == null ? '' : String(manual.region);
  const country  = manual.country  == null ? '' : String(manual.country);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(JTI_SHEET_NAME);

  // Header row. ExcelJS uses 1-indexed rows.
  ws.addRow(JTI_HEADERS);

  // Data rows. We write null for the always-empty L/M/N cells so the
  // resulting cells aren't even emitted in the sheet — matches the
  // macro's output (those columns exist as headers but data cells
  // are absent, not blank). Quantity / Date stay as native numbers
  // so number formats apply cleanly.
  for (const r of rows) {
    ws.addRow([
      deriveDocumentType(r.TRANNUM),                          // A DocumentType
      r.TRANNUM == null ? '' : String(r.TRANNUM),             // B DocumentNumber
      r.TRANDATE,                                             // C Date (integer YYYYMMDD)
      r.ITEM == null ? '' : String(r.ITEM),                   // D ProductCode
      r.DESC == null ? '' : String(r.DESC),                   // E ProductName (preserve leading whitespace)
      r.CUSTOMER == null ? '' : String(r.CUSTOMER),           // F CustomerCode
      r.NAMECUST == null ? '' : String(r.NAMECUST),           // G CustomerName
      townCity,                                               // H TownCity
      region,                                                 // I Region
      country,                                                // J Country
      r.QTYSOLD,                                              // K Quantity (native number)
      null,                                                   // L CostExVAT (no cell emitted)
      null,                                                   // M NetValueExVAT
      null,                                                   // N Currency
    ]);
  }

  // Number formats on the data rows ONLY (header stays General).
  // ExcelJS column.numFmt would apply to every cell in the column
  // INCLUDING the header — applying per-cell on rows 2..N preserves
  // the macro's "header in General format" behaviour.
  const lastDataRow = rows.length + 1;   // +1 for the header
  for (let r = 2; r <= lastDataRow; r++) {
    ws.getCell(r, 3).numFmt  = FMT_DATE_INT;     // C: Date
    ws.getCell(r, 11).numFmt = FMT_QUANTITY;     // K: Quantity
  }

  // Default font (Arial 10) on every cell that exists. ExcelJS
  // doesn't expose a workbook-default font setter that affects
  // unspecified cells the way Excel's underlying styles.xml does,
  // so we apply per-cell. Header and data both get it; matches the
  // macro's whole-sheet font.
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      cell.font = DEFAULT_FONT;
    });
  });

  // Buffer return — ExcelJS's writeBuffer returns an ArrayBuffer-ish
  // value that Node treats fine, but Buffer.from is the canonical
  // form for the route's res.end(buffer) downstream.
  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
