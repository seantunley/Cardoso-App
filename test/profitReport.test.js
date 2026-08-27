// Tests for the Invoice Profit rollup in src/services/reporting/profitReport.js.
//
// The SQL is verified against live Sage separately; what's pinned here is the
// arithmetic that can silently drift:
//   • every level is EXACTLY the sum of the level below it (a month total that
//     doesn't equal its weeks is the one bug nobody notices until year end),
//   • credit notes subtract,
//   • inter-branch transfers are excluded from the totals but still reported,
//   • ISO weeks that straddle a month boundary don't leak days into the wrong
//     month.

import { describe, it, expect } from 'vitest';
import {
  buildProfitTree,
  summariseProfit,
  rangeStats,
  filterDocuments,
  describeFilter,
  fetchDocumentLines,
  rollUpDays,
  fetchProfitDayTotals,
  PERIOD_TYPES,
  isInterBranchName,
  marginPct,
  toSageDate,
} from '../src/services/reporting/profitReport.js';

// Build a document the way fetchProfitDocuments emits them.
const doc = (date, docNumber, selling, cost, type = 'invoice') => ({
  doc_type: type,
  doc_number: docNumber,
  date,
  customer_code: 'C1',
  customer_name: 'Test Customer',
  location: '',
  sales_rep: '',
  selling,
  cost,
  profit: selling - cost,
  margin: marginPct(selling - cost, selling),
});

const round = (n) => Math.round(n * 100) / 100;

describe('marginPct', () => {
  it('is profit as a percentage of selling', () => {
    expect(marginPct(25, 100)).toBe(25);
    expect(round(marginPct(716116.63, 27285830.01))).toBe(2.62);
  });

  it('returns 0 rather than Infinity/NaN when selling nets to zero', () => {
    // A day where an invoice is fully reversed by a same-day credit note.
    expect(marginPct(0, 0)).toBe(0);
    expect(marginPct(5, 0)).toBe(0);
    expect(Number.isFinite(marginPct(5, 0))).toBe(true);
  });
});

describe('isInterBranchName', () => {
  it('matches the spellings Sage actually uses', () => {
    expect(isInterBranchName('CCD Inter Branch Transfer POLOKWANE')).toBe(true);
    expect(isInterBranchName('CCD Inter-Branch Transfer PRETORIA')).toBe(true);
    expect(isInterBranchName('ccd interbranch transfer')).toBe(true);
  });

  it('does not match ordinary customers', () => {
    expect(isInterBranchName('Spar Klerksdorp')).toBe(false);
    expect(isInterBranchName('BRANCH FOODS PTY LTD')).toBe(false);
    expect(isInterBranchName('')).toBe(false);
    expect(isInterBranchName(null)).toBe(false);
  });
});

describe('toSageDate', () => {
  it('converts ISO dates to the integer form Sage stores', () => {
    expect(toSageDate('2026-07-01')).toBe(20260701);
    expect(toSageDate('2026-12-31')).toBe(20261231);
  });

  it('rejects anything that is not YYYY-MM-DD, naming the bad value', () => {
    expect(() => toSageDate('01/07/2026')).toThrow(/YYYY-MM-DD/);
    expect(() => toSageDate('')).toThrow(/YYYY-MM-DD/);
  });
});

