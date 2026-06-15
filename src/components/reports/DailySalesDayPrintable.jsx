import { useQuery } from '@tanstack/react-query';

// Print-only render block for ONE day of the Daily Sales Figures report: every
// posted Invoice / Credit Note / Debit Note dated that day, grouped by type with
// per-type subtotals and a Net total. Hidden on screen; revealed only inside
// @media print when `body.print-day-docs` is set (see DAILY_DOCS_PRINT_STYLE).
// The letterhead carries the depot name, the Cardoso branding, and the day —
// matching the BAT reconciliation tab print.

function fmtR(v) {
  return `R ${(Number(v) || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Display order + labels for the three document types.
const GROUPS = [
  { key: 'invoice', label: 'Invoices' },
  { key: 'credit_note', label: 'Credit Notes' },
  { key: 'debit_note', label: 'Debit Notes' },
];

function DocGroup({ label, rows }) {
  const sub = rows.reduce(
    (a, r) => ({ excl: a.excl + (Number(r.excl) || 0), vat: a.vat + (Number(r.vat) || 0), incl: a.incl + (Number(r.incl) || 0) }),
    { excl: 0, vat: 0, incl: 0 },
  );
  return (
    <>
      <div className="ddoc-print-section-title">{label} ({rows.length})</div>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Document</th>
            <th>Customer No.</th>
            <th>Customer</th>
            <th>Order</th>
            <th className="td-right">Ex-VAT</th>
            <th className="td-right">VAT</th>
            <th className="td-right">Incl</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.doc_number}-${i}`}>
              <td className="td-muted">{i + 1}</td>
              <td className="td-mono">{r.doc_number || '—'}</td>
              <td className="td-mono td-muted">{r.customer_code || '—'}</td>
              <td>{r.customer_name || '—'}</td>
              <td className="td-mono td-muted">{r.order_number || '—'}</td>
              <td className="td-right td-mono">{fmtR(r.excl)}</td>
              <td className="td-right td-mono">{fmtR(r.vat)}</td>
              <td className="td-right td-mono">{fmtR(r.incl)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={5}>Subtotal ({rows.length})</td>
            <td className="td-right td-mono">{fmtR(sub.excl)}</td>
            <td className="td-right td-mono">{fmtR(sub.vat)}</td>
            <td className="td-right td-mono">{fmtR(sub.incl)}</td>
          </tr>
        </tfoot>
      </table>
    </>
  );
}

export default function DailySalesDayPrintable({ date, documents = [], netIncl = 0 }) {
  // Same depot letterhead as the BAT tab / Customer Balances prints.
  const { data: depot } = useQuery({
    queryKey: ['depot-profile-name'],
    queryFn: () => fetch('/api/depot-profile', { credentials: 'include' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    staleTime: 5 * 60_000,
  });
  const depotName = (depot?.profile?.name || '').trim();

  const printedAt = new Date().toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const dayLabel = date
    ? new Date(`${date}T00:00:00`).toLocaleDateString('en-ZA', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
    : '—';
  const n = documents.length;
  const grouped = GROUPS.map((g) => ({ ...g, rows: documents.filter((d) => d.type_key === g.key) }));

  return (
    <div id="daily-docs-printable" style={{ visibility: 'hidden', position: 'absolute' }}>
      <div className="ddoc-print-header">
        <div>
          {depotName && <div className="ddoc-print-depot">{depotName}</div>}
          <h1>Daily Sales — Documents</h1>
          <div className="ddoc-print-sub">{dayLabel}</div>
          <p>Printed: {printedAt} · {n} {n === 1 ? 'document' : 'documents'} · Invoices, Credit Notes &amp; Debit Notes (VAT-bearing, ARIBH)</p>
        </div>
        <div className="ddoc-print-brand">
          <img src="/cardoso-logo-orange.png" alt="Cardoso" className="ddoc-print-logo" />
          Confidential business report
        </div>
      </div>

      {n === 0 ? (
        <p className="td-muted">No posted documents on this day.</p>
      ) : (
        grouped.filter((g) => g.rows.length > 0).map((g) => <DocGroup key={g.key} label={g.label} rows={g.rows} />)
      )}

      {n > 0 && (
        <div className="ddoc-grand">
          <span>Net (Invoices + Debit Notes − Credit Notes)</span>
          <strong>{fmtR(netIncl)}</strong>
        </div>
      )}
    </div>
  );
}
