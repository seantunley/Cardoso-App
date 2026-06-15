import { useQuery } from "@tanstack/react-query";

// Print-only render block for a BAT reconciliation tab (Paid / Non-Compliant /
// Exceptions). Hidden on screen; visible only inside @media print where
// BAT_TAB_PRINT_STYLE flips visibility on #bat-tab-printable. The header
// carries the depot name, the Cardoso letterhead, the year + week number, and
// the tab name that was printed — per the operator's requirement.
function fmtR(v) {
  return `R ${(Number(v) || 0).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// OCR / POD status as plain printable text (the on-screen badge has colour
// only). Missing-POD synthetic rows have no extraction status.
function statusText(e) {
  if (e.is_missing_pod) return "No POD";
  switch (e.extraction_status) {
    case "found": return "Found";
    case "not_found": return "Not found";
    case "failed": return "Failed";
    case "pending": return "Pending";
    default: return "—";
  }
}

export default function BatTabPrintable({ rows = [], tabLabel, tabId, weekNumber, year }) {
  // Same depot letterhead as the Customer/Creditor Balances prints.
  const { data: depot } = useQuery({
    queryKey: ["depot-profile-name"],
    queryFn: () => fetch("/api/depot-profile", { credentials: "include" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    staleTime: 5 * 60_000,
  });
  const depotName = (depot?.profile?.name || "").trim();
  const printDate = new Date().toLocaleString("en-ZA", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const isExceptions = tabId === "exceptions";
  const n = rows.length;
  const total = rows.reduce((s, e) => s + (Number(e.order_amount) || 0), 0);
  const weekStr = weekNumber != null ? `Week ${String(weekNumber).padStart(2, "0")}` : "Week —";
  // Columns before Amount: #, Order, Customer No., Customer, Week, Delivery,
  // POD Uploaded, OCR, Invoice = 9 (+ Exception Reason on the exceptions tab).
  const preAmountCols = isExceptions ? 10 : 9;

  return (
    <div id="bat-tab-printable" style={{ visibility: "hidden", position: "absolute" }}>
      <div className="bat-print-header">
        <div className="bat-print-headmain">
          {depotName && <div className="bat-print-depot">{depotName}</div>}
          <h1>BAT Reconciliation — {tabLabel}</h1>
          <div className="bat-print-sub">{weekStr} · {year ?? "—"}</div>
          <p>Printed: {printDate} · {n} {n === 1 ? "invoice" : "invoices"}</p>
        </div>
        <div className="bat-print-brand">
          <img src="/cardoso-logo-orange.png" alt="Cardoso" className="bat-print-logo" />
          Confidential business report
        </div>
      </div>
      <div className="bat-print-summary">
        <div>{tabLabel} — {weekStr} · {year ?? "—"} ({n} {n === 1 ? "invoice" : "invoices"})</div>
        <strong>{fmtR(total)}</strong>
      </div>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Order</th>
            <th>Customer No.</th>
            <th>Customer</th>
            <th>Week</th>
            <th>Delivery</th>
            <th>POD Uploaded</th>
            <th>OCR</th>
            <th>Invoice</th>
            {isExceptions && <th>Exception Reason</th>}
            <th className="td-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e, idx) => (
            <tr key={`batprint-${idx}`}>
              <td className="td-muted">{idx + 1}</td>
              <td className="td-mono">{e.order_number || "—"}</td>
              <td className="td-mono td-muted">{e.validate || "—"}</td>
              <td>{e.store_name || "—"}</td>
              <td className="td-muted">{e.week || "—"}</td>
              <td className="td-mono td-muted">{e.delivery_date || "—"}</td>
              <td className="td-mono td-muted">{e.pod_uploaded_date || "—"}</td>
              <td>{statusText(e)}</td>
              <td className="td-mono">{e.extracted_invoice || "—"}</td>
              {isExceptions && <td className="td-muted">{e.exception_reason || "—"}</td>}
              <td className="td-right td-mono">{e.order_amount != null ? fmtR(e.order_amount) : "—"}</td>
            </tr>
          ))}
          {n === 0 && (
            <tr><td colSpan={preAmountCols + 1} className="td-muted td-center">No invoices in this list.</td></tr>
          )}
        </tbody>
        {n > 0 && (
          <tfoot>
            <tr>
              <td colSpan={preAmountCols}>Total ({n} {n === 1 ? "invoice" : "invoices"})</td>
              <td className="td-right td-mono">{fmtR(total)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