describe('buildProfitTree', () => {
  it('nests month -> week -> day -> documents', () => {
    const tree = buildProfitTree([
      doc('2026-07-01', 'IN1', 1000, 900),
      doc('2026-07-01', 'IN2', 500, 480),
      doc('2026-07-02', 'IN3', 2000, 1900),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0].month).toBe('2026-07');
    expect(tree[0].label).toBe('July 2026');
    expect(tree[0].weeks).toHaveLength(1);
    expect(tree[0].weeks[0].iso_week).toBe(27);
    expect(tree[0].weeks[0].days).toHaveLength(2);
    expect(tree[0].weeks[0].days[0].documents).toHaveLength(2);
  });

  it('makes every level exactly the sum of the level below it', () => {
    const docs = [
      doc('2026-07-01', 'IN1', 1000, 900),
      doc('2026-07-02', 'IN2', 500, 480),
      doc('2026-07-09', 'IN3', 2500, 2300),
      doc('2026-08-03', 'IN4', 900, 800),
    ];
    const tree = buildProfitTree(docs);

    for (const m of tree) {
      const weekSum = m.weeks.reduce((s, w) => s + w.totals.profit, 0);
      expect(round(weekSum)).toBe(round(m.totals.profit));
      for (const w of m.weeks) {
        const daySum = w.days.reduce((s, d) => s + d.totals.profit, 0);
        expect(round(daySum)).toBe(round(w.totals.profit));
        for (const d of w.days) {
          const docSum = d.documents.reduce((s, x) => s + x.profit, 0);
          expect(round(docSum)).toBe(round(d.totals.profit));
        }
      }
    }

    const grand = tree.reduce((s, m) => s + m.totals.profit, 0);
    expect(round(grand)).toBe(round(docs.reduce((s, d) => s + d.profit, 0)));
  });

  it('subtracts credit notes from every level and counts them separately', () => {
    const tree = buildProfitTree([
      doc('2026-07-01', 'IN1', 1000, 900),
      doc('2026-07-01', 'CN1', -400, -380, 'credit_note'),
    ]);

    const day = tree[0].weeks[0].days[0];
    expect(day.totals.selling).toBe(600);
    expect(day.totals.cost).toBe(520);
    expect(day.totals.profit).toBe(80);
    expect(day.totals.invoice_count).toBe(1);
    expect(day.totals.credit_note_count).toBe(1);
    expect(tree[0].totals.profit).toBe(80);
  });

  it('splits a month-straddling ISO week so neither month borrows the other\'s days', () => {
    // ISO week 31 of 2026 runs Mon 27 Jul – Sun 2 Aug, crossing the boundary.
    const tree = buildProfitTree([
      doc('2026-07-31', 'IN-JUL', 1000, 900),
      doc('2026-08-01', 'IN-AUG', 2000, 1800),
    ]);

    expect(tree.map((m) => m.month)).toEqual(['2026-07', '2026-08']);

    const julWeek = tree[0].weeks[0];
    const augWeek = tree[1].weeks[0];
    // Same ISO week, appearing under both months...
    expect(julWeek.iso_week).toBe(31);
    expect(augWeek.iso_week).toBe(31);
    expect(julWeek.partial).toBe(true);
    expect(augWeek.partial).toBe(true);
    // ...but each carrying only its own month's days and totals.
    expect(julWeek.days.map((d) => d.day)).toEqual(['2026-07-31']);
    expect(augWeek.days.map((d) => d.day)).toEqual(['2026-08-01']);
    expect(tree[0].totals.selling).toBe(1000);
    expect(tree[1].totals.selling).toBe(2000);
  });

  it('marks a week that sits wholly inside one month as not partial', () => {
    const tree = buildProfitTree([doc('2026-07-08', 'IN1', 100, 90)]);
    expect(tree[0].weeks[0].partial).toBe(false);
  });

  it('returns an empty tree for no documents', () => {
    expect(buildProfitTree([])).toEqual([]);
  });
});

describe('summariseProfit', () => {
  const docs = [
    doc('2026-07-06', 'IN1', 1000, 900), // Mon, week 28
    doc('2026-07-07', 'IN2', 2000, 1850), // Tue, week 28
    doc('2026-07-13', 'IN3', 3000, 2700), // Mon, week 29 — the latest day
  ];

  it('anchors the to-date figures on the last day WITH ACTIVITY, not on today', () => {
    const s = summariseProfit(docs);
    expect(s.latest_day).toBe('2026-07-13');
    expect(s.day_to_date.selling).toBe(3000);
  });

  it('scopes week-to-date to the latest day\'s ISO week', () => {
    const s = summariseProfit(docs);
    // Week 29 holds only the 13th — the 6th/7th are week 28 and must not leak in.
    expect(s.week_to_date.selling).toBe(3000);
    expect(s.week_to_date.invoice_count).toBe(1);
  });

  it('scopes month-to-date to the latest day\'s month, up to that day', () => {
    const s = summariseProfit([...docs, doc('2026-06-30', 'IN0', 500, 400)]);
    expect(s.month_to_date.selling).toBe(6000); // July only
    expect(s.totals.selling).toBe(6500); // grand total includes June
  });

  it('never counts days after the anchor in the to-date figures', () => {
    // A range ending mid-week: nothing after the latest day exists, but the
    // guard matters once the hub feeds ranges that end in the past.
    const s = summariseProfit(docs);
    expect(s.month_to_date.selling).toBe(6000);
    expect(round(s.totals.profit)).toBe(round(docs.reduce((a, d) => a + d.profit, 0)));
  });

  it('handles an empty range without throwing', () => {
    const s = summariseProfit([]);
    expect(s.latest_day).toBeNull();
    expect(s.day_to_date).toBeNull();
    expect(s.totals.selling).toBe(0);
    expect(s.totals.margin).toBe(0);
  });
});

