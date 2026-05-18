// BAT supplier + Cardoso spreadsheet parsers.
//
// Carved out of src/services/batReconciliation.js as part of the
// module split (PR #279 was the first step). This is the cleanest
// next extraction because the parser:
//   - has no dependency on Sage / OCR / workers / routes
//   - is already testable (test/parseSupplierSpreadsheet.test.js
//     covers the validation paths)
//   - is an active hardening surface (PRs #274 + supplier_total
//     auto-recompute were both about parser robustness)
//
// What this module owns:
//   - SpreadsheetValidationError — structured error class the route
//     unwraps into a 400 response with a `reasons[]` list
//   - parseSupplierSpreadsheet — entry point for BAT supplier xlsx uploads
//   - parseCardosoSpreadsheet — entry point for Cardoso-format xlsx uploads
//   - extractFees / extractStoreName / extractOrderAmounts /
//     extractPodUrls / parseAmount — internal helpers
//   - FEE_MATCHERS — preference-ordered header predicates that absorb
//     supplier typos (e.g. "Adjustement") + Incl/Excl ambiguity
//
// What stays elsewhere:
//   - DB writes (createReconciliation, insertPodEntries) — repository
//     concern, not parser
//   - Sage queries — boundary concern, not parser
//   - Audit logging — route concern
//
// All log lines preserved with their existing prefixes (`[bat]`,
// `[bat-diag]`, `[bat.parser.year_disagreement]`) so log-grep recipes
// in the operator runbook still work after the move.

import XLSX from 'xlsx';
import { logError } from '../../lib/errorLog.js';
import { isoYear } from '../../lib/isoWeek.js';

// Structured upload-rejection error — carries an array of human-
// readable reasons the UI lists verbatim in the rejection modal.
// Distinguishes "spreadsheet rejected for documented reasons" (400 with
// diagnostic list) from "the parser itself crashed unexpectedly" (500).
export class SpreadsheetValidationError extends Error {
  constructor(reasons, fileName) {
    super(`Spreadsheet rejected (${reasons.length} issue${reasons.length !== 1 ? 's' : ''}): ${reasons.join(' | ')}`);
    this.name = 'SpreadsheetValidationError';
    this.reasons = reasons;
    this.fileName = fileName;
  }
}

