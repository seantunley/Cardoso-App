import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ReportFrame, PrintHeader, PrintFooter, fmtR, downloadCsv } from './lib';

// BAT Exceptions by Week — every exception LINE across the year, grouped by
// week, so the operator can print all weeks' exceptions at once instead of
// opening each reconciliation and printing its Exceptions tab. Ties out to each
// week's tab (captured exceptions + missing-POD exceptions). Site-only for now;
// the hub (per week per site) needs its own ETL and is a follow-up.

const todayYear = () => new Date().getFullYear();

function fetchData(year) {
  const qs = year != null ? `?year=${year}` : '';
  return fetch(`/api/reports/bat-exceptions-weekly${qs}`, { credentials: 'include' })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

// OCR status as plain text — same mapping as the on-screen badge / tab print.
function ocrText(row) {
  if (row.is_missing_pod) return 'No POD';
  switch (row.extraction_status) {
    case 'found': return 'Found';
    case 'not_found': return 'Not found';
    case 'failed': return 'Failed';
    case 'pending': return 'Pending';
    default: return '—';
  }
}

const COLS = [
  { key: 'order_number', label: 'Order', mono: true },
  { key: 'customer_no', label: 'Customer No.', mono: true, muted: true },
  { key: 'customer', label: 'Customer' },
  { key: 'delivery_date', label: 'Delivery', mono: true, muted: true },
  { key: 'pod_uploaded_date', label: 'POD uploaded', mono: true, muted: true },
  { key: '_ocr', label: 'OCR' },
  { key: 'extracted_invoice', label: 'Invoice', mono: true },
  { key: 'exception_reason', label: 'Exception reason' },
];

export default function BatExceptionsWeekly() {
  const [year, setYear] = useState(() => String(todayYear()));
  const yearParam = year === 'all' ? null : parseInt(year, 10);

  const { data, isLoading, error } = useQuery({
    queryKey: ['bat-exceptions-weekly', yearParam],
    queryFn: () => fetchData(yearParam),
    staleTime: 60_000,
  });

  const hubUnavailable = !!data?.hub_unavailable;
  const weeks = data?.weeks || [];
  const totalCount = data?.total_count || 0;
  const totalAmount = data?.total_amount || 0;

  // Year options: whatever the server has, plus the current year, newest first.
  const yearOptions = useMemo(() => {
    const set = new Set([...(data?.available_years || []), todayYear()]);
    return Array.from(set).filter(Boolean).sort((a, b) => b - a);
  }, [data]);

  const exportCsv = () => {
    const header = ['Week', 'Year', 'Order', 'Customer No.', 'Customer', 'Delivery', 'POD uploaded', 'OCR', 'Invoice', 'Exception reason', 'Amount'];
    const rows = [];
    for (const w of weeks) {
      for (const r of w.rows) {
        rows.push([w.week_number, w.year, r.order_number || '', r.customer_no || '', r.customer || '', r.delivery_date || '', r.pod_uploaded_date || '', ocrText(r), r.extracted_invoice || '', r.exception_reason || '', (Number(r.order_amount) || 0).toFixed(2)]);
      }
      rows.push([`Week ${w.week_number} subtotal`, '', '', '', '', '', '', '', '', `${w.subtotal_count} exceptions`, (Number(w.subtotal_amount) || 0).toFixed(2)]);
    }
    rows.push(['TOTAL', '', '', '', '', '', '', '', '', `${totalCount} exceptions`, (Number(totalAmount) || 0).toFixed(2)]);
    downloadCsv(`bat-exceptions-${year}.csv`, [header, ...rows]);
  };

  const generatedAtFmt = new Date().toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <ReportFrame
      title={<>BAT Exceptions <em className="text-phosphor">by Week</em>.</>}
      subtitle={`Every BAT exception for ${year === 'all' ? 'all years' : year}, grouped by week — captured exceptions plus missing-POD exceptions, so each week ties to its Exceptions tab. Amounts in Rand (R).`}
      printId="bat-exceptions-weekly"
      orientation="landscape"
      onExportCsv={weeks.length ? exportCsv : undefined}
      onPrint={() => window.print()}
      isLoading={isLoading}
      error={error?.message}
      printHeader={<PrintHeader title="BAT Exceptions by Week" filters={[`Year: ${year === 'all' ? 'All' : year}`, `${totalCount} exceptions`, 'Amounts in Rand (R)']} generatedAt={generatedAtFmt} />}
      printFooter={<PrintFooter note="BAT Exceptions by Week · Cardoso" />}
    >
      {/* Year filter */}
      <div className="report-print-hide mb-4 flex items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Year</span>
        <select
          value={year}
          onChange={(e) => setYear(e.target.value)}
          className="h-9 rounded-xl border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {yearOptions.map((y) => <option key={y} value={String(y)}>{y}</option>)}
          <option value="all">All years</option>
        </select>
      </div>

      {hubUnavailable ? (
        <div className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          Per-week exception detail isn&apos;t available on the hub yet — BAT reconciliation runs per branch. Open this report on a branch (site) install. (A per-site hub version is a planned follow-up.)
        </div>
      ) : !isLoading && !error && weeks.length === 0 ? (
        <div className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          No exceptions recorded for {year === 'all' ? 'any year' : year}.
        </div>
      ) : weeks.length > 0 ? (
        <div className="space-y-6">
          {weeks.map((w) => (
            <div key={`${w.year}-${w.week_number}`} className="overflow-x-auto rounded-xl border border-border bg-card">
              <div className="flex items-baseline justify-between border-b border-border px-4 py-2.5">
                <div className="font-display text-lg">Week {String(w.week_number).padStart(2, '0')} <span className="text-muted-foreground">· {w.year}</span></div>
                <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                  {w.subtotal_count} {w.subtotal_count === 1 ? 'exception' : 'exceptions'} · <span className="tabular-nums text-foreground">R {fmtR(w.subtotal_amount)}</span>
                </div>
              </div>
              <table className="w-full text-sm report-doc-table" style={{ minWidth: 900 }}>
                <thead>
                  <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                    {COLS.map((c) => <th key={c.key} className="px-3 py-1.5 text-left font-medium">{c.label}</th>)}
                    <th className="px-3 py-1.5 text-right font-medium border-l border-border">Amount (R)</th>
                  </tr>
                </thead>
                <tbody>
                  {w.rows.map((r, i) => (
                    <tr key={i} className="border-b border-border/50 last:border-0 hover:bg-muted/20">
                      <td className="px-3 py-1.5 font-mono text-xs text-foreground">{r.order_number || '—'}</td>
                      <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{r.customer_no || '—'}</td>
                      <td className="px-3 py-1.5">{r.customer || (r.is_missing_pod ? <span className="text-muted-subtle">— (missing POD)</span> : '—')}</td>
                      <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{r.delivery_date || '—'}</td>
                      <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{r.pod_uploaded_date || '—'}</td>
                      <td className="px-3 py-1.5 text-xs">{ocrText(r)}</td>
                      <td className="px-3 py-1.5 font-mono text-xs text-foreground">{r.extracted_invoice || '—'}</td>
                      <td className="px-3 py-1.5 text-xs">{r.exception_reason || '—'}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums border-l border-border/40"><span className="text-muted-subtle">R </span>{fmtR(r.order_amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border bg-muted/40">
                    <td className="px-3 py-1.5 font-semibold" colSpan={COLS.length}>Week {String(w.week_number).padStart(2, '0')} subtotal · {w.subtotal_count} {w.subtotal_count === 1 ? 'exception' : 'exceptions'}</td>
                    <td className="px-3 py-1.5 text-right font-semibold tabular-nums border-l border-border"><span className="text-muted-subtle">R </span>{fmtR(w.subtotal_amount)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ))}

          {/* Grand total */}
          <div className="flex items-baseline justify-between rounded-xl border-2 border-accent/40 bg-card px-5 py-3">
            <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">Grand total · {year === 'all' ? 'all years' : year}</div>
            <div className="font-display text-xl tabular-nums">{totalCount} exceptions · R {fmtR(totalAmount)}</div>
          </div>
        </div>
      ) : null}
    </ReportFrame>
  );
}