describe('rangeStats', () => {
  // Three months of differing size, so best/weakest can't accidentally be
  // "first"/"last" and still pass.
  const tree = () => buildProfitTree([
    doc('2026-01-15', 'IN-JAN', 1000, 900),   // profit 100
    doc('2026-02-15', 'IN-FEB', 2000, 1700),  // profit 300  <- best
    doc('2026-03-15', 'IN-MAR', 5000, 4950),  // profit  50  <- weakest (biggest turnover)
  ]);

  it('is null for a single month, so the UI keeps the to-date cards', () => {
    expect(rangeStats(buildProfitTree([doc('2026-07-01', 'IN1', 100, 90)]))).toBeNull();
    expect(rangeStats([])).toBeNull();
    expect(rangeStats(null)).toBeNull();
  });

  it('ranks best and weakest by profit in rand, not by margin', () => {
    const s = rangeStats(tree());
    // March has the largest turnover and Jan the best margin (10%); neither is
    // the answer — February made the most money.
    expect(s.best_month.month).toBe('2026-02');
    expect(s.weakest_month.month).toBe('2026-03');
    expect(s.best_month.totals.profit).toBe(300);
    expect(s.weakest_month.totals.profit).toBe(50);
  });

  it('averages across the months present', () => {
    const s = rangeStats(tree());
    expect(s.month_count).toBe(3);
    expect(s.monthly_average.profit).toBe(450 / 3);
    expect(s.monthly_average.selling).toBe(8000 / 3);
    expect(s.monthly_average.cost).toBe(7550 / 3);
  });

  it('takes the average margin from the totals, not the mean of the percentages', () => {
    const s = rangeStats(tree());
    // Mean of per-month margins would be (10 + 15 + 1)/3 = 8.67% — which would
    // let a tiny high-margin month outvote a huge thin one.
    expect(round(s.monthly_average.margin)).toBe(round((450 / 8000) * 100));
    expect(round(s.monthly_average.margin)).toBe(5.63);
  });

  it('carries the per-month margin so the comparison stays visible', () => {
    const s = rangeStats(tree());
    expect(round(s.best_month.totals.margin)).toBe(15);
    expect(round(s.weakest_month.totals.margin)).toBe(1);
  });

  it('handles a loss-making month as the weakest', () => {
    const s = rangeStats(buildProfitTree([
      doc('2026-01-15', 'IN1', 1000, 900),
      doc('2026-02-15', 'IN2', 1000, 1200), // sold below cost
    ]));
    expect(s.weakest_month.month).toBe('2026-02');
    expect(s.weakest_month.totals.profit).toBe(-200);
    expect(s.monthly_average.profit).toBe(-50);
  });
});

