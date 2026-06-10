// ReportingDashboard — a single at-a-glance overview across the reporting
// surface. Unlike the Reports page (which shows one full report at a time),
// this consolidates the headline numbers from several reports into one screen,
// fronted by the Sage health panel, with "view full report" links that deep-
// link into the matching report. Reuses the existing /api/reports/* endpoints
// and the shared report formatters/tiles so styling stays consistent.
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Wallet, Receipt, Users, Boxes, BarChart3, ArrowRight, RefreshCw, Lightbulb, TrendingUp, PackageX, UserRound } from "lucide-react";
import SageHealthPanel from "@/components/health/SageHealthPanel";
import { SummaryTile, fmtR, fmtCompactR } from "@/components/reports/lib";
import { apiGet } from "@/components/collections/utils";
import BranchFilter from "@/components/reports/BranchFilter";
import { Skeleton } from "@/components/ui/skeleton";
import PageHeader from "@/components/PageHeader";

// AR (debtors) age weekly by document date; keys match the aging engine's
// AR_SCHEME (current/1-7/8-14/15-21/over-21).
const BUCKET_META = [
  { key: "current", label: "Current", color: "hsl(145 55% 45%)" },
  { key: "1-7", label: "1–7d", color: "hsl(80 60% 45%)" },
  { key: "8-14", label: "8–14d", color: "hsl(50 90% 55%)" },
  { key: "15-21", label: "15–21d", color: "hsl(33 95% 55%)" },
  { key: "over-21", label: "Over 21d", color: "hsl(0 72% 50%)" },
];

// AP (creditors) age monthly by due date (Sage Aged Payables periods).
const AP_BUCKET_META = [
  { key: "current", label: "Current", color: "hsl(145 55% 45%)" },
  { key: "1-30", label: "1–30d", color: "hsl(80 60% 45%)" },
  { key: "31-60", label: "31–60d", color: "hsl(50 90% 55%)" },
  { key: "61-90", label: "61–90d", color: "hsl(33 95% 55%)" },
  { key: "over-90", label: "Over 90d", color: "hsl(0 72% 50%)" },
];

// A card that wraps a report summary with a header + deep-link.
// Append the hub branch filter to a card's endpoint URL when a specific branch
// is selected (no-op for "All branches" / site mode).
const withSite = (url, site) =>
  site && site !== "all" ? `${url}${url.includes("?") ? "&" : "?"}site=${encodeURIComponent(site)}` : url;

