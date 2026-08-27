import { useState, Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ReportFrame, PrintHeader, PrintFooter, fmtRSigned, fmtCount, downloadCsv, downloadReport } from './lib';

// Invoice Profit — every invoice's selling, cost and profit, nested
// Month → ISO Week → Day → invoice, with a to-date strip across the top.
//
// Cost is the cost Sage costed onto the document when it was raised, so the
// numbers are historical and don't move when an item's cost changes. Credit
// notes carry negative selling/cost, so every subtotal is a NET figure.
// Inter-branch depot transfers are excluded (and reported as excluded, at the
// foot of the report — never silently dropped).
//
// Site-only for now: the hub keeps monthly AR totals, not per-invoice cost, so
// it shows an explicit note rather than an empty report.

const pad = (n) => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const monthStartISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`; };

// Filter state -> query string, shared by the fetch and the Excel download so a
// downloaded workbook always matches the filtered screen.
function profitQuery(from, to, f) {
  const qs = new URLSearchParams({ from, to });
  if (f.mode === 'losses') qs.set('losses', '1');
  if (f.mode === 'range') {
    if (f.min !== '') qs.set('min', f.min);
    if (f.max !== '') qs.set('max', f.max);
    qs.set('unit', f.unit);
  }
  return qs.toString();
}

function fetchProfit(from, to, f) {
  return fetch(`/api/reports/invoice-profit?${profitQuery(from, to, f)}`, { credentials: 'include' })
    .then(async (r) => {
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || `HTTP ${r.status}`); }
      return r.json();
    });
}

function fetchDocumentLines(type, uniq) {
  const qs = new URLSearchParams({ type, uniq });
  return fetch(`/api/reports/invoice-profit/document?${qs.toString()}`, { credentials: 'include' })
    .then(async (r) => {
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || `HTTP ${r.status}`); }
      return r.json();
    });
}

// Profit and margin read red below zero — a loss-making day should be obvious
// at a glance, not something you have to spot the minus sign for.
const toneFor = (v) => (v < 0 ? 'text-red-400' : v > 0 ? 'text-emerald-500' : 'text-muted-foreground');
// fmtRSigned, NOT fmtR: fmtR takes Math.abs() (right for reports whose values
// are always positive, wrong here). Credit notes carry negative selling and cost,
// and a day can net to a loss — printing those without the minus sign turns a
// R111 loss into a R111 gain on screen.
const Money = ({ v, bold }) => (
  <span className={`tabular-nums ${bold ? 'font-semibold' : ''}`}><span className="text-muted-subtle">R </span>{fmtRSigned(v)}</span>
);
const Profit = ({ v, bold }) => (
  <span className={`tabular-nums ${toneFor(v)} ${bold ? 'font-semibold' : ''}`}><span className="opacity-60">R </span>{fmtRSigned(v)}</span>
);
// Margin is toned by the PROFIT, not by its own sign. A credit note has negative
// profit but a positive margin (it reverses a sale that carried one), and showing
// that in green beside a red loss reads as if the return made money.
const Margin = ({ v, profit, bold }) => (
  <span className={`tabular-nums ${toneFor(profit ?? v)} ${bold ? 'font-semibold' : ''}`}>{(Number(v) || 0).toFixed(2)}%</span>
);

// ── To-date strip ───────────────────────────────────────────────────────────
// Anchored on the last day with activity in the range, not on today, so it still
// reads correctly on a Sunday or when the range ends in the past.
function ToDateCard({ label, sub, totals, accent }) {
  if (!totals) return null;
  return (
    <div className="bg-card p-4" style={{ border: '1px solid hsl(var(--border))', borderRadius: '12px' }}>
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{label}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-subtle">{sub}</div>}
      <div className="mt-3 font-display text-2xl leading-none" style={accent ? { color: 'var(--phosphor)' } : undefined}>
        <Profit v={totals.profit} bold />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>Selling</span><span className="text-right"><Money v={totals.selling} /></span>
        <span>Cost</span><span className="text-right"><Money v={totals.cost} /></span>
        <span>Margin</span><span className="text-right"><Margin v={totals.margin} profit={totals.profit} /></span>
      </div>
    </div>
  );
}

// Shared numeric cells for the month/week/day rows so the columns line up
// across all three levels.
function TotalsCells({ totals, bold }) {
  return (
    <>
      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{fmtCount(totals.invoice_count)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{totals.credit_note_count ? fmtCount(totals.credit_note_count) : <span className="text-muted-subtle">·</span>}</td>
      <td className="px-3 py-1.5 text-right border-l border-border/40"><Money v={totals.selling} bold={bold} /></td>
      <td className="px-3 py-1.5 text-right"><Money v={totals.cost} bold={bold} /></td>
      <td className="px-3 py-1.5 text-right border-l border-border/40"><Profit v={totals.profit} bold={bold} /></td>
      <td className="px-3 py-1.5 text-right"><Margin v={totals.margin} profit={totals.profit} bold={bold} /></td>
    </>
  );
}

// ── Line detail ─────────────────────────────────────────────────────────────
// The stock lines behind one document, fetched on demand. Rendered as rows of
// the same table so the money columns stay aligned with everything above.
function DocumentLines({ doc, colSpan }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['invoice-profit-doc', doc.doc_type, doc.doc_uniq],
    queryFn: () => fetchDocumentLines(doc.doc_type, doc.doc_uniq),
    staleTime: 5 * 60_000,
  });

  if (isLoading) {
    return (
      <tr className="bg-background/60"><td colSpan={colSpan} className="px-3 py-2 pl-20 font-mono text-[11px] text-muted-foreground">Loading lines…</td></tr>
    );
  }
  if (error) {
    return (
      <tr className="bg-background/60"><td colSpan={colSpan} className="px-3 py-2 pl-20 text-xs text-destructive">{error.message}</td></tr>
    );
  }
  const lines = data?.lines || [];
  if (!lines.length) {
    return (
      <tr className="bg-background/60"><td colSpan={colSpan} className="px-3 py-2 pl-20 text-xs text-muted-foreground">This document has no stock lines.</td></tr>
    );
  }

  return (
    <>
      <tr className="bg-background/60">
        <td colSpan={2} className="px-3 pt-2 pb-1 pl-20 font-mono text-[10px] uppercase tracking-wider text-muted-subtle">
          Item · description
        </td>
        <td className="px-3 pt-2 pb-1 text-right font-mono text-[10px] uppercase tracking-wider text-muted-subtle" colSpan={2}>Qty × price</td>
        <td className="px-3 pt-2 pb-1 text-right font-mono text-[10px] uppercase tracking-wider text-muted-subtle border-l border-border/40">Selling</td>
        <td className="px-3 pt-2 pb-1 text-right font-mono text-[10px] uppercase tracking-wider text-muted-subtle">Cost</td>
        <td className="px-3 pt-2 pb-1 text-right font-mono text-[10px] uppercase tracking-wider text-muted-subtle border-l border-border/40">Profit</td>
        <td className="px-3 pt-2 pb-1 text-right font-mono text-[10px] uppercase tracking-wider text-muted-subtle">Margin</td>
      </tr>
      {lines.map((l) => (
        <tr key={l.line_no} className="bg-background/60 border-b border-border/10">
          <td className="px-3 py-1 pl-20 font-mono text-[11px]">{l.item}</td>
          <td className="px-3 py-1 text-[11px] text-muted-foreground">{l.description}</td>
          <td className="px-3 py-1 text-right text-[11px] tabular-nums text-muted-foreground" colSpan={2}>
            {fmtCount(l.qty)}{l.uom ? ` ${l.uom}` : ''} × <span className="text-muted-subtle">R </span>{fmtRSigned(l.unit_price)}
            {!!l.discount && <span className="ml-1 text-muted-subtle">less R {fmtRSigned(l.discount)}</span>}
          </td>
          <td className="px-3 py-1 text-right text-[11px] border-l border-border/40"><Money v={l.selling} /></td>
          <td className="px-3 py-1 text-right text-[11px]"><Money v={l.cost} /></td>
          <td className="px-3 py-1 text-right text-[11px] border-l border-border/40"><Profit v={l.profit} /></td>
          <td className="px-3 py-1 text-right text-[11px]"><Margin v={l.margin} profit={l.profit} /></td>
        </tr>
      ))}
      {/* A handful of Sage documents carry a charge or discount that belongs to
          no single line. Show it, so the lines always add up to the invoice. */}
      {data?.adjustment != null && (
        <tr className="bg-background/60 border-b border-border/10">
          <td colSpan={4} className="px-3 py-1 pl-20 text-[11px] italic text-muted-foreground">
            Document-level adjustment (not attributable to a line)
          </td>
          <td className="px-3 py-1 text-right text-[11px] border-l border-border/40"><Money v={data.adjustment} /></td>
          <td className="px-3 py-1" />
          <td className="px-3 py-1 text-right text-[11px] border-l border-border/40"><Profit v={data.adjustment} /></td>
          <td className="px-3 py-1" />
        </tr>
      )}
      <tr className="bg-background/60 border-b border-border/30">
        <td colSpan={4} className="px-3 py-1 pl-20 font-mono text-[10px] uppercase tracking-wider text-muted-subtle">
          {doc.doc_number} · {lines.length} {lines.length === 1 ? 'line' : 'lines'}
        </td>
        <td className="px-3 py-1 text-right text-[11px] border-l border-border/40"><Money v={data.totals.selling} bold /></td>
        <td className="px-3 py-1 text-right text-[11px]"><Money v={data.totals.cost} bold /></td>
        <td className="px-3 py-1 text-right text-[11px] border-l border-border/40"><Profit v={data.totals.profit} bold /></td>
        <td className="px-3 py-1 text-right text-[11px]"><Margin v={data.totals.margin} profit={data.totals.profit} bold /></td>
      </tr>
    </>
  );
}

const Chevron = ({ open }) => (
  <span className="inline-block w-3 font-mono text-[10px] text-muted-foreground">{open ? '▾' : '▸'}</span>
);

export default function InvoiceProfit() {
  const [from, setFrom] = useState(monthStartISO());
  const [to, setTo] = useState(todayISO());
  // mode: 'all' | 'losses' | 'range'. The range bounds are inclusive and read
  // either as rand of profit or as margin %, per `unit`.
  const [filter, setFilter] = useState({ mode: 'all', min: '', max: '', unit: 'rand' });
  const setF = (patch) => setFilter((f) => ({ ...f, ...patch }));
  // Expansion state keyed by month/week/day id. Everything below a month starts
  // closed — a month of invoices is thousands of rows, and rendering them all up
  // front makes the report unusable. A key absent from the map means "default",
  // which is open for a month when the range covers only one.
  const [expanded, setExpanded] = useState({});
  const toggle = (k) => setExpanded((s) => ({ ...s, [k]: !(k in s ? s[k] : false) }));

  const { data, isLoading, error } = useQuery({
    queryKey: ['invoice-profit', from, to, filter.mode, filter.min, filter.max, filter.unit],
    queryFn: () => fetchProfit(from, to, filter),
    staleTime: 60_000,
  });

  const unavailable = !!data?.unavailable;
  const months = data?.months || [];
  const totals = data?.totals;
  const excluded = data?.excluded;
  // Non-null only when the range spans more than one month — see the strip below.
  const rangeStats = data?.range_stats;
  const activeFilter = data?.filter?.active ? data.filter : null;

  const exportCsv = () => {
    const cell = (v) => Number(v || 0).toFixed(2);
    const header = ['Level', 'Period / Document', 'Type', 'Customer', 'Invoices', 'Credit notes', 'Selling (ex-VAT)', 'Cost', 'Profit', 'Margin %'];
    const rows = [];
    const totalsRow = (level, label, t) => [level, label, '', '', t.invoice_count, t.credit_note_count, cell(t.selling), cell(t.cost), cell(t.profit), cell(t.margin)];
    for (const m of months) {
      rows.push(totalsRow('Month', m.label, m.totals));
      for (const w of m.weeks) {
        rows.push(totalsRow('Week', `${w.label}${w.partial ? ' (part)' : ''} ${w.week_start}–${w.week_end}`, w.totals));
        for (const d of w.days) {
          rows.push(totalsRow('Day', d.day, d.totals));
          for (const doc of d.documents) {
            rows.push(['Document', doc.doc_number, doc.doc_type === 'credit_note' ? 'Credit note' : 'Invoice',
              doc.customer_name, '', '', cell(doc.selling), cell(doc.cost), cell(doc.profit), cell(doc.margin)]);
          }
        }
      }
    }
    if (totals) rows.push(totalsRow('TOTAL', `${from} to ${to}`, totals));
    downloadCsv(`invoice-profit-${from}-to-${to}.csv`, [header, ...rows]);
  };

  const exportPdf = async () => {
    try {
      await downloadReport(`/api/reports/invoice-profit/export.pdf?${profitQuery(from, to, filter)}`, `invoice-profit-${from}-to-${to}.pdf`);
    } catch (e) {
      toast.error(`Could not download the Invoice Profit PDF: ${e.message}`);
    }
  };

  const exportExcel = async () => {
    try {
      await downloadReport(`/api/reports/invoice-profit/export?${profitQuery(from, to, filter)}`, `invoice-profit-${from}-to-${to}.xlsx`);
    } catch (e) {
      toast.error(`Could not download the Invoice Profit workbook: ${e.message}`);
    }
  };

  const generatedAtFmt = new Date().toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  // A single month is open by default; with several in range they all start
  // closed so the page opens on month totals rather than a wall of weeks.
  const monthOpen = (key) => (key in expanded ? expanded[key] : months.length === 1);

  return (
    <ReportFrame
      title={<>Invoice <em className="text-phosphor">Profit</em>.</>}
      subtitle="Every posted invoice with its selling, cost and profit, rolled up by day, week and month. Cost is what Sage costed onto the document when it was raised, so these figures never restate themselves. Credit notes are netted off; inter-branch depot transfers are excluded. Amounts ex-VAT, in Rand (R)."
      printId="invoice-profit"
      orientation="landscape"
      onExportCsv={months.length ? exportCsv : undefined}
      onExportExcel={months.length ? exportExcel : undefined}
      onExportPdf={months.length ? exportPdf : undefined}
      onPrint={() => window.print()}
      isLoading={isLoading}
      error={error?.message}
      printHeader={
        <PrintHeader
          title="Invoice Profit"
          period={`${from} to ${to}`}
          filters={['Ex-VAT, in Rand (R)', 'Credit notes netted off', 'Inter-branch transfers excluded']}
          generatedAt={generatedAtFmt}
        />
      }
      printFooter={<PrintFooter note="Invoice Profit · Cardoso · Confidential — contains cost and margin" />}
    >
      <div className="report-print-hide mb-4 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">From</span>
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)}
            className="h-9 rounded-xl border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary" />
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">To</span>
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)}
            className="h-9 rounded-xl border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary" />
        </div>

        {/* Profit filter. 'Made no profit' is the common case as a one-click
            preset; 'Profit between' is the general form, in rand or margin %. */}
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Show</span>
          <select
            value={filter.mode}
            onChange={(e) => setF({ mode: e.target.value })}
            className="h-9 rounded-xl border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="all">All documents</option>
            <option value="losses">Invoices that made no profit</option>
            <option value="range">Invoices in a profit range</option>
          </select>
        </div>

        {filter.mode === 'range' && (
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">From</span>
            <input
              type="number" value={filter.min} placeholder="any" step="any"
              onChange={(e) => setF({ min: e.target.value })}
              className="h-9 w-24 rounded-xl border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">to</span>
            <input
              type="number" value={filter.max} placeholder="any" step="any"
              onChange={(e) => setF({ max: e.target.value })}
              className="h-9 w-24 rounded-xl border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
            {/* Rand or margin % — 'made 5 or less' means different things to
                different people, so the unit is explicit rather than assumed. */}
            <div className="flex overflow-hidden rounded-xl border border-border">
              {[['rand', 'R'], ['pct', '%']].map(([u, lbl]) => (
                <button
                  key={u}
                  onClick={() => setF({ unit: u })}
                  className={`h-9 px-3 font-mono text-[11px] transition-colors ${filter.unit === u ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  {lbl}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* When a filter is on, say plainly what's being shown and what isn't —
          the totals below describe the MATCHING invoices only. */}
      {activeFilter && (
        <div
          className="mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-2.5 text-sm"
          style={{ border: '1px solid var(--phosphor)', borderRadius: '12px', background: 'hsla(33, 95%, 55%, 0.06)' }}
        >
          <span className="font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: 'var(--phosphor)' }}>Filtered</span>
          <span className="text-foreground">{activeFilter.label}.</span>
          <span className="text-muted-foreground">
            {fmtCount(activeFilter.matched)} of {fmtCount(activeFilter.of_invoices)} invoices match — every total below covers those only.
            Credit notes are left out: each one reverses a sale, so all of them show a negative profit and would swamp the result.
          </span>
        </div>
      )}

      {unavailable ? (
        <div className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          {data?.message || 'Invoice profit is not available on the hub.'}
        </div>
      ) : !isLoading && !error && months.length === 0 ? (
        <div className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          {activeFilter
            ? `No invoices between ${from} and ${to} match: ${activeFilter.label.toLowerCase()}.`
            : `No posted invoices between ${from} and ${to}.`}
        </div>
      ) : months.length > 0 ? (
        <>
          {/* Summary strip. The day/week/month "to date" figures are anchored on
              the last day in the range — meaningful for a single month, but over
              a multi-month range they'd describe one Friday and one part-week
              above a table covering half a year. So a multi-month range gets
              month-vs-month figures instead (range_stats is null for one month,
              which is the server telling us which strip to draw). */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {rangeStats ? (
              <>
                <ToDateCard label="Range total" sub={`${from} → ${to}`} totals={totals} accent />
                <ToDateCard label="Best month" sub={rangeStats.best_month?.label} totals={rangeStats.best_month?.totals} />
                <ToDateCard label="Weakest month" sub={rangeStats.weakest_month?.label} totals={rangeStats.weakest_month?.totals} />
                <ToDateCard label="Monthly average" sub={`across ${rangeStats.month_count} months`} totals={rangeStats.monthly_average} />
              </>
            ) : (
              <>
                <ToDateCard label="Day to date" sub={data?.latest_day} totals={data?.day_to_date} />
                <ToDateCard label="Week to date" sub={data?.latest_day ? `to ${data.latest_day}` : ''} totals={data?.week_to_date} />
                <ToDateCard label="Month to date" sub={data?.latest_day ? `to ${data.latest_day}` : ''} totals={data?.month_to_date} />
                <ToDateCard label="Range total" sub={`${from} → ${to}`} totals={totals} accent />
              </>
            )}
          </div>

          {/* Month → Week → Day → invoices */}
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-sm report-doc-table" style={{ minWidth: 940 }}>
              <thead>
                <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-1.5 text-left font-medium">Period</th>
                  <th className="px-3 py-1.5 text-left font-medium">Customer</th>
                  <th className="px-3 py-1.5 text-right font-medium">Inv</th>
                  <th className="px-3 py-1.5 text-right font-medium">CN</th>
                  <th className="px-3 py-1.5 text-right font-medium border-l border-border">Selling (ex-VAT)</th>
                  <th className="px-3 py-1.5 text-right font-medium">Cost</th>
                  <th className="px-3 py-1.5 text-right font-medium border-l border-border">Profit</th>
                  <th className="px-3 py-1.5 text-right font-medium">Margin</th>
                </tr>
              </thead>
              <tbody>
                {months.map((m) => {
                  const mOpen = monthOpen(m.month);
                  return (
                    <Fragment key={m.month}>
                      <tr
                        className="border-b border-border bg-muted/40 hover:bg-muted/60 cursor-pointer print:break-inside-avoid"
                        onClick={() => setExpanded((s) => ({ ...s, [m.month]: !mOpen }))}
                      >
                        <td className="px-3 py-2 font-display text-base" colSpan={2}>
                          <Chevron open={mOpen} /> {m.label}
                        </td>
                        <TotalsCells totals={m.totals} bold />
                      </tr>

                      {mOpen && m.weeks.map((w) => {
                        const wKey = `${m.month}/${w.key}`;
                        const wOpen = !!expanded[wKey];
                        return (
                          <Fragment key={wKey}>
                            <tr className="border-b border-border/60 hover:bg-muted/20 cursor-pointer" onClick={() => toggle(wKey)}>
                              <td className="px-3 py-1.5 pl-6" colSpan={2}>
                                <Chevron open={wOpen} />{' '}
                                <span className="font-medium">{w.label}</span>{' '}
                                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-subtle">
                                  {w.week_start} – {w.week_end}
                                  {/* A week that straddles two months appears under both, holding
                                      only that month's days, so the levels still sum exactly. */}
                                  {w.partial && <span className="ml-1 text-phosphor">part</span>}
                                </span>
                              </td>
                              <TotalsCells totals={w.totals} />
                            </tr>

                            {wOpen && w.days.map((d) => {
                              const dKey = `${wKey}/${d.day}`;
                              const dOpen = !!expanded[dKey];
                              return (
                                <Fragment key={dKey}>
                                  <tr className="border-b border-border/40 hover:bg-muted/20 cursor-pointer" onClick={() => toggle(dKey)}>
                                    <td className="px-3 py-1.5 pl-12" colSpan={2}>
                                      <Chevron open={dOpen} />{' '}
                                      <span className="font-mono text-xs">{d.day}</span>{' '}
                                      <span className="text-muted-subtle text-xs">{d.label}</span>
                                    </td>
                                    <TotalsCells totals={d.totals} />
                                  </tr>

                                  {dOpen && d.documents.map((doc) => {
                                    const docKey = `${dKey}/${doc.doc_type}/${doc.doc_number}`;
                                    const docOpen = !!expanded[docKey];
                                    return (
                                    <Fragment key={docKey}>
                                    <tr
                                      className="border-b border-border/20 bg-background/40 hover:bg-muted/10 cursor-pointer"
                                      onClick={() => toggle(docKey)}
                                    >
                                      <td className="px-3 py-1 pl-16 font-mono text-xs">
                                        <Chevron open={docOpen} /> {doc.doc_number}
                                        {doc.doc_type === 'credit_note' && (
                                          <span className="ml-2 rounded px-1 py-0.5 text-[9px] uppercase tracking-wider text-red-400 border border-red-400/40">CN</span>
                                        )}
                                      </td>
                                      <td className="px-3 py-1 text-xs">
                                        {doc.customer_name || doc.customer_code}
                                        {doc.customer_name && <span className="ml-1.5 font-mono text-[10px] text-muted-subtle">{doc.customer_code}</span>}
                                      </td>
                                      <td className="px-3 py-1" colSpan={2} />
                                      <td className="px-3 py-1 text-right border-l border-border/40"><Money v={doc.selling} /></td>
                                      <td className="px-3 py-1 text-right"><Money v={doc.cost} /></td>
                                      <td className="px-3 py-1 text-right border-l border-border/40"><Profit v={doc.profit} /></td>
                                      <td className="px-3 py-1 text-right"><Margin v={doc.margin} profit={doc.profit} /></td>
                                    </tr>
                                    {docOpen && <DocumentLines doc={doc} colSpan={8} />}
                                    </Fragment>
                                    );
                                  })}
                                </Fragment>
                              );
                            })}
                          </Fragment>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border bg-muted/40">
                  <td className="px-3 py-2 font-semibold" colSpan={2}>Total · {from} to {to}</td>
                  <TotalsCells totals={totals} bold />
                </tr>
              </tfoot>
            </table>
          </div>

          {/* What the report left out — stated, never silently dropped. */}
          {!!excluded?.count && (
            <p className="text-xs text-muted-foreground">
              Excluded {fmtCount(excluded.count)} inter-branch transfer {excluded.count === 1 ? 'document' : 'documents'} worth{' '}
              <span className="tabular-nums">R {fmtRSigned(excluded.selling)}</span> selling / <span className="tabular-nums">R {fmtRSigned(excluded.cost)}</span> cost.
              {' '}{excluded.reason}
            </p>
          )}
        </>
      ) : null}
    </ReportFrame>
  );
}