export function parseSupplierSpreadsheet(filePath, originalFilename) {
  // Collect every problem we find before throwing — the operator gets the
  // full picture in one go instead of fixing one issue, retrying, fixing
  // the next, retrying again.
  const errors = [];

  // Detect week number from filename FIRST (cheap check, no file read needed)
  const weekMatch = originalFilename.match(/Week[_\s]*(\d{1,2})/i);
  const weekNumber = weekMatch ? parseInt(weekMatch[1], 10) : null;
  if (!weekNumber) {
    errors.push(`Could not detect week number from filename "${originalFilename}". Expected format like "Week_19_..." or "Week 19 ...".`);
  }

  let workbook;
  try {
    workbook = XLSX.readFile(filePath);
  } catch (err) {
    // File itself is unreadable — no point continuing with other checks.
    throw new SpreadsheetValidationError(
      [`Could not open file as a spreadsheet: ${err.message}. The file may be corrupt or not a valid .xlsx/.xls.`],
      originalFilename,
    );
  }

  // Required sheets
  const overviewSheet = workbook.Sheets['Overview'];
  if (!overviewSheet) {
    errors.push(`Required sheet "Overview" is missing. Found sheets: ${workbook.SheetNames.join(', ') || '(none)'}.`);
  }
  const podSheet = workbook.Sheets['Delivery POD'];
  if (!podSheet) {
    errors.push(`Required sheet "Delivery POD" is missing. Found sheets: ${workbook.SheetNames.join(', ') || '(none)'}.`);
  }

  // If either required sheet is missing, we can't extract anything else
  // meaningfully — fail fast with what we already have.
  if (!overviewSheet || !podSheet) {
    throw new SpreadsheetValidationError(errors, originalFilename);
  }

  const overviewData = XLSX.utils.sheet_to_json(overviewSheet, { header: 1, defval: '' });
  const fees = extractFees(overviewData);
  let storeName = extractStoreName(overviewData);
  const orderAmounts = extractOrderAmounts(overviewData);

  const podData = XLSX.utils.sheet_to_json(podSheet, { header: 1, defval: '' });
  const podUrls = [];
  const detectedYear = extractPodUrls(podData, podUrls);
  if (!storeName) storeName = extractStoreName(podData);

  // Structural checks: zero ODR rows or zero PODs means the spreadsheet
  // looks structurally wrong (parser found no order numbers in the
  // Overview pivot, or no PDF links in the Delivery POD sheet). Saving
  // this would create an empty recon that the operator could never use.
  // Note: per the user's strictness setting, all-zero fees alone is NOT
  // a hard fail (some weeks legitimately have zero pricing adjustment
  // etc.) — only flagged when accompanied by zero ODRs / zero PODs.
  if (orderAmounts.size === 0) {
    errors.push(`No order rows (ODR-...) found in the "Overview" sheet pivot table. The fees + order-amount extractor couldn't locate any data — the layout may have changed, or the wrong sheet is named "Overview".`);
  }
  if (podUrls.length === 0) {
    errors.push(`No POD URLs (PDF links) found in the "Delivery POD" sheet. Without PDFs the OCR pipeline has nothing to process.`);
  }

  // Per-fee-category column-not-found checks. Each FEE_MATCHERS entry
  // accepts a generous range of header variants (typos, abbreviations,
  // singular/plural). If a category STILL didn't match anywhere, the
  // supplier's header is likely in a form we've never seen before — we
  // refuse the upload with an explicit reason rather than silently
  // writing R 0.00 into the recon. Operator can then either fix the
  // source spreadsheet (most common — a typo by the supplier) or send
  // the new header text so we can extend the matcher.
  //
  // We do NOT fail when a category matched but the SUM is zero — that's
  // a legitimate case (genuinely no Pricing Adjustments for the week).
  // We only fail when the COLUMN itself was never located.
  const feeChecks = [
    { key: 'discount', label: 'Discount',           expectedHeaders: 'Discount, Sum of Discount' },
    { key: 'delivery', label: 'Delivery Fee',       expectedHeaders: 'Delivery Fee, Delivery Fee Excl NC, Sum of Delivery Fee' },
    { key: 'pricing',  label: 'Price Adjustment',   expectedHeaders: 'Price Adjustment, Pricing Adjustment, Sum of Price Adjustment' },
  ];
  for (const check of feeChecks) {
    if (!fees._matched[check.key]) {
      errors.push(
        `Couldn't find the "${check.label}" column anywhere in the Overview sheet — header text didn't match any known variant. ` +
        `Expected one of: ${check.expectedHeaders}. ` +
        `Common cause: the supplier renamed or typo'd the header (e.g. "Adjustement" instead of "Adjustment"). ` +
        `Fix the column header in the spreadsheet and re-upload, OR send the operator team the actual header text so we can extend the parser. ` +
        `Refusing the upload because importing with R 0.00 here would silently corrupt the BAT TOTAL on this recon.`
      );
    }
  }

  if (errors.length > 0) {
    throw new SpreadsheetValidationError(errors, originalFilename);
  }

  // Fallback: if per-row branch wasn't found, use overview-level store name
  if (storeName) {
    for (const pod of podUrls) {
      if (!pod.branchName) pod.branchName = storeName;
    }
  }

  // Match order amounts from Overview sheet (normal + exception)
  if (orderAmounts.size > 0) {
    for (const pod of podUrls) {
      if (pod.orderNumber && orderAmounts.has(pod.orderNumber)) {
        const entry = orderAmounts.get(pod.orderNumber);
        pod.orderAmount = entry.amount;
        pod.isException = entry.isException ? 1 : 0;
        pod.supplierDiscount = entry.discount;
        pod.supplierDelFee = entry.deliveryFee;
        pod.supplierPricing = entry.pricingAdj;
      }
    }
    const matched = podUrls.filter(p => p.orderAmount != null);
    const exceptions = podUrls.filter(p => p.isException);
    console.log(`[bat] Matched ${matched.length}/${podUrls.length} order amounts (${exceptions.length} exceptions)`);
  }

  // Year-boundary sanity check. The order-number year-detection
  // (ORD-YYYY) is right ~99% of the time, but if a supplier hasn't
  // rolled their numbering at the year change, a Week 1 / 2026 file
  // can come in with ORD-2025-* numbers and get misfiled to 2025.
  // We don't auto-correct (a retroactive upload of last year's data
  // is legitimate), but if the recon's week_number is in the
  // year-straddle danger zone (W1-2 or W51-53) AND the detected year
  // disagrees with the ISO year of the upload date, log a warning so
  // the operator sees the discrepancy in System Log and can override
  // via the form's year selector before processing.
  if (detectedYear && weekNumber) {
    const inDangerZone = weekNumber <= 2 || weekNumber >= 51;
    const uploadIsoYear = isoYear(new Date());
    if (inDangerZone && detectedYear !== uploadIsoYear) {
      try {
        logError(
          'bat.parser.year_disagreement',
          new Error(
            `Year detected from order numbers (${detectedYear}) disagrees with ISO year of upload date (${uploadIsoYear}) for boundary week W${weekNumber}. Verify the year is correct before processing — supplier may not have rolled their order numbering at the year change.`,
          ),
          {
            file: originalFilename,
            week_number: weekNumber,
            detected_year: detectedYear,
            upload_iso_year: uploadIsoYear,
          },
          'warn',
        );
      } catch { /* logError best-effort — don't block the upload */ }
    }
  }

  return {
    weekNumber,
    year: detectedYear,
    fees,
    storeName,
    orderAmounts,
    podUrls,
    podCount: podUrls.length,
  };
}

