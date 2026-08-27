import { useState, Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ReportFrame, PrintHeader, PrintFooter, fmtR, fmtCount, downloadCsv, downloadReport } from './lib';

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

function fetchProfit(from, to) {
  const qs = new URLSearchParams({ from, to });
  return fetch(`/api/reports/invoice-profit?${qs.toString()}`, { credentials: 'include' })
    .then(async (r) => {
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || `HTTP ${r.status}`); }
      return r.json();
    });
}

// Profit and margin read red below zero — a loss-making day should be obvious
// at a glance, not something you have to spot the minus sign for.
const toneFor = (v) => (v < 0 ? 'text-red-400' : v > 0 ? 'text-emerald-500' : 'text-muted-foreground');
const Money = ({ v, bold }) => (
  <span className={`tabular-nums ${bold ? 'font-semibold' : ''}`}><span className="text-muted-subtle">R </span>{fmtR(v)}</span>
);
const Profit = ({ v, bold }) => (
  <span className={`tabular-nums ${toneFor(v)} ${bold ? 'font-semibold' : ''}`}><span className="opacity-60">R </span>{fmtR(v)}</span>
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

const Chevron = ({ open }) => (
  <span className="inline-block w-3 font-mono text-[10px] text-muted-foreground">{open ? '▾' : '▸'}</span>
);

export default function InvoiceProfit() {
  const [from, setFrom] = useState(monthStartISO());
  const [to, setTo] = useState(todayISO());
  // Expansion state keyed by month/week/day id. Everything below a month starts
  // closed — a month of invoices is thousands of rows, and rendering them all up
  // front makes the report unusable. A key absent from the map means "default",
  // which is open for a month when the range covers only one.
  const [expanded, setExpanded] = useState({});
  const toggle = (k) => setExpanded((s) => ({ ...s, [k]: !(k in s ? s[k] : false) }));

  const { data, isLoading, error } = useQuery({
    queryKey: ['invoice-profit', from, to],
    queryFn: () => fetchProfit(from, to),
    staleTime: 60_000,
  });

  const unavailable = !!data?.unavailable;
  const months = data?.months || [];
  const totals = data?.totals;
  const excluded = data?.excluded;

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

  const exportExcel = async () => {
    try {
      await downloadReport(`/api/reports/invoice-profit/export?from=${from}&to=${to}`, `invoice-profit-${from}-to-${to}.xlsx`);
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
      </div>

      {unavailable ? (
        <div className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          {data?.message || 'Invoice profit is not available on the hub.'}
        </div>
      ) : !isLoading && !error && months.length === 0 ? (
        <div className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          No posted invoices between {from} and {to}.
        </div>
      ) : months.length > 0 ? (
        <>
          {/* To-date strip */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <ToDateCard label="Day to date" sub={data?.latest_day} totals={data?.day_to_date} />
            <ToDateCard label="Week to date" sub={data?.latest_day ? `to ${data.latest_day}` : ''} totals={data?.week_to_date} />
            <ToDateCard label="Month to date" sub={data?.latest_day ? `to ${data.latest_day}` : ''} totals={data?.month_to_date} />
            <ToDateCard label="Range total" sub={`${from} → ${to}`} totals={totals} accent />
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

                                  {dOpen && d.documents.map((doc) => (
                                    <tr key={`${dKey}/${doc.doc_type}/${doc.doc_number}`} className="border-b border-border/20 bg-background/40 hover:bg-muted/10">
                                      <td className="px-3 py-1 pl-16 font-mono text-xs">
                                        {doc.doc_number}
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
                                  ))}
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
              <span className="tabular-nums">R {fmtR(excluded.selling)}</span> selling / <span className="tabular-nums">R {fmtR(excluded.cost)}</span> cost.
              {' '}{excluded.reason}
            </p>
          )}
        </>
      ) : null}
    </ReportFrame>
  );
}
