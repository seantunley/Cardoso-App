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
           sales_query_override, receipts_query_override, unpaid_query_override,
           updated_at, updated_by_user_id
    FROM commission_settings WHERE id = 1
  `).get();
  // Migration v81 seeds this row; if it's somehow missing, fall back to
  // the spreadsheet defaults instead of returning nulls that the UI
  // would render as NaN%.
  if (!row) {
    return {
      sweets_rate: 0.015, cigtob_rate: 0.0017, reference_rate: 0.01, vat_rate: 0.14,
      sales_query_override: null, receipts_query_override: null, unpaid_query_override: null,
      updated_at: null, updated_by_user_id: null,
    };
  }
  return row;
}

export function updateCommissionSettings({
  sweets_rate, cigtob_rate, reference_rate, vat_rate,
  sales_query_override, receipts_query_override, unpaid_query_override,
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
  if (unpaid_query_override !== undefined) {
    sets.push('unpaid_query_override = ?');
    args.push(unpaid_query_override && String(unpaid_query_override).trim().length > 0 ? String(unpaid_query_override) : null);
  }
  if (sets.length === 0) return getCommissionSettings();

  sets.push('updated_at = now_local()');
  sets.push('updated_by_user_id = ?');
  args.push(userId ?? null);
  db.prepare(`UPDATE commission_settings SET ${sets.join(', ')} WHERE id = 1`).run(...args);
  return getCommissionSettings();
}

// --- Default Sage SQL (exported for the Settings UI's "view default" view) ---
//
// All three queries take named @-params:
//   @from, @to  — YYYYMMDD ints, inclusive
//   @vat        — 1 + vat_rate, used as the divisor (receipts only)
// Override SQL MUST keep these param names or the runtime bind step
// will fail.
//
// Sales SQL counts every sweets invoice in the period regardless of
// payment status — sweets commission is earned when the invoice is
// raised, not when the customer pays. The separate unpaid-invoices
// query below is informational only (a tracking report alongside the
// commission totals, not a filter on them).

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

// Per-invoice list of sweets invoices in the period that haven't been
// fully paid (AROBL.SWPAID = 0). Informational tracking report shown
// alongside the commission totals — NOT a filter on them. The
// commission report counts every sweets invoice in the period; this
// list just surfaces which of those are still outstanding from AR.
export const DEFAULT_COMMISSION_UNPAID_SQL = `
SELECT LTRIM(RTRIM(ISNULL(OESHDT.SALESPER, ''))) AS sales_rep,
       LTRIM(RTRIM(OESHDT.TRANNUM))              AS invoice_number,
       LTRIM(RTRIM(OESHDT.CUSTOMER))             AS customer_code,
       LTRIM(RTRIM(ISNULL(cu.NAMECUST, '')))     AS customer_name,
       MIN(OESHDT.TRANDATE)                      AS invoice_date,
       MAX(ar.AMTINVCHC)                         AS original_amount,
       MAX(ar.AMTDUEHC)                          AS outstanding_amount,
       SUM(ISNULL(OESHDT.FAMTSALES, 0))
         - SUM(ISNULL(OESHDT.FRETSALES, 0))      AS net_sweet_amount
FROM OESHDT
INNER JOIN ICITMV ON OESHDT.ITEM = ICITMV.ITEMNO
INNER JOIN ICITEM ON OESHDT.ITEM = ICITEM.ITEMNO
INNER JOIN AROBL ar
  ON LTRIM(RTRIM(ar.IDINVC))  = LTRIM(RTRIM(OESHDT.TRANNUM))
 AND LTRIM(RTRIM(ar.IDCUST)) = LTRIM(RTRIM(OESHDT.CUSTOMER))
LEFT JOIN ARCUS cu
  ON LTRIM(RTRIM(cu.IDCUST)) = LTRIM(RTRIM(OESHDT.CUSTOMER))
WHERE OESHDT.TRANDATE BETWEEN @from AND @to
  AND LTRIM(RTRIM(ICITEM.COMMODIM)) = '1'
  AND ar.SWPAID = 0