describe('filterDocuments', () => {
  const docs = [
    doc('2026-07-01', 'IN-LOSS', 1000, 1200),   // profit -200, margin -20%
    doc('2026-07-01', 'IN-EVEN', 1000, 1000),   // profit    0, margin   0%
    doc('2026-07-01', 'IN-THIN', 1000, 996),    // profit    4, margin 0.4%
    doc('2026-07-01', 'IN-FIVE', 1000, 995),    // profit    5, margin 0.5%
    doc('2026-07-01', 'IN-FAT',  1000, 800),    // profit  200, margin  20%
    doc('2026-07-01', 'CN-1', -500, -450, 'credit_note'), // profit -50
  ];
  const nums = (r) => r.map((d) => d.doc_number);

  it('returns everything untouched when no filter is set', () => {
    expect(filterDocuments(docs, {})).toBe(docs);
    expect(filterDocuments(docs, { min: null, max: null })).toBe(docs);
  });

  it('treats break-even as "made no profit"', () => {
    expect(nums(filterDocuments(docs, { losses: true }))).toEqual(['IN-LOSS', 'IN-EVEN']);
  });

  it('excludes credit notes from every filtered result', () => {
    // A credit note ALWAYS has negative profit — including them would bury the
    // real loss-makers under every return in the period.
    for (const f of [{ losses: true }, { max: 5 }, { min: -1000, max: 1000 }]) {
      expect(nums(filterDocuments(docs, f))).not.toContain('CN-1');
    }
  });

  it('filters by rand of profit, inclusive on both bounds', () => {
    expect(nums(filterDocuments(docs, { max: 5 }))).toEqual(['IN-LOSS', 'IN-EVEN', 'IN-THIN', 'IN-FIVE']);
    expect(nums(filterDocuments(docs, { min: 5 }))).toEqual(['IN-FIVE', 'IN-FAT']);
    expect(nums(filterDocuments(docs, { min: 0, max: 5 }))).toEqual(['IN-EVEN', 'IN-THIN', 'IN-FIVE']);
  });

  it('filters by margin percentage when the unit says so', () => {
    // Same "5 or less" bound, read as a percentage instead of rand — a
    // different set, which is exactly why the unit is explicit in the UI.
    expect(nums(filterDocuments(docs, { max: 5, unit: 'pct' })))
      .toEqual(['IN-LOSS', 'IN-EVEN', 'IN-THIN', 'IN-FIVE']);
    expect(nums(filterDocuments(docs, { min: 5, unit: 'pct' }))).toEqual(['IN-FAT']);
  });

  it('rolls up cleanly off a filtered list', () => {
    const tree = buildProfitTree(filterDocuments(docs, { losses: true }));
    expect(tree[0].totals.profit).toBe(-200);
    expect(tree[0].totals.invoice_count).toBe(2);
    expect(tree[0].totals.credit_note_count).toBe(0);
  });
});

describe('describeFilter', () => {
  it('says nothing when no filter is active', () => {
    expect(describeFilter({})).toBeNull();
    expect(describeFilter({ min: null, max: null })).toBeNull();
  });

  it('describes each shape in plain English, with the unit', () => {
    expect(describeFilter({ losses: true })).toBe('Invoices that made no profit (R0 or less)');
    expect(describeFilter({ max: 5 })).toBe('Invoices that made R5 or less');
    expect(describeFilter({ max: 5, unit: 'pct' })).toBe('Invoices that made 5% or less');
    expect(describeFilter({ min: 100 })).toBe('Invoices that made R100 or more');
    expect(describeFilter({ min: 0, max: 5 })).toBe('Invoices with a profit between R0 and R5');
  });
});

