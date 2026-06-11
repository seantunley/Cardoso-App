import { memo, useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import FlagDot from "./FlagDot";
import CreditBadge, { VerdictHoverCard } from "./CreditBadge";
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
//
// Hovering the row shows the CREDIT VERDICT explanation as a prominent card
// that FOLLOWS THE CURSOR (operator request: the old Radix tooltip pinned to
// the row's left margin, far from the pointer). The card renders through a
// portal to document.body so the table's overflow never clips it, with
// pointer-events:none so it never blocks the row's click/hover. Position is
// written straight to the node's style on mousemove — no React state churn
// per move across all the virtualised rows.
const CustomerBalancesRow = memo(function CustomerBalancesRow(/** @type {{ row: any, idx: number, globalIdx: number, isTop: boolean, creditLogicConfig: any, assignment: any, measureRef: (n: Element | null) => void }} */ {
  row, idx, globalIdx, isTop, creditLogicConfig, assignment, measureRef,
}) {
  const amount = parseAmount(row.outstanding_balance);
  const [hover, setHover] = useState(false);
  const tipRef = useRef(null);
  const posRef = useRef({ x: 0, y: 0 });

  // Place the card just off the cursor, flipping to the other side / above
  // when it would spill past the viewport edge.
  const positionTip = useCallback(() => {
    const el = tipRef.current;
    if (!el) return;
    const pad = 16;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = posRef.current.x + pad;
    let top = posRef.current.y + pad;
    if (left + w > vw - 8) left = posRef.current.x - pad - w;
    if (left < 8) left = 8;
    if (top + h > vh - 8) top = Math.max(8, posRef.current.y - pad - h);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, []);

  const onMove = useCallback((e) => {
    posRef.current = { x: e.clientX, y: e.clientY };
    positionTip();
  }, [positionTip]);

  return (
    <>
      <tr
        ref={measureRef}
        data-index={idx}
        onMouseEnter={(e) => { posRef.current = { x: e.clientX, y: e.clientY }; setHover(true); }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(false)}
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
        <td className="px-2 py-1 text-xs text-muted-foreground"><span className="block truncate">{row.location || "—"}</span></td>
        <td className="px-2 py-1 text-xs text-muted-foreground"><span className="block truncate">{row.terms || "—"}</span></td>
        <td className="px-2 py-1 text-xs">
          <div className="font-mono text-foreground leading-tight">{row.last_unpaid_invoice_1 || "—"}</div>
          {row.last_unpaid_invoice_1_amount && <div className="tabular-nums text-amber-400 leading-tight">R {formatAmount(row.last_unpaid_invoice_1_amount)}</div>}
          {row.last_unpaid_invoice_1_date && <div className="text-muted-subtle leading-tight">{row.last_unpaid_invoice_1_date}</div>}
        </td>
        <td className="px-2 py-1 text-xs">
          <div className="font-mono text-foreground leading-tight">{row.last_receipt_1 || "—"}</div>
          {row.last_receipt_1_amount && <div className="tabular-nums text-amber-400 leading-tight">R {formatAmount(row.last_receipt_1_amount)}</div>}
          {row.last_receipt_1_date && <div className="text-muted-subtle leading-tight">{row.last_receipt_1_date}</div>}
        </td>
        <td className="px-2 py-1 text-right">
          <span
            className={`font-semibold tabular-nums ${amount > 10000 ? "text-red-400" : amount > 0 ? "text-orange-400" : "text-muted-foreground"}`}
          >
            R {formatAmount(amount)}
          </span>
        </td>
        <td className="px-2 py-1 text-center">
          <CreditBadge row={row} creditLogicConfig={creditLogicConfig} />
        </td>
      </tr>
      {hover && createPortal(
        <div
          ref={(el) => { tipRef.current = el; if (el) positionTip(); }}
          style={{ position: "fixed", left: posRef.current.x + 16, top: posRef.current.y + 16, zIndex: 70, pointerEvents: "none" }}
        >
          <VerdictHoverCard row={row} creditLogicConfig={creditLogicConfig} />
        </div>,
        document.body,
      )}
    </>
  );
});

export default CustomerBalancesRow;
