import { useMemo } from "react";
import { analyseInvoiceCredit, CREDIT_BADGE_META } from "@/lib/creditAnalysis";
import { DEFAULT_CREDIT_LOGIC_CONFIG } from "@/lib/creditLogic";

// The WHY behind the verdict — a prominent card: verdict chip, score, the
// customer name, and the actual factors. Rendered only when the row is
// hovered (the row mounts this in a cursor-following portal), so running the
// full analysis stays off the table-render path.
//
// Exported because the WHOLE ROW carries this as its hover content (operator
// request): one explanation for the row, near the cursor, instead of a
// left-pinned tooltip and a separate badge tooltip overlapping each other.
export function VerdictHoverCard({ row, creditLogicConfig }) {
  const result = useMemo(
    () => analyseInvoiceCredit([row], [], creditLogicConfig || DEFAULT_CREDIT_LOGIC_CONFIG),
    [row, creditLogicConfig],
  );
  const meta = CREDIT_BADGE_META[result.verdict] || CREDIT_BADGE_META.caution;
  const factors = (result.factors || []).slice(0, 5);
  return (
    <div className="w-[340px] overflow-hidden rounded-xl border border-border bg-card shadow-2xl ring-1 ring-black/20">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3.5 py-2.5">
        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${meta.className}`}>
          {meta.label}
        </span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          Score <span className="font-semibold text-foreground">{result.score ?? "—"}</span>/100
        </span>
      </div>
      <div className="px-3.5 py-3">
        {row.customer_name && (
          <div className="mb-2 truncate text-sm font-semibold text-foreground">{row.customer_name}</div>
        )}
        {factors.length > 0 ? (
          <ul className="space-y-1.5">
            {factors.map((factor, i) => (
              <li key={i} className="flex gap-2 text-xs leading-snug text-foreground">
                <span
                  aria-hidden="true"
                  className={`shrink-0 font-bold ${factor.type === "good" ? "text-emerald-400" : factor.type === "block" ? "text-red-400" : "text-amber-400"}`}
                >
                  {factor.type === "good" ? "✓" : factor.type === "block" ? "✕" : "!"}
                </span>
                <span>{factor.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No detail available for this verdict.</p>
        )}
      </div>
    </div>
  );
}

// ── Credit analysis (shared with CustomerLookup) ─────────────────────────
// Plain pill — the hover explanation lives on the ROW (VerdictHoverContent),
// so the badge no longer carries its own tooltip (two stacked tooltips
// overlapped and looked messy).
export default function CreditBadge({ row, creditLogicConfig }) {
  // Prefer the server-computed verdict on row.credit_verdict (added by the
  // /api/top-balances route) — saves running analyseInvoiceCredit per row
  // on every parent re-render. Falls back to local compute for rows that
  // pre-date the server addition (e.g. hub-mode, older caches).
  const result = useMemo(() => {
    if (row?.credit_verdict) return { verdict: row.credit_verdict, score: row.credit_score };
    return analyseInvoiceCredit([row], [], creditLogicConfig || DEFAULT_CREDIT_LOGIC_CONFIG);
  }, [row, creditLogicConfig]);
  const meta = CREDIT_BADGE_META[result.verdict] || CREDIT_BADGE_META.caution;

  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold cursor-default ${meta.className}`}>
      {meta.label}
    </span>
  );
}