describe('fetchDocumentLines', () => {
  // Stub pool: hands back the header recordset for the header query and the
  // line recordset for the line query, so the sign convention and the
  // reconciliation logic can be pinned without a live Sage.
  const stubPool = (header, lines) => ({
    request: () => ({
      input() { return this; },
      query(sqlText) {
        const isHeader = /OEINVH|OECRDH/.test(sqlText);
        return Promise.resolve({ recordset: isHeader ? (header ? [header] : []) : lines });
      },
    }),
  });

  const invHeader = { doc_number: 'IN000433366', ymd: 20260701, customer_code: '5115', customer_name: 'N17 LIQUOR EXPRESS', selling: 2196.52 };
  const invLines = [
    { line_no: 16, item: '86', description: 'CAMEL BLUE BOX 20s', qty: 1, uom: 'CTN', unit_price: 532.18, discount: 0, selling: 532.18, cost: 518.70 },
    { line_no: 32, item: '65', description: 'CAMEL DOUBLE & PURPLE', qty: 1, uom: 'CTN', unit_price: 410.19, discount: 0, selling: 410.19, cost: 397.13 },
  ];

  it('rejects an unknown document type by name', async () => {
    await expect(fetchDocumentLines({ pool: stubPool(invHeader, []), type: 'quote', uniq: '1' }))
      .rejects.toThrow(/unknown document type/i);
  });

  it('rejects a non-numeric document id rather than interpolating it', async () => {
    for (const bad of ["1; DROP TABLE OEINVH", '', 'abc']) {
      await expect(fetchDocumentLines({ pool: stubPool(invHeader, []), type: 'invoice', uniq: bad }))
        .rejects.toThrow(/must be numeric/i);
    }
  });

  it('says so plainly when the document no longer exists', async () => {
    await expect(fetchDocumentLines({ pool: stubPool(null, []), type: 'invoice', uniq: '99' }))
      .rejects.toThrow(/no invoice found in Sage with id 99/i);
  });

  it('computes per-line profit and margin', async () => {
    const r = await fetchDocumentLines({ pool: stubPool(invHeader, invLines), type: 'invoice', uniq: '1' });
    expect(r.lines).toHaveLength(2);
    expect(round(r.lines[0].profit)).toBe(13.48);
    expect(round(r.lines[0].margin)).toBe(2.53);
    expect(r.doc_number).toBe('IN000433366');
    expect(r.date).toBe('2026-07-01');
  });

  it('takes totals from the header selling so the detail ties to the row that opened it', async () => {
    const r = await fetchDocumentLines({ pool: stubPool(invHeader, invLines), type: 'invoice', uniq: '1' });
    expect(r.totals.selling).toBe(2196.52);       // header, not the 2 stub lines
    expect(round(r.totals.cost)).toBe(915.83);    // summed from the lines
    expect(round(r.totals.profit)).toBe(round(2196.52 - 915.83));
  });

  it('reports a document-level adjustment when the lines do not account for the header', async () => {
    // Header 2196.52 vs lines 942.37 -> the rest belongs to no single line.
    const r = await fetchDocumentLines({ pool: stubPool(invHeader, invLines), type: 'invoice', uniq: '1' });
    expect(r.adjustment).not.toBeNull();
    expect(round(r.adjustment)).toBe(round(2196.52 - 942.37));
  });

  it('reports no adjustment when the lines reconcile exactly', async () => {
    const exact = { ...invHeader, selling: 942.37 };
    const r = await fetchDocumentLines({ pool: stubPool(exact, invLines), type: 'invoice', uniq: '1' });
    expect(r.adjustment).toBeNull();
  });

  it('ignores sub-cent rounding rather than showing a R0.00 adjustment row', async () => {
    const nearly = { ...invHeader, selling: 942.38 };
    const r = await fetchDocumentLines({ pool: stubPool(nearly, invLines), type: 'invoice', uniq: '1' });
    expect(r.adjustment).toBeNull();
  });
});

