// Invoice Profit report — per-invoice selling, cost and profit, rolled up by
// day, ISO week and month.
//
// SOURCE (verified against live Sage, ERMDAT, 2026-08-27)
//   Invoices     OEINVH  header  — INVNUMBER, INVDATE, CUSTOMER, INVNETNOTX
//                OEINVD  lines   — EXTICOST  (extended INVOICED cost)
//   Credit notes OECRDH  header  — CRDNUMBER, CRDDATE, CUSTOMER, CRDNETNOTX
//                OECRDD  lines   — EXTCCOST  (extended CREDITED cost)
//
//   Selling is Sage's own ex-VAT document net (INVNETNOTX / CRDNETNOTX), which
//   was reconciled day-by-day against the Daily Sales Figures report's AR source
//   (ARIBH.BASETAX1) and matches to the cent on every VAT-bearing day.
//
//   Cost is the cost Sage COSTED ONTO THE DOCUMENT when it was raised — not the
//   item master's current last_cost. That makes profit historical: reprinting
//   last July's report next year gives the same numbers it gives today. Using
//   the item master instead would silently restate history every time a cost
//   changed.
//
// SIGN CONVENTION
//   Credit notes are carried as NEGATIVE selling and NEGATIVE cost, so every
//   level (day, week, month, grand total) is a plain SUM and the report's
//   selling total reconciles to Net sales rather than gross.
//
// INTER-BRANCH TRANSFERS ARE EXCLUDED
//   Sage carries stock moved between depots as ordinary zero-VAT invoices to
//   customers named 'CCD Inter Branch Transfer <BRANCH>'. They are internal
//   movements at cost (July 2026: R459,831 of "sales" at R183 of "profit"), and
//   the same stock is invoiced AGAIN when the receiving branch sells it. Left in,
//   they inflate turnover and drag the margin % down twice over. The predicate
//   matches the one Sales by Vendor already uses (SBV_EXCL_INTER_BRANCH) so the
//   two reports agree on what counts as a sale. The excluded figures are still
//   RETURNED (as `excluded`) so the report can say what it left out instead of
//   quietly dropping R460k a month.

import sql from 'mssql';
import { isoWeek, dateFromIso } from '../../lib/isoWeek.js';

// Inter-branch transfers are filtered in JS rather than in the WHERE clause for
// two reasons:
//   1. The report SAYS what it excluded, so the rows have to come back to be
//      counted rather than being dropped by the server.
//   2. This Sage database has a CASE-SENSITIVE collation. A plain
//      `NAMECUST LIKE '%INTER%BRANCH%'` matches nothing, and a lower-cased one
//      only works if every call site remembers to wrap it — during development
//      exactly that slip hid 'CCD Inter Branch Transfer WELKOM' (R234,407 in one
//      month) from an ad-hoc query. A case-insensitive regex here cannot make
//      that mistake.
// Matches the same three spellings Sales by Vendor's SBV_EXCL_INTER_BRANCH
// matches, so both reports agree on what counts as a sale.
/** @param {string | null | undefined} name */
export function isInterBranchName(name) {
  return /inter[\s-]?branch/i.test(String(name || ''));
}

// 'YYYY-MM-DD' -> 20260701, the INTEGER form every Sage date column uses.
/** @param {string} iso */
export function toSageDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) throw new Error(`Invoice Profit report: date must be YYYY-MM-DD, received ${JSON.stringify(iso)}`);
  return Number(`${m[1]}${m[2]}${m[3]}`);
}

