import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ReportFrame, PrintHeader, PrintFooter, fmtR, downloadCsv } from './lib';

// Posted A/R documents (Invoices / Credit Notes / Debit Notes) by month with
// VAT split out. Net = Invoices + Debit notes − Credit notes. Site mode queries
// Sage live (ARIBH); hub mode shows a consolidated table plus one section per
// branch (synced down into hub_ar_document_summary).

const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const yearStartStr = () => `${new Date().getFullYear()}-01-01`;

function fetchSummary({ from, to }) {
  const qs = new URLSearchParams({ from, to });
  return fetch(`/api/reports/ar-document-summary?${qs.toString()}`, { credentials: 'include' })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

const TYPES = [
  { key: 'invoices', label: 'Invoices', accent: 'hsl(145 55% 45%)' },
  { key: 'credit_notes', label: 'Credit Notes', accent: 'hsl(0 72% 50%)' },
  { key: 'debit_notes', label: 'Debit Notes', accent: 'hsl(33 95% 55%)' },
];

const Td = ({ v, strong }) => (
  <td className={`px-2 py-1 text-right tabular-nums ${strong ? 'font-semibold text-foreground' : 'text-foreground/90'}`}>{fmtR(v)}</td>
);

function DocTable({ months, totals, currentMonth }) {
  if (!months?.length) {
    return <div className="rounded-xl border border-border bg-card px-6 py-8 text-center text-sm text-muted-foreground">No posted documents in this range.</div>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full text-sm report-doc-table" style={{ minWidth: 980 }}>
        <thead>
          <tr className="border-b border-border">
            <th rowSpan={2} className="px-2 py-1.5 text-left text-xs font-medium text-muted-foreground align-bottom">Month</th>
            {TYPES.map((t) => (
              <th key={t.key} colSpan={3} className="px-2 py-1.5 text-center text-xs font-semibold uppercase tracking-wide border-l border-border" style={{ color: t.accent }}>{t.label}</th>
            ))}
            <th rowSpan={2} className="px-2 py-1.5 text-right text-xs font-semibold text-foreground align-bottom border-l border-border">Net (Incl)</th>
          </tr>
          <tr className="border-b border-border">
            {TYPES.map((t) => (
              <Fragment key={t.key}>
                <th className="px-2 py-1.5 text-right text-[10px] font-medium text-muted-foreground border-l border-border">Ex-VAT</th>
                <th className="px-2 py-1.5 text-right text-[10px] font-medium text-muted-foreground">VAT</th>
                <th className="px-2 py-1.5 text-right text-[10px] font-medium text-muted-foreground">Incl</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {months.map((m) => {
            const isCurrent = m.month === currentMonth;
            return (
              <tr key={m.month} className={`border-b border-border/50 ${isCurrent ? 'bg-[hsla(33,95%,55%,0.10)]' : 'hover:bg-muted/30'}`}>
                <td className="px-2 py-1 text-left font-mono text-foreground">
                  {m.month}
                  {isCurrent && <span className="ml-1.5 font-mono text-[9px] uppercase tracking-wider" style={{ color: 'var(--phosphor)' }}>current</span>}
                </td>
                {TYPES.map((t) => (
                  <Fragment key={`${m.month}-${t.key}`}>
                    <td className="px-2 py-1 text-right tabular-nums text-foreground/90 border-l border-border/40">{fmtR(m[t.key].excl)}</td>
                    <Td v={m[t.key].vat} />
                    <Td v={m[t.key].incl} />
                  </Fragment>
                ))}
                <td className="px-2 py-1 text-right tabular-nums font-semibold text-foreground border-l border-border/40">{fmtR(m.net_incl)}</td>
              </tr>
            );
          })}
        </tbody>
        {totals && (
          <tfoot>
            <tr className="border-t-2 border-border bg-muted/40">
              <td className="px-2 py-1.5 text-left font-semibold text-foreground">TOTAL</td>
              {TYPES.map((t) => (
                <Fragment key={`tot-${t.key}`}>
                  <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-foreground border-l border-border/40">{fmtR(totals[t.key].excl)}</td>
                  <Td v={totals[t.key].vat} strong />
                  <Td v={totals[t.key].incl} strong />
                </Fragment>
              ))}
              <td className="px-2 py-1.5 text-right tabular-nums font-bold text-foreground border-l border-border/40">{fmtR(totals.net_incl)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

export default function ArDocumentSummary() {
  const [from, setFrom] = useState(yearStartStr());
  const [to, setTo] = useState(todayStr());

  const { data, isLoading, error } = useQuery({
    queryKey: ['ar-document-summary', from, to],
    queryFn: () => fetchSummary({ from, to }),
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
      subtitle="Posted invoices, credit notes and debit notes by month with VAT shown separately. Net = Invoices + Debit notes − Credit notes. Matches the Sage 'Sales Figures' report (ARIBH, VAT-bearing documents)."
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
      </div>

      {!isLoading && !error && !hasData && (
        <div className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          No posted documents in this date range.
        </div>
      )}

      {!isHub && months.length > 0 && (
        <DocTable months={months} totals={totals} currentMonth={currentMonth} />
      )}

      {isHub && hasData && (
        <div className="space-y-6">
          {(consolidated?.months?.length || 0) > 0 && (
            <div>
              <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-foreground">All branches · consolidated</div>
              <DocTable months={consolidated.months} totals={consolidated.totals} currentMonth={currentMonth} />
            </div>
          )}
          {branches.map((b) => (
            <div key={b.site_id}>
              <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.2em]" style={{ color: 'var(--phosphor)' }}>{b.site_name}</div>
              <DocTable months={b.months} totals={b.totals} currentMonth={currentMonth} />
            </div>
          ))}
        </div>
      )}
    </ReportFrame>
  );
}