// Matcher predicates lifted out so they're testable, reusable, and
// deliberately tolerant of common header drift. The previous strict
// equality (`cell === 'PRICE ADJUSTMENT'`) silently dropped real-world
// variants like "Sum of Price Adjustement" (typo, extra "e") — the
// column wasn't matched, the fee value silently became R 0.00, and the
// recon's BAT TOTAL was wrong with no operator-visible signal.
//
// Each matcher accepts the exact text plus reasonable variants
// (singular/plural, common typos, abbreviation forms). New variants can
// be added by extending the regex without touching the surrounding
// extraction logic.
export const FEE_MATCHERS = {
  // PRICE ADJUSTMENT, PRICING ADJUSTMENT, PRICE ADJUSTEMENT (typo),
  // SUM OF PRICE ADJUSTMENT, PRICE ADJ, PRICING ADJ.
  pricing:  (s) => /(^|\s)(PRICE|PRICING)\s*ADJ/.test(s),
  // DISCOUNT, SUM OF DISCOUNT — guard against TOTAL/HEADER rows that
  // contain DISCOUNT as part of a larger label (e.g. "TOTAL DISCOUNT").
  discount: (s) => /(^|\s)DISCOUNT(\s|$)/.test(s) && !/TOTAL/.test(s),

  // Delivery is preference-ordered to handle the common case of a sheet
  // with BOTH "Delivery Fee Incl NC" and "Delivery Fee Excl NC" columns:
  // the recon needs the Excl total (VAT-exclusive), and a permissive
  // single matcher would happily bind to whichever column appears first
  // — silently summing VAT-inclusive values into supplier_delivery while
  // _matched.delivery still reads true. Codex review catch on PR #274.
  //
  // The extraction loop tries each matcher in order:
  //   1. deliveryExcl    — explicit EXCL variant, always preferred
  //   2. deliveryPlain   — bare "Delivery Fee" with no EXCL/INCL marker
  //                        (templates that only have a single column)
  //
  // deliveryIncl exists only as a NEGATIVE guard — extraction code
  // SKIPS columns that match it so we never accidentally bind to the
  // VAT-inclusive variant.
  deliveryExcl:  (s) => /DELIVERY/.test(s) && /EXCL/.test(s) && !/TOTAL|VOLUME/.test(s),
  deliveryIncl:  (s) => /DELIVERY/.test(s) && /INCL/.test(s),
  deliveryPlain: (s) => /DELIVERY/.test(s) && !/EXCL|INCL|TOTAL|VOLUME/.test(s),
};

