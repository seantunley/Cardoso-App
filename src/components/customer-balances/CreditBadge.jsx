import { useMemo } from "react";
import { analyseInvoiceCredit, CREDIT_BADGE_META } from "@/lib/creditAnalysis";
import { DEFAULT_CREDIT_LOGIC_CONFIG } from "@/lib/creditLogic";

// The WHY behind the verdict — score, label, and the actual factors.
// Rendered only when a tooltip actually opens (Radix mounts content lazily),
// so running the full analysis stays off the table-render path.
//
// Exported because the WHOLE ROW now carries this as its hover content
// (operator request): the row's own title tooltip overlapped the badge
// tooltip and looked messy, so the verdict explanation became the single
// default hover for the row, and the badge itself is a plain pill.
export function VerdictHoverContent({ row, creditLogicConfig }) {
  const result = useMemo(
    () => analyseInvoiceCredit([row], [], creditLogicConfig || DEFAULT_CREDIT_LOGIC_CONFIG),
    [row, creditLogicConfig],
  );
  const meta = CREDIT_BADGE_META[result.verdict] || CREDIT_BADGE_META.caution;
  const factors = (result.factors || []).slice(0, 4);
  return (
    <div>
      <div>Score: {result.score ?? "—"}/100 — {meta.label}</div>
      {factors.length > 0 && (
        <ul className="mt-1.5 max-w-[300px] space-y-1 border-t border-border pt-1.5 text-left">
          {factors.map((factor, i) => (
            <li key={i} className="text-xs leading-snug">
              <span aria-hidden="true" className="mr-1">
                {factor.type === "good" ? "✓" : factor.type === "block" ? "✕" : "!"}
              </span>
              {factor.text}
            </li>
          ))}
        </ul>
      )}
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
