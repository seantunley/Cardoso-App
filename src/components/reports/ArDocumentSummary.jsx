import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ReportFrame, fmtR, downloadCsv } from './lib';

// Posted A/R documents (Invoices / Credit Notes / Debit Notes) by month with
// VAT split out, from Sage AROBL. Net = Invoices + Debit notes − Credit notes.

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
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

export default function ArDocumentSummary() {
  const [from, setFrom] = useState(yearStartStr());
  const [to, setTo] = useState(todayStr());

  const { data, isLoading, error } = useQuery({
    queryKey: ['ar-document-summary', from, to],
    queryFn: () => fetchSummary({ from, to }),
    staleTime: 60_000,
    enabled: Boolean(from && to),
  });

  const months = data?.months || [];
  const totals = data?.totals;

  const exportCsv = () => {
    const header = [
      'Month',
      'Invoices Ex-VAT', 'Invoices VAT', 'Invoices Incl',
      'Credit Notes Ex-VAT', 'Credit Notes VAT', 'Credit Notes Incl',
      'Debit Notes Ex-VAT', 'Debit Notes VAT', 'Debit Notes Incl',
      'Net (Incl)',
    ];
    const cell = (v) => Number(v || 0).toFixed(2);
    const rowFor = (label, m) => [
      label,
      cell(m.invoices.excl), cell(m.invoices.vat), cell(m.invoices.incl),
      cell(m.credit_notes.excl), cell(m.credit_notes.vat), cell(m.credit_notes.incl),
      cell(m.debit_notes.excl), cell(m.debit_notes.vat), cell(m.debit_notes.incl),
      cell(m.net_incl),
    ];
    const rows = months.map((m) => rowFor(m.month, m));
    if (totals) rows.push(rowFor('TOTAL', totals));
    downloadCsv(`ar-document-summary-${from}_to_${to}.csv`, [header, ...rows]);
  };

  const Th = (props) => <th className="px-2 py-1.5 text-right text-xs font-medium text-muted-foreground" {...props} />;
  const Td = ({ v, strong }) => (
    <td className={`px-2 py-1 text-right tabular-nums ${strong ? 'font-semibold text-foreground' : 'text-foreground/90'}`}>R {fmtR(v)}</td>
  );

  return (
    <ReportFrame
      title={<>A/R Document <em>Summary</em>.</>}
      subtitle="Posted invoices, credit notes and debit notes by month with VAT shown separately. Net = Invoices + Debit notes − Credit notes. Sourced live from Sage (AROBL); covers documents not yet cleared from history."
      printId="ar-doc-summary"
      orientation="landscape"
      onExportCsv={months.length ? exportCsv : undefined}
      onPrint={() => window.print()}
      isLoading={isLoading}
      error={error?.message}
    >
      {/* Date range */}
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

      {!isLoading && !error && months.length === 0 && (
        <div className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          No posted documents in this date range.
        </div>
      )}

      {months.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-sm" style={{ minWidth: 980 }}>
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
                    <Th className="px-2 py-1.5 text-right text-[10px] font-medium text-muted-foreground border-l border-border">Ex-VAT</Th>
                    <Th>VAT</Th>
                    <Th>Incl</Th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month} className="border-b border-border/50 hover:bg-muted/30">
                  <td className="px-2 py-1 text-left font-mono text-foreground">{m.month}</td>
                  {TYPES.map((t) => (
                    <Fragment key={`${m.month}-${t.key}`}>
                      <td className="px-2 py-1 text-right tabular-nums text-foreground/90 border-l border-border/40">R {fmtR(m[t.key].excl)}</td>
                      <Td v={m[t.key].vat} />
                      <Td v={m[t.key].incl} />
                    </Fragment>
                  ))}
                  <td className="px-2 py-1 text-right tabular-nums font-semibold text-foreground border-l border-border/40">R {fmtR(m.net_incl)}</td>
                </tr>
              ))}
            </tbody>
            {totals && (
              <tfoot>
                <tr className="border-t-2 border-border bg-muted/40">
                  <td className="px-2 py-1.5 text-left font-semibold text-foreground">TOTAL</td>
                  {TYPES.map((t) => (
                    <Fragment key={`tot-${t.key}`}>
                      <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-foreground border-l border-border/40">R {fmtR(totals[t.key].excl)}</td>
                      <Td v={totals[t.key].vat} strong />
                      <Td v={totals[t.key].incl} strong />
                    </Fragment>
                  ))}
                  <td className="px-2 py-1.5 text-right tabular-nums font-bold text-foreground border-l border-border/40">R {fmtR(totals.net_incl)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </ReportFrame>
  );
}
