import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ReportFrame, ChartCard, SummaryTile, PrintHeader, PrintFooter,
  fmtR, fmtCompactR, downloadCsv, downloadReport, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  AXIS_TICK, AXIS_LINE, AXIS_LABEL,
  TOOLTIP_CONTENT, TOOLTIP_LABEL, TOOLTIP_ITEM, TOOLTIP_CURSOR,
  LEGEND_WRAPPER,
} from './lib';

// Sage A/P Aged Payables periods — MONTHLY (creditors age by due date), which
// differs from the weekly A/R debtor scheme.
const BUCKET_META = {
  current:   { label: 'Current',      color: 'hsl(145 55% 45%)', sortOrder: 0 },
  '1-30':    { label: '1–30 days',    color: 'hsl(80 60% 45%)',  sortOrder: 1 },
  '31-60':   { label: '31–60 days',   color: 'hsl(50 90% 55%)',  sortOrder: 2 },
  '61-90':   { label: '61–90 days',   color: 'hsl(33 95% 55%)',  sortOrder: 3 },
  'over-90': { label: 'Over 90 days', color: 'hsl(0 72% 50%)',   sortOrder: 4 },
  unknown:   { label: 'No date',      color: 'hsl(220 8% 50%)',  sortOrder: 5 },
};
const BUCKET_ORDER = ['current', '1-30', '31-60', '61-90', 'over-90', 'unknown'];

