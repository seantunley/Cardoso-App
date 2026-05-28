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
    SELECT sweets_rate, cigtob_rate, reference_rate, vat_rate, updated_at, updated_by_user_id
    FROM commission_settings WHERE id = 1
  `).get();
  // Migration v81 seeds this row; if it's somehow missing, fall back to
  // the spreadsheet defaults instead of returning nulls that the UI
  // would render as NaN%.
  if (!row) {
    return { sweets_rate: 0.015, cigtob_rate: 0.0017, reference_rate: 0.01, vat_rate: 0.14, updated_at: null, updated_by_user_id: null };
  }
  return row;
}

export function updateCommissionSettings({ sweets_rate, cigtob_rate, reference_rate, vat_rate, userId }) {
  const next = {
    sweets_rate: Number.isFinite(sweets_rate) ? Math.max(0, sweets_rate) : 0,
    cigtob_rate: Number.isFinite(cigtob_rate) ? Math.max(0, cigtob_rate) : 0,
    reference_rate: Number.isFinite(reference_rate) ? Math.max(0, reference_rate) : 0,
    vat_rate: Number.isFinite(vat_rate) ? Math.max(0, vat_rate) : 0,
  };
  db.prepare(`
    UPDATE commission_settings
       SET sweets_rate = ?, cigtob_rate = ?, reference_rate = ?, vat_rate = ?,
           updated_at = datetime('now'),
           updated_by_user_id = ?
     WHERE id = 1
  `).run(next.sweets_rate, next.cigtob_rate, next.reference_rate, next.vat_rate, userId ?? null);
  return getCommissionSettings();
}

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

  // Mirrors the operator's existing Sage query — same source, same joins,
  // same rep field. OESHDT carries BOTH sales (FAMTSALES) and credit
  // returns (FRETSALES) per row; OESHDT.SALESPER is the rep at time of
  // sale (sticky), which is what the spreadsheet uses for attribution.
  // INNER JOIN ICITMV filters items without a vendor record — matches
  // the spreadsheet's scope.
  const salesAndCreditsSql = `
    SELECT LTRIM(RTRIM(ISNULL(OESHDT.SALESPER, ''))) AS sales_rep,
           SUM(ISNULL(OESHDT.FAMTSALES, 0)) AS gross_amount,
           SUM(ISNULL(OESHDT.FRETSALES, 0)) AS credit_amount
    FROM OESHDT
    INNER JOIN ICITMV ON OESHDT.ITEM = ICITMV.ITEMNO
    INNER JOIN ICITEM ON OESHDT.ITEM = ICITEM.ITEMNO
    WHERE OESHDT.TRANDATE BETWEEN @from AND @to
      AND LTRIM(RTRIM(ICITEM.COMMODIM)) = '1'
    GROUP BY LTRIM(RTRIM(ISNULL(OESHDT.SALESPER, '')))
  `;
  // --- 2. Customer payments (receipts) -----------------------------------
  // AROBP holds paired application rows (PY-prefixed = receipt headers,
  // IN-prefixed = invoice applications) that net to zero. The receipt
  // amount is on the PY-prefixed rows.
  //
  // Divide by (1 + VAT) — operator's spreadsheet shows customer payments
  // VAT-exclusive (gross / 1.14 at the historical 14% rate). The divisor
  // is settings-driven so the rate can be changed without a code deploy.
  const vatDivisor = 1 + (Number.isFinite(settings.vat_rate) ? settings.vat_rate : 0.14);
  const receiptsSql = `
    SELECT LTRIM(RTRIM(ISNULL(c.CODESLSP1, ''))) AS sales_rep,
           SUM(ISNULL(o.AMTPAYMHC, 0)) / @vat AS receipt_amount
    FROM AROBP o
    INNER JOIN ARCUS c
      ON LTRIM(RTRIM(c.IDCUST)) = LTRIM(RTRIM(o.IDCUST))
     AND c.CODECURN = o.CODECURN
    WHERE o.DATERMIT BETWEEN @from AND @to
      AND LTRIM(RTRIM(o.IDINVC)) LIKE 'PY%'
    GROUP BY LTRIM(RTRIM(ISNULL(c.CODESLSP1, '')))
  `;

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
