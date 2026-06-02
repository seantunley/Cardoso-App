// Reusable summary tile used across pages that show a headline figure
// (Customer Balances, Inventory, Collections). One canonical place
// for the padding, border radius, and label/number typography so
// changes happen in one file instead of N.
//
// Usage:
//   <SummaryTile
//     label="Total outstanding (115 customers)"
//     value={`R ${formatAmount(123456.78)}`}
//   />
//
// Pass `accent` for the optional left/bottom orange phosphor bar
// (matches the Reconciliation page tiles).

export default function SummaryTile({ label, value, accent = false, className = "" }) {
  return (
    <div
      className={`relative rounded-xl border border-border bg-card px-6 py-5 overflow-hidden ${className}`}
    >
      {accent && (
        <div
          className="absolute left-0 right-0 bottom-0 h-[2px]"
          style={{ background: "var(--phosphor)", boxShadow: "0 0 12px hsla(33,95%,55%,0.35)" }}
        />
      )}
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-bold text-foreground tabular-nums">{value}</div>
    </div>
  );
}
