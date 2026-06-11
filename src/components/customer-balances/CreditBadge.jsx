import { useMemo } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { analyseInvoiceCredit, CREDIT_BADGE_META } from "@/lib/creditAnalysis";
import { DEFAULT_CREDIT_LOGIC_CONFIG } from "@/lib/creditLogic";

// The WHY behind the verdict — rendered only when the tooltip actually opens
// (Radix mounts content lazily), so running the full analysis stays off the
// table-render path. Without this, a Hold sitting next to an Approve was
// unexplainable from the page (operator report: verdicts looked inverted
// until you knew the older unpaid invoices lived in slots the row doesn't
// display).
function VerdictWhy({ row, creditLogicConfig }) {
  const result = useMemo(
    () => analyseInvoiceCredit([row], [], creditLogicConfig || DEFAULT_CREDIT_LOGIC_CONFIG),
    [row, creditLogicConfig],
  );
  const factors = (result.factors || []).slice(0, 4);
  if (factors.length === 0) return null;
  return (
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
  );
}

// ── Credit analysis (shared with CustomerLookup) ─────────────────────────
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
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold cursor-default ${meta.className}`}>
          {meta.label}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <div>Score: {result.score ?? "—"}/100 — {meta.label}</div>
        <VerdictWhy row={row} creditLogicConfig={creditLogicConfig} />
      </TooltipContent>
    </Tooltip>
  );
}