// 20260701 -> '2026-07-01'
/** @param {number | string} n */
const fromSageDate = (n) => {
  const s = String(n);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Margin as a percentage of selling. Guarded because a day can legitimately net
// to zero selling (an invoice fully reversed by a credit note the same day) and
// x/0 would put Infinity/NaN on screen.
/** @param {number} profit @param {number} selling */
export const marginPct = (profit, selling) => (selling ? (profit / selling) * 100 : 0);

// One row per posted document, invoices and credit notes together.
// Bounded by date on BOTH sides of each union arm — the OE tables are large and
// an unbounded scan times out over the branch links.
const INVOICE_SQL = `
  SELECT
    'invoice' AS doc_type,
    LTRIM(RTRIM(h.INVNUMBER))     AS doc_number,
    h.INVDATE                     AS ymd,
    LTRIM(RTRIM(h.CUSTOMER))      AS customer_code,
    LTRIM(RTRIM(cu.NAMECUST))     AS cust_name,
    LTRIM(RTRIM(h.LOCATION))      AS location,
    LTRIM(RTRIM(h.SALESPER1))     AS sales_rep,
    h.INVNETNOTX                  AS selling,
    ISNULL(dc.cost, 0)            AS cost
  FROM OEINVH h
  LEFT JOIN ARCUS cu ON LTRIM(RTRIM(cu.IDCUST)) = LTRIM(RTRIM(h.CUSTOMER))
  LEFT JOIN (
    SELECT d.INVUNIQ, SUM(d.EXTICOST) AS cost
    FROM OEINVD d
    INNER JOIN OEINVH hh ON hh.INVUNIQ = d.INVUNIQ AND hh.INVDATE BETWEEN @from AND @to
    GROUP BY d.INVUNIQ
  ) dc ON dc.INVUNIQ = h.INVUNIQ
  WHERE h.INVDATE BETWEEN @from AND @to

  UNION ALL

  SELECT
    'credit_note',
    LTRIM(RTRIM(k.CRDNUMBER)),
    k.CRDDATE,
    LTRIM(RTRIM(k.CUSTOMER)),
    LTRIM(RTRIM(cu2.NAMECUST)),
    LTRIM(RTRIM(k.LOCATION)),
    LTRIM(RTRIM(k.SALESPER1)),
    -k.CRDNETNOTX,
    -ISNULL(kc.cost, 0)
  FROM OECRDH k
  LEFT JOIN ARCUS cu2 ON LTRIM(RTRIM(cu2.IDCUST)) = LTRIM(RTRIM(k.CUSTOMER))
  LEFT JOIN (
    SELECT d.CRDUNIQ, SUM(d.EXTCCOST) AS cost
    FROM OECRDD d
    INNER JOIN OECRDH kk ON kk.CRDUNIQ = d.CRDUNIQ AND kk.CRDDATE BETWEEN @from AND @to
    GROUP BY d.CRDUNIQ
  ) kc ON kc.CRDUNIQ = k.CRDUNIQ
  WHERE k.CRDDATE BETWEEN @from AND @to
`;

/**
 * Pull every posted invoice and credit note in the range from Sage.
 *
 * @param {{ pool: import('mssql').ConnectionPool, from: string, to: string }} args
 * @returns {Promise<{ documents: object[], excluded: { count: number, selling: number, cost: number } }>}
 */
export async function fetchProfitDocuments({ pool, from, to }) {
  const fromInt = toSageDate(from);
  const toInt = toSageDate(to);
  if (fromInt > toInt) {
    throw new Error(`Invoice Profit report: the "from" date (${from}) is after the "to" date (${to}) — swap them and try again.`);
  }

  const result = await pool.request()
    .input('from', sql.Int, fromInt)
    .input('to', sql.Int, toInt)
    .query(`SELECT * FROM (${INVOICE_SQL}) q ORDER BY q.ymd, q.doc_number`);

  const documents = [];
  const excluded = { count: 0, selling: 0, cost: 0 };

  for (const r of result.recordset) {
    const selling = num(r.selling);
    const cost = num(r.cost);
    if (isInterBranchName(r.cust_name)) {
      excluded.count += 1;
      excluded.selling += selling;
      excluded.cost += cost;
      continue;
    }
    const profit = selling - cost;
    documents.push({
      doc_type: r.doc_type,
      doc_number: r.doc_number || '',
      date: fromSageDate(r.ymd),
      customer_code: r.customer_code || '',
      customer_name: r.cust_name || '',
      location: r.location || '',
      sales_rep: r.sales_rep || '',
      selling,
      cost,
      profit,
      margin: marginPct(profit, selling),
    });
  }

  return { documents, excluded };
}

// Running accumulator shared by every level of the tree.
const emptyTotals = () => ({ selling: 0, cost: 0, profit: 0, invoice_count: 0, credit_note_count: 0 });
const addDoc = (t, d) => {
  t.selling += d.selling;
  t.cost += d.cost;
  t.profit += d.profit;
  if (d.doc_type === 'credit_note') t.credit_note_count += 1; else t.invoice_count += 1;
};
const sealTotals = (t) => ({ ...t, margin: marginPct(t.profit, t.selling) });

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (ym) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const dayLabel = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-ZA', { weekday: 'short', day: '2-digit', month: 'short' });

/**
 * Nest flat documents into Month -> ISO Week -> Day -> documents, with selling,
 * cost, profit, margin and document counts at every level.
 *
 * ISO WEEKS STRADDLE MONTHS. A week that starts in one month and ends in the
 * next is emitted under BOTH months, each carrying only the days that fall in
 * that month, and flagged `partial: true` with the portion of the week covered.
 * That keeps the arithmetic honest — every level is exactly the sum of the
 * level below it, and a month total is never inflated by days outside it. The UI
 * labels partial weeks so nobody reads one as a full trading week.
 *
 * @param {object[]} documents
 */
export function buildProfitTree(documents) {
  /** @type {Map<string, any>} */
  const months = new Map();

  for (const d of documents) {
    const ym = d.date.slice(0, 7);
    const { year: isoYr, week: isoWk } = isoWeek(d.date);
    const weekKey = `${isoYr}-W${String(isoWk).padStart(2, '0')}`;

    let month = months.get(ym);
    if (!month) {
      month = { month: ym, label: monthLabel(ym), weeks: new Map(), totals: emptyTotals() };
      months.set(ym, month);
    }
    let week = month.weeks.get(weekKey);
    if (!week) {
      week = { key: weekKey, iso_year: isoYr, iso_week: isoWk, days: new Map(), totals: emptyTotals() };
      month.weeks.set(weekKey, week);
    }
    let day = week.days.get(d.date);
    if (!day) {
      day = { day: d.date, label: dayLabel(d.date), documents: [], totals: emptyTotals() };
      week.days.set(d.date, day);
    }

    day.documents.push(d);
    addDoc(day.totals, d);
    addDoc(week.totals, d);
    addDoc(month.totals, d);
  }

  const isoDay = (dt) => dt.toISOString().slice(0, 10);

  return [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({
      month: m.month,
      label: m.label,
      totals: sealTotals(m.totals),
      weeks: [...m.weeks.values()]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((w) => {
          // Calendar span of the whole ISO week vs the part of it inside this
          // month — that difference is what makes a week "partial".
          const weekStart = isoDay(dateFromIso(w.iso_year, w.iso_week, 1));
          const weekEnd = isoDay(dateFromIso(w.iso_year, w.iso_week, 7));
          const days = [...w.days.values()].sort((a, b) => a.day.localeCompare(b.day));
          const partial = weekStart.slice(0, 7) !== weekEnd.slice(0, 7);
          return {
            key: w.key,
            iso_year: w.iso_year,
            iso_week: w.iso_week,
            label: `Week ${w.iso_week}`,
            week_start: weekStart,
            week_end: weekEnd,
            // True when the ISO week spans a month boundary, so this block holds
            // only the part of it that belongs to `m.month`.
            partial,
            totals: sealTotals(w.totals),
            days: days.map((dd) => ({
              day: dd.day,
              label: dd.label,
              totals: sealTotals(dd.totals),
              documents: dd.documents,
            })),
          };
        }),
    }));
}

/**
 * Grand totals plus the "to date" figures the report header shows: the latest
 * trading day in the range, and the week and month that day belongs to.
 *
 * Anchored on the LAST DAY WITH ACTIVITY rather than on today's date, so the
 * strip still reads correctly on a Sunday, over a public holiday, or when the
 * range ends in the past.
 *
 * @param {object[]} documents
 */
export function summariseProfit(documents) {
  const grand = emptyTotals();
  for (const d of documents) addDoc(grand, d);

  const days = [...new Set(documents.map((d) => d.date))].sort();
  const latest = days[days.length - 1] || null;

  const scoped = (predicate) => {
    const t = emptyTotals();
    for (const d of documents) if (predicate(d)) addDoc(t, d);
    return sealTotals(t);
  };

  if (!latest) {
    return { totals: sealTotals(grand), latest_day: null, day_to_date: null, week_to_date: null, month_to_date: null };
  }

  const { year: ly, week: lw } = isoWeek(latest);
  return {
    totals: sealTotals(grand),
    latest_day: latest,
    day_to_date: scoped((d) => d.date === latest),
    // Week/month to date = everything in that week/month UP TO the latest day,
    // never the whole week (which would count days the range doesn't cover).
    week_to_date: scoped((d) => {
      const w = isoWeek(d.date);
      return w.year === ly && w.week === lw && d.date <= latest;
    }),
    month_to_date: scoped((d) => d.date.slice(0, 7) === latest.slice(0, 7) && d.date <= latest),
  };
}

/**
 * Full report payload — the ONE builder both the site route and (once the hub
 * rollup lands) the hub route call, so the two can never compute different
 * numbers for the same day.
 *
 * @param {{ pool: import('mssql').ConnectionPool, from: string, to: string }} args
 */
export async function buildProfitReport({ pool, from, to }) {
  const { documents, excluded } = await fetchProfitDocuments({ pool, from, to });
  const summary = summariseProfit(documents);
  return {
    from,
    to,
    months: buildProfitTree(documents),
    ...summary,
    document_count: documents.length,
    excluded: {
      ...excluded,
      profit: excluded.selling - excluded.cost,
      reason: 'Inter-branch depot transfers — internal stock movements, not sales.',
    },
  };
}
