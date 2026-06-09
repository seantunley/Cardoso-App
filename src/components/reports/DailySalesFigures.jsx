import { useQuery } from '@tanstack/react-query';
import { ReportFrame, PrintHeader, PrintFooter, downloadCsv } from './lib';
import SalesFiguresTable from './SalesFiguresTable';

// Current month's posted A/R documents broken down by day, with the VAT split
// and Net (Invoices + Debit notes − Credit notes). Same Sage source (ARIBH) as
// the Monthly Sales Figures report. Amounts in Rand (R). Site-only — the hub
// keeps monthly totals, so it shows a note in hub mode.

const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function fetchDaily() {
  return fetch('/api/reports/daily-sales-figures', { credentials: 'include' })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

export default function DailySalesFigures() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['daily-sales-figures'],
    queryFn: fetchDaily,
    staleTime: 60_000,
  });

  const unavailable = !!data?.unavailable;
  const days = data?.days || [];
  const totals = data?.totals;
  const month = data?.month || '';
  const today = todayStr();

  const exportCsv = () => {
    const header = ['Date', 'Invoices Ex-VAT', 'Invoices VAT', 'Invoices Incl', 'Credit Notes Ex-VAT', 'Credit Notes VAT', 'Credit Notes Incl', 'Debit Notes Ex-VAT', 'Debit Notes VAT', 'Debit Notes Incl', 'Net (Incl)'];
    const cell = (v) => Number(v || 0).toFixed(2);
    const rowFor = (label, m) => [label, cell(m.invoices.excl), cell(m.invoices.vat), cell(m.invoices.incl), cell(m.credit_notes.excl), cell(m.credit_notes.vat), cell(m.credit_notes.incl), cell(m.debit_notes.excl), cell(m.debit_notes.vat), cell(m.debit_notes.incl), cell(m.net_incl)];
    const rows = days.map((d) => rowFor(d.day, d));
    if (totals) rows.push(rowFor('TOTAL', totals));
    downloadCsv(`daily-sales-figures-${month}.csv`, [header, ...rows]);
  };

  const generatedAtFmt = new Date().toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <ReportFrame
      title={<>Daily Sales <em className="text-phosphor">Figures</em>.</>}
      subtitle={`Posted invoices, credit notes and debit notes for ${month || 'the current month'}, broken down by day with VAT shown separately. Net = Invoices + Debit notes − Credit notes. Amounts in Rand (R). Same Sage source as the Monthly Sales Figures (ARIBH, VAT-bearing documents).`}
      printId="daily-sales-figures"
      orientation="landscape"
      onExportCsv={days.length ? exportCsv : undefined}
      onPrint={() => window.print()}
      isLoading={isLoading}
      error={error?.message}
      printHeader={
        <PrintHeader
          title="Daily Sales Figures"
          filters={[`Month: ${month}`, 'Amounts in Rand (R)']}
          generatedAt={generatedAtFmt}
        />
      }
      printFooter={<PrintFooter note="Daily Sales Figures · Cardoso" />}
    >
      {unavailable ? (
        <div className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          Daily figures run live against each branch&apos;s Sage and aren&apos;t available on the hub. Open this report on a branch (site) install — the hub keeps monthly totals (see Monthly Sales Figures).
        </div>
      ) : !isLoading && !error && days.length === 0 ? (
        <div className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          No posted documents yet this month.
        </div>
      ) : days.length > 0 ? (
        <SalesFiguresTable rows={days} totals={totals} labelKey="day" labelHeader="Date" currentLabel={today} />
      ) : null}
    </ReportFrame>
  );
}
