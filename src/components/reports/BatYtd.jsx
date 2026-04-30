import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ReportFrame, ChartCard, SummaryTile, PrintHeader, PrintFooter,
  fmtR, fmtRSigned, fmtPct, downloadCsv,
  ResponsiveContainer, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  AXIS_TICK, AXIS_LINE, AXIS_LABEL,
  TOOLTIP_CONTENT, TOOLTIP_LABEL, TOOLTIP_ITEM, TOOLTIP_CURSOR,
  LEGEND_WRAPPER,
  REPORT_COLORS, fmtCompactR,
} from './lib';

const FEE_COLORS = {
  Discount: REPORT_COLORS.primary,
  Delivery: REPORT_COLORS.info,
  Pricing:  REPORT_COLORS.purple,
};

function fetchBatYtd(year) {
  const qs = new URLSearchParams({ year: String(year) });
  return fetch(`/api/reports/bat-ytd?${qs.toString()}`, { credentials: 'include' })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

export default function BatYtd() {
  const [year, setYear] = useState(new Date().getFullYear());

  const { data, isLoading, error } = useQuery({
    queryKey: ['bat-ytd', year],
    queryFn: () => fetchBatYtd(year),
    staleTime: 60_000,
  });

  const fees = data?.fees || [];
  const summary = data?.summary;

  const handleExportCsv = () => {
    if (!fees.length) return;
    const headers = ['Fee Type', 'BAT (R)', 'Sage (R)', 'Variance (R)', 'Variance %'];
    const rows = fees.map(f => [f.fee_type, f.supplier.toFixed(2), f.sage.toFixed(2), f.variance.toFixed(2), f.variance_pct.toFixed(2)]);
    downloadCsv(`bat-ytd-${year}.csv`, [headers, ...rows]);
  };

  const generatedAt = data?.generated_at ? new Date(data.generated_at) : new Date();
  const generatedAtFmt = generatedAt.toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <ReportFrame
      sectionLabel="BAT Reconciliation"
      title={<>YTD <em className="text-phosphor">fee breakdown</em>.</>}
      subtitle="Year-to-date BAT fees vs. Sage credit notes, broken down by fee type."
      printId="bat-ytd"
      orientation="portrait"
      onExportCsv={fees.length ? handleExportCsv : null}
      onPrint={() => window.print()}
      isLoading={isLoading}
      error={error}
      printHeader={
        <PrintHeader
          title={`BAT YTD Fee Breakdown · ${year}`}
          period={summary ? `${summary.weeks_uploaded} weeks uploaded` : ''}
          filters={[`Year ${year}`]}
          generatedAt={generatedAtFmt}
        />
      }
      printFooter={<PrintFooter note="BAT YTD Fee Breakdown · Cardoso" />}
    >
      <div className="report-print-hide bg-card border border-border p-3 grid grid-cols-2 lg:grid-cols-4 gap-3" style={{ borderRadius: '12px' }}>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-1">Year</label>
          <select
            value={year}
            onChange={(e) => setYear(parseInt(e.target.value, 10))}
            className="w-full bg-background border border-border text-foreground px-2 py-1.5 text-xs outline-none focus:border-accent"
            style={{ borderRadius: '12px' }}
          >
            {(data?.available_years || [year]).map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {data && summary && (
        <>
          <div className="report-print-summary grid grid-cols-2 md:grid-cols-4 gap-3">
            <SummaryTile label="Weeks uploaded" value={summary.weeks_uploaded.toLocaleString('en-ZA')} accent={REPORT_COLORS.primary} />
            <SummaryTile label="Total BAT" value={<><span className="text-muted-foreground/60 mr-1">R</span>{fmtR(summary.total_supplier)}</>} accent={REPORT_COLORS.primary} big />
            <SummaryTile label="Total Sage" value={<><span className="text-muted-foreground/60 mr-1">R</span>{fmtR(summary.total_sage)}</>} accent={REPORT_COLORS.secondary} />
            <SummaryTile
              label="Total Variance"
              value={<><span className="text-muted-foreground/60 mr-1">R</span>{fmtRSigned(summary.total_variance)}</>}
              sub={summary.total_variance > 0 ? 'BAT higher' : summary.total_variance < 0 ? 'Sage higher' : 'matched'}
              accent={Math.abs(summary.total_variance) < 1 ? REPORT_COLORS.secondary : REPORT_COLORS.danger}
            />
          </div>

          <div className="report-print-hide mt-4">
            <ChartCard title="BAT vs Sage by Fee Type" sub={`Year ${year} totals`} height={320}>
              <BarChart data={fees} margin={{ top: 10, right: 16, left: 6, bottom: 32 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="fee_type" tick={AXIS_TICK} tickLine={AXIS_LINE} axisLine={AXIS_LINE}
                  label={{ value: 'Fee type', position: 'insideBottom', offset: -5, style: AXIS_LABEL }} />
                <YAxis tick={AXIS_TICK} tickLine={AXIS_LINE} axisLine={AXIS_LINE} tickFormatter={fmtCompactR} width={70}
                  label={{ value: 'Rand', angle: -90, position: 'insideLeft', offset: 10, style: AXIS_LABEL }} />
                <Tooltip contentStyle={TOOLTIP_CONTENT} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={TOOLTIP_CURSOR}
                  formatter={(v, n) => [`R ${fmtR(v)}`, n === 'supplier' ? 'BAT' : 'Sage']} />
                <Legend wrapperStyle={LEGEND_WRAPPER} iconType="square" />
                <Bar dataKey="supplier" name="BAT" fill={REPORT_COLORS.primary} radius={[2, 2, 0, 0]} />
                <Bar dataKey="sage" name="Sage" fill={REPORT_COLORS.secondary} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ChartCard>
          </div>

          <div className="bg-card border border-border mt-4 overflow-auto" style={{ borderRadius: '12px' }}>
            <table className="report-print-table w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Fee type</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">BAT</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">Sage</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">Variance</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">Variance %</th>
                </tr>
              </thead>
              <tbody>
                {fees.map((f) => (
                  <tr key={f.fee_type} className="border-b border-border hover:bg-muted/30">
                    <td className="px-2 py-1.5 text-foreground">
                      <span className="inline-block w-2 h-2 mr-2" style={{ background: FEE_COLORS[f.fee_type] || REPORT_COLORS.muted }} />
                      {f.fee_type}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-foreground td-right">
                      <span className="text-muted-foreground/60 mr-1">R</span>{fmtR(f.supplier)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-foreground td-right">
                      <span className="text-muted-foreground/60 mr-1">R</span>{fmtR(f.sage)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums td-right" style={{ color: Math.abs(f.variance) < 0.01 ? 'hsl(145 55% 45%)' : 'hsl(0 72% 50%)' }}>
                      <span className="opacity-60 mr-1">R</span>{fmtRSigned(f.variance)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums td-right" style={{ color: Math.abs(f.variance_pct) < 0.5 ? 'hsl(145 55% 45%)' : 'hsl(0 72% 50%)' }}>
                      {fmtPct(f.variance_pct, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                  <td className="px-2 py-2 text-foreground">Total</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums text-foreground td-right">
                    <span className="text-muted-foreground/60 mr-1">R</span>{fmtR(summary.total_supplier)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums text-foreground td-right">
                    <span className="text-muted-foreground/60 mr-1">R</span>{fmtR(summary.total_sage)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums td-right" style={{ color: Math.abs(summary.total_variance) < 1 ? 'hsl(145 55% 45%)' : 'hsl(0 72% 50%)' }}>
                    <span className="opacity-60 mr-1">R</span>{fmtRSigned(summary.total_variance)}
                  </td>
                  <td className="px-2 py-2"></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </ReportFrame>
  );
}