function extractFees(rows) {
  const fees = {
    discount: { subTotal: 0, vat: 0, total: 0 },
    delivery: { subTotal: 0, vat: 0, total: 0 },
    pricing: { subTotal: 0, vat: 0, total: 0 },
    total: { subTotal: 0, vat: 0, total: 0 },
    // Per-category match flags — caller (parseSupplierSpreadsheet)
    // checks these after extraction and raises a structured upload
    // error when any category was never matched. Without this, a
    // missing column silently writes R 0.00 into the recon, which
    // pollutes BAT TOTAL and the BAT-vs-Sage variance calculation
    // without any operator-visible signal.
    _matched: { discount: false, delivery: false, pricing: false },
  };

  // Sum from the Overview pivot table. Strategy:
  // 1. Find the first "Row Labels" header — that marks the left pivot
  // 2. Find "Discount", "Delivery Fee Excl NC", "Price Adjustment" in that SAME header row
  //    but only columns AFTER the Row Labels column (to stay in the left pivot)
  // 3. Find the ODR column in data rows, sum only those rows

  let headerRow = -1, pivotStart = -1;
  let discountCol = -1, deliveryCol = -1, pricingCol = -1;
  let odrCol = -1;

  // Strategy: find the first row that has ODR- data, then look ABOVE it for the header row
  // with Discount / Delivery Fee / Price Adjustment. This avoids "Row Labels" ambiguity.
  let firstOdrRow = -1, firstOdrCol = -1;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    for (let j = 0; j < row.length; j++) {
      if (String(row[j] || '').trim().startsWith('ODR-')) {
        if (firstOdrCol < 0 || j < firstOdrCol) { // leftmost ODR column
          firstOdrRow = i;
          firstOdrCol = j;
        }
        break; // only check first ODR per row
      }
    }
    if (firstOdrCol >= 0) break;
  }

  if (firstOdrCol >= 0) {
    // Search header rows above the first ODR row, same column area
    for (let i = firstOdrRow - 1; i >= Math.max(0, firstOdrRow - 5); i--) {
      const row = rows[i];
      if (!Array.isArray(row)) continue;
      // Only look at columns near the ODR column (within the same pivot)
      // Track delivery candidates separately so we can prefer EXCL over
      // a bare "Delivery Fee" header when both kinds appear in the sheet.
      // See FEE_MATCHERS.deliveryExcl/Plain comment block.
      let deliveryColExcl = -1;
      let deliveryColPlain = -1;
      for (let j = firstOdrCol; j < Math.min(row.length, firstOdrCol + 15); j++) {
        const cell = String(row[j] || '').trim().toUpperCase();
        if (FEE_MATCHERS.discount(cell) && discountCol < 0) discountCol = j;
        if (FEE_MATCHERS.pricing(cell)  && pricingCol  < 0) pricingCol  = j;
        // Delivery: classify each candidate. Skip Incl outright (we
        // never want to bind to the VAT-inclusive column).
        if (FEE_MATCHERS.deliveryIncl(cell)) continue;
        if (FEE_MATCHERS.deliveryExcl(cell)  && deliveryColExcl  < 0) deliveryColExcl  = j;
        else if (FEE_MATCHERS.deliveryPlain(cell) && deliveryColPlain < 0) deliveryColPlain = j;
      }
      if (deliveryCol < 0) {
        // Excl wins; bare Delivery is the fallback when no Excl exists.
        deliveryCol = deliveryColExcl >= 0 ? deliveryColExcl : deliveryColPlain;
      }
      if (discountCol >= 0 || deliveryCol >= 0 || pricingCol >= 0) {
        headerRow = i;
        pivotStart = firstOdrCol;
        break;
      }
    }

    // Find the second "Row Labels" to mark the right pivot boundary
    if (headerRow >= 0) {
      const hdrRow = rows[headerRow];
      let pivotEnd = hdrRow.length;
      for (let j = pivotStart + 1; j < hdrRow.length; j++) {
        const cell = String(hdrRow[j] || '').trim().toUpperCase();
        if (cell === 'ROW LABELS') { pivotEnd = j; break; }
      }
      // Verify fee columns are within the left pivot
      if (discountCol >= pivotEnd) discountCol = -1;
      if (deliveryCol >= pivotEnd) deliveryCol = -1;
      if (pricingCol >= pivotEnd) pricingCol = -1;
    }

    console.log(`[bat] extractFees: headerRow=${headerRow}, odrCol=${firstOdrCol}, discount@${discountCol}, delivery@${deliveryCol}, pricing@${pricingCol}`);
  }

  if (headerRow < 0 || (discountCol < 0 && deliveryCol < 0 && pricingCol < 0)) {
    console.log('[bat] extractFees: pivot header not found, trying summary rows');
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const row = rows[i];
      if (!Array.isArray(row)) continue;
      const label = String(row[0] || '').trim().toUpperCase();
      if (!label) continue;
      const numericCells = [];
      for (let j = 1; j < row.length; j++) {
        const val = parseAmount(row[j]);
        if (val !== null) numericCells.push(val);
      }
      const last3 = numericCells.slice(-3);
      // Same loosened matchers as the pivot path so a typo in the
      // summary section (where these labels also appear) doesn't fall
      // through to a silent zero.
      if (last3.length < 3) continue;
      if (FEE_MATCHERS.discount(label)) {
        fees.discount = { subTotal: last3[0], vat: last3[1], total: last3[2] };
        fees._matched.discount = true;
      } else if (FEE_MATCHERS.deliveryIncl(label)) {
        // Explicit Incl variant — skip. See FEE_MATCHERS comment.
        continue;
      } else if (FEE_MATCHERS.deliveryExcl(label) || (FEE_MATCHERS.deliveryPlain(label) && !fees._matched.delivery)) {
        // Excl always wins; bare "Delivery" only accepted if no Excl
        // has matched yet (preference-ordered to match the pivot path).
        fees.delivery = { subTotal: last3[0], vat: last3[1], total: last3[2] };
        fees._matched.delivery = true;
      } else if (FEE_MATCHERS.pricing(label)) {
        fees.pricing = { subTotal: last3[0], vat: last3[1], total: last3[2] };
        fees._matched.pricing = true;
      }
    }
  } else {
    // Find the ODR column in data rows
    for (let i = headerRow + 1; i < Math.min(rows.length, headerRow + 10); i++) {
      const row = rows[i];
      if (!Array.isArray(row)) continue;
      for (let j = pivotStart; j < (discountCol >= 0 ? discountCol : pivotStart + 5); j++) {
        if (String(row[j] || '').trim().startsWith('ODR-')) { odrCol = j; break; }
      }
      if (odrCol >= 0) break;
    }

    let discountSum = 0, deliverySum = 0, pricingSum = 0;
    for (let i = headerRow + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row)) continue;
      if (odrCol >= 0 && !String(row[odrCol] || '').trim().startsWith('ODR-')) continue;
      if (discountCol >= 0) discountSum += parseFloat(row[discountCol]) || 0;
      if (deliveryCol >= 0) deliverySum += parseFloat(row[deliveryCol]) || 0;
      if (pricingCol >= 0)  pricingSum  += parseFloat(row[pricingCol]) || 0;
    }

    fees.discount = { subTotal: discountSum, vat: 0, total: discountSum };
    fees.delivery = { subTotal: deliverySum, vat: 0, total: deliverySum };
    fees.pricing  = { subTotal: pricingSum,  vat: 0, total: pricingSum };
    // Track which categories actually had a column matched. A column
    // index of -1 means the header text never matched any of FEE_MATCHERS
    // — caller will surface this to the operator instead of silently
    // shipping a R 0.00 value.
    fees._matched.discount = discountCol >= 0;
    fees._matched.delivery = deliveryCol >= 0;
    fees._matched.pricing  = pricingCol  >= 0;

    console.log(`[bat] Fees from pivot: Discount=R${discountSum.toFixed(2)}, Delivery=R${deliverySum.toFixed(2)}, Pricing=R${pricingSum.toFixed(2)}`);
  }

  // Calculate total
  fees.total.subTotal = fees.discount.subTotal + fees.delivery.subTotal + fees.pricing.subTotal;
  fees.total.vat = fees.discount.vat + fees.delivery.vat + fees.pricing.vat;
  fees.total.total = fees.discount.total + fees.delivery.total + fees.pricing.total;

  return fees;
}

