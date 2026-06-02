import { memo } from "react";
import FlagDot from "./FlagDot";
import CreditBadge from "./CreditBadge";
import {
  parseAmount, formatAmount,
  getVisibleAccountType, getAccountTypePillClasses,
} from "./utils";

// React.memo'd row — virtualisation already trims DOM count, but each
// visible row was still re-rendering on every parent state change
// (filters, sort, hover). With stable props from React Query, memo
// skips the row body's reconciliation when only unrelated state moves.
//
// Rows have variable height (invoice/receipt cells render 1-3 lines), so
// we accept a measureRef from the virtualizer for accurate spacer math.
const CustomerBalancesRow = memo(function CustomerBalancesRow(/** @type {{ row: any, idx: number, globalIdx: number, isTop: boolean, creditLogicConfig: any, assignment: any, measureRef: (n: Element | null) => void }} */ {
  row, idx, globalIdx, isTop, creditLogicConfig, assignment, measureRef,
}) {
  const amount = parseAmount(row.outstanding_balance);
  return (
    <tr
      ref={measureRef}
      data-index={idx}
      className={`border-b border-border last:border-0 transition-colors hover:bg-muted/30 ${isTop ? "bg-amber-500/5" : ""}`}
    >
      <td className="px-2 py-1 text-xs text-muted-foreground">{globalIdx + 1}</td>
      <td className="px-2 py-1 pr-3">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 w-[88px] shrink-0">
            <FlagDot color={row.flag_color} reason={row.flag_reason} />
            {getVisibleAccountType(row.account_type) && (
              <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium ${getAccountTypePillClasses(row.account_type)}`}>
                {getVisibleAccountType(row.account_type)}
              </span>
            )}
          </div>
          <span className={`font-medium truncate ${isTop ? "text-amber-400" : "text-foreground"}`}>
            {row.customer_name || "—"}
          </span>
          {assignment && (
            <span
              className="ml-auto shrink-0 inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/15 text-amber-300 px-1.5 py-0.5 text-[10px] font-medium"
              title={`On "${assignment.worklist_name}" — assigned to ${assignment.owner_name || "unassigned"}`}
            >
              Assigned: {assignment.owner_name || "—"}
            </span>
          )}
        </div>
      </td>
      <td className="px-2 py-1 text-xs text-muted-foreground font-mono">{row.customer_number || "—"}</td>
      <td className="px-2 py-1 text-xs text-muted-foreground">{row.site_name || "—"}</td>
      <td className="px-2 py-1 text-xs text-muted-foreground">{row.sales_rep || "—"}</td>
      <td className="px-2 py-1 text-xs">
        <div className="font-mono text-foreground leading-tight">{row.last_unpaid_invoice_1 || "—"}</div>
        {row.last_unpaid_invoice_1_amount && <div className="tabular-nums text-amber-400 leading-tight">R {formatAmount(row.last_unpaid_invoice_1_amount)}</div>}
        {row.last_unpaid_invoice_1_date && <div className="text-muted-foreground/60 leading-tight">{row.last_unpaid_invoice_1_date}</div>}
      </td>
      <td className="px-2 py-1 text-xs">
        <div className="font-mono text-foreground leading-tight">{row.last_receipt_1 || "—"}</div>
        {row.last_receipt_1_amount && <div className="tabular-nums text-amber-400 leading-tight">R {formatAmount(row.last_receipt_1_amount)}</div>}
        {row.last_receipt_1_date && <div className="text-muted-foreground/60 leading-tight">{row.last_receipt_1_date}</div>}
      </td>
      <td className="px-2 py-1 text-right">
        <span
          className={`font-semibold tabular-nums ${amount > 10000 ? "text-red-400" : amount > 0 ? "text-orange-400" : "text-muted-foreground"}`}
          title={amount > 10000 ? "High balance (over R10,000)" : amount > 0 ? "Outstanding balance" : "No balance"}
        >
          R {formatAmount(amount)}
        </span>
      </td>
      <td className="px-2 py-1 text-center">
        <CreditBadge row={row} creditLogicConfig={creditLogicConfig} />
      </td>
    </tr>
  );
});

export default CustomerBalancesRow;
