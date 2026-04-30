import { useMemo, useState, Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ReportFrame, ChartCard, SummaryTile, PrintHeader, PrintFooter,
  fmtR, fmtCount, downloadCsv,
  ResponsiveContainer, BarChart, Bar, Cell,
  ThemedXAxis, ThemedYAxis, ThemedTooltip, ThemedGrid,
  REPORT_COLORS,
} from './lib';

function fetchRepExposure(minBalance) {
  const qs = new URLSearchParams();
  if (minBalance) qs.set('min_balance', String(minBalance));
  return fetch(`/api/reports/rep-exposure?${qs.toString()}`, { credentials: 'include' })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

export default function SalesRepExposure() {
  const [minBalance, setMinBalance] = useState(3);
  const [expandedRep, setExpandedRep] = useState(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['rep-exposure', minBalance],
    queryFn: () => fetchRepExposure(minBalance),
    staleTime: 60_000,
  });

  const reps = data?.reps || [];
  const summary = data?.summary;

  const chartData = useMemo(() => reps.slice(0, 20).map(r => ({
    name: r.sales_rep.length > 18 ? r.sales_rep.slice(0, 16) + '…' : r.sales_rep,
    fullName: r.sales_rep,
    total: r.total_outstanding,
    count: r.customer_count,
    red: r.flag_counts.red,
  })), [reps]);

  const handleExportCsv = () => {
    if (!reps.length) return;
    const headers = ['Sales Rep', 'Customers', 'Total Outstanding (R)', 'Red Flags', 'Orange Flags', 'Green Flags', 'Unflagged'];
    const rows = reps.map(r => [
      r.sales_rep, r.customer_count, r.total_outstanding.toFixed(2),
      r.flag_counts.red, r.flag_counts.orange, r.flag_counts.green, r.flag_counts.none,
    ]);
    downloadCsv(`sales-rep-exposure-${new Date().toISOString().slice(0, 10)}.csv`, [headers, ...rows]);
  };

  const generatedAt = data?.generated_at ? new Date(data.generated_at) : new Date();
  const generatedAtFmt = generatedAt.toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <ReportFrame
      sectionLabel="Accounts Receivable"
      title={<>Sales Rep <em className="text-phosphor">exposure</em>.</>}
      subtitle="Total outstanding per rep, flag mix, and the top customers driving the exposure."
      printId="rep-exposure"
      orientation="portrait"
      onExportCsv={reps.length ? handleExportCsv : null}
      onPrint={() => window.print()}
      isLoading={isLoading}
      error={error}
      printHeader={
        <PrintHeader
          title="Sales Rep Exposure"
          period={data?.site_name}
          filters={[`Min balance R ${minBalance}`]}
          generatedAt={generatedAtFmt}
        />
      }
      printFooter={<PrintFooter note="Sales Rep Exposure · Cardoso" />}
    >
      <div className="report-print-hide bg-card border border-border p-3 grid grid-cols-2 lg:grid-cols-4 gap-3" style={{ borderRadius: '12px' }}>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-1">Min Balance (R)</label>
          <input
            type="number" min={0} step={1} value={minBalance}
            onChange={(e) => setMinBalance(parseFloat(e.target.value) || 0)}
            className="w-full bg-background border border-border text-foreground px-2 py-1.5 text-xs tabular-nums outline-none focus:border-accent"
            style={{ borderRadius: '12px' }}
          />
        </div>
      </div>

      {data && summary && (
        <>
          <div className="report-print-summary grid grid-cols-2 md:grid-cols-4 gap-3">
            <SummaryTile label="Sales Reps" value={fmtCount(summary.total_reps)} accent={REPORT_COLORS.primary} />
            <SummaryTile label="Customers" value={fmtCount(summary.total_customers)} accent={REPORT_COLORS.info} />
            <SummaryTile label="Total Outstanding" value={<><span className="text-muted-foreground/60 mr-1">R</span>{fmtR(summary.total_outstanding)}</>} accent={REPORT_COLORS.primary} big />
            <SummaryTile label="Red-flagged" value={fmtCount(summary.total_red)} sub={`+ ${summary.total_orange} orange`} accent={REPORT_COLORS.danger} />
          </div>

          <div className="report-print-hide mt-4">
            <ChartCard title="Outstanding by Sales Rep · Top 20" sub="Bar = total R; opacity scales with red-flag count" height={Math.max(300, chartData.length * 22)}>
              <BarChart data={chartData} layout="vertical" margin={{ top: 10, right: 16, left: 100, bottom: 24 }}>
                <ThemedGrid />
                <ThemedXAxis type="number" currency label="Outstanding (R)" />
                <ThemedYAxis type="category" dataKey="name" width={120} tickFormatter={(v) => v} label="" />
                <ThemedTooltip formatter={(v, n, p) => [`R ${fmtR(v)} · ${p.payload.count} cust · ${p.payload.red} red`, p.payload.fullName]} />
                <Bar dataKey="total" radius={[0, 2, 2, 0]}>
                  {chartData.map((entry, i) => (
                    <Cell key={i} fill={REPORT_COLORS.primary} fillOpacity={Math.min(0.3 + (entry.red * 0.15), 1)} />
                  ))}
                </Bar>
              </BarChart>
            </ChartCard>
          </div>

          <div className="report-print-section-title hidden">Per-Rep Detail</div>
          <div className="bg-card border border-border mt-4 overflow-auto" style={{ borderRadius: '12px' }}>
            <table className="report-print-table w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Sales Rep</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Cust</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground" style={{ color: 'hsl(0 72% 50%)' }}>Red</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground" style={{ color: 'hsl(33 95% 55%)' }}>Orange</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground" style={{ color: 'hsl(145 55% 45%)' }}>Green</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {reps.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-8 text-center text-muted-foreground font-mono text-[11px]">No reps to show.</td></tr>
                )}
                {reps.map((r) => {
                  const isOpen = expandedRep === r.sales_rep;
                  return (
                    <Fragment key={r.sales_rep}>
                      <tr
                        className="border-b border-border hover:bg-muted/30 cursor-pointer"
                        onClick={() => setExpandedRep(isOpen ? null : r.sales_rep)}
                      >
                        <td className="px-2 py-1.5 text-foreground">
                          <span className="font-mono text-muted-foreground/60 mr-2">{isOpen ? '▾' : '▸'}</span>
                          {r.sales_rep}
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums text-foreground">{fmtCount(r.customer_count)}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums" style={{ color: r.flag_counts.red ? 'hsl(0 72% 50%)' : 'hsl(var(--muted-foreground))' }}>{r.flag_counts.red || '—'}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums" style={{ color: r.flag_counts.orange ? 'hsl(33 95% 55%)' : 'hsl(var(--muted-foreground))' }}>{r.flag_counts.orange || '—'}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums" style={{ color: r.flag_counts.green ? 'hsl(145 55% 45%)' : 'hsl(var(--muted-foreground))' }}>{r.flag_counts.green || '—'}</td>
                        <td className="px-2 py-1.5 text-right font-mono tabular-nums text-foreground td-right">
                          <span className="text-muted-foreground/60 mr-1">R</span>{fmtR(r.total_outstanding)}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={6} className="px-2 py-2 bg-muted/20">
                            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-2">Top 10 customers</div>
                            <table className="w-full text-xs">
                              <tbody>
                                {r.top_customers.map(c => (
                                  <tr key={c.customer_number} className="border-b border-border/50">
                                    <td className="px-2 py-1 font-mono text-muted-foreground">{c.customer_number}</td>
                                    <td className="px-2 py-1 text-foreground">{c.customer_name}</td>
                                    <td className="px-2 py-1 text-right font-mono tabular-nums text-foreground">
                                      <span className="text-muted-foreground/60 mr-1">R</span>{fmtR(c.outstanding_balance)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
              {reps.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                    <td className="px-2 py-2 text-foreground">Total</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">{fmtCount(summary.total_customers)}</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums" style={{ color: 'hsl(0 72% 50%)' }}>{summary.total_red}</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums" style={{ color: 'hsl(33 95% 55%)' }}>{summary.total_orange}</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums">—</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums text-foreground td-right">
                      <span className="text-muted-foreground/60 mr-1">R</span>{fmtR(summary.total_outstanding)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      )}
    </ReportFrame>
  );
}