function extractStoreName(rows) {
  // Search all cells for pattern "CARDOSO <STORE> SUPPLIER"
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    for (let j = 0; j < row.length; j++) {
      const cell = String(row[j] || '').trim();
      const match = cell.match(/CARDOSO\s+(.+?)\s+SUPPLIER/i);
      if (match) {
        console.log(`[bat] Found store name "${match[1].trim()}" in Overview row ${i} col ${j}: "${cell}"`);
        return match[1].trim();
      }
    }
  }
  console.log('[bat] Could not find store name pattern "CARDOSO <name> SUPPLIER" in Overview sheet');
  return null;
}

function extractOrderAmounts(rows) {
  // Overview sheet has TWO pivot tables side by side:
  //   Left:  Column J = order number, Column U = Sub Total Excl NC (normal)
  //   Right: Column W = order number, Column AG = Sub Total Excl NC (exception)
  // Returns Map<orderNumber, { amount, isException }>

  const amounts = new Map();

  // Find header row and all "Sub Total" + "Excl" columns
  const subTotalCols = [];
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    for (let j = 0; j < row.length; j++) {
      const cell = String(row[j] || '').trim().toUpperCase();
      if (cell.includes('SUB TOTAL') && cell.includes('EXCL')) subTotalCols.push({ row: i, col: j });
    }
  }

  if (subTotalCols.length === 0) {
    console.log('[bat] Overview order amounts: no "Sub Total Excl" columns found');
    return amounts;
  }

  const headerRow = subTotalCols[0].row;
  const dataStart = headerRow + 1;
  const sortedAmtCols = subTotalCols.map(s => s.col).sort((a, b) => a - b);

  // Find ODR- columns by scanning data rows
  const odrCols = new Set();
  for (let i = dataStart; i < Math.min(rows.length, dataStart + 10); i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    for (let j = 0; j < row.length; j++) {
      if (String(row[j] || '').trim().startsWith('ODR-')) odrCols.add(j);
    }
  }

  // Pair each ODR column with its nearest Sub Total column TO THE RIGHT
  const pairs = [];
  const sortedOdrCols = [...odrCols].sort((a, b) => a - b);

  for (const oc of sortedOdrCols) {
    const ac = sortedAmtCols.find(c => c > oc);
    if (ac != null) {
      const isException = pairs.length > 0; // second pivot = exception
      pairs.push({ orderCol: oc, amountCol: ac, isException });
    }
  }

  // For each pivot, find the canonical data-header row (the row immediately above
  // the first ODR row that ALSO contains a "Sub Total Excl" cell within this pivot's
  // column range). Then read ALL column positions (amount, discount, delivery, pricing)
  // from THAT single row. This guarantees the columns are a coherent set and ignores
  // stray "DISCOUNT" cells in summary/section rows above.
  const widestRow = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
  const isSubTotal = (s) => s.includes('SUB TOTAL') && s.includes('EXCL');
  const isDiscount = (s) => s === 'DISCOUNT';
  const isDelivery = (s) => s === 'DELIVERY FEE EXC NC' || s === 'DELIVERY FEE EXCL NC';
  const isPricing  = (s) => s === 'PRICE ADJUSTMENT' || s === 'PRICING ADJUSTMENT' || s === 'PRICE ADJ' || s === 'PRICING ADJ';
  for (const pair of pairs) {
    const nextPivotStart = pairs.find(p => p.orderCol > pair.orderCol)?.orderCol || widestRow;
    pair.discountCol = -1;
    pair.deliveryCol = -1;
    pair.pricingCol = -1;
    let firstOdrRowForPair = rows.length;
    for (let r = 0; r < rows.length; r++) {
      if (Array.isArray(rows[r]) && String(rows[r][pair.orderCol] || '').trim().startsWith('ODR-')) {
        firstOdrRowForPair = r; break;
      }
    }
    // Walk upward from the first data row to find the row that anchors a "Sub Total Excl"
    // within this pivot's column range. That's the data-header row.
    let headerRowForPair = -1;
    for (let r = firstOdrRowForPair - 1; r >= 0; r--) {
      const row = rows[r];
      if (!Array.isArray(row)) continue;
      for (let j = pair.orderCol; j < nextPivotStart; j++) {
        const cell = String(row[j] || '').trim().toUpperCase();
        if (cell && isSubTotal(cell)) { headerRowForPair = r; break; }
      }
      if (headerRowForPair >= 0) break;
    }
    // Read all column positions from that single header row
    if (headerRowForPair >= 0) {
      const row = rows[headerRowForPair];
      let amountColCandidate = -1;
      for (let j = pair.orderCol; j < nextPivotStart; j++) {
        const cell = String(row[j] || '').trim().toUpperCase();
        if (!cell) continue;
        if (amountColCandidate < 0 && isSubTotal(cell)) amountColCandidate = j;
        if (pair.discountCol < 0 && isDiscount(cell)) pair.discountCol = j;
        if (pair.deliveryCol < 0 && isDelivery(cell)) pair.deliveryCol = j;
        if (pair.pricingCol  < 0 && isPricing(cell))  pair.pricingCol  = j;
      }
      if (amountColCandidate >= 0) pair.amountCol = amountColCandidate;
    }
  }

  console.log(`[bat] Overview pivot pairs: ${pairs.map(p => `ODR@col${p.orderCol}→Amt@col${p.amountCol} (disc@${p.discountCol},del@${p.deliveryCol},price@${p.pricingCol})${p.isException ? ' EXC' : ''}`).join(', ')}`);

  // Diagnostic: when a pivot is missing one or more columns, dump everything
  // we have in the relevant column range from row 0 down to the first ODR row.
  for (const pair of pairs) {
    if (pair.discountCol < 0 || pair.deliveryCol < 0 || pair.pricingCol < 0) {
      const nextPivotStart = pairs.find(p => p.orderCol > pair.orderCol)?.orderCol || widestRow;
      // Find first ODR row for this pivot so we know where data begins
      let firstOdrRowForPair = rows.length;
      for (let r = 0; r < rows.length; r++) {
        if (Array.isArray(rows[r]) && String(rows[r][pair.orderCol] || '').trim().startsWith('ODR-')) {
          firstOdrRowForPair = r; break;
        }
      }
      console.log(`[bat-diag] Pivot ${pair.isException ? 'EXC' : 'NORMAL'} cols ${pair.orderCol}..${nextPivotStart - 1}, first ODR row ${firstOdrRowForPair}:`);
      for (let r = 0; r < Math.min(firstOdrRowForPair + 1, rows.length); r++) {
        const row = rows[r];
        if (!Array.isArray(row)) continue;
        const slice = [];
        for (let j = pair.orderCol; j < nextPivotStart; j++) {
          const v = String(row[j] ?? '').trim();
          if (v) slice.push(`[${j}]="${v}"`);
        }
        if (slice.length) console.log(`[bat-diag]   row ${r}: ${slice.join(' | ')}`);
      }
    }
  }

  const pn = (v) => { const n = parseFloat(String(v || '0').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };

  for (const { orderCol, amountCol, discountCol, deliveryCol, pricingCol, isException } of pairs) {
    for (let i = dataStart; i < rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row)) continue;
      const orderNumber = String(row[orderCol] || '').trim();
      if (!orderNumber.startsWith('ODR-')) continue;
      // Capture every ODR in the Overview pivot, even when the
      // amount cell is blank or non-numeric. The downstream
      // bat_overview_orders persistence (uploadProcessor.js) uses
      // this map to populate the Missing PODs detection table —
      // skipping un-parseable rows would let those ODRs silently
      // vanish from the audit trail, showing "no missing PODs"
      // when the real answer is "we don't know the amount yet for
      // these orders". amount stays null in that case so callers
      // can distinguish "no amount yet" from "amount = R 0".
      const rawVal = row[amountCol];
      let val = null;
      if (rawVal !== '' && rawVal != null) {
        const parsed = parseFloat(String(rawVal).replace(/[^0-9.\-]/g, ''));
        if (!isNaN(parsed)) val = parsed;
      }
      if (!amounts.has(orderNumber)) {
        amounts.set(orderNumber, {
          amount: val,
          isException,
          discount: discountCol >= 0 ? pn(row[discountCol]) : null,
          deliveryFee: deliveryCol >= 0 ? pn(row[deliveryCol]) : null,
          pricingAdj: pricingCol >= 0 ? pn(row[pricingCol]) : null,
        });
      }
    }
  }

  const normal = [...amounts.values()].filter(v => !v.isException).length;
  const exceptions = [...amounts.values()].filter(v => v.isException).length;
  console.log(`[bat] Extracted ${amounts.size} order amounts (${normal} normal, ${exceptions} exceptions)`);
  return amounts;
}

