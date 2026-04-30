import sql from 'mssql';
import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { createWorker } from 'tesseract.js';
import db from '../db/index.js';
import { decryptPassword } from './encryption.js';
import { logError } from '../lib/errorLog.js';

// Status emitter for the SSE-based extraction-status stream. Worker emits
// 'update:<reconId>' after every invoice processed; subscribers (route
// handlers) translate that into Server-Sent Events to push to the browser.
export const extractionEvents = new EventEmitter();
extractionEvents.setMaxListeners(50); // multiple browser tabs can subscribe
function emitExtractionUpdate(reconId) {
  try { extractionEvents.emit(`update:${reconId}`); } catch {}
}

// ── MSSQL Connection ─────────────────────────────────────────────────────────

let pool = null;
let poolConfigKey = null; // tracks which config the current pool was opened with

// Picks the Sage MSSQL config in this order:
//   1. The databaseconnection row whose id matches bat_settings.sage_connection_id
//   2. The first active databaseconnection whose name matches /sage/i
//   3. SAGE_* environment variables (legacy)
function loadSageConfig() {
  // 1) Explicit pick from bat_settings
  const pickedId = (() => {
    try {
      const row = db.prepare(`SELECT value FROM bat_settings WHERE key = 'sage_connection_id'`).get();
      return row?.value ? parseInt(row.value, 10) : null;
    } catch { return null; }
  })();

  let row = null;
  if (pickedId) {
    row = db.prepare(`SELECT id, name, host, port, database_name, username, encrypted_password FROM databaseconnection WHERE id = ?`).get(pickedId);
  }

  // 2) Auto-pick by name
  if (!row) {
    row = db.prepare(`SELECT id, name, host, port, database_name, username, encrypted_password FROM databaseconnection WHERE status = 'active' AND LOWER(name) LIKE '%sage%' ORDER BY id LIMIT 1`).get();
  }

  if (row) {
    return {
      source: `databaseconnection#${row.id} (${row.name}) ${row.host}:${row.port || 1433}/${row.database_name}`,
      // Key includes host/port/db so a host change on the same row id reopens the pool
      key: `db:${row.id}:${row.host}:${row.port || 1433}:${row.database_name}:${row.username}`,
      config: {
        user: row.username,
        password: decryptPassword(row.encrypted_password),
        server: row.host,
        database: row.database_name,
        port: row.port || 1433,
        options: {
          encrypt: false,
          trustServerCertificate: true,
          enableArithAbort: true,
        },
        requestTimeout: 60000,
        connectionTimeout: 15000,
      },
    };
  }

  // 3) Env-var fallback
  if (process.env.SAGE_HOST) {
    return {
      source: 'env:SAGE_*',
      key: 'env',
      config: {
        user: process.env.SAGE_USER,
        password: process.env.SAGE_PASSWORD,
        server: process.env.SAGE_HOST,
        database: process.env.SAGE_DATABASE,
        port: parseInt(process.env.SAGE_PORT || '1433', 10),
        options: {
          encrypt: process.env.SAGE_ENCRYPT === 'true',
          trustServerCertificate: process.env.SAGE_TRUST_CERT !== 'false',
          enableArithAbort: true,
        },
        requestTimeout: 60000,
        connectionTimeout: 15000,
      },
    };
  }

  return null;
}

async function getSagePool() {
  const loaded = loadSageConfig();
  if (!loaded) {
    throw new Error('No Sage connection configured — add a databaseconnection with "sage" in its name, set bat_settings.sage_connection_id, or set SAGE_* env vars');
  }

  // Re-open pool if the config source changed under us, or if the cached pool
  // is no longer connected (idle timeout, network blip via Tailscale, etc.)
  if (pool && (poolConfigKey !== loaded.key || pool.connected === false || pool.connecting === false && !pool.connected)) {
    try { await pool.close(); } catch {}
    pool = null;
  }

  if (pool) return pool;
  console.log(`[bat-sage] Opening Sage pool from ${loaded.source}`);
  pool = await sql.connect(loaded.config);
  poolConfigKey = loaded.key;
  return pool;
}

// Run a Sage query with one auto-retry if the cached pool turns out to be dead.
async function runSageQuery(sqlText) {
  let p = await getSagePool();
  try {
    return await p.request().query(sqlText);
  } catch (err) {
    if (/Connection is closed|ECONNRESET|ETIMEDOUT|EPIPE/i.test(err.message || '')) {
      console.log('[bat-sage] Pool dropped, reopening and retrying once');
      try { await p.close(); } catch {}
      pool = null;
      p = await getSagePool();
      return await p.request().query(sqlText);
    }
    throw err;
  }
}

export async function resetSagePool() {
  if (pool) {
    try { await pool.close(); } catch {}
  }
  pool = null;
  poolConfigKey = null;
  // Sage connection changed — invalidate the posted-invoices cache so the next
  // matching pass re-fetches against the new connection.
  _sagePostedInvoicesCache = null;
}

// 5-minute TTL cache of querySagePostedInvoices() — the BAT vendor invoice list
// rarely changes within a single matching session and the underlying SQL
// scans the entire APOBL table.
let _sagePostedInvoicesCache = null; // { data, expiresAt }
const SAGE_POSTED_INVOICES_TTL_MS = 5 * 60 * 1000;

// ── Spreadsheet Parsing ──────────────────────────────────────────────────────

