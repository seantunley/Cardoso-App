import { useQuery } from "@tanstack/react-query";

// Print-only render of one item's stock card: opening balance, every movement
// with its running balance, then closing — with the same depot letterhead as
// the BAT tab / daily-sales document prints. Hidden on screen; revealed only
// under body.print-stock-card (see STOCK_CARD_PRINT_STYLE). The on-screen card
// is the source of truth — this mirrors exactly what the ledger table shows so
// the printout ties out the same way.

function fmtQty(v) {
  if (v == null) return "—";
  const n = Math.round(Number(v) * 1000) / 1000;
  return n.toLocaleString("en-ZA", { maximumFractionDigits: 3 });
}
function fmtR(v) {
  return v == null ? "—" : `R ${(Number(v) || 0).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function StockCardPrintable({ item, from, to, ledger, totals }) {
  // Same depot letterhead as the other prints.
  const { data: depot } = useQuery({
    queryKey: ["depot-profile-name"],
    queryFn: () => fetch("/api/depot-profile", { credentials: "include" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    staleTime: 5 * 60_000,
  });
  const depotName = (depot?.profile?.name || "").trim();
  const printedAt = new Date().toLocaleString("en-ZA", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

  if (!item || !ledger) return <div id="stock-card-printable" style={{ visibility: "hidden", position: "absolute" }} />;
  const movements = ledger.movements || [];

  return (
    <div id="stock-card-printable" style={{ visibility: "hidden", position: "absolute" }}>
      <div className="sc-head">
        <div>
          {depotName && <div className="sc-depot">{depotName}</div>}
          <h1>Stock Card — {item.item_number}</h1>
          <div className="sc-sub">{item.item_description || "—"} · {item.location}</div>
          <p>Period {from} → {to} · Printed {printedAt}</p>
        </div>
        <div className="sc-brand">
          <img src="/cardoso-logo-orange.png" alt="Cardoso" className="sc-logo" />
          Confidential business report
        </div>
      </div>

      <div className="sc-summary">
        <div><div className="lbl">Opening ({from})</div><div className="val">{fmtQty(ledger.opening_balance)}</div></div>
        <div><div className="lbl">In · Out</div><div className="val">{fmtQty(totals.inQty)} · {fmtQty(totals.outQty)}</div></div>
        <div><div className="lbl">Closing ({to})</div><div className="val">{fmtQty(ledger.closing_balance)}</div></div>
        <div><div className="lbl">On hand</div><div className="val">{fmtQty(ledger.on_hand)}{ledger.reconciles ? " ✓" : ""}</div></div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Movement</th>
            <th>Document</th>
            <th className="td-right">In</th>
            <th className="td-right">Out</th>
            <th className="td-right">Balance</th>
            <th className="td-right">Cost</th>
          </tr>
        </thead>
        <tbody>
          <tr className="tr-bound">
            <td colSpan={5}>Opening balance — as at {from}</td>
            <td className="td-right td-mono">{fmtQty(ledger.opening_balance)}</td>
            <td />
          </tr>
          {movements.map((m, i) => {
            const q = Number(m.stock_qty) || 0;
            return (
              <tr key={i}>
                <td className="td-mono td-muted">{m.transaction_date || "—"}</td>
                <td>{m.movement_type}</td>
                <td className="td-mono td-muted">{m.doc_number || "—"}</td>
                <td className="td-right td-mono">{q > 0 ? fmtQty(q) : ""}</td>
                <td className="td-right td-mono">{q < 0 ? fmtQty(-q) : ""}</td>
                <td className="td-right td-mono">{fmtQty(m.balance)}</td>
                <td className="td-right td-mono td-muted">{fmtR(m.cost)}</td>
              </tr>
            );
          })}
          {movements.length === 0 && (
            <tr><td colSpan={7} className="td-muted td-center" style={{ padding: "6px" }}>No movements in this window.</td></tr>
          )}
          <tr className="tr-bound">
            <td colSpan={5}>
              Closing balance — as at {to}
              {ledger.reconciles ? " · anchored to on hand ✓" : ` · internal variance ${fmtQty(ledger.reconcile_variance)}`}
            </td>
            <td className="td-right td-mono">{fmtQty(ledger.closing_balance)}</td>
            <td />
          </tr>
        </tbody>
      </table>
    </div>
  );
}
