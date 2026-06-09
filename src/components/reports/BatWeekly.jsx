import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isoYear } from '@/lib/isoWeek';
import {
  ReportFrame, ChartCard, SummaryTile, PrintHeader, PrintFooter,
  fmtR, fmtRSigned, fmtCount, downloadCsv, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  AXIS_TICK, AXIS_LINE, AXIS_LABEL,
  TOOLTIP_CONTENT, TOOLTIP_LABEL, TOOLTIP_ITEM, TOOLTIP_CURSOR,
  LEGEND_WRAPPER,
  REPORT_COLORS, fmtCompactR,
} from './lib';

function fetchBatWeekly(year) {
  const qs = new URLSearchParams();
  if (year) qs.set('year', String(year));
  return fetch(`/api/reports/bat-weekly?${qs.toString()}`, { credentials: 'include' })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

export default function BatWeekly() {
  // ISO year (not calendar year) — bat_reconciliations is keyed on ISO
  // (week, year) so the per-year filter must match.
  const [year, setYear] = useState(() => isoYear(new Date()));

  const { data, isLoading, error } = useQuery({
    queryKey: ['bat-weekly', year],
    queryFn: () => fetchBatWeekly(year),
    staleTime: 60_000,
  });

  const weeks = data?.weeks || [];
  const summary = data?.summary;

  // Reverse for chart so weeks ascend left → right
  const chartData = useMemo(() => weeks.slice().reverse().map(w => ({
    label: `W${w.week_number}`,
    week: w.week_number,
    bat:  w.supplier_total,
    sage: w.sage_total,
    variance: w.variance,
    exc: w.exc_amount,
  })), [weeks]);

  const handleExportCsv = () => {
    if (!weeks.length) return;
    const headers = ['Year', 'Week', 'BAT Total (R)', 'Sage Total (R)', 'Variance (R)', 'Status', 'OCR %', 'Exception Count', 'Exception Amount (R)'];
    const rows = weeks.map(w => [
      w.year, w.week_number, w.supplier_total.toFixed(2), w.sage_total.toFixed(2), w.variance.toFixed(2),
      w.matched ? 'Matched' : w.sage_present ? 'Mismatch' : 'Awaiting',
      w.ocr_pct.toFixed(1), w.exc_count, w.exc_amount.toFixed(2),
    ]);
    downloadCsv(`bat-weekly-${year}.csv`, [headers, ...rows]);
  };

  const generatedAt = data?.generated_at ? new Date(data.generated_at) : new Date();
  const generatedAtFmt = generatedAt.toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <ReportFrame
      sectionLabel="BAT Reconciliation"
      title={<>Weekly <em className="text-phosphor">reconciliation</em>.</>}
      subtitle="BAT supplier totals vs. Sage credit notes per week, with variance, OCR coverage and exception load."
      printId="bat-weekly"
      orientation="landscape"
      onExportCsv={weeks.length ? handleExportCsv : null}
      onPrint={() => window.print()}
      isLoading={isLoading}
      error={error}
      printHeader={
        <PrintHeader
          title={`BAT Weekly Reconciliation · ${year}`}
          period={`${weeks.length} weeks`}
          filters={[`Year ${year}`]}
          generatedAt={generatedAtFmt}
        />
      }
      printFooter={<PrintFooter note="BAT Weekly Reconciliation · Cardoso" />}
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

      {data?.hub_unavailable && (
        <div className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          BAT reconciliation runs per branch — open this report on a branch (site) install. The hub doesn&apos;t consolidate per-branch BAT recon data.
        </div>
      )}
      {data && summary && (
        <>
          <div className="report-print-summary grid grid-cols-2 md:grid-cols-5 gap-3">
            <SummaryTile label="Weeks" value={fmtCount(summary.weeks_count)} accent={REPORT_COLORS.primary} />
            <SummaryTile label="Total BAT" value={<><span className="text-muted-foreground/60 mr-1">R</span>{fmtR(summary.total_supplier)}</>} accent={REPORT_COLORS.primary} />
            <SummaryTile label="Total Credit Notes" value={<><span className="text-muted-foreground/60 mr-1">R</span>{fmtR(summary.total_sage)}</>} accent={REPORT_COLORS.secondary} />
            <SummaryTile
              label="Total Variance"
              value={<><span className="text-muted-foreground/60 mr-1">R</span>{fmtRSigned(summary.total_variance)}</>}
              sub={summary.total_variance > 0 ? 'BAT higher' : summary.total_variance < 0 ? 'Sage higher' : 'matched'}
              accent={Math.abs(summary.total_variance) < 1 ? REPORT_COLORS.secondary : REPORT_COLORS.danger}
              big
            />
            <SummaryTile
              label="Status mix"
              value={<>{summary.matched_count}<span className="text-muted-foreground/60 text-base ml-1">/{summary.weeks_count}</span></>}
              sub={`${summary.mismatch_count} mismatch · ${summary.awaiting_count} awaiting`}
              accent={REPORT_COLORS.info}
            />
          </div>

          <div className="report-print-hide grid grid-cols-1 lg:grid-cols-2 gap-3 mt-4">
            <ChartCard title="Weekly BAT vs Credit Notes" sub="Side-by-side per week">
              <BarChart data={chartData} margin={{ top: 10, right: 16, left: 6, bottom: 32 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="label" tick={AXIS_TICK} tickLine={AXIS_LINE} axisLine={AXIS_LINE}
                  interval={Math.floor(chartData.length / 12) || 0}
                  label={{ value: 'Week', position: 'insideBottom', offset: -5, style: AXIS_LABEL }} />
                <YAxis tick={AXIS_TICK} tickLine={AXIS_LINE} axisLine={AXIS_LINE} tickFormatter={fmtCompactR} width={70}
                  label={{ value: 'Rand', angle: -90, position: 'insideLeft', offset: 10, style: AXIS_LABEL }} />
                <Tooltip contentStyle={TOOLTIP_CONTENT} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={TOOLTIP_CURSOR}
                  formatter={(v, n) => [`R ${fmtR(v)}`, n === 'bat' ? 'BAT' : 'Credit Notes']} />
                <Legend wrapperStyle={LEGEND_WRAPPER} iconType="square" />
                <Bar dataKey="bat" name="BAT" fill={REPORT_COLORS.primary} radius={[2, 2, 0, 0]} />
                <Bar dataKey="sage" name="Credit Notes" fill={REPORT_COLORS.secondary} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ChartCard>
            <ChartCard title="Total value per week" sub="BAT vs Credit Notes (R)"
              hint="Each week's BAT supplier total and Sage credit-notes total, in Rand. The two lines should track closely on a clean reconciliation — a visible gap between them is that week's variance.">

              <LineChart data={chartData} margin={{ top: 10, right: 16, left: 6, bottom: 32 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="label" tick={AXIS_TICK} tickLine={AXIS_LINE} axisLine={AXIS_LINE}
                  interval={Math.floor(chartData.length / 12) || 0}
                  label={{ value: 'Week', position: 'insideBottom', offset: -5, style: AXIS_LABEL }} />
                <YAxis tick={AXIS_TICK} tickLine={AXIS_LINE} axisLine={AXIS_LINE} tickFormatter={fmtCompactR} width={70}
                  label={{ value: 'Rand', angle: -90, position: 'insideLeft', offset: 10, style: AXIS_LABEL }} />
                <Tooltip contentStyle={TOOLTIP_CONTENT} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={TOOLTIP_CURSOR}
                  formatter={(v) => `R ${fmtR(v)}`} />
                <Legend wrapperStyle={LEGEND_WRAPPER} iconType="square" />
                <Line type="monotone" dataKey="bat" name="BAT" stroke={REPORT_COLORS.primary} strokeWidth={2} dot={{ r: 2, fill: REPORT_COLORS.primary }} />
                <Line type="monotone" dataKey="sage" name="Credit Notes" stroke={REPORT_COLORS.secondary} strokeWidth={2} dot={{ r: 2, fill: REPORT_COLORS.secondary }} />
              </LineChart>
            </ChartCard>
          </div>

          <div className="bg-card border border-border mt-4 overflow-auto" style={{ borderRadius: '12px' }}>
            <table className="report-print-table w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Year</th>
                  <th className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Wk</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">BAT</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">Credit Notes</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">Variance</th>
                  <th className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Status</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">OCR</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">Exc.</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">Exc. R</th>
                </tr>
              </thead>
              <tbody>
                {weeks.length === 0 && (
                  <tr><td colSpan={9} className="px-3 py-8 text-center text-muted-foreground font-mono text-[11px]">No reconciliations for this year.</td></tr>
                )}
                {weeks.map((w) => {
                  const status = w.matched ? { label: 'Matched', color: REPORT_COLORS.secondary } :
                                 w.sage_present ? { label: 'Mismatch', color: REPORT_COLORS.danger } :
                                 { label: 'Awaiting', color: REPORT_COLORS.purple };
                  return (
                    <tr key={`${w.year}-${w.week_number}`} className="border-b border-border hover:bg-muted/30">
                      <td className="px-2 py-1.5 font-mono text-muted-foreground tabular-nums">{w.year}</td>
                      <td className="px-2 py-1.5 font-mono text-foreground tabular-nums">{w.week_number}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-foreground td-right">
                        <span className="text-muted-foreground/60 mr-1">R</span>{fmtR(w.supplier_total)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-foreground td-right">
                        {w.sage_present ? <><span className="text-muted-foreground/60 mr-1">R</span>{fmtR(w.sage_total)}</> : '—'}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums td-right" style={{ color: w.matched ? 'hsl(145 55% 45%)' : (w.sage_present ? 'hsl(0 72% 50%)' : 'hsl(var(--muted-foreground))') }}>
                        {w.sage_present ? <><span className="opacity-60 mr-1">R</span>{fmtRSigned(w.variance)}</> : '—'}
                      </td>
                      <td className="px-2 py-1.5">
                        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.15em]" style={{ color: status.color }}>● {status.label}</span>
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground td-right">
                        {w.found_count}/{w.pod_count}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground td-right">{w.exc_count || '—'}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground td-right">
                        {w.exc_amount > 0 ? <><span className="text-muted-foreground/60 mr-1">R</span>{fmtR(w.exc_amount)}</> : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {weeks.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                    <td className="px-2 py-2 text-foreground" colSpan={2}>Total ({summary.weeks_count} weeks)</td>
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
                    <td className="px-2 py-2"></td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums text-foreground td-right">{summary.total_exceptions}</td>
                    <td className="px-2 py-2 text-right font-mono tabular-nums text-foreground td-right">
                      <span className="text-muted-foreground/60 mr-1">R</span>{fmtR(summary.total_exception_amount)}
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