export function parseSupplierSpreadsheet(filePath, originalFilename) {
  const workbook = XLSX.readFile(filePath);

  // Detect week number from filename
  const weekMatch = originalFilename.match(/Week[_\s]*(\d{1,2})/i);
  const weekNumber = weekMatch ? parseInt(weekMatch[1], 10) : null;

  // Parse Overview sheet
  const overviewSheet = workbook.Sheets['Overview'];
  if (!overviewSheet) throw new Error('Overview sheet not found in spreadsheet');
  const overviewData = XLSX.utils.sheet_to_json(overviewSheet, { header: 1, defval: '' });

  const fees = extractFees(overviewData);
  let storeName = extractStoreName(overviewData);
  const orderAmounts = extractOrderAmounts(overviewData);

  // Parse Delivery POD sheet
  const podSheet = workbook.Sheets['Delivery POD'];
  const podUrls = [];
  let detectedYear = null;
  if (podSheet) {
    const podData = XLSX.utils.sheet_to_json(podSheet, { header: 1, defval: '' });
    detectedYear = extractPodUrls(podData, podUrls);
    // Fallback: try Delivery POD sheet if not found in Overview
    if (!storeName) storeName = extractStoreName(podData);
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

function extractFees(rows) {
  const fees = {
    discount: { subTotal: 0, vat: 0, total: 0 },
    delivery: { subTotal: 0, vat: 0, total: 0 },
    pricing: { subTotal: 0, vat: 0, total: 0 },
    total: { subTotal: 0, vat: 0, total: 0 },
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
      for (let j = firstOdrCol; j < Math.min(row.length, firstOdrCol + 15); j++) {
        const cell = String(row[j] || '').trim().toUpperCase();
        if ((cell === 'DISCOUNT' || cell === ' DISCOUNT') && discountCol < 0) discountCol = j;
        if (cell.includes('DELIVERY FEE') && cell.includes('EXCL') && deliveryCol < 0) deliveryCol = j;
        if ((cell === 'PRICE ADJUSTMENT' || cell === ' PRICE ADJUSTMENT') && pricingCol < 0) pricingCol = j;
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
      if (label.includes('DISCOUNT') && !label.includes('TOTAL') && !label.includes('DELIVERY') && last3.length >= 3)
        fees.discount = { subTotal: last3[0], vat: last3[1], total: last3[2] };
      else if (label.includes('DELIVERY') && !label.includes('TOTAL') && !label.includes('VOLUME') && last3.length >= 3)
        fees.delivery = { subTotal: last3[0], vat: last3[1], total: last3[2] };
      else if (label.includes('PRICING') && !label.includes('TOTAL') && last3.length >= 3)
        fees.pricing = { subTotal: last3[0], vat: last3[1], total: last3[2] };
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
      const rawVal = row[amountCol];
      if (rawVal === '' || rawVal == null) continue;
      const val = parseFloat(String(rawVal).replace(/[^0-9.\-]/g, ''));
      if (isNaN(val)) continue;
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

// ── Sage 300 Queries ─────────────────────────────────────────────────────────

export async function querySageCreditNotes(weekNumber) {
  const sagePool = await getSagePool();
  // APIBC join is LEFT so credit-note lines whose batch header has been
  // purged / archived still appear (they were dropped silently before,
  // making per-week totals diverge from the cached week totals).
  const result = await sagePool.request().query(`
    SELECT
      h.CNTBTCH AS batch_number,
      LTRIM(RTRIM(COALESCE(bc.BTCHDESC, ''))) AS batch_description,
      CASE bc.BTCHSTTS
        WHEN 1 THEN 'Open'
        WHEN 3 THEN 'Posted'
        WHEN 4 THEN 'Deleted'
        WHEN 7 THEN 'Posted'
        WHEN NULL THEN 'Archived'
        ELSE 'Unknown (' + CAST(bc.BTCHSTTS AS VARCHAR) + ')'
      END AS batch_status,
      LTRIM(RTRIM(h.IDVEND)) AS vendor_number,
      LTRIM(RTRIM(h.IDINVC)) AS document_number,
      h.DATEINVC AS document_date,
      LTRIM(RTRIM(d.TEXTDESC)) AS line_description,
      LTRIM(RTRIM(
        SUBSTRING(
          d.TEXTDESC,
          PATINDEX('%WEEK [0-9]%', d.TEXTDESC) + 5,
          2
        )
      )) AS week_number,
      CASE
        WHEN LTRIM(RTRIM(d.TEXTDESC)) LIKE 'DELIVERY%' THEN 'DELIVERY FEE'
        WHEN LTRIM(RTRIM(d.TEXTDESC)) LIKE 'DISCOUNT%' THEN 'DISCOUNT FEE'
        WHEN LTRIM(RTRIM(d.TEXTDESC)) LIKE 'PRICING%'  THEN 'PRICING ADJ'
        WHEN LTRIM(RTRIM(d.TEXTDESC)) LIKE 'PRICE%'    THEN 'PRICING ADJ'
        ELSE 'OTHER'
      END AS fee_type,
      d.AMTDISTHC AS line_amount
    FROM APIBH h
    INNER JOIN APIBD d ON d.CNTBTCH = h.CNTBTCH AND d.CNTITEM = h.CNTITEM
    LEFT JOIN APIBC bc ON bc.CNTBTCH = h.CNTBTCH
    WHERE LTRIM(RTRIM(h.IDVEND)) LIKE '%BAT%'
      AND LTRIM(RTRIM(d.TEXTDESC)) LIKE '%WEEK ${String(weekNumber).padStart(2, '0')}%'
    ORDER BY
      CASE
        WHEN LTRIM(RTRIM(d.TEXTDESC)) LIKE 'DELIVERY%' THEN 1
        WHEN LTRIM(RTRIM(d.TEXTDESC)) LIKE 'DISCOUNT%' THEN 2
        WHEN LTRIM(RTRIM(d.TEXTDESC)) LIKE 'PRICING%'  THEN 3
        ELSE 4
      END,
      h.CNTBTCH
  `);
  return result.recordset || [];
}

export async function querySagePostedInvoices() {
  const sagePool = await getSagePool();
  const result = await sagePool.request().query(`
    SELECT
      LTRIM(RTRIM(IDVEND)) AS vendor_number,
      LTRIM(RTRIM(IDINVC)) AS document_number,
      DATEINVC AS document_date,
      ISNULL(AMTINVCHC, 0) AS amount,
      LTRIM(RTRIM(DESCINVC)) AS description
    FROM APOBL
    WHERE LTRIM(RTRIM(IDVEND)) LIKE '%BAT%'
  `);
  return result.recordset || [];
}

// Per-year/per-week totals from Sage credit notes.
// Year is derived from h.DATEINVC (Sage stores it as INT YYYYMMDD).
// Returns [{ year, week_number, delivery, discount, pricing, total, batch_count }, ...]
export async function querySageWeekTotals() {
  const result = await runSageQuery(`
    ;WITH src AS (
      SELECT
        h.DATEINVC AS doc_date_int,
        CAST(CAST(h.DATEINVC AS VARCHAR(8)) AS DATE) AS doc_date,
        CAST(LTRIM(RTRIM(SUBSTRING(d.TEXTDESC, PATINDEX('%WEEK [0-9]%', d.TEXTDESC) + 5, 2))) AS INT) AS desc_week,
        h.CNTBTCH,
        d.TEXTDESC,
        d.AMTDISTHC
      FROM APIBH h
      INNER JOIN APIBD d ON d.CNTBTCH = h.CNTBTCH AND d.CNTITEM = h.CNTITEM
      WHERE LTRIM(RTRIM(h.IDVEND)) LIKE '%BAT%'
        AND d.TEXTDESC LIKE '%WEEK [0-9]%'
    ),
    attributed AS (
      SELECT
        CASE
          WHEN desc_week > DATEPART(ISO_WEEK, doc_date) + 4
            THEN YEAR(doc_date) - 1
          ELSE YEAR(doc_date)
        END AS year,
        desc_week AS week_number,
        TEXTDESC,
        AMTDISTHC,
        CNTBTCH
      FROM src
    )
    SELECT
      year,
      week_number,
      SUM(CASE WHEN UPPER(LTRIM(RTRIM(TEXTDESC))) LIKE 'DELIVERY%' THEN AMTDISTHC ELSE 0 END) AS delivery,
      SUM(CASE WHEN UPPER(LTRIM(RTRIM(TEXTDESC))) LIKE 'DISCOUNT%' THEN AMTDISTHC ELSE 0 END) AS discount,
      SUM(CASE
            WHEN UPPER(LTRIM(RTRIM(TEXTDESC))) LIKE 'PRICING%'
              OR UPPER(LTRIM(RTRIM(TEXTDESC))) LIKE 'PRICE%'
            THEN AMTDISTHC ELSE 0 END) AS pricing,
      SUM(AMTDISTHC) AS total,
      COUNT(DISTINCT CNTBTCH) AS batch_count
    FROM attributed
    GROUP BY year, week_number
    ORDER BY year, week_number
  `);
  return (result.recordset || [])
    .filter(r => r.week_number > 0 && r.week_number <= 53 && r.year > 2000 && r.year < 2100)
    .map(r => ({
      year:        Math.floor(Number(r.year)),
      week_number: Number(r.week_number),
      delivery:    Number(r.delivery) || 0,
      discount:    Number(r.discount) || 0,
      pricing:     Number(r.pricing)  || 0,
      total:       Number(r.total)    || 0,
      batch_count: Number(r.batch_count) || 0,
    }));
}

// ── Sage Week-Totals Cache ───────────────────────────────────────────────────
// We cache per-(year, week) totals locally so the dashboard works even when Sage
// is unreachable. Refreshed every 3h on weekdays 7am–4pm by the scheduler, plus
// on-demand via the Refresh button.

let _refreshInProgress = false;

// In-memory cache of the bat_sage_week_cache table contents. The dashboard /
// week-status endpoints read this on every poll (5–15s); avoid the DB hit
// since the underlying table is only written by refreshSageWeekTotalsCache().
let _sageTotalsMemo = null;
function invalidateSageTotalsMemo() { _sageTotalsMemo = null; }

export function getCachedSageWeekTotals() {
  if (_sageTotalsMemo) return _sageTotalsMemo;
  try {
    _sageTotalsMemo = db.prepare(`
      SELECT year, week_number, delivery, discount, pricing, total, batch_count
      FROM bat_sage_week_cache
      ORDER BY year, week_number
    `).all();
    return _sageTotalsMemo;
  } catch { return []; }
}

export function getSageCacheMeta() {
  try {
    const rows = db.prepare(`SELECT key, value, updated_at FROM bat_sage_cache_meta`).all();
    const meta = {};
    for (const r of rows) meta[r.key] = r.value;
    return meta;
  } catch { return {}; }
}

function setSageCacheMeta(key, value) {
  try {
    db.prepare(`INSERT INTO bat_sage_cache_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(key, value);
  } catch (e) { console.error('[bat-sage-cache] meta write failed:', e.message); }
}

export async function refreshSageWeekTotalsCache() {
  if (_refreshInProgress) {
    return { ok: false, status: 'already_running' };
  }
  _refreshInProgress = true;
  try {
    const live = await querySageWeekTotals();
    const before = getCachedSageWeekTotals();
    const beforeMap = new Map(before.map(r => [`${r.year}/${r.week_number}`, r]));
    const liveMap = new Map(live.map(r => [`${r.year}/${r.week_number}`, r]));

    let added = 0, removed = 0, changed = 0;
    for (const [k, l] of liveMap) {
      const b = beforeMap.get(k);
      if (!b) { added++; continue; }
      if (Math.abs((b.total || 0) - (l.total || 0)) > 0.01) changed++;
    }
    for (const k of beforeMap.keys()) if (!liveMap.has(k)) removed++;

    // Upsert via ON CONFLICT — avoids the brief window between DELETE and INSERT
    // where the cache would be empty. Then sweep any rows no longer present
    // in `live` (so removed weeks don't linger). All inside one transaction.
    const replace = db.transaction((rows) => {
      const upsert = db.prepare(`
        INSERT INTO bat_sage_week_cache (year, week_number, delivery, discount, pricing, total, batch_count, refreshed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(year, week_number) DO UPDATE SET
          delivery = excluded.delivery,
          discount = excluded.discount,
          pricing = excluded.pricing,
          total = excluded.total,
          batch_count = excluded.batch_count,
          refreshed_at = excluded.refreshed_at
      `);
      for (const r of rows) upsert.run(r.year, r.week_number, r.delivery, r.discount, r.pricing, r.total, r.batch_count);
      // Remove any cached rows not in the live result set
      const liveKeys = new Set(rows.map(r => `${r.year}/${r.week_number}`));
      const existing = db.prepare('SELECT year, week_number FROM bat_sage_week_cache').all();
      const del = db.prepare('DELETE FROM bat_sage_week_cache WHERE year = ? AND week_number = ?');
      for (const e of existing) {
        if (!liveKeys.has(`${e.year}/${e.week_number}`)) del.run(e.year, e.week_number);
      }
    });
    replace(live);
    invalidateSageTotalsMemo();

    setSageCacheMeta('last_refreshed_at', new Date().toISOString());
    setSageCacheMeta('last_status', 'ok');
    setSageCacheMeta('last_error', '');
    setSageCacheMeta('last_change_summary', JSON.stringify({ added, removed, changed, total: live.length }));
    console.log(`[bat-sage-cache] Refresh OK: ${live.length} weeks (added=${added}, removed=${removed}, changed=${changed})`);
    return { ok: true, status: 'ok', added, removed, changed, total: live.length };
  } catch (err) {
    setSageCacheMeta('last_status', 'error');
    setSageCacheMeta('last_error', String(err.message).slice(0, 500));
    setSageCacheMeta('last_failed_at', new Date().toISOString());
    logError('bat.sage.cacheRefresh', err);
    return { ok: false, status: 'error', error: err.message };
  } finally {
    _refreshInProgress = false;
  }
}

export async function querySagePaidWeeks() {
  const sagePool = await getSagePool();
  const result = await sagePool.request().query(`
    SELECT DISTINCT
      LTRIM(RTRIM(SUBSTRING(d.TEXTDESC, PATINDEX('%WEEK [0-9]%', d.TEXTDESC) + 5, 2))) AS week_number
    FROM APIBC bc
    INNER JOIN APIBH h ON h.CNTBTCH = bc.CNTBTCH
    INNER JOIN APIBD d ON d.CNTBTCH = h.CNTBTCH AND d.CNTITEM = h.CNTITEM
    WHERE LTRIM(RTRIM(h.IDVEND)) LIKE '%BAT%'
      AND d.TEXTDESC LIKE '%WEEK [0-9]%'
    ORDER BY week_number
  `);
  return (result.recordset || [])
    .map(r => parseInt(r.week_number, 10))
    .filter(n => n > 0 && n <= 53);
}

// ── Reconciliation CRUD ──────────────────────────────────────────────────────

export function createReconciliation({ weekNumber, year, filename, fees, podUrls, userId }) {
  // Check for existing
  const existing = db.prepare('SELECT id FROM bat_reconciliations WHERE week_number = ? AND year = ?').get(weekNumber, year);
  if (existing) {
    // Update existing
    db.prepare(`
      UPDATE bat_reconciliations SET
        upload_filename = ?,
        supplier_discount = ?, supplier_delivery = ?, supplier_pricing = ?,
        supplier_discount_vat = ?, supplier_delivery_vat = ?, supplier_pricing_vat = ?,
        supplier_total = ?, status = 'pending', created_by = ?
      WHERE id = ?
    `).run(
      filename,
      fees.discount.subTotal, fees.delivery.subTotal, fees.pricing.subTotal,
      fees.discount.vat, fees.delivery.vat, fees.pricing.vat,
      fees.total.total, userId,
      existing.id
    );

    // Clear old extractions for this reconciliation (keep cached ones by pdf_url)
    db.prepare('DELETE FROM bat_sage_credit_notes WHERE reconciliation_id = ?').run(existing.id);

    insertPodEntries(existing.id, podUrls);
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO bat_reconciliations (
      week_number, year, upload_filename,
      supplier_discount, supplier_delivery, supplier_pricing,
      supplier_discount_vat, supplier_delivery_vat, supplier_pricing_vat,
      supplier_total, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    weekNumber, year, filename,
    fees.discount.subTotal, fees.delivery.subTotal, fees.pricing.subTotal,
    fees.discount.vat, fees.delivery.vat, fees.pricing.vat,
    fees.total.total, userId
  );

  const reconId = result.lastInsertRowid;
  insertPodEntries(reconId, podUrls);
  return reconId;
}

function insertPodEntries(reconId, podUrls) {
  const upsert = db.prepare(`
    INSERT INTO bat_invoice_extractions (
      reconciliation_id, pdf_url, order_number, branch_name, store_name,
      week, order_day, delivery_day, lead_time, delivery_date, pod_uploaded_date, validate, order_amount, is_exception, target_days, compliance_status, exception_reason, supplier_discount, supplier_del_fee, supplier_pricing
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pdf_url) DO UPDATE SET
      reconciliation_id = excluded.reconciliation_id,
      order_number = COALESCE(excluded.order_number, bat_invoice_extractions.order_number),
      branch_name = COALESCE(excluded.branch_name, bat_invoice_extractions.branch_name),
      store_name = COALESCE(excluded.store_name, bat_invoice_extractions.store_name),
      week = COALESCE(excluded.week, bat_invoice_extractions.week),
      order_day = COALESCE(excluded.order_day, bat_invoice_extractions.order_day),
      delivery_day = COALESCE(excluded.delivery_day, bat_invoice_extractions.delivery_day),
      lead_time = COALESCE(excluded.lead_time, bat_invoice_extractions.lead_time),
      delivery_date = COALESCE(excluded.delivery_date, bat_invoice_extractions.delivery_date),
      pod_uploaded_date = COALESCE(excluded.pod_uploaded_date, bat_invoice_extractions.pod_uploaded_date),
      validate = COALESCE(excluded.validate, bat_invoice_extractions.validate),
      order_amount = COALESCE(excluded.order_amount, bat_invoice_extractions.order_amount),
      is_exception = COALESCE(excluded.is_exception, bat_invoice_extractions.is_exception),
      target_days = COALESCE(excluded.target_days, bat_invoice_extractions.target_days),
      compliance_status = COALESCE(excluded.compliance_status, bat_invoice_extractions.compliance_status),
      exception_reason = COALESCE(excluded.exception_reason, bat_invoice_extractions.exception_reason),
      supplier_discount = COALESCE(excluded.supplier_discount, bat_invoice_extractions.supplier_discount),
      supplier_del_fee = COALESCE(excluded.supplier_del_fee, bat_invoice_extractions.supplier_del_fee),
      supplier_pricing = COALESCE(excluded.supplier_pricing, bat_invoice_extractions.supplier_pricing)
  `);
  const tx = db.transaction((urls) => {
    for (const pod of urls) {
      // Use ?? for numeric fields so a legitimate 0 isn't converted to null
      upsert.run(
        reconId, pod.url, pod.orderNumber, pod.branchName || null, pod.storeName,
        pod.week || null, pod.orderDay || null, pod.deliveryDay || null, pod.leadTime ?? null,
        pod.deliveryDate, pod.podUploadedDate || null, pod.validate || null,
        pod.orderAmount ?? null, pod.isException || 0,
        pod.targetDays ?? null, pod.complianceStatus || null, pod.exceptionReason || null,
        pod.supplierDiscount ?? null, pod.supplierDelFee ?? null, pod.supplierPricing ?? null
      );
    }
  });
  tx(podUrls);
}

export function backfillOrderAmounts(orderAmounts) {
  if (!orderAmounts || orderAmounts.size === 0) return 0;

  const rows = db.prepare(
    'SELECT id, order_number FROM bat_invoice_extractions WHERE order_amount IS NULL AND order_number IS NOT NULL'
  ).all();

  const update = db.prepare(
    'UPDATE bat_invoice_extractions SET order_amount = ?, is_exception = ? WHERE id = ?'
  );

  let count = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const entry = orderAmounts.get(row.order_number);
      if (entry) {
        update.run(entry.amount, entry.isException ? 1 : 0, row.id);
        count++;
      }
    }
  });
  tx();

  if (count > 0) {
    console.log(`[bat] Backfilled ${count} order amounts from new spreadsheet onto previous extractions`);
  }
  return count;
}

export function storeSageCreditNotes(reconId, creditNotes) {
  const insert = db.prepare(`
    INSERT INTO bat_sage_credit_notes (
      reconciliation_id, batch_number, batch_description, batch_status,
      vendor_number, document_number, document_date, line_description,
      week_number, fee_type, line_amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((notes) => {
    for (const n of notes) {
      insert.run(
        reconId, n.batch_number, n.batch_description, n.batch_status,
        n.vendor_number, n.document_number, n.document_date, n.line_description,
        parseInt(n.week_number, 10) || null, n.fee_type, n.line_amount
      );
    }
  });
  tx(creditNotes);

  // Sum Sage amounts by fee type and update reconciliation
  const sageTotals = { 'DELIVERY FEE': 0, 'DISCOUNT FEE': 0, 'PRICING ADJ': 0 };
  for (const n of creditNotes) {
    if (sageTotals[n.fee_type] !== undefined) {
      sageTotals[n.fee_type] += (n.line_amount || 0);
    }
  }
  const sageTotal = sageTotals['DELIVERY FEE'] + sageTotals['DISCOUNT FEE'] + sageTotals['PRICING ADJ'];
  db.prepare(`
    UPDATE bat_reconciliations SET
      sage_delivery = ?, sage_discount = ?, sage_pricing = ?, sage_total = ?
    WHERE id = ?
  `).run(sageTotals['DELIVERY FEE'], sageTotals['DISCOUNT FEE'], sageTotals['PRICING ADJ'], sageTotal, reconId);
}

export function getReconciliation(id) {
  const recon = db.prepare('SELECT * FROM bat_reconciliations WHERE id = ?').get(id);
  if (!recon) return null;
  recon.creditNotes = db.prepare('SELECT * FROM bat_sage_credit_notes WHERE reconciliation_id = ? ORDER BY fee_type, batch_number').all(id);
  recon.extractions = db.prepare('SELECT * FROM bat_invoice_extractions WHERE reconciliation_id = ? ORDER BY id').all(id);

  // Overlay Sage totals from the local cache (refreshed on schedule). The per-recon
  // bat_reconciliations.sage_* fields only get filled when the user clicks "Refresh Sage"
  // on this page; the cache is the up-to-date source of truth for week-level totals.
  try {
    const cached = db.prepare(
      'SELECT delivery, discount, pricing, total FROM bat_sage_week_cache WHERE year = ? AND week_number = ?'
    ).get(recon.year, recon.week_number);
    if (cached) {
      recon.sage_delivery = cached.delivery;
      recon.sage_discount = cached.discount;
      recon.sage_pricing  = cached.pricing;
      recon.sage_total    = cached.total;
    }
  } catch {}

  // Fee comparison
  recon.feeComparison = buildFeeComparison(recon);
  recon.extractionStats = buildExtractionStats(recon.extractions, recon.id);

  return recon;
}

// Build a normalized lookup of every Cardoso invoice → amount, in JS.
// Replaces SQL expressions like UPPER(REPLACE(ci.invoice_number, ' ', '')) which
// can't use any index and force a full table scan per extraction row.
//
// Cached: dashboard / list / detail endpoints all rebuild this on every call,
// and Cardoso invoice writes are infrequent. We invalidate on any code path
// that mutates bat_cardoso_invoices (upload, generate, replicate, overwrite).
let _cardosoLookupCache = null;
let _cardosoLookupAt = 0;
const CARDOSO_LOOKUP_TTL_MS = 60_000; // safety net — 1 min max staleness even without explicit invalidation
export function invalidateCardosoLookup() {
  _cardosoLookupCache = null;
  _cardosoLookupAt = 0;
}
function buildCardosoLookup() {
  const now = Date.now();
  if (_cardosoLookupCache && (now - _cardosoLookupAt) < CARDOSO_LOOKUP_TTL_MS) {
    return _cardosoLookupCache;
  }
  const rows = db.prepare('SELECT invoice_number, amount FROM bat_cardoso_invoices').all();
  const amountByKey = new Map();
  for (const r of rows) {
    if (!r.invoice_number) continue;
    const key = String(r.invoice_number).replace(/\s/g, '').toUpperCase();
    if (!amountByKey.has(key)) amountByKey.set(key, r.amount);
  }
  _cardosoLookupCache = amountByKey;
  _cardosoLookupAt = now;
  return amountByKey;
}

export function listReconciliations() {
  // LEFT JOIN the Sage week cache so the per-week tile can show live Sage totals
  // even when the per-recon refresh has never been run. Match counts (matched +
  // exact) are computed in JS using a single Cardoso lookup map — much faster
  // than correlated EXISTS subqueries with non-sargable string normalization.
  const reconRows = db.prepare(`
    SELECT r.*,
      COALESCE(ext_stats.pod_count, 0)   AS pod_count,
      COALESCE(ext_stats.found_count, 0) AS found_count,
      COALESCE(c.delivery, r.sage_delivery) AS sage_delivery,
      COALESCE(c.discount, r.sage_discount) AS sage_discount,
      COALESCE(c.pricing,  r.sage_pricing)  AS sage_pricing,
      COALESCE(c.total,    r.sage_total)    AS sage_total,
      CASE WHEN c.year IS NOT NULL THEN 1 ELSE 0 END AS sage_present
    FROM bat_reconciliations r
    LEFT JOIN (
      SELECT reconciliation_id,
             COUNT(*) AS pod_count,
             SUM(CASE WHEN extraction_status = 'found' THEN 1 ELSE 0 END) AS found_count
      FROM bat_invoice_extractions
      GROUP BY reconciliation_id
    ) ext_stats ON ext_stats.reconciliation_id = r.id
    LEFT JOIN bat_sage_week_cache c ON c.year = r.year AND c.week_number = r.week_number
    ORDER BY r.year DESC, r.week_number DESC
  `).all();

  const cardosoAmounts = buildCardosoLookup();
  const extractions = db.prepare(`
    SELECT reconciliation_id, extracted_invoice, order_amount
    FROM bat_invoice_extractions
    WHERE extracted_invoice IS NOT NULL
  `).all();

  const matchByRecon = new Map(); // reconId -> { matched, exact }
  for (const e of extractions) {
    const key = String(e.extracted_invoice).replace(/\s/g, '').toUpperCase();
    const cAmount = cardosoAmounts.get(key);
    if (cAmount === undefined) continue;
    let m = matchByRecon.get(e.reconciliation_id);
    if (!m) { m = { matched: 0, exact: 0 }; matchByRecon.set(e.reconciliation_id, m); }
    m.matched++;
    if (Math.abs((e.order_amount || 0) - (cAmount || 0)) < 0.01) m.exact++;
  }

  for (const r of reconRows) {
    const m = matchByRecon.get(r.id);
    r.matched_count = m?.matched || 0;
    r.exact_match_count = m?.exact || 0;
  }
  return reconRows;
}

function buildFeeComparison(recon) {
  // Sage column = actual Sage credit-note totals only (recon.sage_* is overlaid
  // from bat_sage_week_cache in getReconciliation). Don't fall back to
  // Cardoso-invoice sums — those belong in a separate column if needed.
  const sageDelivery = recon.sage_delivery || 0;
  const sageDiscount = recon.sage_discount || 0;
  const sagePricing  = recon.sage_pricing  || 0;

  const compare = (type, supplierAmount, sageAmount) => {
    const diff = (supplierAmount || 0) - (sageAmount || 0);
    const absDiff = Math.abs(diff);
    let status = 'red';
    if (absDiff < 0.01) status = 'green';
    else if (absDiff < 100) status = 'amber';
    return { type, supplier: supplierAmount || 0, sage: sageAmount || 0, difference: diff, status };
  };

  return [
    compare('Delivery Fee', recon.supplier_delivery, sageDelivery),
    compare('Discount Fee', recon.supplier_discount, sageDiscount),
    compare('Pricing Adjustment', recon.supplier_pricing, sagePricing),
  ];
}

function buildExtractionStats(extractions, reconId) {
  const total = extractions.length;

  // Single pass: accumulate status counts AND build the duplicate-detection map.
  let found = 0, notFound = 0, failed = 0, pending = 0, exceptions = 0;
  const counts = new Map();
  for (const e of extractions) {
    switch (e.extraction_status) {
      case 'found':     found++; break;
      case 'not_found': notFound++; break;
      case 'failed':    failed++; break;
      case 'pending':   pending++; break;
    }
    if (e.is_exception === 1) exceptions++;
    if (e.extracted_invoice) {
      const k = String(e.extracted_invoice).toUpperCase();
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }

  // Duplicate invoice numbers within this reconciliation — OCR can output the same
  // number for two different PDFs (typically a common OCR misread). Mark every
  // extraction in a duplicate group so the UI can flag them.
  let duplicateGroups = 0;
  let duplicateExtractions = 0;
  for (const [, c] of counts) {
    if (c > 1) {
      duplicateGroups += 1;
      duplicateExtractions += c;
    }
  }
  // Mutate each extraction so the UI can render a per-row badge
  for (const e of extractions) {
    const k = e.extracted_invoice ? String(e.extracted_invoice).toUpperCase() : null;
    e.duplicate_count = k ? (counts.get(k) || 1) : 1;
  }

  // matched / exactMatched derived from the cached Cardoso lookup map. Replaces
  // two correlated EXISTS subqueries with non-sargable string normalization
  // (each scanned the full bat_cardoso_invoices table per extraction row).
  let matched = 0, exactMatched = 0, amountMismatch = 0;
  try {
    const cardosoAmounts = buildCardosoLookup();
    for (const e of extractions) {
      if (!e.extracted_invoice) continue;
      const key = String(e.extracted_invoice).replace(/\s/g, '').toUpperCase();
      const cAmount = cardosoAmounts.get(key);
      if (cAmount === undefined) continue;
      matched++;
      if (Math.abs((e.order_amount || 0) - (cAmount || 0)) < 0.01) exactMatched++;
    }
    amountMismatch = matched - exactMatched;
  } catch {}
  // Anything that needs the user to look at it: OCR failed/not_found, amount
  // mismatched, exceptions, OR duplicate invoice numbers within the recon.
  // (exceptions counted in the single pass above)
  const needsAttention = notFound + failed + amountMismatch + exceptions + duplicateExtractions;
  const unmatched = found - matched;

  return { total, found, notFound, failed, pending, matched, exactMatched, amountMismatch, exceptions, unmatched, needsAttention, duplicateGroups, duplicateExtractions };
}

export function manualSetInvoice(extractionId, invoiceNumber) {
  const ext = db.prepare('SELECT * FROM bat_invoice_extractions WHERE id = ?').get(extractionId);
  if (!ext) throw new Error('Extraction not found');

  // Set manual_override=1 so the cross-ref fuzzy auto-correct never overwrites
  // the user's deliberate fix back to the original mis-OCR'd value.
  db.prepare(`
    UPDATE bat_invoice_extractions
    SET extracted_invoice = ?, extraction_status = 'found',
        extraction_attempts = extraction_attempts + 1, manual_override = 1
    WHERE id = ?
  `).run(invoiceNumber, extractionId);

  return ext.reconciliation_id;
}

// ── OCR Invoice Extraction (Queue-based background worker) ──────────────────

let workerRunning = false;
let workerReconId = null;

export function getExtractionProgress(reconId) {
  if (!reconId) return null;
  const total = db.prepare('SELECT COUNT(*) as c FROM bat_invoice_extractions WHERE reconciliation_id = ?').get(reconId)?.c || 0;
  const pending = db.prepare("SELECT COUNT(*) as c FROM bat_invoice_extractions WHERE reconciliation_id = ? AND extraction_status = 'pending'").get(reconId)?.c || 0;
  const processed = total - pending;
  const running = workerRunning && workerReconId === reconId;
  return { running, processed, total, pending };
}

export async function runInvoiceExtraction(reconId) {
  if (ocrPaused) {
    // Don't silently swallow the request — the UI disables the button when
    // paused, but a stale tab or scripted caller can still hit this endpoint.
    const err = new Error('OCR is paused — resume it in Settings → Reconciliation before extracting.');
    err.code = 'OCR_PAUSED';
    err.status = 409;
    throw err;
  }

  const pending = db.prepare(
    "SELECT COUNT(*) as c FROM bat_invoice_extractions WHERE reconciliation_id = ? AND extraction_status = 'pending'"
  ).get(reconId)?.c || 0;

  if (pending === 0) {
    await matchExtractedInvoices(reconId);
    return { message: 'No pending extractions', processed: 0 };
  }

  // Kick off the background worker if not already running
  startExtractionWorker(reconId);

  return { message: 'Extraction started', total: pending };
}

export function retryNotFound(reconId) {
  const rows = db.prepare(
    "SELECT id, pdf_url, store_name FROM bat_invoice_extractions WHERE reconciliation_id = ? AND extraction_status IN ('not_found', 'failed')"
  ).all(reconId);
  if (rows.length === 0) return { message: 'Nothing to retry', requeued: 0 };

  // Run Google Vision-only pass (skip Tesseract/ocr.space)
  runGoogleVisionRetry(reconId, rows);
  return { message: `Retrying ${rows.length} extractions with Google Vision`, requeued: rows.length };
}

async function runGoogleVisionRetry(reconId, rows) {
  if (!getGoogleVisionKey()) {
    const msg = 'Google Vision retry skipped: GOOGLE_VISION_KEY not set';
    console.error(`[bat-gv] ${msg}`);
    recordReconciliationError(reconId, msg);
    return;
  }

  // Clear previous error state at the start of a retry pass
  db.prepare("UPDATE bat_reconciliations SET last_error = NULL, last_error_at = NULL WHERE id = ?").run(reconId);

  try {
    await runGoogleVisionRetryInner(reconId, rows);
  } catch (err) {
    console.error('[bat-gv] Retry pass crashed:', err.message);
    recordReconciliationError(reconId, `Google Vision retry crashed: ${err.message}`);
  }
}

async function runGoogleVisionRetryInner(reconId, rows) {
  const sharp = (await import('sharp')).default;
  const updateExtraction = db.prepare(`
    UPDATE bat_invoice_extractions
    SET extracted_invoice = ?, extraction_status = ?, extraction_attempts = extraction_attempts + 1
    WHERE id = ?
  `);

  console.log(`[bat-gv] Google Vision retry: ${rows.length} items`);

  for (const row of rows) {
    try {
      console.log(`[bat-gv] Processing id=${row.id} ${row.store_name || ''}`);

      const response = await fetch(row.pdf_url);
      if (!response.ok) { updateExtraction.run(null, 'failed', row.id); continue; }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 100 || !buffer.subarray(0, 5).toString().startsWith('%PDF')) {
        updateExtraction.run(null, 'failed', row.id); continue;
      }

      // Render PDF to image
      let imageBuffer;
      try {
        const scale = buffer.length > 2 * 1024 * 1024 ? 1.5 : 2.0;
        imageBuffer = await pdfPageToImage(buffer, 1, scale);
      } catch (err) {
        console.error(`[bat-gv] Render failed id=${row.id}: ${err.message}`);
        updateExtraction.run(null, 'failed', row.id); continue;
      }

      // Send to Google Vision — try upright first, then rotated
      let invoice = null;
      for (const angle of [0, 90]) {
        const jpeg = await sharp(imageBuffer)
          .rotate(angle)
          .resize({ width: 2400 })
          .jpeg({ quality: 85 })
          .toBuffer();

        const text = await ocrViaGoogleVision(jpeg);
        invoice = findInvoiceNumber(text);
        if (invoice) {
          console.log(`[bat-gv] id=${row.id} -> ${invoice} (rot ${angle})`);
          break;
        }
      }

      if (invoice) {
        updateExtraction.run(invoice, 'found', row.id);
      } else {
        updateExtraction.run(null, 'not_found', row.id);
        console.log(`[bat-gv] id=${row.id} — not found`);
      }
    } catch (err) {
      console.error(`[bat-gv] id=${row.id} failed: ${err.message}`);
      updateExtraction.run(null, 'failed', row.id);
    }
  }

  console.log(`[bat-gv] Google Vision retry complete for reconciliation ${reconId}`);
  normalizeInvoiceNumbers(reconId);
  await matchExtractedInvoices(reconId);
}

// ── OCR pause switch ───────────────────────────────────────────────────────
// Flip to `false` to resume. While paused: no new workers start, auto-resume
// on server boot is skipped, and the in-flight processQueue loop exits cleanly
// after its current invoice finishes (so we don't lose work mid-flight).
let ocrPaused = true;
export function isOcrPaused() { return ocrPaused; }
export function setOcrPaused(v) { ocrPaused = !!v; }

function startExtractionWorker(reconId) {
  if (ocrPaused) {
    console.log('[bat-ocr] Paused — not starting worker');
    return;
  }
  if (workerRunning) {
    console.log('[bat-ocr] Worker already running, skipping');
    return;
  }
  workerRunning = true;
  workerReconId = reconId;

  processQueue(reconId).catch(err => {
    console.error('[bat-ocr] Worker crashed:', err.message);
    recordReconciliationError(reconId, `Worker crashed: ${err.message}`);
  }).finally(() => {
    workerRunning = false;
    workerReconId = null;
  });
}

// Auto-resume: call on server start to pick up any pending work
export function resumeExtractionWorker() {
  if (ocrPaused) {
    console.log('[bat-ocr] Paused — skipping auto-resume on startup');
    return;
  }
  const pendingRecon = db.prepare(`
    SELECT DISTINCT reconciliation_id FROM bat_invoice_extractions
    WHERE extraction_status = 'pending' LIMIT 1
  `).get();
  if (pendingRecon) {
    console.log(`[bat-ocr] Auto-resuming extraction for reconciliation ${pendingRecon.reconciliation_id}`);
    startExtractionWorker(pendingRecon.reconciliation_id);
  }
}

function normalizeInvoiceNumbers(reconId) {
  // Disabled: prefix-based normalization was making OCR errors worse
  // (dominant prefix detection converted correct 578xxx to wrong 579xxx).
  // Fuzzy matching against Cardoso invoices handles single-digit OCR errors instead.
  return;

  const found = db.prepare(
    `SELECT id, extracted_invoice FROM bat_invoice_extractions WHERE reconciliation_id = ? AND extraction_status = 'found'`
  ).all(reconId);

  if (found.length < 3) return;

  // Separate IN-prefix and numeric-only invoices
  const inPrefixed = found.filter(r => r.extracted_invoice.startsWith('IN'));
  const numeric = found.filter(r => !r.extracted_invoice.startsWith('IN'));

  const update = db.prepare('UPDATE bat_invoice_extractions SET extracted_invoice = ? WHERE id = ?');

  // Normalize IN-prefix invoices
  if (inPrefixed.length >= 3) {
    const digits = inPrefixed.map(r => ({ id: r.id, invoice: r.extracted_invoice, nums: r.extracted_invoice.replace(/^IN/i, '') }));
    const lengthCounts = {};
    for (const d of digits) { lengthCounts[d.nums.length] = (lengthCounts[d.nums.length] || 0) + 1; }
    const expectedLen = parseInt(Object.entries(lengthCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '0', 10);
    if (!expectedLen) return;

    const prefixLen = Math.max(1, expectedLen - 3);
    const prefixCounts = {};
    for (const d of digits) {
      if (d.nums.length === expectedLen) {
        const prefix = d.nums.substring(0, prefixLen);
        prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
      }
    }
    const dominantPrefix = Object.entries(prefixCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!dominantPrefix) return;

    console.log(`[bat-ocr-norm] IN pattern: IN${dominantPrefix}xxx (${expectedLen} digits)`);

    const tx = db.transaction(() => {
      for (const d of digits) {
        let corrected = null;
        if (d.nums.length < expectedLen) {
          const missing = expectedLen - d.nums.length;
          const candidate = dominantPrefix.substring(0, missing) + d.nums;
          if (candidate.length === expectedLen) corrected = `IN${candidate}`;
        }
        if (!corrected && d.nums.length === expectedLen && !d.nums.startsWith(dominantPrefix)) {
          let diffCount = 0;
          for (let i = 0; i < prefixLen; i++) { if (d.nums[i] !== dominantPrefix[i]) diffCount++; }
          if (diffCount <= 2) corrected = `IN${dominantPrefix}${d.nums.substring(prefixLen)}`;
        }
        if (corrected && corrected !== d.invoice) {
          console.log(`[bat-ocr-norm] Corrected ${d.invoice} → ${corrected}`);
          update.run(corrected, d.id);
        }
      }
    });
    tx();
  }

  // Normalize long numeric invoices (e.g., 18000422xxx)
  if (numeric.length >= 3) {
    const lengthCounts = {};
    for (const r of numeric) { lengthCounts[r.extracted_invoice.length] = (lengthCounts[r.extracted_invoice.length] || 0) + 1; }
    const expectedLen = parseInt(Object.entries(lengthCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '0', 10);
    if (!expectedLen) return;

    const prefixLen = Math.max(1, expectedLen - 3);
    const prefixCounts = {};
    for (const r of numeric) {
      if (r.extracted_invoice.length === expectedLen) {
        prefixCounts[r.extracted_invoice.substring(0, prefixLen)] = (prefixCounts[r.extracted_invoice.substring(0, prefixLen)] || 0) + 1;
      }
    }
    const dominantPrefix = Object.entries(prefixCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!dominantPrefix) return;

    console.log(`[bat-ocr-norm] Numeric pattern: ${dominantPrefix}xxx (${expectedLen} digits)`);

    const tx = db.transaction(() => {
      for (const r of numeric) {
        let corrected = null;
        if (r.extracted_invoice.length < expectedLen) {
          const missing = expectedLen - r.extracted_invoice.length;
          const candidate = dominantPrefix.substring(0, missing) + r.extracted_invoice;
          if (candidate.length === expectedLen) corrected = candidate;
        }
        if (!corrected && r.extracted_invoice.length === expectedLen && !r.extracted_invoice.startsWith(dominantPrefix)) {
          let diffCount = 0;
          for (let i = 0; i < prefixLen; i++) { if (r.extracted_invoice[i] !== dominantPrefix[i]) diffCount++; }
          if (diffCount <= 2) corrected = dominantPrefix + r.extracted_invoice.substring(prefixLen);
        }
        if (corrected && corrected !== r.extracted_invoice) {
          console.log(`[bat-ocr-norm] Corrected ${r.extracted_invoice} → ${corrected}`);
          update.run(corrected, r.id);
        }
      }
    });
    tx();
  }
}

const PDF_TIMEOUT = 300000; // 5 min per PDF — large scanned PDFs (20-40MB) need time to download + OCR

// Concurrency for the OCR worker pool. Default 4 — small enough to stay below
// ocr.space / Google Vision per-IP rate limits but big enough that 90% of the
// wall time is the slowest in-flight network call instead of waiting.
// Override via OCR_CONCURRENCY env var (set to "1" to revert to sequential).
const OCR_CONCURRENCY = Math.max(1, parseInt(process.env.OCR_CONCURRENCY || '4', 10));

async function processQueue(reconId) {
  const N = OCR_CONCURRENCY;
  console.log(`[bat-ocr] Starting worker pool (concurrency=${N}) for reconciliation ${reconId}`);

  // Pre-init N Tesseract workers — creation is ~500 ms each, so do it once.
  const workers = await Promise.all(Array.from({ length: N }, () => createWorker('eng')));

  const updateExtraction = db.prepare(`
    UPDATE bat_invoice_extractions
    SET extracted_invoice = ?, extraction_status = ?, preview_path = COALESCE(?, preview_path),
        extraction_attempts = extraction_attempts + 1, extraction_error = ?
    WHERE id = ?
  `);
  // Pull the next pending row that ISN'T already being processed by another
  // lane. The in-memory `inFlight` Set is the source of truth for "claimed by
  // a lane this run". Avoids changing the SQL schema or status values that
  // the UI checks against.
  const inFlight = new Set();
  const claimNext = () => {
    const candidates = db.prepare(
      "SELECT * FROM bat_invoice_extractions WHERE reconciliation_id = ? AND extraction_status = 'pending' ORDER BY id LIMIT ?"
    ).all(reconId, OCR_CONCURRENCY * 4);
    for (const row of candidates) {
      if (!inFlight.has(row.id)) { inFlight.add(row.id); return row; }
    }
    return null;
  };

  db.prepare("UPDATE bat_reconciliations SET last_error = NULL, last_error_at = NULL WHERE id = ?").run(reconId);

  const lanes = workers.map((w) => ({ worker: w }));

  const runLane = async (lane) => {
    while (true) {
      if (ocrPaused) {
        console.log('[bat-ocr] Paused — lane exiting after current item');
        return;
      }
      const next = claimNext();
      if (!next) return;

      console.log(`[bat-ocr] Processing id=${next.id} ${next.store_name || ''}`);
      try {
        try {
          const result = await Promise.race([
            extractInvoiceFromPdf(lane.worker, next.pdf_url, next.id),
            new Promise((_, reject) => setTimeout(() => reject(new Error('PDF timeout')), PDF_TIMEOUT)),
          ]);
          const invoiceNumber = result?.invoice ?? result;
          const previewPath = result?.previewPath ?? null;
          const engineError = result?.error ?? null;

          if (invoiceNumber) {
            updateExtraction.run(invoiceNumber, 'found', previewPath, null, next.id);
            console.log(`[bat-ocr] id=${next.id} -> ${invoiceNumber}`);
          } else {
            updateExtraction.run(null, 'not_found', previewPath, engineError, next.id);
            console.log(`[bat-ocr] id=${next.id} — not found${engineError ? ` (engine issue: ${engineError})` : ''}`);
            if (engineError) recordReconciliationError(reconId, engineError);
          }
          emitExtractionUpdate(reconId);
        } catch (err) {
          console.error(`[bat-ocr] id=${next.id} failed: ${err.message}`);
          updateExtraction.run(null, 'failed', null, err.message, next.id);
          recordReconciliationError(reconId, `Extraction id=${next.id}: ${err.message}`);
          emitExtractionUpdate(reconId);

          // Recreate the lane's Tesseract worker — assumed dead on uncaught error.
          try {
            await lane.worker.terminate().catch(() => {});
            lane.worker = await createWorker('eng');
          } catch (e) {
            console.error('[bat-ocr] Worker recreation failed:', e.message);
            recordReconciliationError(reconId, `Tesseract worker crashed: ${e.message}`);
            inFlight.delete(next.id);
            return; // lane retires
          }
        }
      } finally {
        inFlight.delete(next.id);
      }
    }
  };

  try {
    await Promise.all(lanes.map(runLane));
  } finally {
    await Promise.all(lanes.map(l => l.worker.terminate().catch(() => {})));
  }

  normalizeInvoiceNumbers(reconId);
  await matchExtractedInvoices(reconId);
  db.prepare("UPDATE bat_reconciliations SET status = 'completed' WHERE id = ?").run(reconId);
  console.log(`[bat-ocr] Extraction complete for reconciliation ${reconId}`);
  emitExtractionUpdate(reconId);
}

async function pdfPageToImage(buffer, pageNum, scale = 3.0) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('canvas');

  const pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(viewport.width, viewport.height);
  const context = canvas.getContext('2d');

  await page.render({ canvasContext: context, viewport }).promise;
  await pdfDoc.destroy();

  return canvas.toBuffer('image/png');
}

function getBatSetting(key) {
  try {
    const row = db.prepare('SELECT value FROM bat_settings WHERE key = ?').get(key);
    return row?.value || null;
  } catch { return null; }
}

function setBatSetting(key, value) {
  try {
    db.prepare(`INSERT INTO bat_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(key, String(value));
  } catch (e) { console.error('[bat-settings] write failed:', e.message); }
}

function getGoogleVisionKey() {
  return getBatSetting('google_vision_key') || process.env.GOOGLE_VISION_KEY || null;
}

function getOcrSpaceKey() {
  return getBatSetting('ocr_space_key') || process.env.OCR_SPACE_KEY || null;
}

function recordReconciliationError(reconId, message) {
  if (!reconId || !message) return;
  try {
    db.prepare(
      "UPDATE bat_reconciliations SET last_error = ?, last_error_at = datetime('now') WHERE id = ?"
    ).run(String(message).slice(0, 500), reconId);
  } catch (err) {
    console.error('[bat] Failed to persist reconciliation error:', err.message);
  }
}

async function ocrViaGoogleVision(imageBuffer) {
  const apiKey = getGoogleVisionKey();
  if (!apiKey) throw new Error('GOOGLE_VISION_KEY not set');

  const base64 = imageBuffer.toString('base64');
  const body = {
    requests: [{
      image: { content: base64 },
      features: [{ type: 'TEXT_DETECTION', maxResults: 1 }],
    }],
  };

  const res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google Vision HTTP ${res.status}: ${err.substring(0, 200)}`);
  }

  const data = await res.json();
  const annotation = data.responses?.[0]?.fullTextAnnotation;
  return annotation?.text || '';
}

async function ocrViaOcrSpaceEngine(imageBuffer, engine = '2', retries = 1) {
  const apiKey = getOcrSpaceKey();
  if (!apiKey) throw new Error('OCR_SPACE_KEY not set — configure in BAT settings or env');
  const base64 = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const formData = new URLSearchParams();
    formData.append('base64Image', base64);
    formData.append('language', 'eng');
    formData.append('isOverlayRequired', 'false');
    formData.append('OCREngine', engine);
    formData.append('scale', 'true');
    formData.append('isTable', 'true');
    formData.append('detectOrientation', 'true');

    const res = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { apikey: apiKey },
      body: formData,
    });

    if (!res.ok) {
      const body = await res.text();
      // 413 = file too large; 403 = quota/key issues — both are tier-level problems worth surfacing
      const tier = res.status === 413 || res.status === 403;
      const err = new Error(`ocr.space HTTP ${res.status}: ${body.substring(0, 200)}`);
      if (tier) err.tierError = true;
      throw err;
    }
    const data = await res.json();

    if (data.IsErroredOnProcessing) {
      const errMsg = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join('; ') : (data.ErrorMessage || 'unknown');
      if (errMsg.includes('E101') && attempt < retries) {
        console.log(`[bat-ocr] ocr.space E${engine} E101 timeout, retry ${attempt + 1}/${retries} in 8s...`);
        await new Promise(r => setTimeout(r, 8000));
        continue;
      }
      const err = new Error(`ocr.space error: ${errMsg}`);
      // E556 = file too large (free-tier 1.5MB cap), E102/E103 = key/quota issues
      if (/E556|E102|E103|too large|Plan|quota|limit/i.test(errMsg)) err.tierError = true;
      throw err;
    }

    return (data.ParsedResults || []).map(r => r.ParsedText || '').join('\n');
  }
}

// Backward compat alias
async function ocrViaOcrSpaceBase64(imageBuffer) {
  return ocrViaOcrSpaceEngine(imageBuffer, '2');
}

// Preview storage directory
const previewDir = path.join(process.cwd(), 'uploads', 'bat-previews');
if (!fs.existsSync(previewDir)) fs.mkdirSync(previewDir, { recursive: true });

async function extractInvoiceFromPdf(worker, pdfUrl, extractionId) {
  // Download the PDF
  let response;
  try {
    response = await fetch(pdfUrl);
  } catch (err) {
    throw new Error(`Download failed: ${err.message}`);
  }
  if (!response.ok) throw new Error(`Failed to download PDF: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length < 100 || !buffer.subarray(0, 5).toString().startsWith('%PDF')) {
    console.log(`[bat-ocr] Not a valid PDF (${buffer.length} bytes)`);
    return { invoice: null, previewPath: null };
  }

  const isLarge = buffer.length > 2 * 1024 * 1024; // > 2MB
  console.log(`[bat-ocr] PDF ${(buffer.length / 1024 / 1024).toFixed(1)}MB — using ${isLarge ? 'ocr.space' : 'Tesseract'}`);

  // Step 1: Try pdfjs text extraction (no OCR needed)
  try {
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
    loadingTask.onUnsupportedFeature = () => {};
    const pdfDoc = await loadingTask.promise;

    for (let p = 1; p <= Math.min(pdfDoc.numPages, 3); p++) {
      const page = await pdfDoc.getPage(p);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(item => item.str).join(' ');
      if (pageText.trim()) {
        const invoice = findInvoiceNumber(pageText);
        if (invoice) {
          await pdfDoc.destroy();
          console.log(`[bat-ocr] Found via text layer: ${invoice}`);
          return { invoice, previewPath: null };
        }
      }
    }
    await pdfDoc.destroy();
  } catch (err) {
    console.log(`[bat-ocr] Text extraction failed: ${err.message}`);
  }

  // Step 2: Render to image
  let imageBuffer;
  try {
    imageBuffer = await pdfPageToImage(buffer, 1, isLarge ? 1.5 : 2.0);
  } catch (err) {
    console.error(`[bat-ocr] Render failed: ${err.message}`);
    return { invoice: null, previewPath: null };
  }

  const sharp = (await import('sharp')).default;

  // Save a lightweight JPEG preview for the UI
  let previewPath = null;
  try {
    const previewJpeg = await sharp(imageBuffer).resize({ width: 1200 }).jpeg({ quality: 70 }).toBuffer();
    const filename = `${extractionId}.jpg`;
    const fullPath = path.join(previewDir, filename);
    fs.writeFileSync(fullPath, previewJpeg);
    previewPath = `/api/bat/preview/${filename}`;
  } catch (err) {
    console.log(`[bat-ocr] Preview save failed: ${err.message}`);
  }

  // ── Multi-engine OCR pipeline ──────────────────────────────────────────────
  // Try every available engine in order of reliability until one finds the invoice.
  // Each engine gets both rotations (0° then 90°) before moving to the next.

  const ocrEngines = [];

  // Google Vision first — fastest and most accurate
  if (getGoogleVisionKey()) {
    ocrEngines.push({
      name: 'GoogleVision',
      run: async (angle) => {
        const jpeg = await sharp(imageBuffer).rotate(angle).resize({ width: 2400 }).jpeg({ quality: 85 }).toBuffer();
        console.log(`[bat-ocr] Google Vision rot ${angle} (${jpeg.length} bytes)`);
        return await ocrViaGoogleVision(jpeg);
      },
    });
  }

  ocrEngines.push(
    {
      name: 'ocr.space/e1',
      run: async (angle) => {
        const jpeg = await sharp(imageBuffer).rotate(angle).resize({ width: 2000 }).jpeg({ quality: 80 }).toBuffer();
        console.log(`[bat-ocr] ocr.space E1 rot ${angle} (${jpeg.length} bytes)`);
        return await ocrViaOcrSpaceEngine(jpeg, '1');
      },
    },
    {
      name: 'ocr.space/e3',
      run: async (angle) => {
        const jpeg = await sharp(imageBuffer).rotate(angle).resize({ width: 2000 }).jpeg({ quality: 85 }).toBuffer();
        console.log(`[bat-ocr] ocr.space E3 rot ${angle} (${jpeg.length} bytes)`);
        return await ocrViaOcrSpaceEngine(jpeg, '3');
      },
    },
    {
      name: 'Tesseract',
      run: async (angle) => {
        const processed = await sharp(imageBuffer)
          .rotate(angle).greyscale().normalise().sharpen({ sigma: 2 }).threshold(140).png().toBuffer();
        const { data: { text } } = await worker.recognize(processed);
        return text;
      },
    },
    {
      name: 'Tesseract-noThresh',
      run: async (angle) => {
        const processed = await sharp(imageBuffer)
          .rotate(angle).greyscale().normalise().sharpen({ sigma: 3 }).png().toBuffer();
        const { data: { text } } = await worker.recognize(processed);
        return text;
      },
    },
    {
      name: 'ocr.space/e2',
      run: async (angle) => {
        const jpeg = await sharp(imageBuffer).rotate(angle).resize({ width: 2000 }).jpeg({ quality: 80 }).toBuffer();
        console.log(`[bat-ocr] ocr.space E2 rot ${angle} (${jpeg.length} bytes)`);
        return await ocrViaOcrSpaceEngine(jpeg, '2');
    },
  });

  let tierError = null;
  for (const engine of ocrEngines) {
    for (const angle of [0, 90]) {
      try {
        const text = await engine.run(angle);
        if (!text || text.trim().length < 20) continue;
        console.log(`[bat-ocr] ${engine.name} rot ${angle}: ${text.length} chars`);
        const invoice = findInvoiceNumber(text);
        if (invoice) {
          console.log(`[bat-ocr] Found via ${engine.name} (rot ${angle}): ${invoice}`);
          return { invoice, previewPath };
        }
      } catch (err) {
        console.log(`[bat-ocr] ${engine.name} rot ${angle} failed: ${err.message}`);
        if (err.tierError && !tierError) tierError = `${engine.name}: ${err.message}`;
      }
    }
  }

  return { invoice: null, previewPath, error: tierError };
}

function findInvoiceNumber(text) {
  if (!text) return null;
  // Normalize OCR artifacts: common misreads
  const cleaned = text
    .replace(/[|]/g, 'I')
    .replace(/[oO](?=\d{3,})/g, '0')  // O before digits -> 0
    .replace(/[lI](?=N\d)/g, 'I')     // l before N+digits -> I
    .replace(/\*/g, '')               // strip asterisks (*IN555177* → IN555177)
    .replace(/[{}[\]()]/g, '')        // strip brackets OCR might add
    .replace(/[—–-]{2,}/g, ' ');      // collapse long dashes

  // Pattern 1: Long invoices — OCR reads "IN" as "18" (I→1, N→8), so 18000422xxx = IN000422xxx
  const longMatch = cleaned.match(/\b(18\d{8,9})\b/);
  if (longMatch) {
    const corrected = 'IN' + longMatch[1].substring(2);
    console.log(`[bat-ocr] Found long invoice (18→IN): ${corrected}`);
    return corrected;
  }

  // Pattern 1b: Already correct IN + 8-9 digits (IN000412926 or IN00412926 with dropped zero)
  const inLongMatch = cleaned.match(/\bIN\s*(\d{8,9})\b/i);
  if (inLongMatch) {
    let digits = inLongMatch[1];
    if (digits.length === 8) digits = '0' + digits; // pad dropped zero: IN00412926 -> IN000412926
    console.log(`[bat-ocr] Found long IN invoice: IN${digits}`);
    return `IN${digits}`;
  }

  // Pattern 2: Partial long invoice — 000422xxx (core with garbled/missing prefix)
  const partialPatterns = [
    /\b\d?0{2,3}(422\d{3,6})\b/,                  // x000422xxx or 00422xxx
    /(?:INVOIC|NVOIC|VOICE)[E]?\s*[#:.]?\s*\d{0,5}(422\d{3})\b/i,  // near INVOICE keyword
  ];
  for (const p of partialPatterns) {
    const m = cleaned.match(p);
    if (m) {
      const full = 'IN000' + m[1];
      if (full.length >= 12 && full.length <= 14) {
        console.log(`[bat-ocr] Reconstructed long invoice: ${full}`);
        return full;
      }
    }
  }

  // Pattern 3: IN-prefix invoices (e.g., IN555177) — but NOT if digits are 8+ (likely a long invoice misread)
  const inPatterns = [
    /\bIN\s*(\d{4,7})\b/i,                       // IN55177 (max 7 digits to avoid eating long invoices)
    /\bINV\s*(\d{4,7})\b/i,                      // INV55177
    /[IL1]\s*N\s*(\d{4,7})\b/,                   // OCR misread: 1N55177
    /IN[^a-zA-Z\n\d]{0,3}(\d{4,7})\b/,           // IN + noise + digits
  ];
  for (const pattern of inPatterns) {
    const match = cleaned.match(pattern);
    if (match) {
      return `IN${match[1]}`;
    }
  }

  // Pattern 4: Standalone 55xxxx (IN555xxx without the IN prefix)
  const standaloneMatch = cleaned.match(/\b(55\d{4,7})\b/);
  if (standaloneMatch) {
    console.log(`[bat-ocr] Found standalone 55... number: ${standaloneMatch[1]}`);
    return `IN${standaloneMatch[1]}`;
  }

  return null;
}

// ── Invoice Matching ─────────────────────────────────────────────────────────

async function matchExtractedInvoices(reconId) {
  const foundExtractions = db.prepare(
    `SELECT * FROM bat_invoice_extractions WHERE reconciliation_id = ? AND extraction_status = 'found' AND match_status = 'pending'`
  ).all(reconId);

  if (foundExtractions.length === 0) return;

  let sageInvoices;
  try {
    const now = Date.now();
    if (_sagePostedInvoicesCache && _sagePostedInvoicesCache.expiresAt > now) {
      sageInvoices = _sagePostedInvoicesCache.data;
    } else {
      sageInvoices = await querySagePostedInvoices();
      _sagePostedInvoicesCache = { data: sageInvoices, expiresAt: now + SAGE_POSTED_INVOICES_TTL_MS };
    }
  } catch (err) {
    console.error('[bat-match] Failed to query Sage invoices:', err.message);
    return;
  }

  // Build lookup map — document_number -> invoice data
  const sageLookup = new Map();
  for (const inv of sageInvoices) {
    const docNum = (inv.document_number || '').trim().toUpperCase();
    sageLookup.set(docNum, inv);
  }

  const updateMatch = db.prepare(`
    UPDATE bat_invoice_extractions
    SET sage_match_document = ?, sage_match_amount = ?, match_status = ?
    WHERE id = ?
  `);

  const tx = db.transaction((entries) => {
    for (const ext of entries) {
      const invoiceNum = (ext.extracted_invoice || '').trim().toUpperCase();
      const match = sageLookup.get(invoiceNum);
      if (match) {
        updateMatch.run(match.document_number, match.amount, 'matched', ext.id);
      } else {
        updateMatch.run(null, null, 'unmatched', ext.id);
      }
    }
  });
  tx(foundExtractions);
}

// ── Dashboard Aggregates ─────────────────────────────────────────────────────

export function getDashboardData() {
  const reconciliations = listReconciliations();
  // totalSupplier — single SQL aggregate against bat_reconciliations.
  let totalSupplier = 0;
  try {
    const row = db.prepare('SELECT COALESCE(SUM(supplier_total), 0) AS s FROM bat_reconciliations').get();
    totalSupplier = row?.s || 0;
  } catch {}
  // totalSage = sum of all Sage credit notes for the CURRENT YEAR, regardless
  // of whether we've uploaded a supplier file for that week.
  let totalSage = 0;
  try {
    const currentYear = new Date().getFullYear();
    const row = db.prepare('SELECT COALESCE(SUM(total), 0) AS s FROM bat_sage_week_cache WHERE year = ?').get(currentYear);
    totalSage = row?.s || 0;
  } catch {}
  const totalVariance = totalSupplier - totalSage;

  // totalPods + matched + exact-matched: pod_count is a cheap COUNT(*); matched
  // counts are computed in JS via a single Cardoso lookup map. Replaces two
  // correlated EXISTS subqueries with non-sargable string normalization.
  let totalPods = 0, totalMatched = 0, totalExactMatched = 0;
  try {
    const podRow = db.prepare('SELECT COUNT(*) AS c FROM bat_invoice_extractions').get();
    totalPods = podRow?.c || 0;
    const cardosoAmounts = buildCardosoLookup();
    const extRows = db.prepare(
      "SELECT extracted_invoice, order_amount FROM bat_invoice_extractions WHERE extracted_invoice IS NOT NULL"
    ).all();
    for (const e of extRows) {
      const key = String(e.extracted_invoice).replace(/\s/g, '').toUpperCase();
      const cAmount = cardosoAmounts.get(key);
      if (cAmount === undefined) continue;
      totalMatched++;
      if (Math.abs((e.order_amount || 0) - (cAmount || 0)) < 0.01) totalExactMatched++;
    }
  } catch {}
  // Match rate = invoices that match by BOTH number AND amount (within R 0.01)
  // out of all PODs we attempted to extract. Mismatched amounts no longer inflate
  // the match rate.
  const matchRate = totalPods > 0 ? (totalExactMatched / totalPods) * 100 : 0;

  let totalExceptionsCount = 0, totalExceptionsAmount = 0;
  let exceptionsByReason = [];
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS c, COALESCE(SUM(order_amount), 0) AS a
      FROM bat_invoice_extractions
      WHERE is_exception = 1
    `).get();
    totalExceptionsCount = row?.c || 0;
    totalExceptionsAmount = row?.a || 0;
    const rawRows = db.prepare(`
      SELECT exception_reason, order_amount
      FROM bat_invoice_extractions
      WHERE is_exception = 1
    `).all();
    // Normalize: lowercase, strip punctuation, collapse whitespace, drop duplicate words.
    // Lets "Incorrect delivery status/quantity" and "Incorrect delivery status/Incorrect quantity"
    // collapse to the same key.
    const normalize = (s) => {
      const lower = (s || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!lower) return '';
      const seen = new Set();
      const out = [];
      for (const w of lower.split(' ')) {
        if (!seen.has(w)) { seen.add(w); out.push(w); }
      }
      return out.join(' ');
    };
    const grouped = new Map();
    for (const r of rawRows) {
      const raw = (r.exception_reason || '').trim() || 'Unspecified';
      const key = normalize(raw) || 'unspecified';
      let g = grouped.get(key);
      if (!g) { g = { reason: raw, count: 0, amount: 0 }; grouped.set(key, g); }
      g.count++;
      g.amount += r.order_amount || 0;
      // Pick the shortest (canonical) phrasing for display
      if (raw.length < g.reason.length) g.reason = raw;
    }
    exceptionsByReason = [...grouped.values()].sort((a, b) => b.amount - a.amount);
  } catch {}

  return {
    summary: { totalSupplier, totalSage, totalVariance, matchRate, totalReconciliations: reconciliations.length, totalExactMatched, totalMatched, totalPods, totalExceptionsCount, totalExceptionsAmount, exceptionsByReason },
    reconciliations,
    weekTrend: reconciliations.map(r => ({
      week: `W${r.week_number}`,
      supplier: r.supplier_total || 0,
      sage: r.sage_total || 0,
      variance: (r.supplier_total || 0) - (r.sage_total || 0),
    })).reverse(),
  };
}

// ── Cardoso Invoice Generation (from Sage, replaces the Crystal+Excel pipeline) ──

// In-flight generation tracking so the user can abort via the Cancel button.
let _activeGenerate = null; // { request, cancelled, startedAt }

export function cancelCardosoInvoiceGeneration() {
  if (!_activeGenerate) return { ok: true, status: 'not_running' };
  const prev = _activeGenerate;
  prev.cancelled = true;
  try { prev.request?.cancel(); } catch {}
  // Release the lock immediately so a new Generate can start. Any in-flight
  // SQL/aggregation from the old call still runs to completion in the background
  // but its cleanup paths short-circuit on cancelled=true.
  _activeGenerate = null;
  return { ok: true, status: 'cancelled' };
}

export function getCardosoGenerateStatus() {
  return _activeGenerate
    ? { running: true, startedAt: _activeGenerate.startedAt, cancelling: !!_activeGenerate.cancelled }
    : { running: false };
}

// Mirrors the Excel macro: pulls OEINVH+OEINVD line items, joins ICPRICP for the
// Cardoso standard price on the invoice's price list, computes per-line totals,
// then aggregates per invoice for storage in bat_cardoso_invoices.
//
// TG1/TG2 rates default to the macro's 0.0009 / 0.0001 but can be overridden
// per call OR globally via bat_settings.tg1_rate / tg2_rate (per-site).
export async function generateCardosoInvoicesFromSage({ fromDate, toDate, mode = 'overwrite', tg1Rate, tg2Rate } = {}) {
  if (!fromDate || !toDate) throw new Error('fromDate and toDate required (YYYY-MM-DD)');
  const intDate = (d) => parseInt(String(d).replace(/-/g, ''), 10);
  const from = intDate(fromDate);
  const to   = intDate(toDate);
  if (!from || !to) throw new Error('Invalid date range');

  // Resolve TG rates: explicit param > bat_settings > macro default
  const tg1 = Number(tg1Rate ?? getBatSetting('tg1_rate') ?? 0.0009);
  const tg2 = Number(tg2Rate ?? getBatSetting('tg2_rate') ?? 0.0001);
  if (!Number.isFinite(tg1) || !Number.isFinite(tg2)) {
    throw new Error('Invalid TG1/TG2 rate');
  }
  // If explicit rates were passed in, persist them so the next run uses the same defaults
  if (tg1Rate != null) setBatSetting('tg1_rate', String(tg1));
  if (tg2Rate != null) setBatSetting('tg2_rate', String(tg2));

  if (_activeGenerate) throw new Error('Generation already in progress');

  // Pull line items joined with the Cardoso price-list price for the same item
  // and the same price list as the invoice line. Suppress zero-priced ICPRICP rows.
  // Use an explicit request so we can call request.cancel() from the cancel endpoint.
  const pool = await getSagePool();
  const request = pool.request();
  _activeGenerate = { request, cancelled: false, startedAt: new Date().toISOString() };
  let lines;
  try {
    const result = await request.query(`
      SELECT
        LTRIM(RTRIM(d.ITEM))      AS item,
        LTRIM(RTRIM(d."DESC"))    AS description,
        d.QTYORDERED              AS qty,
        LTRIM(RTRIM(d.PRICELIST)) AS pricelist,
        LTRIM(RTRIM(h.INVNUMBER)) AS invoice_number,
        d.UNITPRICE               AS unit_price,
        d.INVDISC                 AS discount,
        h.INVDATE                 AS invoice_date,
        LTRIM(RTRIM(h.PONUMBER))  AS po_number,
        LTRIM(RTRIM(h.REFERENCE)) AS reference,
        icp.UNITPRICE             AS cardoso_price
      FROM CARDAT.dbo.OEINVH h
      INNER JOIN CARDAT.dbo.OEINVD d ON d.INVUNIQ = h.INVUNIQ
      LEFT JOIN  CARDAT.dbo.ICPRICP icp
        ON icp.ITEMNO    = d.ITEM
       AND icp.PRICELIST = d.PRICELIST
      WHERE d.PRICELIST IN ('BF', 'OC')
        AND h.INVDATE BETWEEN ${from} AND ${to}
        AND COALESCE(icp.UNITPRICE, 0) > 0
      ORDER BY h.INVNUMBER
    `);
    if (_activeGenerate?.cancelled) {
      _activeGenerate = null;
      return { ok: false, status: 'cancelled' };
    }
    lines = result.recordset || [];
  } catch (err) {
    const wasCancelled = _activeGenerate?.cancelled;
    _activeGenerate = null;
    if (wasCancelled || /cancel/i.test(err.message || '')) {
      return { ok: false, status: 'cancelled' };
    }
    throw err;
  }

  // Cancel check before the post-SQL work
  if (_activeGenerate?.cancelled) {
    _activeGenerate = null;
    return { ok: false, status: 'cancelled' };
  }

  // Aggregate per invoice (matches the macro's per-sheet subtotal output)
  const byInvoice = new Map();
  for (const ln of lines) {
    const qty   = Number(ln.qty)           || 0;
    const unit  = Number(ln.unit_price)    || 0;
    const card  = Number(ln.cardoso_price) || 0;
    const disc  = Number(ln.discount)      || 0;
    const batx  = unit * qty;
    const ccdx  = card * qty;
    const diff  = ccdx - batx;
    const tg1Amt = batx * tg1;
    const tg2Amt = batx * tg2;
    const del   = tg1Amt + tg2Amt;
    const total = del + disc + diff;
    const inv = ln.invoice_number;
    if (!byInvoice.has(inv)) {
      byInvoice.set(inv, {
        invoice_number: inv,
        invoice_date:   ln.invoice_date,
        po_number:      stripOrdPrefix(ln.po_number),
        reference:      ln.reference,
        pricelist:      ln.pricelist,
        batx: 0, ccdx: 0, price_diff: 0, discount: 0, del_fee: 0, total: 0,
        line_count: 0,
      });
    }
    const agg = byInvoice.get(inv);
    agg.batx       += batx;
    agg.ccdx       += ccdx;
    agg.price_diff += diff;
    agg.discount   += disc;
    agg.del_fee    += del;
    agg.total      += total;
    agg.line_count += 1;
    // Capture the first non-blank PONUMBER (matches macro behaviour)
    if (!agg.po_number && ln.po_number) agg.po_number = stripOrdPrefix(ln.po_number);
  }

  const invoices = [...byInvoice.values()];

  // Persist to bat_cardoso_invoices using the same shape parseCardosoSpreadsheet produces
  // (camelCase keys — storeCardosoInvoices expects invoiceNumber/priceDiff/delFee/rawData)
  const storeShape = invoices
    .filter(i => i.invoice_number)
    .map(i => ({
      invoiceNumber: String(i.invoice_number),
      amount:        i.total,
      priceDiff:     i.price_diff,
      discount:      i.discount,
      delFee:        i.del_fee,
      rawData:       JSON.stringify({
        source: 'sage_generated',
        generated_at: new Date().toISOString(),
        fromDate, toDate,
        pricelist: i.pricelist,
        po_number: i.po_number,
        reference: i.reference,
        invoice_date: i.invoice_date,
        line_count: i.line_count,
        batx: i.batx,
        ccdx: i.ccdx,
      }),
    }));

  const sourceLabel = `sage:${fromDate}..${toDate}`;
  const storeResult = storeCardosoInvoices(null, storeShape, sourceLabel, mode);
  // Auto-rerun the supplier match so the dashboard reflects the new invoices
  let matching = null;
  try { matching = matchCardosoToSupplier(null); } catch {}

  _activeGenerate = null;
  return {
    ok: true,
    fromDate, toDate,
    sageLines: lines.length,
    invoices: invoices.length,
    inserted: storeResult?.inserted ?? 0,
    updated:  storeResult?.updated  ?? 0,
    skipped:  storeResult?.skipped  ?? 0,
    matching: matching ? matching.stats : null,
  };
}

// Overwrites bat_cardoso_invoices.{price_diff, discount} with the matching
// supplier extraction's values for every row that hasn't been overwritten yet.
// del_fee is LEFT ALONE — that comes from the per-line TG1/TG2 calc on the
// Cardoso side and shouldn't be replaced with the supplier figure.
// Idempotent: rows with c_overwritten=1 are skipped on subsequent calls.
export function replicateSupplierIntoCardoso() {
  const rows = db.prepare(`
    SELECT ci.id AS cardoso_id, ci.invoice_number, ci.del_fee AS existing_del_fee,
           e.supplier_pricing, e.supplier_discount
    FROM bat_cardoso_invoices ci
    INNER JOIN bat_invoice_extractions e
      ON UPPER(REPLACE(e.extracted_invoice, ' ', '')) = UPPER(REPLACE(ci.invoice_number, ' ', ''))
    WHERE COALESCE(ci.c_overwritten, 0) = 0
      AND (e.supplier_pricing IS NOT NULL OR e.supplier_discount IS NOT NULL)
  `).all();

  // A single cardoso invoice may match multiple extractions (e.g. duplicates) —
  // collapse to the FIRST extraction's values per cardoso_id (insertion order).
  const seen = new Map();
  for (const r of rows) {
    if (!seen.has(r.cardoso_id)) seen.set(r.cardoso_id, r);
  }

  // Recompute amount = price_diff + discount + (existing cardoso del_fee).
  const update = db.prepare(`
    UPDATE bat_cardoso_invoices
    SET price_diff = ?, discount = ?, amount = ?, c_overwritten = 1
    WHERE id = ?
  `);
  let updated = 0;
  const tx = db.transaction(() => {
    for (const r of seen.values()) {
      const newAmount = (r.supplier_pricing || 0) + (r.supplier_discount || 0) + (r.existing_del_fee || 0);
      update.run(r.supplier_pricing, r.supplier_discount, newAmount, r.cardoso_id);
      updated += 1;
    }
  });
  tx();

  const totalNotOverwritten = db.prepare("SELECT COUNT(*) c FROM bat_cardoso_invoices WHERE COALESCE(c_overwritten, 0) = 0").get().c;
  const totalOverwritten   = db.prepare("SELECT COUNT(*) c FROM bat_cardoso_invoices WHERE c_overwritten = 1").get().c;
  invalidateCardosoLookup();
  return { ok: true, updated, totalOverwritten, remainingNotOverwritten: totalNotOverwritten };
}

function stripOrdPrefix(value) {
  if (!value) return null;
  return String(value).replace(/ORD/gi, '').trim() || null;
}

// ── Cardoso Invoice Upload & Matching ────────────────────────────────────────

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

export function storeCardosoInvoices(reconId, invoices, filename, duplicateMode = 'skip') {
  // duplicateMode: 'skip' = keep existing, 'overwrite' = update existing with new amount
  const existing = db.prepare('SELECT id, invoice_number FROM bat_cardoso_invoices').all();
  const existingMap = new Map(existing.map(r => [r.invoice_number.toUpperCase(), r.id]));

  const insert = db.prepare(`
    INSERT INTO bat_cardoso_invoices (reconciliation_id, invoice_number, amount, price_diff, discount, del_fee, upload_filename, raw_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE bat_cardoso_invoices SET amount = ?, price_diff = ?, discount = ?, del_fee = ?, upload_filename = ?, raw_data = ? WHERE id = ?
  `);
  let inserted = 0, updated = 0, skipped = 0;
  const tx = db.transaction(() => {
    for (const inv of invoices) {
      const key = inv.invoiceNumber.toUpperCase();
      const existingId = existingMap.get(key);
      if (existingId) {
        if (duplicateMode === 'overwrite') {
          update.run(inv.amount, inv.priceDiff, inv.discount, inv.delFee, filename, inv.rawData, existingId);
          updated++;
        } else {
          skipped++;
        }
      } else {
        insert.run(reconId, inv.invoiceNumber, inv.amount, inv.priceDiff, inv.discount, inv.delFee, filename, inv.rawData);
        inserted++;
      }
    }
  });
  tx();
  console.log(`[bat] Cardoso invoices: ${inserted} new, ${updated} updated, ${skipped} skipped (mode=${duplicateMode})`);
  invalidateCardosoLookup();
  return { inserted, updated, skipped, duplicatesFound: updated + skipped };
}

export function getCardosoInvoices(reconId) {
  if (reconId) return db.prepare('SELECT * FROM bat_cardoso_invoices WHERE reconciliation_id = ? ORDER BY id').all(reconId);
  return db.prepare('SELECT * FROM bat_cardoso_invoices ORDER BY id').all();
}

export function matchCardosoToSupplier(reconId) {
  // If reconId is null, match across ALL reconciliations
  const extractions = reconId
    ? db.prepare('SELECT e.id, e.extracted_invoice, e.order_amount, e.supplier_discount, e.supplier_del_fee, e.supplier_pricing, e.delivery_date, e.is_exception, e.manual_override, e.reconciliation_id, r.week_number, r.year FROM bat_invoice_extractions e LEFT JOIN bat_reconciliations r ON r.id = e.reconciliation_id WHERE e.reconciliation_id = ? AND e.extracted_invoice IS NOT NULL').all(reconId)
    : db.prepare('SELECT e.id, e.extracted_invoice, e.order_amount, e.supplier_discount, e.supplier_del_fee, e.supplier_pricing, e.delivery_date, e.is_exception, e.manual_override, e.reconciliation_id, r.week_number, r.year FROM bat_invoice_extractions e LEFT JOIN bat_reconciliations r ON r.id = e.reconciliation_id WHERE e.extracted_invoice IS NOT NULL').all();
  const cardosoInvoices = reconId
    ? db.prepare('SELECT id, invoice_number, amount, price_diff, discount, del_fee FROM bat_cardoso_invoices WHERE reconciliation_id = ?').all(reconId)
    : db.prepare('SELECT id, invoice_number, amount, price_diff, discount, del_fee FROM bat_cardoso_invoices').all();

  // Build lookup: normalized invoice number → cardoso row
  const cardosoMap = new Map();
  for (const ci of cardosoInvoices) {
    const key = ci.invoice_number.replace(/\s/g, '').toUpperCase();
    cardosoMap.set(key, ci);
  }

  // Fuzzy match helper: find Cardoso invoice within 1 digit difference
  function fuzzyFind(ocrInvoice) {
    const ocrKey = ocrInvoice.replace(/\s/g, '').toUpperCase();
    if (ocrKey.length < 4) return null;
    for (const [cardosoKey, ci] of cardosoMap) {
      if (cardosoKey.length !== ocrKey.length) continue;
      let diffs = 0;
      for (let i = 0; i < ocrKey.length; i++) {
        if (ocrKey[i] !== cardosoKey[i]) diffs++;
        if (diffs > 1) break;
      }
      if (diffs === 1) return { ci, correctedInvoice: ci.invoice_number };
    }
    return null;
  }

  const results = [];
  const matchedCardosoIds = new Set();
  let autoCorrections = 0;

  // Auto-correct update statement
  const correctInvoice = db.prepare('UPDATE bat_invoice_extractions SET extracted_invoice = ? WHERE id = ?');

  for (const ext of extractions) {
    const key = (ext.extracted_invoice || '').replace(/\s/g, '').toUpperCase();
    let cardoso = cardosoMap.get(key);

    // Fuzzy match: if exact match fails, try 1-digit-off — but ONLY for rows
    // the user hasn't manually corrected. Manual edits are sacred.
    let wasCorrected = false;
    if (!cardoso && !ext.manual_override) {
      const fuzzy = fuzzyFind(ext.extracted_invoice);
      if (fuzzy) {
        cardoso = fuzzy.ci;
        console.log(`[bat-match] Auto-corrected ${ext.extracted_invoice} → ${fuzzy.correctedInvoice} (1-digit OCR fix)`);
        correctInvoice.run(fuzzy.correctedInvoice, ext.id);
        ext.extracted_invoice = fuzzy.correctedInvoice;
        wasCorrected = true;
        autoCorrections++;
      }
    }

    if (cardoso) {
      matchedCardosoIds.add(cardoso.id);
      const diff = (ext.order_amount || 0) - (cardoso.amount || 0);
      results.push({
        extraction_id: ext.id,
        cardoso_id: cardoso.id,
        invoice_number: ext.extracted_invoice,
        supplier_amount: ext.order_amount,
        cardoso_amount: cardoso.amount,
        supplier_discount: ext.supplier_discount,
        supplier_del_fee: ext.supplier_del_fee,
        supplier_pricing: ext.supplier_pricing,
        cardoso_price_diff: cardoso.price_diff,
        cardoso_discount: cardoso.discount,
        cardoso_del_fee: cardoso.del_fee,
        difference: diff,
        matched: true,
        amount_mismatch: Math.abs(diff) > 0.01,
        auto_corrected: wasCorrected,
        is_exception: ext.is_exception,
        week_number: ext.week_number,
        year: ext.year,
        delivery_date: ext.delivery_date,
      });
    } else {
      results.push({
        extraction_id: ext.id,
        cardoso_id: null,
        invoice_number: ext.extracted_invoice,
        supplier_amount: ext.order_amount,
        supplier_discount: ext.supplier_discount,
        supplier_del_fee: ext.supplier_del_fee,
        supplier_pricing: ext.supplier_pricing,
        cardoso_amount: null,
        cardoso_price_diff: null,
        cardoso_discount: null,
        cardoso_del_fee: null,
        difference: null,
        matched: false,
        amount_mismatch: false,
        is_exception: ext.is_exception,
        week_number: ext.week_number,
        year: ext.year,
        delivery_date: ext.delivery_date,
      });
    }
  }

  // Unmatched Cardoso invoices (not found in supplier)
  for (const ci of cardosoInvoices) {
    if (!matchedCardosoIds.has(ci.id)) {
      results.push({
        extraction_id: null,
        cardoso_id: ci.id,
        invoice_number: ci.invoice_number,
        supplier_amount: null,
        cardoso_amount: ci.amount,
        cardoso_price_diff: ci.price_diff,
        cardoso_discount: ci.discount,
        cardoso_del_fee: ci.del_fee,
        difference: null,
        matched: false,
        amount_mismatch: false,
      });
    }
  }

  const matched = results.filter(r => r.matched).length;
  const mismatches = results.filter(r => r.amount_mismatch).length;
  console.log(`[bat] Matching: ${matched} matched (${autoCorrections} auto-corrected), ${mismatches} amount mismatches, ${results.length - matched} unmatched`);

  return {
    results,
    stats: {
      total: results.length,
      matched,
      mismatches,
      autoCorrections,
      unmatchedSupplier: results.filter(r => !r.matched && r.extraction_id).length,
      unmatchedCardoso: results.filter(r => !r.matched && r.cardoso_id).length,
    },
  };
}
