import { useMemo } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { analyseInvoiceCredit, CREDIT_BADGE_META } from "@/lib/creditAnalysis";
import { DEFAULT_CREDIT_LOGIC_CONFIG } from "@/lib/creditLogic";

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
      <TooltipContent>Score: {result.score ?? "—"}/100 — {meta.label}</TooltipContent>
    </Tooltip>
  );
}
