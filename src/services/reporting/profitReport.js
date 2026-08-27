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
    CAST(h.INVUNIQ AS varchar(32)) AS doc_uniq,
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
    CAST(k.CRDUNIQ AS varchar(32)),
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
      doc_uniq: r.doc_uniq,
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

/**
 * The lines behind ONE document — the drill-down under an invoice row.
 *
 * Line selling is qty x unit price LESS the line discount, which is how Sage
 * arrives at the header net. Verified over all 2,498 July 2026 documents:
 * 2,495 tie to the header exactly; 3 differ (R287 in total) because they carry a
 * document-level charge or discount that belongs to no single line. Those are
 * NOT hidden — `adjustment` carries the difference so the drill-down always adds
 * up to the invoice row above it. A detail view that doesn't reconcile to its
 * own header is worse than no detail view.
 *
 *   Invoices     OEINVD  QTYSHIPPED x UNITPRICE - INVDISC  /  EXTICOST
 *   Credit notes OECRDD  QTYRETURN  x UNITPRICE - CRDDISC  /  EXTCCOST  (negated)
 *
 * @param {{ pool: import('mssql').ConnectionPool, type: 'invoice'|'credit_note', uniq: string }} args
 */
export async function fetchDocumentLines({ pool, type, uniq }) {
  if (type !== 'invoice' && type !== 'credit_note') {
    throw new Error(`Invoice Profit detail: unknown document type ${JSON.stringify(type)} — expected 'invoice' or 'credit_note'.`);
  }
  if (!/^\d{1,32}$/.test(String(uniq || ''))) {
    throw new Error(`Invoice Profit detail: document id must be numeric, received ${JSON.stringify(uniq)}.`);
  }

  const isInvoice = type === 'invoice';
  // Credit notes are negated to match the sign convention used everywhere else
  // in this report, so a drill-down's numbers agree with the row that opened it.
  const linesSql = isInvoice
    ? `SELECT d.LINENUM AS line_no, LTRIM(RTRIM(d.ITEM)) AS item, LTRIM(RTRIM(d."DESC")) AS description,
              d.QTYSHIPPED AS qty, LTRIM(RTRIM(d.INVUNIT)) AS uom, d.UNITPRICE AS unit_price,
              d.INVDISC AS discount,
              (d.QTYSHIPPED * d.UNITPRICE) - d.INVDISC AS selling,
              d.EXTICOST AS cost
       FROM OEINVD d WHERE d.INVUNIQ = @uniq ORDER BY d.LINENUM`
    : `SELECT d.LINENUM AS line_no, LTRIM(RTRIM(d.ITEM)) AS item, LTRIM(RTRIM(d."DESC")) AS description,
              -d.QTYRETURN AS qty, '' AS uom, d.UNITPRICE AS unit_price,
              -d.CRDDISC AS discount,
              -((d.QTYRETURN * d.UNITPRICE) - d.CRDDISC) AS selling,
              -d.EXTCCOST AS cost
       FROM OECRDD d WHERE d.CRDUNIQ = @uniq ORDER BY d.LINENUM`;

  const headerSql = isInvoice
    ? `SELECT LTRIM(RTRIM(h.INVNUMBER)) AS doc_number, h.INVDATE AS ymd,
              LTRIM(RTRIM(h.CUSTOMER)) AS customer_code, LTRIM(RTRIM(cu.NAMECUST)) AS customer_name,
              h.INVNETNOTX AS selling
       FROM OEINVH h LEFT JOIN ARCUS cu ON LTRIM(RTRIM(cu.IDCUST)) = LTRIM(RTRIM(h.CUSTOMER))
       WHERE h.INVUNIQ = @uniq`
    : `SELECT LTRIM(RTRIM(k.CRDNUMBER)) AS doc_number, k.CRDDATE AS ymd,
              LTRIM(RTRIM(k.CUSTOMER)) AS customer_code, LTRIM(RTRIM(cu.NAMECUST)) AS customer_name,
              -k.CRDNETNOTX AS selling
       FROM OECRDH k LEFT JOIN ARCUS cu ON LTRIM(RTRIM(cu.IDCUST)) = LTRIM(RTRIM(k.CUSTOMER))
       WHERE k.CRDUNIQ = @uniq`;

  const req = () => pool.request().input('uniq', sql.VarChar(32), String(uniq));
  const [headerRs, linesRs] = await Promise.all([req().query(headerSql), req().query(linesSql)]);

  const header = headerRs.recordset[0];
  if (!header) {
    throw new Error(`Invoice Profit detail: no ${isInvoice ? 'invoice' : 'credit note'} found in Sage with id ${uniq}. It may have been deleted since the report was built — reload the report.`);
  }

  const lines = linesRs.recordset.map((r) => {
    const selling = num(r.selling);
    const cost = num(r.cost);
    const profit = selling - cost;
    return {
      line_no: num(r.line_no),
      item: r.item || '',
      description: r.description || '',
      qty: num(r.qty),
      uom: (r.uom || '').trim(),
      unit_price: num(r.unit_price),
      discount: num(r.discount),
      selling,
      cost,
      profit,
      margin: marginPct(profit, selling),
    };
  });

  const lineSelling = lines.reduce((a, l) => a + l.selling, 0);
  const headerSelling = num(header.selling);
  const diff = headerSelling - lineSelling;

  return {
    doc_type: type,
    doc_uniq: String(uniq),
    doc_number: header.doc_number || '',
    date: fromSageDate(header.ymd),
    customer_code: header.customer_code || '',
    customer_name: header.customer_name || '',
    lines,
    // Non-null only when the lines don't account for the whole document — a
    // header-level charge or discount. Shown as its own row so the detail always
    // reconciles to the invoice row it opened from.
    adjustment: Math.abs(diff) > 0.02 ? diff : null,
    // Totals come from the HEADER selling and the summed line cost — the same
    // two numbers the report's own invoice row uses, so the drill-down can never
    // disagree with the row that opened it.
    totals: (() => {
      const cost = lines.reduce((a, l) => a + l.cost, 0);
      return {
        selling: headerSelling,
        cost,
        profit: headerSelling - cost,
        margin: marginPct(headerSelling - cost, headerSelling),
        line_count: lines.length,
      };
    })(),
  };
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

// Last calendar day of a 'YYYY-MM'.
const monthEnd = (ym) => {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (ym) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const dayLabel = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-ZA', { weekday: 'short', day: '2-digit', month: 'short' });

// Every 'YYYY-MM' from `from` to `to` inclusive.
const monthsBetween = (from, to) => {
  const out = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const ty = Number(to.slice(0, 4));
  const tm = Number(to.slice(5, 7));
  while ((y < ty || (y === ty && m <= tm)) && out.length < 600) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
};

/**
 * Nest flat documents into Month -> ISO Week -> Day -> documents, with selling,
 * cost, profit, margin and document counts at every level.
 *
 * PARTIAL PERIODS. A month or week block can hold less than its whole calendar
 * span for two reasons, and both must be visible or the totals read as more than
 * they are:
 *   - an ISO week straddling a month boundary is emitted under BOTH months, each
 *     carrying only its own month's days;
 *   - the requested range starts or ends mid-period, so a Thursday-to-Friday
 *     range covers two days of a seven-day week.
 * Either way the block is flagged `partial`, with `covered_start`/`covered_end`
 * saying what it actually spans. Without the second case a Thu-Fri range showed
 * a full Mon-Sun span with no marker, which reads as a complete trading week.
 *
 * ZERO-ACTIVITY MONTHS are materialised when the caller passes the range, so a
 * January-March report with no February trade shows February at R0 rather than
 * omitting it — a month that sold nothing is a fact about the range, and leaving
 * it out also skewed the monthly average in rangeStats().
 *
 * @param {object[]} documents
 * @param {{ from?: string, to?: string }} [range]
 */
export function buildProfitTree(documents, range = {}) {
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
  const { from, to } = range;

  // Materialise every month the caller asked for, so a month with no trade is
  // shown at zero rather than silently missing. Only when documents exist at
  // all — an empty result must stay empty so the UI shows its "no invoices"
  // state instead of a page of zeroes.
  if (from && to && months.size > 0) {
    for (const ym of monthsBetween(from.slice(0, 7), to.slice(0, 7))) {
      if (!months.has(ym)) months.set(ym, { month: ym, label: monthLabel(ym), weeks: new Map(), totals: emptyTotals() });
    }
  }

  return [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => {
      const monthStart = `${m.month}-01`;
      const monthEndDay = monthEnd(m.month);
      // What of this month the range actually covers.
      const mCovStart = from && from > monthStart ? from : monthStart;
      const mCovEnd = to && to < monthEndDay ? to : monthEndDay;
      return {
        month: m.month,
        label: m.label,
        month_start: monthStart,
        month_end: monthEndDay,
        covered_start: mCovStart,
        covered_end: mCovEnd,
        // True when the range clips this month — the totals are for part of it.
        partial: mCovStart !== monthStart || mCovEnd !== monthEndDay,
        totals: sealTotals(m.totals),
        weeks: [...m.weeks.values()]
          .sort((a, b) => a.key.localeCompare(b.key))
          .map((w) => {
            const weekStart = isoDay(dateFromIso(w.iso_year, w.iso_week, 1));
            const weekEnd = isoDay(dateFromIso(w.iso_year, w.iso_week, 7));
            const days = [...w.days.values()].sort((a, b) => a.day.localeCompare(b.day));
            // The week's span narrowed by BOTH the month it sits under and the
            // requested range — either can clip it, and both make it partial.
            let covStart = weekStart > mCovStart ? weekStart : mCovStart;
            let covEnd = weekEnd < mCovEnd ? weekEnd : mCovEnd;
            if (covStart > covEnd) { covStart = weekStart; covEnd = weekEnd; }
            return {
              key: w.key,
              iso_year: w.iso_year,
              iso_week: w.iso_week,
              label: `Week ${w.iso_week}`,
              week_start: weekStart,
              week_end: weekEnd,
              covered_start: covStart,
              covered_end: covEnd,
              // True when this block holds less than the whole ISO week: it
              // straddles a month boundary, or the range clips it, or both.
              partial: covStart !== weekStart || covEnd !== weekEnd,
              totals: sealTotals(w.totals),
              days: days.map((dd) => ({
                day: dd.day,
                label: dd.label,
                totals: sealTotals(dd.totals),
                documents: dd.documents,
              })),
            };
          }),
      };
    });
}

/**
 * Grand totals plus the "to date" figures the report header shows: the latest
 * trading day in the range, and the week and month that day belongs to.
 *
 * Anchored on the LAST DAY WITH ACTIVITY rather than on today's date, so the
 * strip still reads correctly on a Sunday, over a public holiday, or when the
 * range ends in the past.
 *
 * The week and month figures are only genuinely "to date" when the range reaches
 * back to the start of that week/month. Ask for 20-27 August and the month card
 * would otherwise call eight days' trade "month to date", hiding 1-19 August
 * behind a label that claims completeness. When the range clips the period, the
 * figure is still returned but flagged `complete: false`, and the UI relabels it
 * as range-scoped instead of pretending.
 *
 * @param {object[]} documents
 * @param {{ from?: string, to?: string }} [range]
 */
export function summariseProfit(documents, range = {}) {
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
  const from = range.from || null;
  // Start of the anchor week / month. If the requested range begins after
  // either, the matching card covers only part of the period it names.
  const weekStart = dateFromIso(ly, lw, 1).toISOString().slice(0, 10);
  const monthStart = `${latest.slice(0, 7)}-01`;
  const weekComplete = !from || from <= weekStart;
  const monthComplete = !from || from <= monthStart;
  return {
    totals: sealTotals(grand),
    latest_day: latest,
    day_to_date: scoped((d) => d.date === latest),
    // Week/month to date = everything in that week/month UP TO the latest day,
    // never the whole week (which would count days the range doesn't cover).
    week_to_date: {
      ...scoped((d) => {
        const w = isoWeek(d.date);
        return w.year === ly && w.week === lw && d.date <= latest;
      }),
      complete: weekComplete,
      covered_from: weekComplete ? weekStart : from,
    },
    month_to_date: {
      ...scoped((d) => d.date.slice(0, 7) === latest.slice(0, 7) && d.date <= latest),
      complete: monthComplete,
      covered_from: monthComplete ? monthStart : from,
    },
  };
}

/**
 * Narrow the report to the invoices worth looking at — the loss-makers, or a
 * profit/margin band ("everything that made R5 or less").
 *
 * CREDIT NOTES ARE DROPPED WHENEVER A FILTER IS ACTIVE. Every credit note has
 * negative profit by construction — it reverses a sale that carried a margin —
 * so a plain "profit <= 0" would return all 461 of July's credit notes and bury
 * the handful of genuinely loss-making invoices underneath them. A returned sale
 * is not a sale that failed to make money. The UI says this on screen when a
 * filter is on, so nobody has to infer it from a document count.
 *
 * Bounds are INCLUSIVE, and `unit` chooses what they measure:
 *   'rand' → the invoice's profit in rand
 *   'pct'  → its margin percentage
 *
 * @param {object[]} documents
 * @param {{ losses?: boolean, min?: number|null, max?: number|null, unit?: 'rand'|'pct' }} filters
 */
export function filterDocuments(documents, filters = {}) {
  const { losses = false, min = null, max = null, unit = 'rand' } = filters;
  const hasMin = Number.isFinite(min);
  const hasMax = Number.isFinite(max);
  if (!losses && !hasMin && !hasMax) return documents;

  return documents.filter((d) => {
    if (d.doc_type !== 'invoice') return false;
    // "Didn't make a profit" includes breaking exactly even — an invoice that
    // returned its cost and nothing more is not a profitable one.
    if (losses) return d.profit <= 0;
    const value = unit === 'pct' ? d.margin : d.profit;
    if (hasMin && value < min) return false;
    if (hasMax && value > max) return false;
    return true;
  });
}

/** Human-readable description of an active filter, shown on screen and in exports. */
export function describeFilter({ losses = false, min = null, max = null, unit = 'rand' } = {}) {
  const hasMin = Number.isFinite(min);
  const hasMax = Number.isFinite(max);
  if (losses) return 'Invoices that made no profit (R0 or less)';
  if (!hasMin && !hasMax) return null;
  const fmt = (v) => (unit === 'pct' ? `${v}%` : `R${v}`);
  if (hasMin && hasMax) return `Invoices with a profit between ${fmt(min)} and ${fmt(max)}`;
  if (hasMax) return `Invoices that made ${fmt(max)} or less`;
  return `Invoices that made ${fmt(min)} or more`;
}

// Period buckets the hub presents. The hub stores DAYS ONLY and derives the
// other three, so a rollup can never disagree with the days it is made of.
export const PERIOD_TYPES = ['day', 'week', 'month', 'year'];

// Inter-branch exclusion, in SQL this time. LOWER() is not optional: this Sage
// database has a CASE-SENSITIVE collation, so an unwrapped LIKE '%Inter Branch%'
// silently matches only one spelling. Same three spellings as
// isInterBranchName() above, which is what the per-invoice path uses.
// ISNULL is not decoration. These run under `WHERE NOT (...)`, and in SQL a
// LIKE against NULL is UNKNOWN, so NOT(UNKNOWN) is UNKNOWN and the row is
// DROPPED. A document whose customer has no ARCUS row (or a null name) would
// therefore vanish from the hub totals while the per-invoice report kept it —
// isInterBranchName(null) is false — and the hub would quietly disagree with the
// branch. Coalescing to '' makes the predicate false instead of unknown, so the
// document is kept, matching the per-invoice path exactly.
const IB_SQL = (alias) => `(
  LOWER(ISNULL(${alias}.NAMECUST, '')) LIKE '%inter branch%' OR
  LOWER(ISNULL(${alias}.NAMECUST, '')) LIKE '%inter-branch%' OR
  LOWER(ISNULL(${alias}.NAMECUST, '')) LIKE '%interbranch%'
)`;

/**
 * Profit totals BY DAY, aggregated in SQL.
 *
 * The per-invoice path (fetchProfitDocuments) pulls ~45,000 rows for two years
 * and builds an object per document — fine for a month on screen, far too heavy
 * for the hub's two-year window. These four grouped queries return ~830 rows for
 * the same period and were checked against the document path for July 2026:
 * selling, cost and profit match to the cent.
 *
 * @param {{ pool: import('mssql').ConnectionPool, from: string, to: string }} args
 * @returns {Promise<Array<{ day: string, selling: number, cost: number, profit: number,
 *                           invoice_count: number, credit_note_count: number }>>}
 */
export async function fetchProfitDayTotals({ pool, from, to }) {
  const fromInt = toSageDate(from);
  const toInt = toSageDate(to);
  if (fromInt > toInt) {
    throw new Error(`Invoice Profit day totals: the "from" date (${from}) is after the "to" date (${to}).`);
  }
  const run = (text) => pool.request()
    .input('from', sql.Int, fromInt)
    .input('to', sql.Int, toInt)
    .query(text);

  const [invSell, invCost, cnSell, cnCost] = await Promise.all([
    run(`SELECT h.INVDATE AS ymd, SUM(h.INVNETNOTX) AS amount, COUNT(*) AS docs
         FROM OEINVH h
         LEFT JOIN ARCUS cu ON LTRIM(RTRIM(cu.IDCUST)) = LTRIM(RTRIM(h.CUSTOMER))
         WHERE h.INVDATE BETWEEN @from AND @to AND NOT ${IB_SQL('cu')}
         GROUP BY h.INVDATE`),
    run(`SELECT h.INVDATE AS ymd, SUM(d.EXTICOST) AS amount
         FROM OEINVD d
         INNER JOIN OEINVH h ON h.INVUNIQ = d.INVUNIQ
         LEFT JOIN ARCUS cu ON LTRIM(RTRIM(cu.IDCUST)) = LTRIM(RTRIM(h.CUSTOMER))
         WHERE h.INVDATE BETWEEN @from AND @to AND NOT ${IB_SQL('cu')}
         GROUP BY h.INVDATE`),
    run(`SELECT k.CRDDATE AS ymd, SUM(k.CRDNETNOTX) AS amount, COUNT(*) AS docs
         FROM OECRDH k
         LEFT JOIN ARCUS cu ON LTRIM(RTRIM(cu.IDCUST)) = LTRIM(RTRIM(k.CUSTOMER))
         WHERE k.CRDDATE BETWEEN @from AND @to AND NOT ${IB_SQL('cu')}
         GROUP BY k.CRDDATE`),
    run(`SELECT k.CRDDATE AS ymd, SUM(d.EXTCCOST) AS amount
         FROM OECRDD d
         INNER JOIN OECRDH k ON k.CRDUNIQ = d.CRDUNIQ
         LEFT JOIN ARCUS cu ON LTRIM(RTRIM(cu.IDCUST)) = LTRIM(RTRIM(k.CUSTOMER))
         WHERE k.CRDDATE BETWEEN @from AND @to AND NOT ${IB_SQL('cu')}
         GROUP BY k.CRDDATE`),
  ]);

  /** @type {Map<string, any>} */
  const days = new Map();
  const at = (ymd) => {
    const day = fromSageDate(ymd);
    let d = days.get(day);
    if (!d) { d = { day, selling: 0, cost: 0, profit: 0, invoice_count: 0, credit_note_count: 0 }; days.set(day, d); }
    return d;
  };
  // Credit notes subtract, matching the sign convention the whole report uses.
  for (const r of invSell.recordset) { const d = at(r.ymd); d.selling += num(r.amount); d.invoice_count += num(r.docs); }
  for (const r of invCost.recordset) { at(r.ymd).cost += num(r.amount); }
  for (const r of cnSell.recordset) { const d = at(r.ymd); d.selling -= num(r.amount); d.credit_note_count += num(r.docs); }
  for (const r of cnCost.recordset) { at(r.ymd).cost -= num(r.amount); }

  return [...days.values()]
    .map((d) => ({ ...d, profit: d.selling - d.cost }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Roll day totals up into day / week / month / year buckets.
 *
 * Every bucket carries `period_start` and `period_end` because the hub's
 * drill-down link hands the branch an exact date range — the branch owns the
 * invoices, and a link that guesses the range lands on the wrong numbers.
 *
 * Weeks are ISO (Monday start), keyed by ISO year so a week straddling New Year
 * keeps one key. YEARS are CALENDAR years: "2026" must mean the trading year the
 * accounts are cut on, not ISO-2026, which can begin in December.
 *
 * @param {Array<{ day: string, selling: number, cost: number, invoice_count?: number, credit_note_count?: number }>} days
 */
export function rollUpDays(days) {
  const buckets = { day: new Map(), week: new Map(), month: new Map(), year: new Map() };

  const bump = (type, key, start, end, row) => {
    let b = buckets[type].get(key);
    if (!b) {
      b = { period_type: type, period_key: key, period_start: start, period_end: end, ...emptyTotals() };
      buckets[type].set(key, b);
    }
    b.selling += num(row.selling);
    b.cost += num(row.cost);
    b.profit += num(row.selling) - num(row.cost);
    b.invoice_count += num(row.invoice_count);
    b.credit_note_count += num(row.credit_note_count);
  };

  const isoDay = (dt) => dt.toISOString().slice(0, 10);

  for (const row of days || []) {
    if (!row?.day) continue;
    const ym = row.day.slice(0, 7);
    const year = row.day.slice(0, 4);
    const { year: wy, week: wn } = isoWeek(row.day);
    bump('day', row.day, row.day, row.day, row);
    bump('week', `${wy}-W${String(wn).padStart(2, '0')}`, isoDay(dateFromIso(wy, wn, 1)), isoDay(dateFromIso(wy, wn, 7)), row);
    bump('month', ym, `${ym}-01`, monthEnd(ym), row);
    bump('year', year, `${year}-01-01`, `${year}-12-31`, row);
  }

  const out = {};
  for (const type of PERIOD_TYPES) {
    out[type] = [...buckets[type].values()]
      .map(sealTotals)
      .sort((a, b) => a.period_key.localeCompare(b.period_key));
  }
  return out;
}

/**
 * Range-level figures for a report spanning MORE THAN ONE MONTH.
 *
 * The day/week/month "to date" figures above are anchored on the last day in the
 * range. Over a single month that's exactly what you want; over Jan–Jul it means
 * three of the four summary cards describe one Friday, one part-week and one
 * month, sitting above a table covering seven — right numbers, wrong question.
 * So a multi-month range gets these instead: how the months compare, and what an
 * average one looks like.
 *
 * Best/weakest are ranked by PROFIT (rand), not margin — a high-margin month
 * that sold nothing isn't the best month. Each carries its own margin so the
 * comparison is still visible.
 *
 * PARTIAL MONTHS ARE NOT COMPARED. A range of 20 August to 30 September holds
 * twelve days of August against a whole September; ranking those together would
 * regularly crown the clipped boundary month "weakest" for no reason other than
 * being short, and would drag the monthly average down with it. Best, weakest
 * and the average are computed over COMPLETE months only, and `partial_months`
 * says how many were set aside so the UI can state it rather than hide it.
 *
 * When fewer than two complete months exist there is nothing meaningful to
 * compare, so best/weakest come back null and only the average is offered — over
 * whatever months there are, flagged by `average_includes_partial`.
 *
 * Returns null for a single-month range, which is the UI's signal to keep
 * showing the to-date cards.
 *
 * @param {ReturnType<typeof buildProfitTree>} months
 */
export function rangeStats(months) {
  if (!months || months.length < 2) return null;

  const complete = months.filter((m) => !m.partial);
  const partialCount = months.length - complete.length;
  // Compare like with like where we can; fall back to everything when we can't,
  // and say which happened.
  const comparable = complete.length >= 2 ? complete : months;
  const rankable = complete.length >= 2;

  const byProfit = [...comparable].sort((a, b) => b.totals.profit - a.totals.profit);
  const brief = (m) => ({ month: m.month, label: m.label, partial: !!m.partial, totals: m.totals });

  const n = comparable.length;
  const sumOf = (key) => comparable.reduce((s, m) => s + m.totals[key], 0);
  const avgSelling = sumOf('selling') / n;
  const avgProfit = sumOf('profit') / n;

  return {
    month_count: n,
    partial_months: partialCount,
    average_includes_partial: !rankable && partialCount > 0,
    best_month: rankable ? brief(byProfit[0]) : null,
    weakest_month: rankable ? brief(byProfit[byProfit.length - 1]) : null,
    monthly_average: {
      selling: avgSelling,
      cost: sumOf('cost') / n,
      profit: avgProfit,
      invoice_count: Math.round(sumOf('invoice_count') / n),
      credit_note_count: Math.round(sumOf('credit_note_count') / n),
      // Margin of the averages is the range margin — dividing the summed profit
      // by the summed selling, not averaging the per-month percentages (which
      // would weight a quiet month the same as a busy one).
      margin: marginPct(avgProfit, avgSelling),
    },
  };
}

/**
 * Full report payload — the ONE builder both the site route and (once the hub
 * rollup lands) the hub route call, so the two can never compute different
 * numbers for the same day.
 *
 * @param {{ pool: import('mssql').ConnectionPool, from: string, to: string,
 *           filters?: { losses?: boolean, min?: number|null, max?: number|null, unit?: 'rand'|'pct' } }} args
 */
export async function buildProfitReport({ pool, from, to, filters = {} }) {
  const { documents: all, excluded } = await fetchProfitDocuments({ pool, from, to });
  // Every total on the report — cards, rollups, exports — is built from the
  // SAME filtered list, so what's on screen always adds up to what's in the
  // rows underneath it.
  const documents = filterDocuments(all, filters);
  const filterLabel = describeFilter(filters);
  const summary = summariseProfit(documents, { from, to });
  const months = buildProfitTree(documents, { from, to });
  return {
    from,
    to,
    months,
    range_stats: rangeStats(months),
    ...summary,
    filter: filterLabel
      ? {
        active: true,
        label: filterLabel,
        matched: documents.length,
        // Invoices only — the denominator has to match what the filter
        // considered, or "12 of 16,032" reads as if 16,020 invoices were
        // profitable when most of that number is credit notes.
        of_invoices: all.filter((d) => d.doc_type === 'invoice').length,
      }
      : { active: false },
    document_count: documents.length,
    excluded: {
      ...excluded,
      profit: excluded.selling - excluded.cost,
      reason: 'Inter-branch depot transfers — internal stock movements, not sales.',
    },
  };
}
