import { useState, useMemo, Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ReportFrame, PrintHeader, PrintFooter, fmtR, downloadCsv } from './lib';

// BAT Exceptions by Week — every exception LINE across the year, so the operator
// can print all weeks at once instead of opening each reconciliation. On a site
// it groups by week; on the hub it groups by SITE -> week (with a per-site grand
// total and a site filter). Ties out to each week's Exceptions tab: captured
// exceptions + missing-POD exceptions, the same two sets the tab merges.

const todayYear = () => new Date().getFullYear();

function fetchData(year, site) {
  const qs = new URLSearchParams();
  qs.set('year', year); // 'all' or 'YYYY' — always sent so the server never falls back to current-year
  if (site && site !== 'all') qs.set('site', site);
  return fetch(`/api/reports/bat-exceptions-weekly?${qs.toString()}`, { credentials: 'include' })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const COLS = ['Order', 'Customer No.', 'Customer', 'Delivery', 'POD uploaded', 'OCR', 'Invoice', 'Exception reason'];

function WeekBlock({ week }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <div className="flex items-baseline justify-between border-b border-border px-4 py-2.5">
        <div className="font-display text-lg">Week {String(week.week_number).padStart(2, '0')} <span className="text-muted-foreground">· {week.year}</span></div>
        <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {week.subtotal_count} {week.subtotal_count === 1 ? 'exception' : 'exceptions'} · <span className="tabular-nums text-foreground">R {fmtR(week.subtotal_amount)}</span>
        </div>
      </div>
      <table className="w-full text-sm report-doc-table" style={{ minWidth: 900 }}>
        <thead>
          <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
            {COLS.map((c) => <th key={c} className="px-3 py-1.5 text-left font-medium">{c}</th>)}
            <th className="px-3 py-1.5 text-right font-medium border-l border-border">Amount (R)</th>
          </tr>
        </thead>
        <tbody>
          {week.rows.map((r, i) => (
            <tr key={i} className="border-b border-border/50 last:border-0 hover:bg-muted/20">
              <td className="px-3 py-1.5 font-mono text-xs text-foreground">{r.order_number || '—'}</td>
              <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{r.customer_no || '—'}</td>
              <td className="px-3 py-1.5">{r.customer || (r.is_missing_pod ? <span className="text-muted-subtle">— (missing POD)</span> : '—')}</td>
              <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{r.delivery_date || '—'}</td>
              <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{r.pod_uploaded_date || '—'}</td>
              <td className="px-3 py-1.5 text-xs">{r.ocr || '—'}</td>
              <td className="px-3 py-1.5 font-mono text-xs text-foreground">{r.invoice || '—'}</td>
              <td className="px-3 py-1.5 text-xs">{r.exception_reason || '—'}</td>
              <td className="px-3 py-1.5 text-right tabular-nums border-l border-border/40"><span className="text-muted-subtle">R </span>{fmtR(r.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border bg-muted/40">
            <td className="px-3 py-1.5 font-semibold" colSpan={COLS.length}>Week {String(week.week_number).padStart(2, '0')} subtotal · {week.subtotal_count} {week.subtotal_count === 1 ? 'exception' : 'exceptions'}</td>
            <td className="px-3 py-1.5 text-right font-semibold tabular-nums border-l border-border"><span className="text-muted-subtle">R </span>{fmtR(week.subtotal_amount)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export default function BatExceptionsWeekly() {
  const [year, setYear] = useState(() => String(todayYear()));
  const [site, setSite] = useState('all');

  const { data, isLoading, error } = useQuery({
    queryKey: ['bat-exceptions-weekly', year, site],
    queryFn: () => fetchData(year, site),
    staleTime: 60_000,
  });

  const isHub = !!data?.hub;
  const weeks = data?.weeks || [];          // site mode
  const sites = data?.sites || [];          // hub mode
  const totalCount = data?.total_count || 0;
  const totalAmount = data?.total_amount || 0;
  const hasData = isHub ? sites.length > 0 : weeks.length > 0;

  const yearOptions = useMemo(() => {
    const set = new Set([...(data?.available_years || []), todayYear()]);
    return Array.from(set).filter(Boolean).sort((a, b) => b - a);
  }, [data]);
  const siteOptions = data?.filters?.sites || [];

  const exportCsv = () => {
    const header = [...(isHub ? ['Site'] : []), 'Week', 'Year', 'Order', 'Customer No.', 'Customer', 'Delivery', 'POD uploaded', 'OCR', 'Invoice', 'Exception reason', 'Amount'];
    const rows = [];
    const pushWeek = (w, siteName) => {
      for (const r of w.rows) {
        rows.push([...(isHub ? [siteName] : []), w.week_number, w.year, r.order_number || '', r.customer_no || '', r.customer || '', r.delivery_date || '', r.pod_uploaded_date || '', r.ocr || '', r.invoice || '', r.exception_reason || '', (Number(r.amount) || 0).toFixed(2)]);
      }
      rows.push([...(isHub ? [siteName] : []), `Week ${w.week_number} subtotal`, '', '', '', '', '', '', '', '', `${w.subtotal_count} exceptions`, (Number(w.subtotal_amount) || 0).toFixed(2)]);
    };
    if (isHub) {
      for (const s of sites) {
        for (const w of s.weeks) pushWeek(w, s.site_name);
        rows.push([s.site_name, 'SITE TOTAL', '', '', '', '', '', '', '', '', `${s.total_count} exceptions`, (Number(s.total_amount) || 0).toFixed(2)]);
      }
    } else {
      for (const w of weeks) pushWeek(w);
    }
    rows.push([...(isHub ? [''] : []), 'GRAND TOTAL', '', '', '', '', '', '', '', '', `${totalCount} exceptions`, (Number(totalAmount) || 0).toFixed(2)]);
    downloadCsv(`bat-exceptions-${year}${isHub && site !== 'all' ? `-${site}` : ''}.csv`, [header, ...rows]);
  };

  const generatedAtFmt = new Date().toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const yearLabel = year === 'all' ? 'all years' : year;

  return (
    <ReportFrame
      title={<>BAT Exceptions <em className="text-phosphor">by Week</em>.</>}
      subtitle={`Every BAT exception for ${yearLabel}${isHub ? ', grouped by site then week' : ', grouped by week'} — captured exceptions plus missing-POD exceptions, so each week ties to its Exceptions tab. Amounts in Rand (R).`}
      printId="bat-exceptions-weekly"
      orientation="landscape"
      onExportCsv={hasData ? exportCsv : undefined}
      onPrint={() => window.print()}
      isLoading={isLoading}
      error={error?.message}
      printHeader={<PrintHeader title="BAT Exceptions by Week" filters={[`Year: ${year === 'all' ? 'All' : year}`, ...(isHub ? [`Site: ${site === 'all' ? 'All sites' : site}`] : []), `${totalCount} exceptions`, 'Amounts in Rand (R)']} generatedAt={generatedAtFmt} />}
      printFooter={<PrintFooter note="BAT Exceptions by Week · Cardoso" />}
    >
      {/* Filters */}
      <div className="report-print-hide mb-4 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Year</span>
          <select value={year} onChange={(e) => setYear(e.target.value)} className="h-9 rounded-xl border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary">
            {yearOptions.map((y) => <option key={y} value={String(y)}>{y}</option>)}
            <option value="all">All years</option>
          </select>
        </div>
        {isHub && siteOptions.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Site</span>
            <select value={site} onChange={(e) => setSite(e.target.value)} className="h-9 rounded-xl border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary">
              <option value="all">All sites</option>
              {siteOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
      </div>

      {!isLoading && !error && !hasData ? (
        <div className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          No exceptions recorded for {yearLabel}{isHub && site !== 'all' ? ` at ${site}` : ''}.
        </div>
      ) : hasData ? (
        <div className="space-y-6">
          {isHub ? (
            sites.map((s) => (
              <Fragment key={s.site_id}>
                <div className="flex items-baseline justify-between rounded-xl border-l-2 border-l-[var(--phosphor)] border border-border bg-card px-4 py-2.5">
                  <div className="font-display text-xl">{s.site_name}</div>
                  <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">site total · {s.total_count} exceptions · <span className="tabular-nums text-foreground">R {fmtR(s.total_amount)}</span></div>
                </div>
                <div className="space-y-4 pl-1">
                  {s.weeks.map((w) => <WeekBlock key={`${s.site_id}-${w.year}-${w.week_number}`} week={w} />)}
                </div>
              </Fragment>
            ))
          ) : (
            weeks.map((w) => <WeekBlock key={`${w.year}-${w.week_number}`} week={w} />)
          )}

          {/* Grand total */}
          <div className="flex items-baseline justify-between rounded-xl border-2 border-accent/40 bg-card px-5 py-3">
            <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">Grand total · {yearLabel}{isHub ? ' · all sites shown' : ''}</div>
            <div className="font-display text-xl tabular-nums">{totalCount} exceptions · R {fmtR(totalAmount)}</div>
          </div>
        </div>
      ) : null}
    </ReportFrame>
  );
}
