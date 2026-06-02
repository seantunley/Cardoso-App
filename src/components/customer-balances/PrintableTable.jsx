import {
  parseAmount, formatAmount,
  getVisibleAccountType, getAccountTypePillClasses,
} from "./utils";

// Print-only render block — hidden on screen, visible only inside
// @media print where the PRINT_STYLE block flips visibility on
// #customer-balances-printable. Renders the *full* result set (printData
// or the current page's data, whichever is available) so the printed
// PDF isn't truncated to PAGE_SIZE.
export default function PrintableTable({
  printTitle, printDate, totalRecords,
  siteFilter, ageBucket, activeAgeBucketLabel,
  filteredGrandTotal, printRows, printData, sites,
}) {
  return (
    <div id="customer-balances-printable" style={{ visibility: "hidden", position: "absolute" }}>
      <div className="cb-print-header">
        <h1>{printTitle}</h1>
        <p>Printed: {printDate} · {totalRecords} customer{totalRecords !== 1 ? "s" : ""}</p>
      </div>
      <div className="cb-print-summary">
        <div>
          <div>
            Total outstanding ({totalRecords} customers{siteFilter !== "all" ? ` · ${siteFilter}` : ""}
            {ageBucket !== "all" ? ` · ${activeAgeBucketLabel}` : ""})
          </div>
          <strong>R {formatAmount(filteredGrandTotal)}</strong>
        </div>
        <div className="td-right">
            <div>Printed rows ({printRows.length} customers)</div>
            <strong>R {formatAmount(printData?.filteredTotalOutstanding ?? filteredGrandTotal)}</strong>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Customer Name</th>
            <th>Customer ID</th>
            {sites.length > 1 && <th>Site</th>}
            <th>Last Invoice</th>
            <th>Last Receipt</th>
            <th className="td-right">Outstanding Balance</th>
          </tr>
        </thead>
        <tbody>
          {printRows.map((row, idx) => {
            const amount = parseAmount(row.outstanding_balance);
            const fc = row.flag_color && row.flag_color !== "none" ? row.flag_color : null;
            return (
              <tr key={`print-${idx}`} className={idx === 0 ? "td-top" : ""}>
                <td className="td-muted">{idx + 1}</td>
                <td>
                  {fc && <span className={`flag-dot flag-${fc}`} title={row.flag_reason || fc} />}
                  {getVisibleAccountType(row.account_type) && (
                    <span className={`mr-2 inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium ${getAccountTypePillClasses(row.account_type)}`}>
                      {getVisibleAccountType(row.account_type)}
                    </span>
                  )}
                  <strong>{row.customer_name || "—"}</strong>
                </td>
                <td className="td-mono td-muted">{row.customer_number || "—"}</td>
                {sites.length > 1 && <td className="td-muted">{row.site_name || "—"}</td>}
                <td>
                  <div className="td-mono">{row.last_unpaid_invoice_1 || "—"}</div>
                  {row.last_unpaid_invoice_1_amount && <div>R {formatAmount(row.last_unpaid_invoice_1_amount)}</div>}
                  {row.last_unpaid_invoice_1_date && <div className="td-muted">{row.last_unpaid_invoice_1_date}</div>}
                </td>
                <td>
                  <div className="td-mono">{row.last_receipt_1 || "—"}</div>
                  {row.last_receipt_1_amount && <div>R {formatAmount(row.last_receipt_1_amount)}</div>}
                  {row.last_receipt_1_date && <div className="td-muted">{row.last_receipt_1_date}</div>}
                </td>
                <td className={`td-right ${amount > 10000 ? "td-amount-high" : amount > 0 ? "td-amount-mid" : "td-muted"}`}>
                  R {formatAmount(amount)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