function ReportCard({ icon: Icon, title, accent, to, children, query, hint }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Carry the dashboard's selected branch into the full report, so the
  // branch-filtered view continues instead of resetting to all branches
  // (the reports read ?site= the same way the dashboard does).
  const openReport = () => {
    let url = query ? `${to}?report=${query}` : to;
    const site = searchParams.get("site");
    if (site && site !== "all") url += `${url.includes("?") ? "&" : "?"}site=${encodeURIComponent(site)}`;
    navigate(url);
  };
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2" title={hint}>
          <Icon className="h-4 w-4" style={{ color: accent }} />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground" style={hint ? { cursor: 'help' } : undefined}>{title}</h2>
        </div>
        {to && (
          <button
            type="button"
            onClick={openReport}
            title={`Open the full ${title} report`}
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

function AgedDebtorsCard({ site }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["dash-debtor-balance-summary", site],
    queryFn: () => apiGet(withSite("/api/reports/debtor-balance-summary", site)),
    staleTime: 60_000,
  });
  // Positive open balances only, from the same source as the Customer Balances
  // page — so this headline matches that page (the "who owes us" figure) rather
  // than the net open-item ledger.
  const s = data;
  return (
    <ReportCard icon={Wallet} title="Aged Debtors" accent="hsl(33 95% 55%)" to="/CustomerBalances">
      {error ? (
        <CardError error={error} onRetry={refetch} />
      ) : isLoading ? (
        <CardSkeleton />
      ) : (
        <>
          <div className="mb-3">
            <div className="text-2xl font-semibold tabular-nums text-foreground">
              <span className="mr-1 text-muted-subtle">R</span>
              {fmtR(s?.total_outstanding)}
            </div>
            <div className="text-xs text-muted-foreground">{s?.total_customers ?? 0} customers outstanding</div>
          </div>
          {/* Hub mode's debtor-balance-summary has no per-bucket breakdown
              (buckets: null). Render the aging list only when bucket data is
              present, so the hub card shows the headline total alone rather
              than a misleading column of R 0.00 rows. */}
          {s?.buckets && (
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
          )}
        </>
      )}
    </ReportCard>
  );
}

function AgedCreditorsCard({ site }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["dash-aged-creditors-paid", site],
    queryFn: () => apiGet(withSite("/api/reports/aged-creditors?paid_only=true", site)),
    staleTime: 60_000,
  });
  const s = data?.summary;
  return (
    <ReportCard icon={Receipt} title="Aged Creditors" accent="hsl(280 70% 65%)" to="/Reports" query="aged-creditors">
      {error ? (
        <CardError error={error} onRetry={refetch} />
      ) : isLoading ? (
        <CardSkeleton />
      ) : (
        <>
          <div className="mb-3">
            <div className="text-2xl font-semibold tabular-nums text-foreground">
              <span className="mr-1 text-muted-subtle">R</span>
              {fmtR(s?.total_outstanding)}
            </div>
            <div className="text-xs text-muted-foreground">{s?.total_vendors ?? 0} vendors outstanding</div>
          </div>
          <div className="space-y-1">
            {AP_BUCKET_META.map((b) => (
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

function RepExposureCard({ site }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["dash-rep-exposure", site],
    queryFn: () => apiGet(withSite("/api/reports/rep-exposure", site)),
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
              <span className="mr-1 text-muted-subtle">R</span>
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

function InventoryValueCard({ site }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["dash-inventory-value", site],
    queryFn: () => apiGet(withSite("/api/reports/inventory-value", site)),
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
              <span className="mr-1 text-muted-subtle">R</span>
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
      title="Open the Insights feed — automatically detected changes and risks across sales, customers, inventory and receivables"
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

// Compact ranked bar list — a smaller version of the Trends top-10 graphs.
function MiniRankList({ rows, accent, isLoading, error, refetch, empty, fmtValue }) {
  if (error) return <CardError error={error} onRetry={refetch} />;
  if (isLoading) return <CardSkeleton />;
  if (!rows?.length) return <p className="py-2 text-xs text-muted-foreground">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value) || 0));
  return (
    <ol className="space-y-1.5">
      {rows.map((r, i) => (
        <li key={r.key ?? i} className="flex items-center gap-2">
          <span className="w-3.5 shrink-0 text-right font-mono text-[10px] tabular-nums text-muted-subtle">{i + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate text-foreground/90" title={r.title || r.label}>{r.label}</span>
              <span className="shrink-0 tabular-nums text-foreground">{fmtValue(r.value)}</span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted/40">
              <div className="h-full rounded-full" style={{ width: `${Math.max(3, (Math.abs(r.value) / max) * 100)}%`, background: accent }} />
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

const SITE_ONLY_NOTE = "Inventory & sales figures are available on branch (site) installs.";

function TopItemsMtdCard({ site }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["dash-top-items-mtd", site],
    queryFn: () => apiGet(withSite("/api/reports/dashboard/top-items-mtd", site)),
    staleTime: 60_000,
  });
  const accent = "hsl(145 55% 45%)";
  const rows = (data?.rows || []).map((r) => ({
    key: r.item_number,
    label: r.item_description ? `${r.item_number} · ${r.item_description}` : r.item_number,
    title: `${r.item_number}${r.item_description ? " · " + r.item_description : ""}`,
    value: r.qty,
  }));
  return (
    <ReportCard icon={TrendingUp} title="Top Items Sold (MTD)" accent={accent} to="/Trends"
      hint="The 10 best-selling items this month by units sold (inter-branch transfers excluded). Each row shows item code · description — hover a row for the full text. Bar length is relative to the top item.">

      {data?.site_only
        ? <p className="py-2 text-xs text-muted-foreground">{SITE_ONLY_NOTE}</p>
        : <MiniRankList rows={rows} accent={accent} isLoading={isLoading} error={error} refetch={refetch}
            empty="No sales recorded yet this month." fmtValue={(v) => `${Number(v || 0).toLocaleString("en-ZA")} u`} />}
    </ReportCard>
  );
}

function DeadStockItemsCard({ site }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["dash-dead-stock-items", site],
    queryFn: () => apiGet(withSite("/api/reports/dashboard/dead-stock-items", site)),
    staleTime: 60_000,
  });
  const accent = "hsl(0 72% 50%)";
  const rows = (data?.rows || []).map((r, i) => ({
    key: `${r.site_name || ""}-${r.item_number}-${i}`,
    label: `${r.site_name && site === "all" ? r.site_name + " · " : ""}${r.item_description || r.item_number}`,
    title: `${r.site_name ? r.site_name + " · " : ""}${r.item_number}${r.last_period ? " · last sold " + r.last_period : " · never sold"}`,
    value: r.inv_value,
  }));
  return (
    <ReportCard icon={PackageX} title="Top Dead Stock" accent={accent} to="/Trends"
      hint="The 10 highest-value items still in stock with no sale in the last 3+ months, ranked by held stock value (R). Inter-branch transfers don't count as a sale. Bar length is relative to the top item.">

      {data?.site_only
        ? <p className="py-2 text-xs text-muted-foreground">{SITE_ONLY_NOTE}</p>
        : <MiniRankList rows={rows} accent={accent} isLoading={isLoading} error={error} refetch={refetch}
            empty="No dead stock — every held SKU has sold recently." fmtValue={(v) => fmtCompactR(v)} />}
    </ReportCard>
  );
}

function TopCustomersCard({ site }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["dash-top-customers", site],
    queryFn: () => apiGet(withSite("/api/reports/dashboard/top-customers?months=12", site)),
    staleTime: 60_000,
  });
  const accent = "hsl(200 80% 55%)";
  const rows = (data?.rows || []).map((r) => ({
    key: r.customer_code,
    label: r.customer_name || r.customer_code,
    title: `${r.customer_code}${r.customer_name ? " · " + r.customer_name : ""}`,
    value: r.revenue,
  }));
  return (
    <ReportCard icon={UserRound} title="Top Customers · 12 mo" accent={accent} to="/Trends"
      hint="Your 10 biggest customers by sales value (R) over the last 12 months. Inter-branch transfers are excluded. Open the full, timeline-filterable list in Trends → Customers → By sales.">

      {data?.site_only
        ? <p className="py-2 text-xs text-muted-foreground">{SITE_ONLY_NOTE}</p>
        : <MiniRankList rows={rows} accent={accent} isLoading={isLoading} error={error} refetch={refetch}
            empty="No customer sales recorded yet." fmtValue={(v) => fmtCompactR(v)} />}
    </ReportCard>
  );
}

export default function ReportingDashboard() {
  const [searchParams] = useSearchParams();
  const site = searchParams.get("site") || "all";
  const { data: kpis } = useQuery({
    queryKey: ["dash-kpis", site],
    queryFn: () => apiGet(withSite("/api/kpis", site)),
    staleTime: 60_000,
  });
  const flags = kpis?.records_by_flag || {};

  return (
    <div className="min-h-screen bg-background px-4 py-6 text-foreground md:px-6">
      <PageHeader
        eyebrow="Reports"
        title={<>Reporting <em className="text-phosphor">Dashboard</em>.</>}
        subtitle="Headline numbers across the business at a glance. Open any card for the full, filterable report."
      />

      {kpis?.hub_mode && (
        <div className="mb-5 max-w-xs">
          <BranchFilter hubMode={kpis?.hub_mode} sites={kpis?.filters?.sites} />
        </div>
      )}

      <div className="mb-5">
        <SageHealthPanel />
      </div>

      <InsightsBanner />

      {/* KPI tiles */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <SummaryTile label="Customers" value={(kpis?.total_records ?? 0).toLocaleString("en-ZA")} accent="var(--phosphor)" title="Total customer records synced from Sage." />
        <SummaryTile label="Red flags" value={(flags.red ?? 0).toLocaleString("en-ZA")} accent="hsl(0 72% 50%)" title="Customers auto-flagged red (highest credit risk)." />
        <SummaryTile label="Orange flags" value={(flags.orange ?? 0).toLocaleString("en-ZA")} accent="hsl(33 95% 55%)" title="Customers auto-flagged orange (watch)." />
        <SummaryTile label="Green flags" value={(flags.green ?? 0).toLocaleString("en-ZA")} accent="hsl(145 55% 45%)" title="Customers flagged green (in good standing)." />
      </div>

      {/* Report summary cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AgedDebtorsCard site={site} />
        <AgedCreditorsCard site={site} />
        <RepExposureCard site={site} />
        <InventoryValueCard site={site} />
        <BatCard />
      </div>

      {/* Sales & inventory highlights — compact versions of the Trends graphs */}
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <TopItemsMtdCard site={site} />
        <DeadStockItemsCard site={site} />
        <TopCustomersCard site={site} />
      </div>
    </div>
  );
}
