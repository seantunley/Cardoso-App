import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ReportFrame, PrintHeader, PrintFooter, downloadCsv } from './lib';
import SalesFiguresTable from './SalesFiguresTable';
import BranchFilter from './BranchFilter';

// Posted A/R documents (Invoices / Credit Notes / Debit Notes) by month with
// VAT split out. Net = Invoices + Debit notes − Credit notes. Site mode queries
// Sage live (ARIBH); hub mode shows a consolidated table plus one section per
// branch (synced down into hub_ar_document_summary). Amounts in Rand (R).

const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const yearStartStr = () => `${new Date().getFullYear()}-01-01`;

function fetchSummary({ from, to, site }) {
  const qs = new URLSearchParams({ from, to });
  if (site && site !== 'all') qs.set('site', site);
  return fetch(`/api/reports/ar-document-summary?${qs.toString()}`, { credentials: 'include' })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

export default function ArDocumentSummary() {
  const [from, setFrom] = useState(yearStartStr());
  const [to, setTo] = useState(todayStr());
  const [searchParams] = useSearchParams();
  const site = searchParams.get('site') || 'all';

  const { data, isLoading, error } = useQuery({
    queryKey: ['ar-document-summary', from, to, site],
    queryFn: () => fetchSummary({ from, to, site }),
    staleTime: 60_000,
    enabled: Boolean(from && to),
  });

  const isHub = !!data?.hub_mode;
  const months = data?.months || [];
  const totals = data?.totals;
  const branches = data?.branches || [];
  const consolidated = data?.consolidated || null;
  const currentMonth = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; })();

  // CSV uses the primary table (site months, or hub consolidated).
  const csvMonths = isHub ? (consolidated?.months || []) : months;
  const csvTotals = isHub ? consolidated?.totals : totals;
  const exportCsv = () => {
    const header = ['Month', 'Invoices Ex-VAT', 'Invoices VAT', 'Invoices Incl', 'Credit Notes Ex-VAT', 'Credit Notes VAT', 'Credit Notes Incl', 'Debit Notes Ex-VAT', 'Debit Notes VAT', 'Debit Notes Incl', 'Net (Incl)'];
    const cell = (v) => Number(v || 0).toFixed(2);
    const rowFor = (label, m) => [label, cell(m.invoices.excl), cell(m.invoices.vat), cell(m.invoices.incl), cell(m.credit_notes.excl), cell(m.credit_notes.vat), cell(m.credit_notes.incl), cell(m.debit_notes.excl), cell(m.debit_notes.vat), cell(m.debit_notes.incl), cell(m.net_incl)];
    const rows = csvMonths.map((m) => rowFor(m.month, m));
    if (csvTotals) rows.push(rowFor('TOTAL', csvTotals));
    downloadCsv(`ar-document-summary-${from}_to_${to}.csv`, [header, ...rows]);
  };

  const hasData = isHub ? (branches.length > 0 || (consolidated?.months?.length || 0) > 0) : months.length > 0;
  const generatedAtFmt = new Date().toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <ReportFrame
      title={<>Monthly Sales <em className="text-phosphor">Figures</em>.</>}
      subtitle="Posted invoices, credit notes and debit notes by month with VAT shown separately. Net = Invoices + Debit notes − Credit notes. Amounts in Rand (R). Matches the Sage 'Sales Figures' report (ARIBH, VAT-bearing documents)."
      printId="ar-doc-summary"
      orientation="landscape"
      onExportCsv={csvMonths.length ? exportCsv : undefined}
      onPrint={() => window.print()}
      isLoading={isLoading}
      error={error?.message}
      printHeader={
        <PrintHeader
          title="Monthly Sales Figures"
          filters={[`Period: ${from} to ${to}`, 'Amounts in Rand (R)']}
          generatedAt={generatedAtFmt}
        />
      }
      printFooter={<PrintFooter note="A/R Document Summary · Cardoso" />}
    >
      <div className="report-print-hide flex flex-wrap items-end gap-3 mb-4">
        <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
          From
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground font-sans tracking-normal" />
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
          To
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground font-sans tracking-normal" />
        </label>
        <div className="min-w-[10rem]"><BranchFilter hubMode={data?.hub_mode} sites={data?.filters?.sites} /></div>
      </div>

      {!isLoading && !error && !hasData && (
        <div className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          No posted documents in this date range.
        </div>
      )}

      {!isHub && months.length > 0 && (
        <SalesFiguresTable rows={months} totals={totals} labelKey="month" labelHeader="Month" currentLabel={currentMonth} />
      )}

      {isHub && hasData && (
        <div className="space-y-6">
          {(consolidated?.months?.length || 0) > 0 && (
            <div>
              <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-foreground">All branches · consolidated</div>
              <SalesFiguresTable rows={consolidated.months} totals={consolidated.totals} labelKey="month" labelHeader="Month" currentLabel={currentMonth} />
            </div>
          )}
          {branches.map((b) => (
            <div key={b.site_id}>
              <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em]" style={{ color: 'var(--phosphor)' }}>{b.site_name}</div>
              <SalesFiguresTable rows={b.months} totals={b.totals} labelKey="month" labelHeader="Month" currentLabel={currentMonth} />
            </div>
          ))}
        </div>
      )}
    </ReportFrame>
  );
}
