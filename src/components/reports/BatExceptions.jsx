import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ReportFrame, ChartCard, SummaryTile, PrintHeader, PrintFooter,
  fmtR, fmtCount, downloadCsv,
  ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell,
  ThemedXAxis, ThemedYAxis, ThemedTooltip, ThemedLegend, ThemedGrid,
  PALETTE, REPORT_COLORS,
} from './lib';

function fetchBatExceptions(year) {
  const qs = new URLSearchParams();
  if (year) qs.set('year', String(year));
  return fetch(`/api/reports/bat-exceptions?${qs.toString()}`, { credentials: 'include' })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

export default function BatExceptions() {
  const [year, setYear] = useState('all'); // 'all' | YYYY

  const yearParam = year === 'all' ? null : parseInt(year, 10);
  const { data, isLoading, error } = useQuery({
    queryKey: ['bat-exceptions', yearParam],
    queryFn: () => fetchBatExceptions(yearParam),
    staleTime: 60_000,
  });

  const summary = data?.summary;
  const byReason = data?.by_reason || [];
  const byStore = data?.by_store || [];

  const reasonChartData = useMemo(() => byReason.slice(0, 10).map((r, i) => ({
    name: r.reason.length > 30 ? r.reason.slice(0, 28) + '…' : r.reason,
    fullName: r.reason,
    amount: r.amount,
    count: r.count,
    color: PALETTE[i % PALETTE.length],
  })), [byReason]);

  const storeChartData = useMemo(() => byStore.slice(0, 15).map(s => ({
    name: s.store_name.length > 24 ? s.store_name.slice(0, 22) + '…' : s.store_name,
    fullName: s.store_name,
    amount: s.amount,
    count: s.count,
  })), [byStore]);

  const handleExportCsv = () => {
    const headers = ['Section', 'Label', 'Count', 'Amount (R)'];
    const rows = [
      ...byReason.map(r => ['Reason', r.reason, r.count, r.amount.toFixed(2)]),
      ...byStore.map(s => ['Store',  s.store_name, s.count, s.amount.toFixed(2)]),
    ];
    downloadCsv(`bat-exceptions-${year}.csv`, [headers, ...rows]);
  };

  const generatedAt = data?.generated_at ? new Date(data.generated_at) : new Date();
  const generatedAtFmt = generatedAt.toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <ReportFrame
      sectionLabel="BAT Reconciliation"
      title={<>Exceptions <em className="text-phosphor">summary</em>.</>}
      subtitle="Every BAT-flagged invoice across all uploaded weeks, broken down by reason and by store."
      printId="bat-exceptions"
      orientation="portrait"
      onExportCsv={(byReason.length || byStore.length) ? handleExportCsv : null}
      onPrint={() => window.print()}
      isLoading={isLoading}
      error={error}
      printHeader={
        <PrintHeader
          title="BAT Exceptions Summary"
          period={year === 'all' ? 'All years' : `Year ${year}`}
          filters={[]}
          generatedAt={generatedAtFmt}
        />
      }
      printFooter={<PrintFooter note="BAT Exceptions Summary · Cardoso" />}
    >
      <div className="report-print-hide bg-card border border-border p-3 grid grid-cols-2 lg:grid-cols-4 gap-3" style={{ borderRadius: '2px' }}>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-1">Year</label>
          <select
            value={year}
            onChange={(e) => setYear(e.target.value)}
            className="w-full bg-background border border-border text-foreground px-2 py-1.5 text-xs outline-none focus:border-accent"
            style={{ borderRadius: '2px' }}
          >
            <option value="all">All years</option>
            {(data?.available_years || []).map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {data && summary && (
        <>
          <div className="report-print-summary grid grid-cols-2 md:grid-cols-4 gap-3">
            <SummaryTile label="Total exception value" value={<><span className="text-muted-foreground/60 mr-1">R</span>{fmtR(summary.total_amount)}</>} accent={REPORT_COLORS.warning} big />
            <SummaryTile label="Flagged invoices" value={fmtCount(summary.total_count)} accent={REPORT_COLORS.warning} />
            <SummaryTile label="Distinct reasons" value={fmtCount(summary.distinct_reasons)} accent={REPORT_COLORS.info} />
            <SummaryTile label="Distinct stores" value={fmtCount(summary.distinct_stores)} accent={REPORT_COLORS.purple} />
          </div>

          <div className="report-print-hide grid grid-cols-1 lg:grid-cols-2 gap-3 mt-4">
            <ChartCard title="Top exception reasons by R" sub="Top 10 · all-time">
              <BarChart data={reasonChartData} layout="vertical" margin={{ top: 10, right: 16, left: 110, bottom: 10 }}>
                <ThemedGrid />
                <ThemedXAxis type="number" currency label="Amount (R)" />
                <ThemedYAxis type="category" dataKey="name" width={130} tickFormatter={(v) => v} />
                <ThemedTooltip formatter={(v, n, p) => [`R ${fmtR(v)} · ${p.payload.count} inv`, p.payload.fullName]} />
                <Bar dataKey="amount" radius={[0, 2, 2, 0]}>
                  {reasonChartData.map((e, i) => <Cell key={i} fill={e.color} />)}
                </Bar>
              </BarChart>
            </ChartCard>
            <ChartCard title="Top stores by exception R" sub="Top 15">
              <BarChart data={storeChartData} layout="vertical" margin={{ top: 10, right: 16, left: 110, bottom: 10 }}>
                <ThemedGrid />
                <ThemedXAxis type="number" currency label="Amount (R)" />
                <ThemedYAxis type="category" dataKey="name" width={130} tickFormatter={(v) => v} />
                <ThemedTooltip formatter={(v, n, p) => [`R ${fmtR(v)} · ${p.payload.count} inv`, p.payload.fullName]} />
                <Bar dataKey="amount" fill={REPORT_COLORS.danger} radius={[0, 2, 2, 0]} />
              </BarChart>
            </ChartCard>
          </div>

          <div className="report-print-section-title hidden">Exceptions by Reason</div>
          <div className="bg-card border border-border mt-4 overflow-auto" style={{ borderRadius: '2px' }}>
            <div className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground border-b border-border">By reason</div>
            <table className="report-print-table w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Reason</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">Count</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">% of total</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {byReason.map((r) => {
                  const pct = summary.total_amount > 0 ? (r.amount / summary.total_amount) * 100 : 0;
                  return (
                    <tr key={r.reason} className="border-b border-border hover:bg-muted/30">
                      <td className="px-2 py-1.5 text-foreground">{r.reason}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground td-right">{r.count}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground td-right">{pct.toFixed(1)}%</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-foreground td-right">
                        <span className="text-muted-foreground/60 mr-1">R</span>{fmtR(r.amount)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                  <td className="px-2 py-2 text-foreground">Total</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums">{summary.total_count}</td>
                  <td className="px-2 py-2"></td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums text-foreground td-right">
                    <span className="text-muted-foreground/60 mr-1">R</span>{fmtR(summary.total_amount)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="bg-card border border-border mt-4 overflow-auto" style={{ borderRadius: '2px' }}>
            <div className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground border-b border-border">Top stores by exception value</div>
            <table className="report-print-table w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Store</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">Count</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {byStore.map(s => (
                  <tr key={s.store_name} className="border-b border-border hover:bg-muted/30">
                    <td className="px-2 py-1.5 text-foreground">{s.store_name}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground td-right">{s.count}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-foreground td-right">
                      <span className="text-muted-foreground/60 mr-1">R</span>{fmtR(s.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </ReportFrame>
  );
}