function extractPodUrls(rows, podUrls) {
  // Find header row to locate "Proof of Delivery" column
  let podColIndex = -1;
  let orderNumColIndex = -1;
  let storeColIndex = -1;
  let supplierColIndex = -1;
  let deliveryDateColIndex = -1;
  let weekColIndex = -1;
  let orderDayColIndex = -1;
  let deliveryDayColIndex = -1;
  let leadTimeColIndex = -1;
  let podUploadedColIndex = -1;
  let validateColIndex = -1;
  let targetDaysColIndex = -1;
  let complianceColIndex = -1;
  let exceptionReasonColIndex = -1;
  let headerRowIndex = -1;

  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    let foundPodInRow = false;
    for (let j = 0; j < row.length; j++) {
      const cell = String(row[j] || '').trim().toUpperCase();
      // Prefer "PROOF OF DELIVERY" over generic "POD" to avoid matching "POD Uploaded Date" etc.
      if (cell.includes('PROOF OF DELIVERY')) {
        podColIndex = j;
        headerRowIndex = i;
        foundPodInRow = true;
      }
      if (cell.includes('ORDER NUMBER') || cell.includes('ORDER: ORDER NUMBER') || cell === 'ORDER NO') orderNumColIndex = j;
      if (cell === 'STORE' || cell === 'CUSTOMER NAME') storeColIndex = j;
      if (cell.includes('SUPPLIER') || cell === 'ORDER: SUPPLIER') supplierColIndex = j;
      if (cell === 'DELIVERY DATE' || cell === 'ORDER: DELIVERY DATE') deliveryDateColIndex = j;
      if (cell === 'WEEK') weekColIndex = j;
      if (cell === 'ORDER DAY') orderDayColIndex = j;
      if (cell === 'DELIVERY DAY') deliveryDayColIndex = j;
      if (cell === 'LEAD TIME DELIVERY') leadTimeColIndex = j;
      if (cell.includes('POD UPLOADED DATE')) podUploadedColIndex = j;
      if (cell === 'BRANCH CODE') validateColIndex = j;
      if (cell.includes('TARGET 2') && cell.includes('5')) targetDaysColIndex = j;
      if (cell.includes('PERFORMANCE TARGET') || cell === 'COMPLIANCE STATUS') complianceColIndex = j;
      if (cell.includes('EXCEPTION') && cell.includes('REASON')) exceptionReasonColIndex = j;
    }
    // If we found the POD column in this row, use it as the header row
    if (foundPodInRow) break;
    // Fallback: if no "PROOF OF DELIVERY" yet, check for generic "POD" but only if cell looks like a URL header
    if (podColIndex < 0) {
      for (let j = 0; j < row.length; j++) {
        const cell = String(row[j] || '').trim().toUpperCase();
        if (cell === 'POD' || cell === 'POD URL' || cell === 'POD LINK') {
          podColIndex = j;
          headerRowIndex = i;
          break;
        }
      }
      if (podColIndex >= 0) break;
    }
  }

  if (podColIndex < 0) return null;

  let detectedYear = null;

  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const url = String(row[podColIndex] || '').trim();
    if (!url || !url.startsWith('http')) continue;

    const orderNumber = String(row[orderNumColIndex] || '').trim() || null;

    // Extract year from order number pattern ORD-YYYY-...
    if (!detectedYear && orderNumber) {
      const yearMatch = orderNumber.match(/ORD-(\d{4})/i);
      if (yearMatch) detectedYear = parseInt(yearMatch[1], 10);
    }

    const col = (idx) => idx >= 0 ? String(row[idx] || '').trim() || null : null;

    // Extract branch name from supplier column (e.g. "CARDOSO ERMELO SUPPLIER" -> "ERMELO")
    let branchName = null;
    const supplierVal = col(supplierColIndex);
    if (supplierVal) {
      const m = supplierVal.match(/CARDOSO\s+(.+?)\s+SUPPLIER/i);
      if (m) branchName = m[1].trim();
    }

    podUrls.push({
      url,
      orderNumber,
      branchName,
      storeName: col(storeColIndex),
      week: col(weekColIndex),
      orderDay: col(orderDayColIndex),
      deliveryDay: col(deliveryDayColIndex),
      leadTime: leadTimeColIndex >= 0 ? parseInt(row[leadTimeColIndex], 10) || null : null,
      deliveryDate: col(deliveryDateColIndex),
      podUploadedDate: col(podUploadedColIndex),
      validate: col(validateColIndex),
      targetDays: targetDaysColIndex >= 0 ? parseInt(row[targetDaysColIndex], 10) || null : null,
      complianceStatus: col(complianceColIndex),
      exceptionReason: col(exceptionReasonColIndex),
    });
  }

  return detectedYear;
}