describe('rollUpDays', () => {
  // The hub stores DAYS and derives week/month/year from them, so these
  // derivations are the thing that has to be right — a wrong week boundary or a
  // year bucket built on ISO years would misstate a branch on the hub.
  const day = (d, selling, cost, inv = 1, cn = 0) => ({
    day: d, selling, cost, invoice_count: inv, credit_note_count: cn,
  });

  it('produces all four period types', () => {
    const r = rollUpDays([day('2026-07-01', 1000, 900)]);
    expect(Object.keys(r).sort()).toEqual([...PERIOD_TYPES].sort());
  });

  it('rolls days into the right week, month and year', () => {
    const r = rollUpDays([
      day('2026-07-01', 1000, 900),
      day('2026-07-02', 2000, 1800),
      day('2026-07-09', 500, 450),
    ]);
    expect(r.day).toHaveLength(3);
    expect(r.week.map((w) => w.period_key)).toEqual(['2026-W27', '2026-W28']);
    expect(r.month.map((m) => m.period_key)).toEqual(['2026-07']);
    expect(r.year.map((y) => y.period_key)).toEqual(['2026']);
    expect(r.week[0].profit).toBe(300); // 1 + 2 July
    expect(r.month[0].profit).toBe(350);
    expect(r.year[0].profit).toBe(350);
  });

  it('makes every period exactly the sum of its days', () => {
    const days = [
      day('2026-01-15', 1000, 900), day('2026-06-30', 2000, 1750),
      day('2026-12-31', 3000, 2900), day('2025-12-31', 500, 400),
    ];
    const r = rollUpDays(days);
    const total = days.reduce((a, d) => a + (d.selling - d.cost), 0);
    for (const type of PERIOD_TYPES) {
      expect(r[type].reduce((a, b) => a + b.profit, 0)).toBe(total);
    }
  });

  it('buckets years by CALENDAR year, not ISO year', () => {
    // 31 Dec 2025 is a Wednesday, so it falls in ISO week 1 of 2026. The week
    // bucket must say 2026-W01, but the YEAR bucket must say 2025 — the accounts
    // are cut on calendar years, and an ISO year would move December's trade
    // into the following financial year.
    const r = rollUpDays([day('2025-12-31', 1000, 900)]);
    expect(r.week[0].period_key).toBe('2026-W01');
    expect(r.year[0].period_key).toBe('2025');
    expect(r.year[0].period_start).toBe('2025-01-01');
    expect(r.year[0].period_end).toBe('2025-12-31');
  });

  it('keeps a New Year week whole under one ISO key', () => {
    const r = rollUpDays([day('2025-12-31', 1000, 900), day('2026-01-01', 2000, 1800)]);
    expect(r.week).toHaveLength(1);
    expect(r.week[0].period_key).toBe('2026-W01');
    expect(r.week[0].profit).toBe(300);
    // ...while the years stay separate.
    expect(r.year.map((y) => y.period_key)).toEqual(['2025', '2026']);
  });

  it('carries exact calendar bounds, which the hub drill-down link depends on', () => {
    const r = rollUpDays([day('2026-02-10', 100, 90)]);
    expect(r.month[0].period_start).toBe('2026-02-01');
    expect(r.month[0].period_end).toBe('2026-02-28');   // 2026 is not a leap year
    expect(r.week[0].period_start).toBe('2026-02-09');  // Monday
    expect(r.week[0].period_end).toBe('2026-02-15');    // Sunday
    expect(r.day[0].period_start).toBe('2026-02-10');
    expect(r.day[0].period_end).toBe('2026-02-10');
  });

  it('gets February right in a leap year', () => {
    const r = rollUpDays([day('2028-02-10', 100, 90)]);
    expect(r.month[0].period_end).toBe('2028-02-29');
  });

  it('computes margin from the summed totals at every level', () => {
    const r = rollUpDays([day('2026-07-01', 1000, 900), day('2026-07-02', 3000, 2900)]);
    // 200 profit on 4000 selling = 5%. The mean of the two DAY margins
    // (10% and 3.33%) would be 6.67% — a quiet day must not weigh the same as
    // a busy one.
    expect(round(r.month[0].margin)).toBe(5);
  });

  it('handles no days without throwing', () => {
    const r = rollUpDays([]);
    for (const type of PERIOD_TYPES) expect(r[type]).toEqual([]);
    expect(rollUpDays(null).day).toEqual([]);
  });
});

