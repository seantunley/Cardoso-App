import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, Users, Package, Sun, Leaf, Snowflake, Flower2 } from "lucide-react";
import { Tooltip as UITooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const COLORS = ["#60a5fa", "#34d399", "#f59e0b", "#f472b6", "#a78bfa", "#22d3ee", "#f87171", "#4ade80"];

async function fetchCustomerTrends(period) {
  const res = await fetch(`/api/hub/trends?period=${period}`, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to load customer trends");
  return data;
}

async function fetchInventoryTrends() {
  const res = await fetch(`/api/hub/trends/inventory`, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to load inventory trends");
  return data;
}

async function fetchSeasonalTopItems() {
  const res = await fetch(`/api/hub/trends/inventory/seasonal`, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to load seasonal trends");
  return data;
}

function pivotByPeriodAndSite(rows, valueKey) {
  const periods = [...new Set(rows.map((row) => row.period))].sort();
  const sites = [...new Set(rows.map((row) => row.site_name))];
  const points = periods.map((period) => {
    const point = { period };
    for (const site of sites) {
      const row = rows.find((item) => item.period === period && item.site_name === site);
      point[site] = row?.[valueKey] ?? 0;
    }
    return point;
  });
  return { sites, points };
}

function ChartCard({ title, subtitle, data, sites, valueSuffix = "", valueDomain, valueFormatter }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
      </div>
      <div className="h-[360px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.35} />
            <XAxis dataKey="period" stroke="#94a3b8" fontSize={12} />
            <YAxis
              stroke="#94a3b8"
              fontSize={12}
              domain={valueDomain}
              tickFormatter={valueFormatter}
            />
            <Tooltip
              contentStyle={{ background: "#020817", border: "1px solid #1e293b", borderRadius: 12 }}
              formatter={(value) => [valueFormatter ? valueFormatter(value) : `${value}${valueSuffix}`, ""]}
            />
            <Legend />
            {sites.map((site, index) => (
              <Line
                key={site}
                type="monotone"
                dataKey={site}
                stroke={COLORS[index % COLORS.length]}
                strokeWidth={2.5}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-4 flex flex-wrap gap-3">
        {sites.map((site, index) => (
          <UITooltip key={site}>
            <TooltipTrigger asChild>
              <div className="inline-flex items-center gap-2 text-xs text-muted-foreground cursor-default">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                {site}
              </div>
            </TooltipTrigger>
            <TooltipContent>{title} trend line for site: {site}</TooltipContent>
          </UITooltip>
        ))}
      </div>
    </div>
  );
}

function EmptyState({ children }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card px-6 py-16 text-center">
      <TrendingUp className="mb-4 h-12 w-12 text-muted-foreground" />
      <h2 className="text-lg font-semibold text-foreground">No trend data yet</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-[420px] animate-pulse rounded-xl border border-border bg-card" />
      <div className="h-[420px] animate-pulse rounded-xl border border-border bg-card" />
    </div>
  );
}

function ErrorBanner({ message }) {
  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-sm text-red-300">
      {message || "Failed to load trends"}
    </div>
  );
}

const formatRand = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  // For axis ticks: compact "R 1.2M" / "R 800K". For tooltips: full
  // commas (the tooltip overrides via valueFormatter when needed).
  if (Math.abs(n) >= 1_000_000) return `R ${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `R ${(n / 1_000).toFixed(0)}K`;
  return `R ${n.toFixed(0)}`;
};
const formatQty = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
};

function CustomerTrends() {
  const [period, setPeriod] = useState("weekly");
  const { data, isLoading, error } = useQuery({
    queryKey: ["hub-trends-customer", period],
    queryFn: () => fetchCustomerTrends(period),
    staleTime: 60_000,
  });
  const rows = data?.data || [];
  const { sites, points: recordVolume } = useMemo(() => pivotByPeriodAndSite(rows, "total_records"), [rows]);
  const { points: flagRate } = useMemo(() => pivotByPeriodAndSite(rows, "flag_rate"), [rows]);

  return (
    <>
      <div className="flex justify-end mb-4">
        <div className="inline-flex rounded-xl border border-border bg-card p-1">
          {[
            { value: "weekly", label: "Weekly" },
            { value: "monthly", label: "Monthly" },
          ].map((option) => (
            <button
              key={option.value}
              onClick={() => setPeriod(option.value)}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                period === option.value
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title={`Bucket the trend by ${option.value} periods`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading && <LoadingSkeleton />}
      {!isLoading && error && <ErrorBanner message={error.message} />}
      {!isLoading && !error && rows.length === 0 && (
        <EmptyState>
          Trends will appear once the hub has enough synced record history to bucket over time.
        </EmptyState>
      )}
      {!isLoading && !error && rows.length > 0 && (
        <div className="space-y-6">
          <ChartCard
            title="Record Volume"
            subtitle={`Showing ${period} totals per site — sourced from hub_records.updated_date`}
            data={recordVolume}
            sites={sites}
          />
          <ChartCard
            title="Flag Rate %"
            subtitle={`Percentage of flagged customers per ${period} bucket`}
            data={flagRate}
            sites={sites}
            valueSuffix="%"
            valueDomain={[0, 100]}
          />
        </div>
      )}
    </>
  );
}

const SEASON_META = {
  Summer: { icon: Sun,       color: "text-amber-400",   ring: "border-amber-500/40",   bg: "bg-amber-500/5"   },
  Autumn: { icon: Leaf,      color: "text-orange-400",  ring: "border-orange-500/40",  bg: "bg-orange-500/5"  },
  Winter: { icon: Snowflake, color: "text-sky-400",     ring: "border-sky-500/40",     bg: "bg-sky-500/5"     },
  Spring: { icon: Flower2,   color: "text-emerald-400", ring: "border-emerald-500/40", bg: "bg-emerald-500/5" },
};

function SeasonalTopItems() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["hub-trends-inventory-seasonal"],
    queryFn: () => fetchSeasonalTopItems(),
    staleTime: 5 * 60_000,
  });

  if (isLoading) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[460px] animate-pulse rounded-xl border border-border bg-card" />
        ))}
      </div>
    );
  }
  if (error) return <ErrorBanner message={error.message} />;
  const seasons = data?.seasons || [];
  const months = data?.months || {};
  const buckets = data?.data || {};
  const hasAny = seasons.some((s) => (buckets[s] || []).length > 0);
  if (!hasAny) {
    return (
      <EmptyState>
        Seasonal trends appear once a site has at least one full month of inventory sales
        synced to the hub.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Top 10 items per season</h2>
          <p className="text-sm text-muted-foreground">
            Aggregated across every year in the hub. Sorted by units sold.
          </p>
        </div>
        <span
          className="text-xs text-muted-foreground"
          title="Seasons as defined by the South African Weather Service / common SA usage. Sales are mapped from period (YYYY-MM) → month → season."
        >
          South African seasons
        </span>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {seasons.map((season) => {
          const meta = SEASON_META[season] || {};
          const Icon = meta.icon || Sun;
          const items = buckets[season] || [];
          return (
            <div key={season} className={`rounded-xl border ${meta.ring || "border-border"} ${meta.bg || "bg-card"} overflow-hidden`}>
              <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card/60">
                <div className="flex items-center gap-2">
                  <Icon className={`w-5 h-5 ${meta.color || "text-foreground"}`} />
                  <h3 className="text-base font-semibold text-foreground">{season}</h3>
                </div>
                <span
                  className="text-[10px] uppercase tracking-wider text-muted-foreground"
                  title={`${season} = ${(months[season] || []).join(', ')}`}
                >
                  {(months[season] || []).join(' · ')}
                </span>
              </div>
              {items.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No sales recorded in {season} months yet.
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                      <th className="px-3 py-2 w-8 cursor-help" title="Rank within the season (1 = best-selling)">#</th>
                      <th className="px-3 py-2 cursor-help" title="Sage item code">Item</th>
                      <th className="px-3 py-2 cursor-help" title="Item description from hub_inventory (latest synced row)">Description</th>
                      <th className="px-3 py-2 text-right cursor-help" title="Sum of units sold across every recorded year of this season">Qty</th>
                      <th className="px-3 py-2 text-right cursor-help" title="Sum of revenue in ZAR across every recorded year of this season">Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((row) => (
                      <tr key={row.item_number} className="border-b border-border last:border-0 hover:bg-muted/30">
                        <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{row.rank}</td>
                        <td className="px-3 py-1.5 font-mono text-xs text-foreground">{row.item_number}</td>
                        <td className="px-3 py-1.5 text-foreground/90 truncate max-w-[260px]" title={row.item_description || ""}>
                          {row.item_description || "—"}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{formatQty(row.qty_sold)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-emerald-300">{formatRand(row.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function InventoryTrends() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["hub-trends-inventory"],
    queryFn: () => fetchInventoryTrends(),
    staleTime: 60_000,
  });
  const rows = data?.data || [];
  const { sites, points: qtyPoints } = useMemo(() => pivotByPeriodAndSite(rows, "total_qty_sold"), [rows]);
  const { points: revPoints } = useMemo(() => pivotByPeriodAndSite(rows, "total_revenue"), [rows]);
  const { points: orderPoints } = useMemo(() => pivotByPeriodAndSite(rows, "total_orders"), [rows]);

  return (
    <>
      <div className="flex justify-end mb-4">
        <div
          className="inline-flex rounded-xl border border-border bg-card px-3 py-2 text-xs text-muted-foreground"
          title="Inventory sales velocity is bucketed monthly by the site ETL — weekly granularity isn't available"
        >
          Monthly (last 12 months)
        </div>
      </div>

      {isLoading && <LoadingSkeleton />}
      {!isLoading && error && <ErrorBanner message={error.message} />}
      {!isLoading && !error && rows.length === 0 && (
        <EmptyState>
          Inventory trends appear once a site syncs movement data
          (Settings → Inventory Movement → Sync) and the hub ETL pulls it.
        </EmptyState>
      )}
      {!isLoading && !error && rows.length > 0 && (
        <div className="space-y-6">
          <ChartCard
            title="Sales Velocity"
            subtitle="Units sold per month per site — SUM(qty_sold) on hub_inventory_sales"
            data={qtyPoints}
            sites={sites}
            valueFormatter={formatQty}
          />
          <ChartCard
            title="Sales Revenue"
            subtitle="Revenue per month per site — SUM(revenue) on hub_inventory_sales"
            data={revPoints}
            sites={sites}
            valueFormatter={formatRand}
          />
          <ChartCard
            title="Order Count"
            subtitle="Number of orders per month per site — SUM(order_count) on hub_inventory_sales"
            data={orderPoints}
            sites={sites}
            valueFormatter={formatQty}
          />

          <SeasonalTopItems />
        </div>
      )}
    </>
  );
}

export default function HubTrends() {
  const [tab, setTab] = useState("customers");

  return (
    <div className="min-h-screen bg-background px-4 py-6 text-foreground sm:px-6">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div className="border-b border-border pb-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">§ Trends</div>
          <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
            The shape of <em className="text-phosphor">time</em>.
          </h1>
          <p className="text-sm text-muted-foreground mt-3">
            Customer record volume + flag rate, and inventory sales velocity + revenue — per site, bucketed over time.
          </p>
        </div>

        <Tabs value={tab} onValueChange={setTab} className="space-y-4">
          <TabsList className="grid w-full max-w-md grid-cols-2">
            <TabsTrigger value="customers" title="Customer record-volume and flag-rate trends per site">
              <Users className="w-4 h-4 mr-2" />
              Customers
            </TabsTrigger>
            <TabsTrigger value="inventory" title="Sales velocity and revenue trends per site">
              <Package className="w-4 h-4 mr-2" />
              Inventory
            </TabsTrigger>
          </TabsList>

          <TabsContent value="customers" className="mt-4 space-y-4">
            <CustomerTrends />
          </TabsContent>

          <TabsContent value="inventory" className="mt-4 space-y-4">
            <InventoryTrends />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
