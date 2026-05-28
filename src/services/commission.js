// src/services/commission.js — Sales commission report.
//
// Replicates the legacy "Commission Sales Report" spreadsheet
// (docs/Commission Report -April 24th 2022 to May 23rd 2022 - Complete.xlsx).
// Pulls three figures per sales rep for a date range:
//   1. Sweet sales       — OE invoices for items where COMMODIM = '1'
//   2. Sweet credits     — OE credit notes for sweet items
//   3. Customer payments — AR receipts (cash in) regardless of which
//                          invoice they were applied to.
//
// Commission math (applied at the read layer in /api/commission/report so
// callers see the final numbers):
//   net_sweets       = sweet_sales - sweet_credits
//   cig_tob_base     = customer_payments - net_sweets
//   sweet_commission = net_sweets   * settings.sweets_rate
//   cigtob_commission= cig_tob_base * settings.cigtob_rate
//   reference        = net_sweets   * settings.reference_rate
//
// Sales rep enumeration: auto-discovered from the local datarecord table
// (per-customer sales_rep is kept fresh by syncEngine), then receipts /
// sales / credits are bucketed in-memory by joining customer -> rep.

import db from '../db/index.js';
import { runCustomerSqlQuery } from './customerSqlPool.js';
import { logError } from '../lib/errorLog.js';

/**
 * @param {string} ymd  date in YYYY-MM-DD (or any Date-parseable form)
 * @returns {number}    YYYYMMDD integer used by Sage TRANDATE / DATEINVC
 */