function fetchAgedCreditors(params) {
  const qs = new URLSearchParams();
  if (params.site && params.site !== 'all') qs.set('site', params.site);
  if (params.minBalance) qs.set('min_balance', String(params.minBalance));
  return fetch(`/api/reports/aged-creditors?${qs.toString()}`, { credentials: 'include' })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

export default function AgedCreditors() {
  // Filters live in the URL so a filtered view is shareable and survives reload.
  const [searchParams, setSearchParams] = useSearchParams();
  const site = searchParams.get('site') || 'all';
  const minBalance = Number(searchParams.get('min_balance') ?? 0);
  const setParam = (key, value, dflt) =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value == null || value === '' || String(value) === String(dflt)) next.delete(key);
      else next.set(key, String(value));
      return next;
    }, { replace: true });
  const setSite = (v) => setParam('site', v, 'all');
  const setMinBalance = (v) => setParam('min_balance', v, 0);

  const [sortBy, setSortBy] = useState('balance');
  const [sortDir, setSortDir] = useState('desc');

  const { data, isLoading, error } = useQuery({
    queryKey: ['aged-creditors', site, minBalance],
    queryFn: () => fetchAgedCreditors({ site, minBalance }),
    staleTime: 60_000,
  });

  const records = data?.records || [];
  const summary = data?.summary;
  const filters = data?.filters || { sites: [] };

  const sortedRecords = useMemo(() => {
    const copy = [...records];
    copy.sort((a, b) => {
      let av, bv;
      if (sortBy === 'balance') { av = Math.abs(a.parsed_balance || 0); bv = Math.abs(b.parsed_balance || 0); }
      else if (sortBy === 'age') { av = a.age_days ?? -1; bv = b.age_days ?? -1; }
      else if (sortBy === 'name') { av = (a.vendor_name || '').toLowerCase(); bv = (b.vendor_name || '').toLowerCase(); }
      else { av = 0; bv = 0; }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ?  1 : -1;
      return 0;
    });
    return copy;
  }, [records, sortBy, sortDir]);

  const bucketChartData = useMemo(() => {
    if (!summary) return [];
    return Object.entries(summary.buckets)
      .map(([key, total]) => ({
        key,
        name: BUCKET_META[key]?.label || key,
        amount: total,
        count: summary.bucket_counts[key] || 0,
        color: BUCKET_META[key]?.color || '#888',
        sortOrder: BUCKET_META[key]?.sortOrder ?? 99,
      }))
      .filter(b => b.amount !== 0 || b.count > 0)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [summary]);

  const handleSort = (col) => {
    if (sortBy === col) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir(col === 'name' ? 'asc' : 'desc'); }
  };

  const handleExportCsv = () => {
    if (!sortedRecords.length) return;
    const showSite = !!data?.hub_mode;
    const headers = ['Vendor Code', 'Vendor', 'Terms', ...(showSite ? ['Site'] : []), ...BUCKET_ORDER.map(k => BUCKET_META[k].label), 'Total'];
    const rows = sortedRecords.map(r => [
      r.vendor_code || '', r.vendor_name || '', r.terms || '', ...(showSite ? [r.site_name || ''] : []),
      ...BUCKET_ORDER.map(k => (r.bucket_amounts?.[k] ?? 0).toFixed(2)),
      (r.parsed_balance ?? 0).toFixed(2),
    ]);
    downloadCsv(`aged-creditors-${new Date().toISOString().slice(0, 10)}.csv`, [headers, ...rows]);
  };

  const exportQs = () => {
    const qs = new URLSearchParams();
    if (site !== 'all') qs.set('site', site);
    if (minBalance) qs.set('min_balance', String(minBalance));
    return qs.toString();
  };
  const stamp = () => new Date().toISOString().slice(0, 10);
  const handleExportPdf = () =>
    downloadReport(`/api/reports/aged-creditors/export?format=pdf&${exportQs()}`, `aged-creditors-${stamp()}.pdf`)
      .catch((e) => toast.error("PDF export failed", { description: e.message }));
  const handleExportExcel = () =>
    downloadReport(`/api/reports/aged-creditors/export?format=xlsx&${exportQs()}`, `aged-creditors-${stamp()}.xlsx`)
      .catch((e) => toast.error("Excel export failed", { description: e.message }));

  const generatedAt = data?.generated_at ? new Date(data.generated_at) : new Date();
  const generatedAtFmt = generatedAt.toLocaleString('en-ZA', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const filterDescriptors = [];
  if (data?.hub_mode && site !== 'all') filterDescriptors.push(`Site: ${site}`);
  if (minBalance) filterDescriptors.push(`Min balance R ${minBalance}`);

  return (
    <ReportFrame
      sectionLabel="Accounts Payable"
      title={<>Aged <em className="text-phosphor">Creditors</em>.</>}
      subtitle="Each open supplier document is aged by its due date into Sage's monthly periods (Current / 1–30 / 31–60 / 61–90 / Over 90) — matching the Sage Aged Payables report. Vendors may span several buckets."
      printId="aged-creditors"
      orientation="landscape"
      onExportCsv={sortedRecords.length ? handleExportCsv : null}
      onExportExcel={sortedRecords.length ? handleExportExcel : null}
      onExportPdf={sortedRecords.length ? handleExportPdf : null}
      onPrint={() => window.print()}
      isLoading={isLoading}
      error={error}
      printHeader={
        <PrintHeader
          title="Aged Creditors Report"
          period={data?.site_name}
          filters={filterDescriptors}
          generatedAt={generatedAtFmt}
        />
      }
      printFooter={<PrintFooter note="Aged Creditors · Cardoso" />}
    >
      {/* Filters */}
      <div className="report-print-hide bg-card border border-border p-3 grid grid-cols-2 lg:grid-cols-4 gap-3" style={{ borderRadius: '12px' }}>
        {data?.hub_mode && (
          <FilterField label="Site" value={site} onChange={setSite} options={[{ value: 'all', label: 'All sites' }, ...filters.sites.map(s => ({ value: s, label: s }))]} />
        )}
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-1">Min Balance (R)</label>
          <input
            type="number" min={0} step={1} value={minBalance}
            onChange={(e) => setMinBalance(parseFloat(e.target.value) || 0)}
            className="w-full bg-background border border-border text-foreground px-2 py-1.5 text-xs tabular-nums outline-none focus:border-accent"
            style={{ borderRadius: '12px' }}
          />
        </div>
        <div className="flex items-end">
          <button
            onClick={() => { setSite('all'); setMinBalance(0); }}
            className="w-full border border-border px-2 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
            style={{ borderRadius: '12px' }}
          >
            Reset filters
          </button>
        </div>
      </div>

      {data && summary && (
        <>
          {/* Summary tiles */}
          <div className="report-print-summary grid grid-cols-2 md:grid-cols-5 gap-3">
            <SummaryTile label="Vendors" value={summary.total_vendors.toLocaleString('en-ZA')} accent="var(--phosphor)" />
            <SummaryTile label="Total Outstanding" value={<><span className="text-muted-foreground/60 mr-1">R</span>{fmtR(summary.total_outstanding)}</>} accent="var(--phosphor)" big />
            <SummaryTile label="1–30 days" value={<><span className="text-muted-foreground/60 mr-1">R</span>{fmtR(summary.buckets['1-30'])}</>} sub={`${summary.bucket_counts['1-30']} vend`} accent={BUCKET_META['1-30'].color} />
            <SummaryTile label="31–60 days" value={<><span className="text-muted-foreground/60 mr-1">R</span>{fmtR(summary.buckets['31-60'])}</>} sub={`${summary.bucket_counts['31-60']} vend`} accent={BUCKET_META['31-60'].color} />
            <SummaryTile label="Over 90 days" value={<><span className="text-muted-foreground/60 mr-1">R</span>{fmtR(summary.buckets['over-90'])}</>} sub={`${summary.bucket_counts['over-90']} vend`} accent={BUCKET_META['over-90'].color} />
          </div>

          {/* Charts (screen only) */}
          <div className="report-print-hide grid grid-cols-1 lg:grid-cols-2 gap-3 mt-4">
            <ChartCard title="Outstanding by Aging Bucket" sub="Rand value">
              <BarChart data={bucketChartData} margin={{ top: 10, right: 16, left: 6, bottom: 26 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="name" tick={AXIS_TICK} tickLine={AXIS_LINE} axisLine={AXIS_LINE}
                  label={{ value: 'Aging bucket', position: 'insideBottom', offset: -5, style: AXIS_LABEL }} />
                <YAxis tick={AXIS_TICK} tickLine={AXIS_LINE} axisLine={AXIS_LINE} tickFormatter={fmtCompactR} width={70}
                  label={{ value: 'Outstanding (R)', angle: -90, position: 'insideLeft', offset: 10, style: AXIS_LABEL }} />
                <Tooltip contentStyle={TOOLTIP_CONTENT} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={TOOLTIP_CURSOR}
                  formatter={(v, n, p) => [`R ${fmtR(v)} · ${p.payload.count} vend`, p.payload.name]} />
                <Bar dataKey="amount" radius={[2, 2, 0, 0]}>
                  {bucketChartData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Bar>
              </BarChart>
            </ChartCard>
            <ChartCard title="Distribution by Bucket" sub="Share of total outstanding">
              <PieChart>
                <Pie data={bucketChartData.filter(b => b.amount > 0)} dataKey="amount" nameKey="name" innerRadius={55} outerRadius={95} paddingAngle={2}>
                  {bucketChartData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                </Pie>
                <Legend wrapperStyle={LEGEND_WRAPPER} iconType="square" />
                <Tooltip contentStyle={TOOLTIP_CONTENT} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={TOOLTIP_CURSOR}
                  formatter={(v) => `R ${fmtR(v)}`} />
              </PieChart>
            </ChartCard>
          </div>

          {/* Table — per-bucket distribution */}
          <div className="report-print-section-title hidden">Vendor Detail</div>
          <div className="bg-card border border-border mt-4 overflow-auto" style={{ borderRadius: '12px' }}>
            <table className="report-print-table w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <SortHeader col="name" label="Vendor" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  <th className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Code</th>
                  {data?.hub_mode && <th className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Site</th>}
                  <th className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Terms</th>
                  {BUCKET_ORDER.map(k => (
                    <th key={k} className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground" style={{ color: BUCKET_META[k].color }}>{BUCKET_META[k].label}</th>
                  ))}
                  <SortHeader col="balance" label="Total" align="right" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                </tr>
              </thead>
              <tbody>
                {sortedRecords.length === 0 && (
                  <tr><td colSpan={(data?.hub_mode ? 5 : 4) + BUCKET_ORDER.length} className="px-3 py-8 text-center text-muted-foreground font-mono text-[11px]">No vendors match the current filters.</td></tr>
                )}
                {sortedRecords.map((r) => (
                  <tr key={`${r.site_name}-${r.vendor_code}`} className="border-b border-border hover:bg-muted/30">
                    <td className="px-2 py-1.5 text-foreground">{r.vendor_name || '—'}</td>
                    <td className="px-2 py-1.5 font-mono text-muted-foreground tabular-nums">{r.vendor_code || '—'}</td>
                    {data?.hub_mode && <td className="px-2 py-1.5 text-muted-foreground">{r.site_name || '—'}</td>}
                    <td className="px-2 py-1.5 text-muted-foreground">{r.terms || '—'}</td>
                    {BUCKET_ORDER.map(k => {
                      const v = r.bucket_amounts?.[k] ?? 0;
                      return (
                        <td key={k} className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground td-right">
                          {v ? fmtR(v) : '—'}
                        </td>
                      );
                    })}
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-foreground td-right">
                      <span className="text-muted-foreground/60 mr-1">R</span>{fmtR(r.parsed_balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
              {sortedRecords.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                    <td className="px-2 py-2 text-foreground" colSpan={data?.hub_mode ? 4 : 3}>Total ({sortedRecords.length} vendors)</td>
                    {BUCKET_ORDER.map(k => (
                      <td key={k} className="px-2 py-2 text-right font-mono tabular-nums text-foreground td-right">
                        <span className="text-muted-foreground/60 mr-1">R</span>{fmtR(summary.buckets[k])}
                      </td>
                    ))}
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

function FilterField({ label, value, onChange, options }) {
  return (
    <div>
      <label className="block font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-background border border-border text-foreground px-2 py-1.5 text-xs outline-none focus:border-accent"
        style={{ borderRadius: '12px' }}
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

function SortHeader({ col, label, align = 'left', sortBy, sortDir, onSort }) {
  const active = sortBy === col;
  return (
    <th
      className={`px-2 py-2 text-${align} font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors`}
      onClick={() => onSort(col)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && <span className="text-accent">{sortDir === 'asc' ? '↑' : '↓'}</span>}
      </span>
    </th>
  );
}