describe('fetchProfitDayTotals', () => {
  // Stub pool returning a different recordset per grouped query, so the sign
  // convention (credit notes subtract) and the day merge can be pinned.
  const stubPool = (sets) => ({
    request: () => ({
      input() { return this; },
      query(text) {
        const isCredit = /OECRD/.test(text);
        const isCost = /EXTICOST|EXTCCOST/.test(text);
        const key = `${isCredit ? 'cn' : 'inv'}${isCost ? 'Cost' : 'Sell'}`;
        return Promise.resolve({ recordset: sets[key] || [] });
      },
    }),
  });

  it('subtracts credit notes from selling and cost', async () => {
    const days = await fetchProfitDayTotals({
      pool: stubPool({
        invSell: [{ ymd: 20260701, amount: 1000, docs: 3 }],
        invCost: [{ ymd: 20260701, amount: 900 }],
        cnSell: [{ ymd: 20260701, amount: 200, docs: 1 }],
        cnCost: [{ ymd: 20260701, amount: 180 }],
      }),
      from: '2026-07-01', to: '2026-07-31',
    });
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({
      day: '2026-07-01', selling: 800, cost: 720, profit: 80,
      invoice_count: 3, credit_note_count: 1,
    });
  });

  it('returns days sorted, merging a day that only has credit notes', async () => {
    const days = await fetchProfitDayTotals({
      pool: stubPool({
        invSell: [{ ymd: 20260703, amount: 500, docs: 1 }],
        invCost: [{ ymd: 20260703, amount: 450 }],
        cnSell: [{ ymd: 20260701, amount: 100, docs: 1 }],
        cnCost: [{ ymd: 20260701, amount: 90 }],
      }),
      from: '2026-07-01', to: '2026-07-31',
    });
    expect(days.map((d) => d.day)).toEqual(['2026-07-01', '2026-07-03']);
    // A day of pure returns is a negative day, not a missing one.
    expect(days[0].selling).toBe(-100);
    expect(days[0].profit).toBe(-10);
  });

  it('refuses a reversed date range', async () => {
    await expect(fetchProfitDayTotals({ pool: stubPool({}), from: '2026-07-31', to: '2026-07-01' }))
      .rejects.toThrow(/is after the "to" date/);
  });
});

// ── Codex review follow-ups (PR #553) ───────────────────────────────────────
// One regression test per finding, so none of them can quietly come back.

