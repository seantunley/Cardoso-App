import { useQuery } from "@tanstack/react-query";

// Print-only render block for Creditor Balances — hidden on screen, visible
// only inside @media print where CREDITOR_PRINT_STYLE flips visibility on
// #creditor-balances-printable. Same letterhead, branding and table rules as
// the Customer Balances print (PrintableTable.jsx), with vendor columns and
// the true-outstanding (posted + unposted) figures.
function fmtR(v) {
  return (Number(v) || 0).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function CreditorPrintableTable({
  printTitle, printDate, rows, aging, site, showSite,
}) {
  // Same depot letterhead as the debtor print.
  const { data: depot } = useQuery({
    queryKey: ["depot-profile-name"],
    queryFn: () => fetch("/api/depot-profile", { credentials: "include" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    staleTime: 5 * 60_000,
  });
  const depotName = (depot?.profile?.name || "").trim();
  const n = rows.length;
  const trueTotal = aging?.net_total ?? aging?.total_outstanding ?? 0;
  const postedTotal = aging?.total_outstanding ?? 0;
  const hasUnposted = (aging?.unposted_invoices_total || 0) !== 0 || (aging?.unposted_payments_total || 0) > 0;

  return (
    <div id="creditor-balances-printable" style={{ visibility: "hidden", position: "absolute" }}>
      <div className="cb-print-header">
        <div className="cb-print-headmain">
          {depotName && <div className="cb-print-depot">{depotName}</div>}
          <h1>{printTitle}</h1>
          <p>Printed: {printDate} · {n} vendor{n !== 1 ? "s" : ""}</p>
        </div>
        <div className="cb-print-brand">
          <img src="/cardoso-logo-orange.png" alt="Cardoso" className="cb-print-logo" />
          Confidential business report
        </div>
      </div>
      <div className="cb-print-summary">
        <div>
          <div>True outstanding ({n} vendor{n !== 1 ? "s" : ""}{showSite && site !== "all" ? ` · ${site}` : ""})</div>
          <strong>R {fmtR(trueTotal)}</strong>
        </div>
        {hasUnposted && (
          <div className="td-right">
            <div>Posted (Sage)</div>
            <strong>R {fmtR(postedTotal)}</strong>
          </div>
        )}
      </div>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Vendor</th>
            <th>Code</th>
            <th>Terms</th>
            <th>Last Receipt</th>
            <th>Last Payment</th>
            <th className="td-right">Outstanding</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => {
            const amount = Number(r.outstanding_amount) || 0;
            return (
              <tr key={`crprint-${idx}`} className={idx === 0 ? "td-top" : ""}>
                <td className="td-muted">{idx + 1}</td>
                <td><strong>{r.vendor_name || "—"}</strong></td>
                <td className="td-mono td-muted">{r.vendor_code || "—"}</td>
                <td className="td-muted">{r.terms || "—"}</td>
                <td className="td-muted">{r.last_receipt_date || "—"}</td>
                <td className="td-muted">{r.last_payment_date || "—"}</td>
                <td className={`td-right ${amount > 10000 ? "td-amount-high" : amount > 0 ? "td-amount-mid" : "td-muted"}`}>
                  R {fmtR(amount)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