function parseAmount(val) {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number') return val;
  const cleaned = String(val).replace(/[R\s,]/g, '').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

export function parseCardosoSpreadsheet(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });

  // Find header row with invoice number + amount + fee breakdown columns
  let invoiceCol = -1, amountCol = -1, headerRow = -1;
  let priceDiffCol = -1, discountCol = -1, delFeeCol = -1;

  for (let i = 0; i < Math.min(data.length, 15); i++) {
    const row = data[i];
    if (!Array.isArray(row)) continue;
    for (let j = 0; j < row.length; j++) {
      const cell = String(row[j] || '').trim().toUpperCase();
      if (invoiceCol < 0 && (
        (cell.includes('INVOICE') && (cell.includes('NO') || cell.includes('NUM') || cell.includes('NUMBER'))) ||
        cell === 'INVOICE' || cell === 'DOCUMENT NUMBER' || cell === 'DOC NO'
      )) invoiceCol = j;
      if (amountCol < 0 && (
        cell === 'AMOUNT' || cell === 'TOTAL' || cell === 'TOTAL AMOUNT' ||
        cell.includes('NET AMOUNT') || cell === 'VALUE' || cell === 'INVOICE AMOUNT'
      )) amountCol = j;
      if (cell === 'PRICEDIFF' || cell === 'PRICE DIFF' || cell === 'PRICE_DIFF') priceDiffCol = j;
      if (cell === 'DISCOUNT') discountCol = j;
      if (cell === 'DELFEE' || cell === 'DEL FEE' || cell === 'DEL_FEE' || cell === 'DELIVERY FEE') delFeeCol = j;
    }
    if (invoiceCol >= 0 && amountCol >= 0) { headerRow = i; break; }
  }

  // Fallback: if headers not found, try detecting by data patterns
  // Column A often has invoice numbers (IN...), scan for first row with IN prefix in col 0
  if (invoiceCol < 0 || amountCol < 0) {
    for (let i = 0; i < Math.min(data.length, 20); i++) {
      const row = data[i];
      if (!Array.isArray(row)) continue;
      const colA = String(row[0] || '').trim().toUpperCase();
      if (colA.match(/^IN\d/) && invoiceCol < 0) {
        invoiceCol = 0;
        headerRow = Math.max(0, i - 1);
      }
    }
    // Column P (idx 15) for amount if still not found
    if (amountCol < 0 && invoiceCol >= 0) {
      amountCol = 15;
      console.log('[bat] Cardoso parser: using fallback columns A=invoice, P=amount');
    }
  }

  if (invoiceCol < 0) throw new Error('Could not find an Invoice Number column in the spreadsheet');
  if (amountCol < 0) throw new Error('Could not find an Amount column in the spreadsheet');

  console.log(`[bat] Cardoso parser: invoiceCol=${invoiceCol}, amountCol=${amountCol}, priceDiff@${priceDiffCol}, discount@${discountCol}, delFee@${delFeeCol}, headerRow=${headerRow}`);

  const parseNum = (v) => { const n = parseFloat(String(v || '0').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };

  const invoices = [];
  for (let i = headerRow + 1; i < data.length; i++) {
    const row = data[i];
    if (!Array.isArray(row)) continue;
    const rawInvoice = String(row[invoiceCol] || '').trim().toUpperCase();
    if (!rawInvoice || rawInvoice === '0' || rawInvoice === 'GRAND TOTAL') continue;
    invoices.push({
      invoiceNumber: rawInvoice,
      amount: parseNum(row[amountCol]),
      priceDiff: priceDiffCol >= 0 ? parseNum(row[priceDiffCol]) : null,
      discount: discountCol >= 0 ? parseNum(row[discountCol]) : null,
      delFee: delFeeCol >= 0 ? parseNum(row[delFeeCol]) : null,
      rawData: JSON.stringify(row),
    });
  }

  console.log(`[bat] Parsed ${invoices.length} Cardoso invoices (invoiceCol=${invoiceCol}, amountCol=${amountCol})`);
  return invoices;
}