GROUP BY LTRIM(RTRIM(ISNULL(OESHDT.SALESPER, ''))),
         LTRIM(RTRIM(OESHDT.TRANNUM)),
         LTRIM(RTRIM(OESHDT.CUSTOMER)),
         LTRIM(RTRIM(ISNULL(cu.NAMECUST, '')))
ORDER BY sales_rep, MIN(OESHDT.TRANDATE), invoice_number
`.trim();

// Compute the previous commission period for clawback lookup. The
// period_year/month uses the END month convention (commissionPeriodForRun).
function previousPeriodOf(year, month) {
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear  = month === 1 ? year - 1 : year;
  const pad = (n) => String(n).padStart(2, '0');
  return {
    year: prevYear, month: prevMonth,
    fromDate: `${prevMonth === 1 ? prevYear - 1 : prevYear}-${pad(prevMonth === 1 ? 12 : prevMonth - 1)}-24`,
    toDate:   `${prevYear}-${pad(prevMonth)}-23`,
  };
}

// Identify the canonical commission period that the given to-date falls
// within. The 24th-23rd cycle: a to-date of 2026-03-23 → period (2026, 3);
// 2026-03-24 → period (2026, 4); 2026-03-15 → period (2026, 3).
function periodContaining(yyyymmdd) {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  if (d >= 24) return { year: m === 12 ? y + 1 : y, month: m === 12 ? 1 : m + 1 };
  return { year: y, month: m };
}

// Recheck Sage for the snapshot of invoices from the previous period.
// Returns a per-rep clawback bucket — only invoices still showing
// SWPAID = 0 in AROBL today are included.
async function buildClawbackForPreviousPeriod(toDate) {
  const currentPeriod = periodContaining(toDate);
  const prev = previousPeriodOf(currentPeriod.year, currentPeriod.month);

  const snapshotRows = db.prepare(`
    SELECT sales_rep, invoice_number, customer_code, customer_name, invoice_date,
           net_sweet_amount, outstanding_amount,
           sweets_rate_at_paid, reference_rate_at_paid,
           sweet_commission_at_paid, reference_commission_at_paid
    FROM commission_unpaid_snapshot
    WHERE period_year = ? AND period_month = ?
    ORDER BY sales_rep, invoice_date, invoice_number
  `).all(prev.year, prev.month);

  if (snapshotRows.length === 0) {
    return { previous_period: { ...prev, invoices_in_snapshot: 0 }, clawback: [], totals: emptyClawbackTotals() };
  }

  // Recheck AROBL — for each invoice number, is it still unpaid (SWPAID=0)?
  // Batch into chunks so the IN clause stays comfortable in SQL Server.
  const stillUnpaid = new Set();
  const all = snapshotRows.map((r) => r.invoice_number).filter(Boolean);
  const CHUNK = 500;
  try {
    for (let i = 0; i < all.length; i += CHUNK) {
      const slice = all.slice(i, i + CHUNK);
      const placeholders = slice.map((_, idx) => `@inv${idx}`).join(',');
      const sqlText = `
        SELECT LTRIM(RTRIM(IDINVC)) AS invoice_number, SWPAID
        FROM AROBL
        WHERE LTRIM(RTRIM(IDINVC)) IN (${placeholders})
      `;
      const params = Object.fromEntries(slice.map((inv, idx) => [`inv${idx}`, inv]));
      const result = await runCustomerSqlQuery(sqlText, params);
      for (const row of (result.recordset || [])) {
        if (row.SWPAID === 0 || row.SWPAID === false) {
          stillUnpaid.add(String(row.invoice_number).trim());
        }
      }
    }
  } catch (err) {
    // Sage unreachable / permission issue — clawback can't be computed
    // safely, surface as warning so the rest of the report still ships.
    logError('commission.clawback.sage_recheck', err, { period: prev }, 'warn');
    return { previous_period: { ...prev, invoices_in_snapshot: snapshotRows.length, error: 'Sage recheck failed' }, clawback: [], totals: emptyClawbackTotals() };
  }

  // Bucket the still-unpaid rows by rep.
  const byRep = new Map();
  for (const row of snapshotRows) {
    if (!stillUnpaid.has(String(row.invoice_number).trim())) continue;
    const key = String(row.sales_rep || '').trim() || 'Unknown';
    if (!byRep.has(key)) byRep.set(key, []);
    // Floor clawback at zero. A return / credit-note invoice has negative net
    // sweets, so the commission "paid" on it was negative (it REDUCED the
    // rep's payout in the prior period). Clawing a negative back would CREDIT
    // the rep — wrong. There's nothing to reclaim on such invoices, so they
    // contribute zero clawback (the row is still listed for visibility).
    byRep.get(key).push({
      invoice_number: row.invoice_number,
      customer_code: row.customer_code,
      customer_name: row.customer_name,
      invoice_date: row.invoice_date,
      net_sweet_amount: Number(row.net_sweet_amount) || 0,
      outstanding_amount: Number(row.outstanding_amount) || 0,
      sweets_rate_at_paid: Number(row.sweets_rate_at_paid) || 0,
      reference_rate_at_paid: Number(row.reference_rate_at_paid) || 0,
      sweet_commission_clawback: Math.max(0, Number(row.sweet_commission_at_paid) || 0),
      reference_commission_clawback: Math.max(0, Number(row.reference_commission_at_paid) || 0),
    });
  }

  const clawback = [...byRep.entries()]
    .map(([sales_rep, invoices]) => {
      const total_sweet_commission_clawback = invoices.reduce((s, i) => s + i.sweet_commission_clawback, 0);
      const total_reference_commission_clawback = invoices.reduce((s, i) => s + i.reference_commission_clawback, 0);
      const total_outstanding = invoices.reduce((s, i) => s + i.outstanding_amount, 0);
      return {
        sales_rep,
        invoice_count: invoices.length,
        total_outstanding,
        total_sweet_commission_clawback,
        total_reference_commission_clawback,
        invoices,
      };
    })
    .sort((a, b) => {
      const na = Number(a.sales_rep), nb = Number(b.sales_rep);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      if (Number.isFinite(na)) return -1;
      if (Number.isFinite(nb)) return 1;
      return a.sales_rep.localeCompare(b.sales_rep);
    });

  const totals = clawback.reduce((acc, r) => {
    acc.invoice_count += r.invoice_count;
    acc.total_outstanding += r.total_outstanding;
    acc.total_sweet_commission_clawback += r.total_sweet_commission_clawback;
    acc.total_reference_commission_clawback += r.total_reference_commission_clawback;
    return acc;
  }, emptyClawbackTotals());

  return {
    previous_period: { ...prev, invoices_in_snapshot: snapshotRows.length },
    clawback,
    totals,
  };
}

function emptyClawbackTotals() {
  return {
    invoice_count: 0,
    total_outstanding: 0,
    total_sweet_commission_clawback: 0,
    total_reference_commission_clawback: 0,
  };
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

  // Use admin-supplied SQL overrides when present, otherwise the bundled
  // defaults. All three queries take @from, @to, @vat — overrides MUST
  // keep those param names or the bind step throws (validated at save).
  const vatDivisor = 1 + (Number.isFinite(settings.vat_rate) ? settings.vat_rate : 0.14);
  const salesAndCreditsSql = (settings.sales_query_override || '').trim().length > 0
    ? settings.sales_query_override
    : DEFAULT_COMMISSION_SALES_SQL;
  const receiptsSql = (settings.receipts_query_override || '').trim().length > 0
    ? settings.receipts_query_override
    : DEFAULT_COMMISSION_RECEIPTS_SQL;
  const unpaidSql = (settings.unpaid_query_override || '').trim().length > 0
    ? settings.unpaid_query_override
    : DEFAULT_COMMISSION_UNPAID_SQL;

  const params = { from: fromInt, to: toInt, vat: vatDivisor };

  let salesCreditRows = [], receiptRows = [], unpaidRows = [];
  try {
    const [sc, r, up] = await Promise.all([
      runCustomerSqlQuery(salesAndCreditsSql, params),
      runCustomerSqlQuery(receiptsSql, params),
      runCustomerSqlQuery(unpaidSql, params).catch((err) => {
        // Unpaid is informational only — a failure here shouldn't kill
        // the commission report. Log it and continue with [].
        logError('commission.report.unpaid', err, { from, to }, 'warn');
        return { recordset: [] };
      }),
    ]);
    salesCreditRows = sc.recordset || [];
    receiptRows = r.recordset || [];
    unpaidRows = up.recordset || [];
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

  // Shape the per-invoice unpaid list, bucketed by sales rep so the UI
  // can render one collapsible per rep. Also compute a hypothetical
  // commission per rep (what they'd earn if every unpaid invoice in
  // their bucket cleared today) — useful "in-flight" view.
  const unpaidByRep = new Map();
  for (const row of unpaidRows) {
    const key = String(row.sales_rep || '').trim() || 'Unknown';
    if (!unpaidByRep.has(key)) unpaidByRep.set(key, []);
    unpaidByRep.get(key).push({
      invoice_number: String(row.invoice_number || '').trim(),
      customer_code: String(row.customer_code || '').trim(),
      customer_name: String(row.customer_name || '').trim() || null,
      invoice_date: row.invoice_date != null ? String(row.invoice_date) : null,
      original_amount: Number(row.original_amount) || 0,
      outstanding_amount: Number(row.outstanding_amount) || 0,
      net_sweet_amount: Number(row.net_sweet_amount) || 0,
    });
  }
  const unpaid_invoices = [...unpaidByRep.entries()]
    .map(([sales_rep, invoices]) => {
      const total_net_sweets = invoices.reduce((s, i) => s + (i.net_sweet_amount || 0), 0);
      const total_outstanding = invoices.reduce((s, i) => s + (i.outstanding_amount || 0), 0);
      return {
        sales_rep,
        invoice_count: invoices.length,
        total_net_sweets,
        total_outstanding,
        // Slice of the rep's commission (Sweets + Reference) attributable
        // to these still-unpaid invoices. The commission itself has
        // already been counted in the headline table — this is purely
        // a "what's tied up in AR" view for follow-up purposes.
        at_risk_sweet_commission: total_net_sweets * settings.sweets_rate,
        at_risk_reference_commission: total_net_sweets * settings.reference_rate,
        invoices,
      };
    })
    .sort((a, b) => {
      const na = Number(a.sales_rep), nb = Number(b.sales_rep);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      if (Number.isFinite(na)) return -1;
      if (Number.isFinite(nb)) return 1;
      return a.sales_rep.localeCompare(b.sales_rep);
    });
  const unpaid_totals = unpaid_invoices.reduce((acc, r) => {
    acc.invoice_count += r.invoice_count;
    acc.total_net_sweets += r.total_net_sweets;
    acc.total_outstanding += r.total_outstanding;
    acc.at_risk_sweet_commission += r.at_risk_sweet_commission;
    acc.at_risk_reference_commission += r.at_risk_reference_commission;
    return acc;
  }, {
    invoice_count: 0, total_net_sweets: 0, total_outstanding: 0,
    at_risk_sweet_commission: 0, at_risk_reference_commission: 0,
  });

  // Clawback from the previous period — re-check Sage for the snapshot
  // of unpaid invoices that were tracked at end of period N-1. Anything
  // still unpaid today contributes to a clawback liability for the rep.
  // Result is informational — the headline totals above are unchanged
  // (per design: operator deducts manually when paying out).
  let clawbackResult;
  try {
    clawbackResult = await buildClawbackForPreviousPeriod(to);
  } catch (err) {
    logError('commission.report.clawback', err, { from, to }, 'warn');
    clawbackResult = { previous_period: null, clawback: [], totals: emptyClawbackTotals() };
  }

  return {
    from, to, settings, reps, totals,
    unpaid_invoices, unpaid_totals,
    clawback: clawbackResult.clawback,
    clawback_totals: clawbackResult.totals,
    clawback_previous_period: clawbackResult.previous_period,
  };
}