function toYyyymmddInt(ymd) {
  const d = ymd instanceof Date ? ymd : new Date(ymd);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid date: ${ymd}`);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return Number(`${y}${m}${day}`);
}

export function getCommissionSettings() {
  const row = db.prepare(`
    SELECT sweets_rate, cigtob_rate, reference_rate, vat_rate,
           sales_query_override, receipts_query_override,
           updated_at, updated_by_user_id
    FROM commission_settings WHERE id = 1
  `).get();
  // Migration v81 seeds this row; if it's somehow missing, fall back to
  // the spreadsheet defaults instead of returning nulls that the UI
  // would render as NaN%.
  if (!row) {
    return {
      sweets_rate: 0.015, cigtob_rate: 0.0017, reference_rate: 0.01, vat_rate: 0.14,
      sales_query_override: null, receipts_query_override: null,
      updated_at: null, updated_by_user_id: null,
    };
  }
  return row;
}

export function updateCommissionSettings({
  sweets_rate, cigtob_rate, reference_rate, vat_rate,
  sales_query_override, receipts_query_override,
  userId,
}) {
  // Build a sparse update so callers can flip just rates OR just SQL
  // without clobbering the other side. Empty string normalises to NULL
  // (= "use default") so the UI's "Reset to default" button just sends
  // an empty string instead of a special clear sentinel.
  const sets = [];
  const args = [];
  if (Number.isFinite(sweets_rate))    { sets.push('sweets_rate = ?');    args.push(Math.max(0, sweets_rate)); }
  if (Number.isFinite(cigtob_rate))    { sets.push('cigtob_rate = ?');    args.push(Math.max(0, cigtob_rate)); }
  if (Number.isFinite(reference_rate)) { sets.push('reference_rate = ?'); args.push(Math.max(0, reference_rate)); }
  if (Number.isFinite(vat_rate))       { sets.push('vat_rate = ?');       args.push(Math.max(0, vat_rate)); }
  if (sales_query_override !== undefined) {
    sets.push('sales_query_override = ?');
    args.push(sales_query_override && String(sales_query_override).trim().length > 0 ? String(sales_query_override) : null);
  }
  if (receipts_query_override !== undefined) {
    sets.push('receipts_query_override = ?');
    args.push(receipts_query_override && String(receipts_query_override).trim().length > 0 ? String(receipts_query_override) : null);
  }
  if (sets.length === 0) return getCommissionSettings();

  sets.push("updated_at = datetime('now')");
  sets.push('updated_by_user_id = ?');
  args.push(userId ?? null);
  db.prepare(`UPDATE commission_settings SET ${sets.join(', ')} WHERE id = 1`).run(...args);
  return getCommissionSettings();
}

// --- Default Sage SQL (exported for the Settings UI's "view default" view) ---
//
// Both queries take three named @-params: @from, @to (YYYYMMDD ints) and
// @vat (1 + vat_rate, used as the divisor). Override SQL MUST keep these
// param names or the runtime bind step will fail.

export const DEFAULT_COMMISSION_SALES_SQL = `
SELECT LTRIM(RTRIM(ISNULL(OESHDT.SALESPER, ''))) AS sales_rep,
       SUM(ISNULL(OESHDT.FAMTSALES, 0)) AS gross_amount,
       SUM(ISNULL(OESHDT.FRETSALES, 0)) AS credit_amount
FROM OESHDT
INNER JOIN ICITMV ON OESHDT.ITEM = ICITMV.ITEMNO
INNER JOIN ICITEM ON OESHDT.ITEM = ICITEM.ITEMNO
WHERE OESHDT.TRANDATE BETWEEN @from AND @to
  AND LTRIM(RTRIM(ICITEM.COMMODIM)) = '1'
GROUP BY LTRIM(RTRIM(ISNULL(OESHDT.SALESPER, '')))
`.trim();

export const DEFAULT_COMMISSION_RECEIPTS_SQL = `
SELECT LTRIM(RTRIM(ISNULL(c.CODESLSP1, ''))) AS sales_rep,
       SUM(ISNULL(o.AMTPAYMHC, 0)) / @vat AS receipt_amount
FROM AROBP o
INNER JOIN ARCUS c
  ON LTRIM(RTRIM(c.IDCUST)) = LTRIM(RTRIM(o.IDCUST))
 AND c.CODECURN = o.CODECURN
WHERE o.DATERMIT BETWEEN @from AND @to
  AND LTRIM(RTRIM(o.IDINVC)) LIKE 'PY%'
GROUP BY LTRIM(RTRIM(ISNULL(c.CODESLSP1, '')))
`.trim();

/**
 * Run the three Sage queries and assemble the per-rep report.
 *
 * @param {{ from: string, to: string }} args  inclusive date range (YYYY-MM-DD)
 * @returns {Promise<{
 *   from: string, to: string,
 *   settings: { sweets_rate: number, cigtob_rate: number, reference_rate: number },
 *   reps: Array<{
 *     sales_rep: string, sweet_sales: number, sweet_credits: number,
 *     net_sweets: number, customer_payments: number, cig_tob_base: number,
 *     sweet_commission: number, cigtob_commission: number, reference_commission: number,
 *     total_commission: number,
 *   }>,
 *   totals: {
 *     sweet_sales: number, sweet_credits: number, net_sweets: number,
 *     customer_payments: number, cig_tob_base: number,
 *     sweet_commission: number, cigtob_commission: number,
 *     reference_commission: number, total_commission: number,
 *   },
 * }>}
 */
export async function buildCommissionReport({ from, to }) {
  if (!from || !to) throw new TypeError('buildCommissionReport: from + to required');
  const fromInt = toYyyymmddInt(from);
  const toInt = toYyyymmddInt(to);
  if (fromInt > toInt) throw new RangeError('from must be <= to');

  const settings = getCommissionSettings();

  // Use admin-supplied SQL overrides when present, otherwise the bundled
  // defaults. Both queries take @from, @to, @vat — overrides MUST keep
  // those param names or the bind step throws (validated at save time).
  const vatDivisor = 1 + (Number.isFinite(settings.vat_rate) ? settings.vat_rate : 0.14);
  const salesAndCreditsSql = (settings.sales_query_override || '').trim().length > 0
    ? settings.sales_query_override
    : DEFAULT_COMMISSION_SALES_SQL;
  const receiptsSql = (settings.receipts_query_override || '').trim().length > 0
    ? settings.receipts_query_override
    : DEFAULT_COMMISSION_RECEIPTS_SQL;

  const params = { from: fromInt, to: toInt, vat: vatDivisor };

  let salesCreditRows = [], receiptRows = [];
  try {
    const [sc, r] = await Promise.all([
      runCustomerSqlQuery(salesAndCreditsSql, params),
      runCustomerSqlQuery(receiptsSql, params),
    ]);
    salesCreditRows = sc.recordset || [];
    receiptRows = r.recordset || [];
  } catch (err) {
    logError('commission.report', err, { from, to });
    throw err;
  }

  // --- 3. Bucket by sales rep --------------------------------------------
  /** @type {Map<string, { sweet_sales: number, sweet_credits: number, customer_payments: number }>} */
  const perRep = new Map();
  const bump = (rep, field, amount) => {
    const key = String(rep || '').trim() || 'Unknown';
    if (!perRep.has(key)) perRep.set(key, { sweet_sales: 0, sweet_credits: 0, customer_payments: 0 });
    perRep.get(key)[field] += Number(amount) || 0;
  };
  for (const row of salesCreditRows) {
    bump(row.sales_rep, 'sweet_sales',   row.gross_amount);
    bump(row.sales_rep, 'sweet_credits', row.credit_amount);
  }
  for (const row of receiptRows) bump(row.sales_rep, 'customer_payments', row.receipt_amount);

  // --- 4. Compute commission ---------------------------------------------
  const reps = [...perRep.entries()]
    .map(([sales_rep, totals]) => {
      const net_sweets = totals.sweet_sales - totals.sweet_credits;
      const cig_tob_base = totals.customer_payments - net_sweets;
      const sweet_commission = net_sweets * settings.sweets_rate;
      const cigtob_commission = cig_tob_base * settings.cigtob_rate;
      const reference_commission = net_sweets * settings.reference_rate;
      return {
        sales_rep,
        sweet_sales: totals.sweet_sales,
        sweet_credits: totals.sweet_credits,
        net_sweets,
        customer_payments: totals.customer_payments,
        cig_tob_base,
        sweet_commission,
        cigtob_commission,
        reference_commission,
        total_commission: sweet_commission + cigtob_commission,
      };
    })
    .sort((a, b) => {
      // Numeric-aware sort so '1','2','10' order naturally; non-numeric
      // labels (HSE, '—') sink to the bottom alphabetically.
      const na = Number(a.sales_rep), nb = Number(b.sales_rep);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      if (Number.isFinite(na)) return -1;
      if (Number.isFinite(nb)) return 1;
      return a.sales_rep.localeCompare(b.sales_rep);
    });

  // --- 5. Column totals --------------------------------------------------
  const totals = reps.reduce((acc, r) => {
    acc.sweet_sales += r.sweet_sales;
    acc.sweet_credits += r.sweet_credits;
    acc.net_sweets += r.net_sweets;
    acc.customer_payments += r.customer_payments;
    acc.cig_tob_base += r.cig_tob_base;
    acc.sweet_commission += r.sweet_commission;
    acc.cigtob_commission += r.cigtob_commission;
    acc.reference_commission += r.reference_commission;
    acc.total_commission += r.total_commission;
    return acc;
  }, {
    sweet_sales: 0, sweet_credits: 0, net_sweets: 0,
    customer_payments: 0, cig_tob_base: 0,
    sweet_commission: 0, cigtob_commission: 0,
    reference_commission: 0, total_commission: 0,
  });

  return { from, to, settings, reps, totals };
}
