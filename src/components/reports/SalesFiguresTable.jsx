import { Fragment } from 'react';
import { Printer } from 'lucide-react';
import { fmtR } from './lib';

// Shared table for the Sales Figures reports (monthly + daily). Renders posted
// A/R documents (Invoices / Credit Notes / Debit Notes) with the VAT split, a
// Net column, and a TOTAL row. All amounts carry the R (Rand) symbol. The
// period column is driven by labelKey ('month' or 'day') so the same table
// serves both reports.

const TYPES = [
  { key: 'invoices', label: 'Invoices', accent: 'hsl(145 55% 45%)' },
  { key: 'credit_notes', label: 'Credit Notes', accent: 'hsl(0 72% 50%)' },
  { key: 'debit_notes', label: 'Debit Notes', accent: 'hsl(33 95% 55%)' },
];

// Right-aligned amount cell prefixed with a muted "R" so the figures read
// clearly as South African Rand.
const RandCell = ({ v, strong, borderL }) => (
  <td className={`px-2 py-1 text-right tabular-nums ${borderL ? 'border-l border-border/40' : ''} ${strong ? 'font-semibold text-foreground' : 'text-foreground/90'}`}>
    <span className="text-muted-subtle">R </span>{fmtR(v)}
  </td>
);

// onPrintRow (optional): when provided, each row gets a small Print button next
// to its label that calls onPrintRow(label). Used by the Daily report to print
// that day's full document list; the Monthly report omits it, so its rows are
// unchanged. The button is .report-print-hide so it never appears in any print.
export default function SalesFiguresTable({ rows, totals, labelHeader = 'Month', labelKey = 'month', currentLabel, onPrintRow }) {
  if (!rows?.length) {
    return <div className="rounded-xl border border-border bg-card px-6 py-8 text-center text-sm text-muted-foreground">No posted documents in this period.</div>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full text-sm report-doc-table" style={{ minWidth: 1000 }}>
        <thead>
          <tr className="border-b border-border">
            <th rowSpan={2} className="px-2 py-1.5 text-left text-xs font-medium text-muted-foreground align-bottom">{labelHeader}</th>
            {TYPES.map((t) => (
              <th key={t.key} colSpan={3} className="px-2 py-1.5 text-center text-xs font-semibold uppercase tracking-wide border-l border-border" style={{ color: t.accent }}>{t.label}</th>
            ))}
            <th rowSpan={2} className="px-2 py-1.5 text-right text-xs font-semibold text-foreground align-bottom border-l border-border">Net (Incl)</th>
          </tr>
          <tr className="border-b border-border">
            {TYPES.map((t) => (
              <Fragment key={t.key}>
                <th className="px-2 py-1.5 text-right text-[10px] font-medium text-muted-foreground border-l border-border">Ex-VAT (R)</th>
                <th className="px-2 py-1.5 text-right text-[10px] font-medium text-muted-foreground">VAT (R)</th>
                <th className="px-2 py-1.5 text-right text-[10px] font-medium text-muted-foreground">Incl (R)</th>
              </Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const label = row[labelKey];
            const isCurrent = label === currentLabel;
            return (
              <tr key={label} className={`border-b border-border/50 ${isCurrent ? 'bg-[hsla(33,95%,55%,0.10)]' : 'hover:bg-muted/30'}`}>
                <td className="px-2 py-1 text-left font-mono text-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    {onPrintRow && (
                      <button
                        type="button"
                        onClick={() => onPrintRow(label)}
                        title={`Print all invoices, credit notes & debit notes for ${label}`}
                        className="report-print-hide inline-flex h-5 w-5 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <Printer className="h-3 w-3" />
                      </button>
                    )}
                    {label}
                    {isCurrent && <span className="font-mono text-[9px] uppercase tracking-wider" style={{ color: 'var(--phosphor)' }}>current</span>}
                  </span>
                </td>
                {TYPES.map((t) => (
                  <Fragment key={`${label}-${t.key}`}>
                    <RandCell v={row[t.key].excl} borderL />
                    <RandCell v={row[t.key].vat} />
                    <RandCell v={row[t.key].incl} />
                  </Fragment>
                ))}
                <RandCell v={row.net_incl} strong borderL />
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
                  <RandCell v={totals[t.key].excl} strong borderL />
                  <RandCell v={totals[t.key].vat} strong />
                  <RandCell v={totals[t.key].incl} strong />
                </Fragment>
              ))}
              <RandCell v={totals.net_incl} strong borderL />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
