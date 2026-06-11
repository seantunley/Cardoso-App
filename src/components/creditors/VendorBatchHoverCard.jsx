// Cursor-following hover card for the Creditor Balances table — the same
// prominent popup style as the Customer Balances credit verdict card, showing
// the vendor's TRUE outstanding position as posted vs unposted batches:
//   Posted (Sage APOBL)  +  unposted invoices  −  unposted payments  =  true.
// Rendered by DataTable's hoverCard prop (portal + cursor-follow + click-through).
function fmtR(v) {
  return (Number(v) || 0).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function VendorBatchHoverCard({ vendor }) {
  if (!vendor) return null;
  const trueOut = Number(vendor.outstanding_amount) || 0;
  const posted = Number(vendor.outstanding_gross ?? vendor.outstanding_amount) || 0;
  const unpostedInv = Number(vendor.unposted_invoices) || 0;
  const unpostedPay = Number(vendor.unposted_payments) || 0;
  const hasUnposted = unpostedInv !== 0 || unpostedPay > 0;

  return (
    <div className="w-[420px] max-w-[90vw] overflow-hidden rounded-xl border border-border bg-card shadow-2xl ring-1 ring-black/20">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3.5 py-2.5">
        <span className="truncate text-sm font-semibold text-foreground">{vendor.vendor_name || vendor.vendor_code || "—"}</span>
        <span className="shrink-0 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">{vendor.vendor_code}</span>
      </div>
      <div className="px-3.5 py-3">
        {hasUnposted ? (
          <>
            <table className="w-full text-xs tabular-nums">
              <tbody>
                <tr>
                  <td className="py-0.5 text-muted-foreground">Posted <span className="text-muted-subtle">(Sage APOBL)</span></td>
                  <td className="py-0.5 text-right text-foreground">R {fmtR(posted)}</td>
                </tr>
                {unpostedInv !== 0 && (
                  <tr>
                    <td className="py-0.5 text-amber-400">+ Invoices in unposted batches</td>
                    <td className="py-0.5 text-right text-amber-400">R {fmtR(unpostedInv)}</td>
                  </tr>
                )}
                {unpostedPay > 0 && (
                  <tr>
                    <td className="py-0.5 text-emerald-400">− Payments captured, not posted</td>
                    <td className="py-0.5 text-right text-emerald-400">R {fmtR(unpostedPay)}</td>
                  </tr>
                )}
                <tr className="border-t border-border">
                  <td className="pt-1.5 font-semibold text-foreground">True outstanding</td>
                  <td className="pt-1.5 text-right font-semibold text-foreground">R {fmtR(trueOut)}</td>
                </tr>
              </tbody>
            </table>
            <p className="mt-2 text-[11px] leading-snug text-muted-subtle">
              Sage shows only the posted figure; the unposted batches (captured
              but not yet posted by accounts) adjust it to the true position.
            </p>
          </>
        ) : (
          <div className="flex items-center justify-between text-xs tabular-nums">
            <span className="text-muted-foreground">Outstanding <span className="text-muted-subtle">(Sage APOBL)</span></span>
            <span className="font-semibold text-foreground">R {fmtR(trueOut)}</span>
          </div>
        )}
        {!hasUnposted && (
          <p className="mt-2 text-[11px] leading-snug text-muted-subtle">No unposted batches — Sage and the true position agree.</p>
        )}
      </div>
    </div>
  );
}