describe('range-aware periods (Codex #553)', () => {
  const doc2 = (date, n, selling, cost) => doc(date, n, selling, cost);

  it('marks a week the RANGE clips as partial, not just one crossing a month', () => {
    // Thu 2 - Fri 3 July 2026, inside ISO week 27 (Mon 29 Jun - Sun 5 Jul).
    // Week 27 also crosses a month boundary here, so use a mid-month week to
    // isolate the range-clipping case: week 28 is Mon 6 - Sun 12 July.
    const tree = buildProfitTree(
      [doc2('2026-07-09', 'IN1', 1000, 900)],
      { from: '2026-07-09', to: '2026-07-10' },
    );
    const week = tree[0].weeks[0];
    expect(week.iso_week).toBe(28);
    expect(week.week_start).toBe('2026-07-06');
    expect(week.week_end).toBe('2026-07-12');
    expect(week.partial).toBe(true);            // was false before the fix
    expect(week.covered_start).toBe('2026-07-09');
    expect(week.covered_end).toBe('2026-07-10');
  });

  it('leaves a week untouched by the range as complete', () => {
    const tree = buildProfitTree(
      [doc2('2026-07-09', 'IN1', 1000, 900)],
      { from: '2026-07-01', to: '2026-07-31' },
    );
    expect(tree[0].weeks[0].partial).toBe(false);
  });

  it('flags a month the range clips, and reports what it covers', () => {
    const tree = buildProfitTree(
      [doc2('2026-08-25', 'IN1', 1000, 900)],
      { from: '2026-08-20', to: '2026-08-27' },
    );
    expect(tree[0].partial).toBe(true);
    expect(tree[0].covered_start).toBe('2026-08-20');
    expect(tree[0].covered_end).toBe('2026-08-27');
  });

  it('materialises a month with no trade so it is not silently missing', () => {
    const tree = buildProfitTree(
      [doc2('2026-01-15', 'IN1', 1000, 900), doc2('2026-03-15', 'IN2', 2000, 1800)],
      { from: '2026-01-01', to: '2026-03-31' },
    );
    expect(tree.map((m) => m.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(tree[1].totals.profit).toBe(0);
    expect(tree[1].totals.invoice_count).toBe(0);
    expect(tree[1].weeks).toEqual([]);
  });

  it('still returns nothing at all when there are no documents', () => {
    // An empty range must stay empty rather than become a page of zero months.
    expect(buildProfitTree([], { from: '2026-01-01', to: '2026-03-31' })).toEqual([]);
  });
});

describe('rangeStats with partial months (Codex #553)', () => {
  const mkMonths = (from, to, docs) => buildProfitTree(docs, { from, to });

  it('excludes clipped boundary months from best/weakest', () => {
    // 20 Aug - 30 Sep: August is 12 days and would otherwise be "weakest" purely
    // for being short.
    const months = mkMonths('2026-08-20', '2026-09-30', [
      doc('2026-08-25', 'IN1', 1000, 950),   // profit 50, partial month
      doc('2026-09-15', 'IN2', 5000, 4500),  // profit 500, whole month
    ]);
    expect(months[0].partial).toBe(true);
    expect(months[1].partial).toBe(false);
    const st = rangeStats(months);
    // Only ONE complete month, so nothing is comparable.
    expect(st.best_month).toBeNull();
    expect(st.weakest_month).toBeNull();
    expect(st.partial_months).toBe(1);
  });

  it('ranks among complete months and says how many were set aside', () => {
    const months = mkMonths('2026-08-20', '2026-10-31', [
      doc('2026-08-25', 'IN0', 1000, 950),   // partial August
      doc('2026-09-15', 'IN1', 5000, 4500),  // whole September, profit 500
      doc('2026-10-15', 'IN2', 4000, 3800),  // whole October,  profit 200
    ]);
    const st = rangeStats(months);
    expect(st.best_month.month).toBe('2026-09');
    expect(st.weakest_month.month).toBe('2026-10');
    expect(st.partial_months).toBe(1);
    // The average covers the two comparable months, not the clipped one.
    expect(st.month_count).toBe(2);
    expect(st.monthly_average.profit).toBe(350);
  });

  it('counts a zero-activity month in the average', () => {
    const months = mkMonths('2026-01-01', '2026-03-31', [
      doc('2026-01-15', 'IN1', 1000, 700),   // profit 300
      doc('2026-03-15', 'IN2', 1000, 700),   // profit 300
    ]);
    const st = rangeStats(months);
    expect(st.month_count).toBe(3);                 // February included
    expect(st.monthly_average.profit).toBe(200);    // 600 / 3, not 600 / 2
    expect(st.weakest_month.month).toBe('2026-02'); // the month that sold nothing
    expect(st.weakest_month.totals.profit).toBe(0);
  });
});

describe('to-date cards honesty (Codex #553)', () => {
  const docs = [doc('2026-08-25', 'IN1', 1000, 900), doc('2026-08-27', 'IN2', 2000, 1800)];

  it('flags the month as incomplete when the range starts mid-month', () => {
    // 20 Aug still covers the whole of ISO week 35 (Mon 24 - Sun 30), so only
    // the MONTH card is clipped here. This is the case Codex called out: eight
    // days of trade labelled "month to date".
    const s = summariseProfit(docs, { from: '2026-08-20', to: '2026-08-27' });
    expect(s.month_to_date.complete).toBe(false);
    expect(s.month_to_date.covered_from).toBe('2026-08-20');
    expect(s.week_to_date.complete).toBe(true);
  });

  it('flags the week as incomplete when the range starts mid-week', () => {
    const s = summariseProfit(docs, { from: '2026-08-26', to: '2026-08-27' });
    expect(s.week_to_date.complete).toBe(false);
    expect(s.week_to_date.covered_from).toBe('2026-08-26');
    expect(s.month_to_date.complete).toBe(false);
  });

  it('reports them as complete when the range covers the whole period', () => {
    const s = summariseProfit(docs, { from: '2026-08-01', to: '2026-08-31' });
    expect(s.month_to_date.complete).toBe(true);
    expect(s.month_to_date.covered_from).toBe('2026-08-01');
    // Week 35 starts Mon 24 Aug, which is inside a 1-31 Aug range.
    expect(s.week_to_date.complete).toBe(true);
  });

  it('treats a range-less call as complete, preserving old behaviour', () => {
    const s = summariseProfit(docs);
    expect(s.month_to_date.complete).toBe(true);
    expect(s.week_to_date.complete).toBe(true);
  });
});
