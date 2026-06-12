import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ReportFrame, PrintHeader, PrintFooter, downloadCsv } from './lib';
import SalesFiguresTable from './SalesFiguresTable';
import DailySalesDayPrintable from './DailySalesDayPrintable';
import { DAILY_DOCS_PRINT_STYLE } from './dailyDocsPrintStyle';

// Current month's posted A/R documents broken down by day, with the VAT split
// and Net (Invoices + Debit notes − Credit notes). Same Sage source (ARIBH) as
// the Monthly Sales Figures report. Amounts in Rand (R). Site-only — the hub
// keeps monthly totals, so it shows a note in hub mode.
//
// Each day row has a Print button that pulls that day's full document list
// (every Invoice / Credit Note / Debit Note) and prints it on its own
// letterhead sheet — see DailySalesDayPrintable + DAILY_DOCS_PRINT_STYLE.

const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

function fetchDaily() {
  return fetch('/api/reports/daily-sales-figures', { credentials: 'include' })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

function fetchDayDocuments(day) {
  return fetch(`/api/reports/daily-sales-documents?date=${encodeURIComponent(day)}`, { credentials: 'include' })
    .then(async (r) => {
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || `HTTP ${r.status}`); }
      return r.json();
    });
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

  // Inject the per-day "documents" print stylesheet once. It's gated on
  // body.print-day-docs so it never interferes with the main report's print.
  useEffect(() => {
    const id = 'daily-docs-print-style';
    if (!document.getElementById(id)) {
      const el = document.createElement('style');
      el.id = id;
      el.textContent = DAILY_DOCS_PRINT_STYLE;
      document.head.appendChild(el);
    }
  }, []);

  // Per-day document print. Clicking a row's Print button bumps `printReq`
  // (with a nonce so the same day can be reprinted); once that day's documents
  // are fetched we flip into print-day-docs mode and call window.print().
  const [printReq, setPrintReq] = useState(null); // { day, nonce }
  const nonceRef = useRef(0);
  const handledNonceRef = useRef(0);

  const docsQuery = useQuery({
    queryKey: ['daily-sales-documents', printReq?.day],
    queryFn: () => fetchDayDocuments(printReq.day),
    enabled: !!printReq?.day,
    staleTime: 60_000,
  });

  const handlePrintDay = (day) => {
    nonceRef.current += 1;
    setPrintReq({ day, nonce: nonceRef.current });
  };

  useEffect(() => {
    if (!printReq || handledNonceRef.current === printReq.nonce) return;

    if (docsQuery.isError) {
      handledNonceRef.current = printReq.nonce;
      toast.error(`Could not load documents for ${printReq.day}: ${docsQuery.error.message}`);
      return;
    }
    if (docsQuery.isSuccess && docsQuery.data?.date === printReq.day) {
      handledNonceRef.current = printReq.nonce;
      if (!docsQuery.data.documents?.length) {
        toast.message(`No posted documents on ${printReq.day}.`);
        return;
      }
      const onAfter = () => { document.body.classList.remove('print-day-docs'); window.removeEventListener('afterprint', onAfter); };
      window.addEventListener('afterprint', onAfter);
      document.body.classList.add('print-day-docs');
      const t = setTimeout(() => window.print(), 60); // let the printable paint first
      return () => clearTimeout(t);
    }
    return undefined;
  }, [printReq, docsQuery.isSuccess, docsQuery.isError, docsQuery.data, docsQuery.error]);

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
    <>
    <ReportFrame
      title={<>Daily Sales <em className="text-phosphor">Figures</em>.</>}
      subtitle={`Posted invoices, credit notes and debit notes for ${month || 'the current month'}, broken down by day with VAT shown separately. Net = Invoices + Debit notes − Credit notes. Amounts in Rand (R). Same Sage source as the Monthly Sales Figures (ARIBH, VAT-bearing documents). Use a row's Print button to print that day's full document list.`}
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
        <SalesFiguresTable rows={days} totals={totals} labelKey="day" labelHeader="Date" currentLabel={today} onPrintRow={handlePrintDay} />
      ) : null}
    </ReportFrame>

    {/* Print-only block, OUTSIDE the report's printable region (so the main
        report print never reveals it). Hidden on screen; shown only under
        body.print-day-docs while printing one day's documents. */}
    <DailySalesDayPrintable
      date={docsQuery.data?.date}
      documents={docsQuery.data?.documents || []}
      netIncl={docsQuery.data?.net_incl || 0}
    />
    </>
  );
}
