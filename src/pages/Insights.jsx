// Insights — a proactive feed of "things worth looking at", computed by the
// /api/insights detectors (sales declines, at-risk customers, dead stock,
// debtor exposure). Each card deep-links to the page where you'd act on it.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, TrendingDown, Info, CheckCircle2, ArrowRight, RefreshCw, Lightbulb, SlidersHorizontal } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/components/collections/utils";
import RulesModal from "@/components/insights/RulesModal";

const SEVERITY = {
  high: { label: "High", ring: "border-red-500/40", dot: "bg-red-500", text: "text-red-600 dark:text-red-400", Icon: AlertTriangle },
  medium: { label: "Medium", ring: "border-amber-500/40", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", Icon: TrendingDown },
  low: { label: "Low", ring: "border-blue-500/40", dot: "bg-blue-500", text: "text-blue-600 dark:text-blue-400", Icon: Info },
  info: { label: "FYI", ring: "border-emerald-500/40", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400", Icon: CheckCircle2 },
};

function InsightCard({ insight, onOpen }) {
  const s = SEVERITY[insight.severity] || SEVERITY.low;
  return (
    <button
      type="button"
      onClick={() => insight.link && onOpen(insight.link)}
      className={`flex w-full items-start gap-3 rounded-xl border ${s.ring} bg-card p-4 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--phosphor)]`}
    >
      <s.Icon className={`mt-0.5 h-5 w-5 shrink-0 ${s.text}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-semibold uppercase tracking-wide ${s.text}`}>{insight.category}</span>
          <span className={`h-1 w-1 rounded-full ${s.dot}`} />
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{s.label}</span>
        </div>
        <div className="mt-1 font-medium text-foreground">{insight.title}</div>
        <div className="mt-0.5 text-sm text-muted-foreground">{insight.detail}</div>
      </div>
      {insight.link && <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />}
    </button>
  );
}

export default function Insights() {
  const navigate = useNavigate();
  const [rulesOpen, setRulesOpen] = useState(false);
  const me = useQuery({ queryKey: ["me"], queryFn: () => apiGet("/api/auth/me"), staleTime: 300_000 });
  const isAdmin = me.data?.role === "admin";
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["insights"],
    queryFn: () => apiGet("/api/insights"),
    staleTime: 60_000,
  });

  const insights = data?.insights || [];
  const generated = data?.generated_at ? new Date(data.generated_at).toLocaleString("en-ZA", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : null;

  return (
    <div className="min-h-screen bg-background px-4 py-6 text-foreground md:px-6">
      <PageHeader
        title="Insights"
        subtitle="Automatically surfaced changes and risks across sales, customers, inventory and receivables. Open a card to act on it."
        actions={
          <>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setRulesOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" /> Manage rules
              </button>
            )}
            <button
              type="button"
              onClick={() => refetch()}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} /> Refresh
            </button>
          </>
        }
      />

      <RulesModal open={rulesOpen} onClose={() => setRulesOpen(false)} onChanged={() => refetch()} />

      {generated && <p className="mb-4 -mt-2 text-xs text-muted-foreground">Updated {generated}</p>}

      {error ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-center text-sm text-red-400">
          <AlertTriangle className="mx-auto mb-3 h-8 w-8 opacity-70" />
          <p className="font-semibold">Couldn't load insights</p>
          <p className="text-xs text-red-400/70">{error.message}</p>
          <button type="button" onClick={() => refetch()} className="mt-3 rounded-md border border-red-500/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10">Retry</button>
        </div>
      ) : isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-border bg-card p-4">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-2 h-4 w-2/3" />
              <Skeleton className="mt-2 h-3 w-1/2" />
            </div>
          ))}
        </div>
      ) : data?.hub_mode ? (
        <EmptyState icon={Lightbulb} title="Insights run on site installs" message="The insights feed reads the local sales cache, which isn't populated on the hub." />
      ) : insights.length === 0 ? (
        <EmptyState icon={CheckCircle2} title="Nothing needs attention" message="No significant changes or risks detected right now. Check back after the next sync." />
      ) : (
        <div className="space-y-3">
          {insights.map((i) => (
            <InsightCard key={i.id} insight={i} onOpen={(link) => navigate(link)} />
          ))}
        </div>
      )}
    </div>
  );
}
