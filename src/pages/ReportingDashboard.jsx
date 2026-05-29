// ReportingDashboard — a single at-a-glance overview across the reporting
// surface. Unlike the Reports page (which shows one full report at a time),
// this consolidates the headline numbers from several reports into one screen,
// fronted by the Sage health panel, with "view full report" links that deep-
// link into the matching report. Reuses the existing /api/reports/* endpoints
// and the shared report formatters/tiles so styling stays consistent.
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Wallet, Users, Boxes, BarChart3, ArrowRight, RefreshCw, Lightbulb } from "lucide-react";
import SageHealthPanel from "@/components/health/SageHealthPanel";
import { SummaryTile, fmtR, fmtCompactR } from "@/components/reports/lib";
import { apiGet } from "@/components/collections/utils";
import { Skeleton } from "@/components/ui/skeleton";
import PageHeader from "@/components/PageHeader";

const BUCKET_META = [
  { key: "current", label: "Current", color: "hsl(145 55% 45%)" },
  { key: "7-13", label: "7–13d", color: "hsl(50 90% 55%)" },
  { key: "14-20", label: "14–20d", color: "hsl(33 95% 55%)" },
  { key: "21+", label: "21+d", color: "hsl(0 72% 50%)" },
];

// A card that wraps a report summary with a header + deep-link.
function ReportCard({ icon: Icon, title, accent, to, children, query }) {
  const navigate = useNavigate();
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4" style={{ color: accent }} />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground">{title}</h2>
        </div>
        {to && (
          <button
            type="button"
            onClick={() => navigate(query ? `${to}?report=${query}` : to)}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            View report <ArrowRight className="h-3 w-3" />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

// Skeleton placeholder while a card's data loads — feels faster than a
// "Loading…" string and reserves the layout so cards don't jump on arrival.
function CardSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
      <div className="space-y-1.5 pt-1">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4" />
      </div>
    </div>
  );
}

function CardError({ error, onRetry }) {
  return (
    <div className="text-sm text-red-600 dark:text-red-400">
      <p>Couldn't load: {error.message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={() => onRetry()}
          className="mt-2 inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      )}
    </div>
  );
}

function AgedDebtorsCard() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["dash-aged-debtors"],
    queryFn: () => apiGet("/api/reports/aged-debtors"),
    staleTime: 60_000,
  });
  const s = data?.summary;
  return (
    <ReportCard icon={Wallet} title="Aged Debtors" accent="hsl(33 95% 55%)" to="/Reports" query="aged-debtors">
      {error ? (
        <CardError error={error} onRetry={refetch} />
      ) : isLoading ? (
        <CardSkeleton />
      ) : (
        <>
          <div className="mb-3">
            <div className="text-2xl font-semibold tabular-nums text-foreground">
              <span className="mr-1 text-muted-foreground/60">R</span>
              {fmtR(s?.total_outstanding)}
            </div>
            <div className="text-xs text-muted-foreground">{s?.total_customers ?? 0} customers outstanding</div>
          </div>
          <div className="space-y-1">
            {BUCKET_META.map((b) => (
              <div key={b.key} className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="h-2 w-2 rounded-full" style={{ background: b.color }} />
                  {b.label}
                </span>
                <span className="tabular-nums text-foreground">R {fmtR(s?.buckets?.[b.key])}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </ReportCard>
  );
}

function RepExposureCard() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["dash-rep-exposure"],
    queryFn: () => apiGet("/api/reports/rep-exposure"),
    staleTime: 60_000,
  });
  const reps = (data?.reps || []).slice(0, 4);
  return (
    <ReportCard icon={Users} title="Rep Exposure" accent="hsl(200 80% 55%)" to="/Reports" query="rep-exposure">
      {error ? (
        <CardError error={error} onRetry={refetch} />
      ) : isLoading ? (
        <CardSkeleton />
      ) : (
        <>
          <div className="mb-3">
            <div className="text-2xl font-semibold tabular-nums text-foreground">
              <span className="mr-1 text-muted-foreground/60">R</span>
              {fmtR(data?.summary?.total_outstanding)}
            </div>
            <div className="text-xs text-muted-foreground">across {data?.summary?.total_reps ?? 0} reps</div>
          </div>
          <div className="space-y-1">
            {reps.map((r) => (
              <div key={r.sales_rep} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate text-muted-foreground">{r.sales_rep}</span>
                <span className="tabular-nums text-foreground">R {fmtR(r.total_outstanding)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </ReportCard>
  );
}

function InventoryValueCard() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["dash-inventory-value"],
    queryFn: () => apiGet("/api/reports/inventory-value"),
    staleTime: 60_000,
  });
  const s = data?.summary;
  return (
    <ReportCard icon={Boxes} title="Inventory Value" accent="hsl(145 55% 45%)" to="/Reports" query="inv-value">
      {error ? (
        <CardError error={error} onRetry={refetch} />
      ) : isLoading ? (
        <CardSkeleton />
      ) : (
        <>
          <div className="mb-3">
            <div className="text-2xl font-semibold tabular-nums text-foreground">
              <span className="mr-1 text-muted-foreground/60">R</span>
              {fmtR(s?.total_value)}
            </div>
            <div className="text-xs text-muted-foreground">{s?.total_items ?? 0} items on hand</div>
          </div>
          <div className="space-y-1">
            {(data?.by_commodity || []).slice(0, 4).map((c) => (
              <div key={c.commodity} className="flex items-center justify-between text-xs">
                <span className="truncate text-muted-foreground">{c.commodity || "—"}</span>
                <span className="tabular-nums text-foreground">{fmtCompactR(c.total_value)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </ReportCard>
  );
}

// Compact strip linking to the full Insights feed; highlights the top item.
function InsightsBanner() {
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["insights"],
    queryFn: () => apiGet("/api/insights"),
    staleTime: 60_000,
  });
  const insights = data?.insights || [];
  if (insights.length === 0) return null;
  const actionable = insights.filter((i) => i.severity === "high" || i.severity === "medium").length;
  const top = insights[0];
  return (
    <button
      type="button"
      onClick={() => navigate("/Insights")}
      className="mb-5 flex w-full items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-left transition-colors hover:bg-amber-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--phosphor)]"
    >
      <Lightbulb className="h-5 w-5 shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground">
          {actionable > 0 ? `${actionable} insight${actionable === 1 ? "" : "s"} need attention` : `${insights.length} insight${insights.length === 1 ? "" : "s"}`}
        </div>
        <div className="truncate text-xs text-muted-foreground">Top: {top.title}</div>
      </div>
      <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function BatCard() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["dash-bat-weekly"],
    queryFn: () => apiGet("/api/reports/bat-weekly"),
    staleTime: 60_000,
  });
  const s = data?.summary;
  return (
    <ReportCard icon={BarChart3} title="BAT Weekly" accent="hsl(280 70% 65%)" to="/Reports" query="bat-weekly">
      {error ? (
        <CardError error={error} onRetry={refetch} />
      ) : isLoading ? (
        <CardSkeleton />
      ) : (
        <>
          <div className="mb-3">
            <div className="text-2xl font-semibold tabular-nums text-foreground">{fmtCompactR(s?.total_variance)}</div>
            <div className="text-xs text-muted-foreground">total variance · {s?.weeks_count ?? 0} weeks</div>
          </div>
          <div className="space-y-1 text-xs text-muted-foreground">
            <div className="flex justify-between"><span>Matched</span><span className="text-foreground">{s?.matched_count ?? 0}</span></div>
            <div className="flex justify-between"><span>Mismatched</span><span className="text-foreground">{s?.mismatch_count ?? 0}</span></div>
            <div className="flex justify-between"><span>Exceptions</span><span className="text-foreground">{s?.total_exceptions ?? 0}</span></div>
          </div>
        </>
      )}
    </ReportCard>
  );
}

export default function ReportingDashboard() {
  const { data: kpis } = useQuery({
    queryKey: ["dash-kpis"],
    queryFn: () => apiGet("/api/kpis"),
    staleTime: 60_000,
  });
  const flags = kpis?.records_by_flag || {};

  return (
    <div className="min-h-screen bg-background px-4 py-6 text-foreground md:px-6">
      <PageHeader
        eyebrow="Reports"
        title="Reporting Dashboard"
        subtitle="Headline numbers across the business at a glance. Open any card for the full, filterable report."
      />

      <div className="mb-5">
        <SageHealthPanel />
      </div>

      <InsightsBanner />

      {/* KPI tiles */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryTile label="Customers" value={(kpis?.total_records ?? 0).toLocaleString("en-ZA")} accent="var(--phosphor)" />
        <SummaryTile label="Red flags" value={(flags.red ?? 0).toLocaleString("en-ZA")} accent="hsl(0 72% 50%)" />
        <SummaryTile label="Orange flags" value={(flags.orange ?? 0).toLocaleString("en-ZA")} accent="hsl(33 95% 55%)" />
        <SummaryTile label="Green flags" value={(flags.green ?? 0).toLocaleString("en-ZA")} accent="hsl(145 55% 45%)" />
      </div>

      {/* Report summary cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AgedDebtorsCard />
        <RepExposureCard />
        <InventoryValueCard />
        <BatCard />
      </div>
    </div>
  );
}
