// Site-mode Trends page — same shape as HubTrends but talks to the
// /api/reports/trends/* endpoints (datarecord + inventory_sales_cache on
// the local install). No per-site filter because a site only has its
// own data.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp, Users, Package, Sun, Leaf, Snowflake, Flower2, ArrowUp, ArrowDown } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

const COLORS = ["#60a5fa", "#34d399", "#f59e0b", "#f472b6", "#a78bfa", "#22d3ee", "#f87171", "#4ade80"];
const COMMODITY_LABELS = { '1': 'Sweets', '2': 'Cigarettes', '3': 'Tobacco', '4': 'Mixed' };
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function fetchCustomerTrends(period) {
  const res = await fetch(`/api/reports/trends/customer?period=${period}`, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to load customer trends");
  return data;
}
async function fetchInventoryTrends() {
  const res = await fetch(`/api/reports/trends/inventory`, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to load inventory trends");
  return data;
}
async function fetchSeasonal() {
  const res = await fetch(`/api/reports/trends/inventory/seasonal`, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to load seasonal trends");
  return data;
}
async function fetchRevenueByCommodity() {
  const res = await fetch(`/api/reports/trends/inventory/revenue-by-commodity`, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to load revenue by commodity");
  return data;
}
async function fetchMarginByCommodity() {
  const res = await fetch(`/api/reports/trends/inventory/margin-by-commodity`, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to load margin by commodity");
  return data;
}
async function fetchDeadStock() {
  const res = await fetch(`/api/reports/trends/inventory/dead-stock`, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to load dead stock trend");
  return data;
}
async function fetchTopMovers() {
  const res = await fetch(`/api/reports/trends/inventory/top-movers`, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to load top movers");
  return data;
}

// Pivot [{ period, commodity, <valueKey> }] into one row per period with each
// commodity as its own column — the shape recharts wants for a multi-line
// chart. Missing combos become null so the line just breaks instead of
// dropping to zero.
function pivotByPeriodAndCommodity(rows, commodityList, valueKey) {
  const periods = [...new Set(rows.map((r) => r.period))].sort();
  const points = periods.map((period) => {
    const point = { period };
    for (const c of commodityList) {
      const row = rows.find((r) => r.period === period && r.commodity === c);
      point[c] = row?.[valueKey] ?? null;
    }
    return point;
  });
  return points;
}

function pivotByPeriod(rows, valueKey, siteName) {
  const periods = [...new Set(rows.map((r) => r.period))].sort();
  const points = periods.map((period) => {
    const point = { period };
    const row = rows.find((r) => r.period === period);
    point[siteName] = row?.[valueKey] ?? 0;
    return point;
  });
  return { points, siteName };
}

function pivotByMonthAndYear(rows, valueKey, visibleYears) {
  const yearSet = new Set(visibleYears);
  const points = MONTH_LABELS.map((label, idx) => {
    const point = { month: label };
    for (const y of visibleYears) {
      const row = rows.find((r) => r.year === y && r.month === idx + 1);
      point[String(y)] = row?.[valueKey] ?? null;
    }
    return point;
  });
  const seriesKeys = visibleYears.map(String).filter((k) => yearSet.has(Number(k)));
  return { seriesKeys, points };
}

const formatRand = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
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

function PeriodChart({ title, subtitle, data, siteName, valueSuffix = "", valueDomain, valueFormatter }) {
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
            <YAxis stroke="#94a3b8" fontSize={12} domain={valueDomain} tickFormatter={valueFormatter} />
            <Tooltip
              contentStyle={{ background: "#020817", border: "1px solid #1e293b", borderRadius: 12 }}
              formatter={(value) => [valueFormatter ? valueFormatter(value) : `${value}${valueSuffix}`, ""]}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey={siteName}
              stroke={COLORS[0]}
              strokeWidth={2.5}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function YearChart({ title, subtitle, data, yearKeys, yearList, valueFormatter }) {
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
            <XAxis dataKey="month" stroke="#94a3b8" fontSize={12} />
            <YAxis stroke="#94a3b8" fontSize={12} tickFormatter={valueFormatter} />
            <Tooltip
              contentStyle={{ background: "#020817", border: "1px solid #1e293b", borderRadius: 12 }}
              formatter={(value) => [valueFormatter ? valueFormatter(value) : value, ""]}
            />
            <Legend />
            {yearKeys.map((yk) => {
              const idx = (yearList || []).findIndex((y) => String(y) === yk);
              const colour = COLORS[(idx >= 0 ? idx : 0) % COLORS.length];
              return (
                <Line
                  key={yk}
                  type="monotone"
                  dataKey={yk}
                  name={yk}
                  stroke={colour}
                  strokeWidth={2.5}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                  connectNulls={false}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
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
function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      <div className="h-[420px] animate-pulse rounded-xl border border-border bg-card" />
      <div className="h-[420px] animate-pulse rounded-xl border border-border bg-card" />
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

function CustomerTrends() {
  const [period, setPeriod] = useState("weekly");
  const { data, isLoading, error } = useQuery({
    queryKey: ["site-trends-customer", period],
    queryFn: () => fetchCustomerTrends(period),
    staleTime: 60_000,
  });
  const rows = data?.data || [];
  const siteName = data?.site_name || "This site";
  const { points: recordVolume } = useMemo(() => pivotByPeriod(rows, "total_records", siteName), [rows, siteName]);
  const { points: flagRate }     = useMemo(() => pivotByPeriod(rows, "flag_rate",     siteName), [rows, siteName]);

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
          Trends will appear once enough record history has been synced from Sage.
        </EmptyState>
      )}
      {!isLoading && !error && rows.length > 0 && (
        <div className="space-y-6">
          <PeriodChart
            title="Record Volume"
            subtitle={`${period === "weekly" ? "Weekly" : "Monthly"} customer record count`}
            data={recordVolume}
            siteName={siteName}
          />
          <PeriodChart
            title="Flag Rate %"
            subtitle={`Percentage of flagged customers per ${period} bucket`}
            data={flagRate}
            siteName={siteName}
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
    queryKey: ["site-trends-seasonal"],
    queryFn: fetchSeasonal,
    staleTime: 5 * 60_000,
  });
  if (isLoading) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-[460px] animate-pulse rounded-xl border border-border bg-card" />)}
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
        Seasonal trends appear once Inventory Movement → Sync has built at least one month of cache.
      </EmptyState>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Top 10 items per season</h2>
          <p className="text-sm text-muted-foreground">
            Aggregated across every year in inventory_sales_cache. Sorted by units sold.
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
                      <th className="px-3 py-2 cursor-help" title="Item description from inventoryrecord">Description</th>
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

function RevenueByCommodityChart() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["trends-inventory-revenue-by-commodity"],
    queryFn: fetchRevenueByCommodity,
    staleTime: 60_000,
  });
  const commodityList = data?.commodity_list || [];
  const rows = data?.data || [];
  const points = useMemo(() => pivotByPeriodAndCommodity(rows, commodityList, "revenue"), [rows, commodityList]);

  if (isLoading) {
    return <div className="h-[420px] animate-pulse rounded-xl border border-border bg-card" />;
  }
  if (error) return <ErrorBanner message={error.message} />;
  if (rows.length === 0) {
    return (
      <EmptyState>
        Revenue by commodity appears once Inventory Movement → Sync has built at least one month of cache.
      </EmptyState>
    );
  }
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-foreground">Revenue by commodity</h2>
        <p className="text-sm text-muted-foreground">Revenue by commodity, per month</p>
      </div>
      <div className="h-[360px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.35} />
            <XAxis dataKey="period" stroke="#94a3b8" fontSize={12} />
            <YAxis stroke="#94a3b8" fontSize={12} tickFormatter={formatRand} />
            <Tooltip
              contentStyle={{ background: "#020817", border: "1px solid #1e293b", borderRadius: 12 }}
              formatter={(value) => [formatRand(value), ""]}
            />
            <Legend />
            {commodityList.map((c, idx) => (
              <Line
                key={c}
                type="monotone"
                dataKey={c}
                name={COMMODITY_LABELS[c] || c}
                stroke={COLORS[idx % COLORS.length]}
                strokeWidth={2.5}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function MarginByCommodityChart() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["trends-inventory-margin-by-commodity"],
    queryFn: fetchMarginByCommodity,
    staleTime: 60_000,
  });
  const commodityList = data?.commodity_list || [];
  const rows = data?.data || [];
  const points = useMemo(() => pivotByPeriodAndCommodity(rows, commodityList, "margin_pct"), [rows, commodityList]);

  if (isLoading) {
    return <div className="h-[420px] animate-pulse rounded-xl border border-border bg-card" />;
  }
  if (error) return <ErrorBanner message={error.message} />;
  if (rows.length === 0) {
    return (
      <EmptyState>
        Margin by commodity appears once Inventory Movement → Sync has built at least one month of cache.
      </EmptyState>
    );
  }
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-foreground">Margin by commodity</h2>
        <p className="text-sm text-muted-foreground">Average margin % by commodity, per month</p>
        <p className="text-xs text-muted-foreground/70 mt-1">
          Uses current cost against historical revenue — directional, not exact.
        </p>
      </div>
      <div className="h-[360px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.35} />
            <XAxis dataKey="period" stroke="#94a3b8" fontSize={12} />
            <YAxis stroke="#94a3b8" fontSize={12} tickFormatter={(v) => v.toFixed(1) + '%'} />
            <Tooltip
              contentStyle={{ background: "#020817", border: "1px solid #1e293b", borderRadius: 12 }}
              formatter={(value) => [Number(value).toFixed(1) + '%', ""]}
            />
            <Legend />
            {commodityList.map((c, idx) => (
              <Line
                key={c}
                type="monotone"
                dataKey={c}
                name={COMMODITY_LABELS[c] || c}
                stroke={COLORS[idx % COLORS.length]}
                strokeWidth={2.5}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function DeadStockChart() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["trends-inventory-dead-stock"],
    queryFn: fetchDeadStock,
    staleTime: 60_000,
  });
  const rows = data?.data || [];

  if (isLoading) {
    return <div className="h-[420px] animate-pulse rounded-xl border border-border bg-card" />;
  }
  if (error) return <ErrorBanner message={error.message} />;
  if (rows.length === 0) {
    return (
      <EmptyState>
        Dead-stock trend appears once Inventory Movement → Sync has built at least three months of cache.
      </EmptyState>
    );
  }
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-foreground">Dead stock over time</h2>
        <p className="text-sm text-muted-foreground">
          SKUs you still hold (stock value &gt; 0) with no sales in the trailing 3 months
        </p>
      </div>
      <div className="h-[360px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" opacity={0.35} />
            <XAxis dataKey="month" stroke="#94a3b8" fontSize={12} />
            <YAxis yAxisId="left" stroke={COLORS[0]} fontSize={12} tickFormatter={formatQty} />
            <YAxis yAxisId="right" orientation="right" stroke={COLORS[2]} fontSize={12} tickFormatter={formatRand} />
            <Tooltip
              contentStyle={{ background: "#020817", border: "1px solid #1e293b", borderRadius: 12 }}
              formatter={(value, name) => {
                if (name === "Dead value") return [formatRand(value), name];
                return [formatQty(value), name];
              }}
            />
            <Legend />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="dead_count"
              name="Dead count"
              stroke={COLORS[0]}
              strokeWidth={2.5}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="dead_value"
              name="Dead value"
              stroke={COLORS[2]}
              strokeWidth={2.5}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function DeltaCell({ pct }) {
  if (pct === null || pct === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  const n = Number(pct);
  if (!Number.isFinite(n)) {
    return <span className="text-muted-foreground">—</span>;
  }
  const up = n >= 0;
  const Icon = up ? ArrowUp : ArrowDown;
  const cls = up
    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
    : "bg-red-500/15 text-red-300 border-red-500/30";
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs tabular-nums ${cls}`}>
      <Icon className="h-3 w-3" />
      {Math.abs(n).toFixed(1)}%
    </span>
  );
}

function TopMoversTable() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["trends-inventory-top-movers"],
    queryFn: fetchTopMovers,
    staleTime: 5 * 60_000,
  });
  const rows = data?.data || [];

  if (isLoading) {
    return <div className="h-[460px] animate-pulse rounded-xl border border-border bg-card" />;
  }
  if (error) return <ErrorBanner message={error.message} />;
  if (rows.length === 0) {
    return (
      <EmptyState>
        Top-movers appear once Inventory Movement → Sync has built at least 12 months of cache.
      </EmptyState>
    );
  }
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-baseline justify-between px-4 py-3 border-b border-border">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Top 10 movers</h2>
          <p className="text-sm text-muted-foreground">
            Top 10 SKUs by lifetime revenue; trailing 12 months vs the 12 months before
          </p>
        </div>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
            <th className="px-3 py-2 w-8" title="Rank by lifetime revenue">#</th>
            <th className="px-3 py-2" title="Sage item code">Item</th>
            <th className="px-3 py-2" title="Item description">Description</th>
            <th className="px-3 py-2" title="Commodity group">Commodity</th>
            <th className="px-3 py-2 text-right" title="Units sold in the trailing 12 months">12-mo qty</th>
            <th className="px-3 py-2 text-right" title="Change vs the previous 12 months">Δ qty %</th>
            <th className="px-3 py-2 text-right" title="Revenue in the trailing 12 months">12-mo revenue</th>
            <th className="px-3 py-2 text-right" title="Change vs the previous 12 months">Δ revenue %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.item_number} className="border-b border-border last:border-0 hover:bg-muted/30">
              <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">{row.rank}</td>
              <td className="px-3 py-1.5 font-mono text-xs text-foreground">{row.item_number}</td>
              <td className="px-3 py-1.5 text-foreground/90 truncate max-w-[260px]" title={row.item_description || ""}>
                {row.item_description || "—"}
              </td>
              <td className="px-3 py-1.5 text-foreground/80">{COMMODITY_LABELS[row.commodity] || row.commodity || "—"}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{formatQty(row.this_year_qty)}</td>
              <td className="px-3 py-1.5 text-right"><DeltaCell pct={row.qty_delta_pct} /></td>
              <td className="px-3 py-1.5 text-right tabular-nums text-emerald-300">{formatRand(row.this_year_revenue)}</td>
              <td className="px-3 py-1.5 text-right"><DeltaCell pct={row.revenue_delta_pct} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InventoryTrends() {
  const [innerTab, setInnerTab] = useState("sales");
  const { data, isLoading, error } = useQuery({
    queryKey: ["site-trends-inventory"],
    queryFn: fetchInventoryTrends,
    staleTime: 60_000,
  });
  const rows = data?.data || [];
  const yearList = useMemo(
    () => (data?.year_list || []).slice().sort((a, b) => b - a),
    [data?.year_list],
  );
  const [hiddenYears, setHiddenYears] = useState(/** @type {Set<number>} */ (new Set()));
  const [defaultApplied, setDefaultApplied] = useState(false);
  useEffect(() => {
    if (defaultApplied || yearList.length === 0) return;
    if (yearList.length > 3) setHiddenYears(new Set(yearList.slice(3)));
    setDefaultApplied(true);
  }, [yearList, defaultApplied]);
  const visibleYears = useMemo(
    () => yearList.filter((y) => !hiddenYears.has(y)).slice().sort((a, b) => a - b),
    [yearList, hiddenYears],
  );
  const { seriesKeys: qtyKeys, points: qtyPoints }   = useMemo(() => pivotByMonthAndYear(rows, "total_qty_sold", visibleYears), [rows, visibleYears]);
  const { points: revPoints }   = useMemo(() => pivotByMonthAndYear(rows, "total_revenue", visibleYears),  [rows, visibleYears]);
  const { points: orderPoints } = useMemo(() => pivotByMonthAndYear(rows, "total_orders",  visibleYears),  [rows, visibleYears]);
  const toggleYear = (y) => {
    setHiddenYears((prev) => {
      const next = new Set(prev);
      if (next.has(y)) next.delete(y); else next.add(y);
      return next;
    });
  };
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div
          className="text-xs text-muted-foreground"
          title="Each line is a calendar year on the same Jan-Dec axis — toggle the chips to compare years"
        >
          Year-over-year comparison
        </div>
        <div className="inline-flex flex-wrap gap-1.5 rounded-xl border border-border bg-card p-1">
          {yearList.map((y, idx) => {
            const isHidden = hiddenYears.has(y);
            const color = COLORS[idx % COLORS.length];
            return (
              <button
                key={y}
                onClick={() => toggleYear(y)}
                title={isHidden ? `Show ${y}` : `Hide ${y}`}
                className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  isHidden ? "text-muted-foreground/60 hover:text-foreground" : "bg-muted/40 text-foreground"
                }`}
              >
                <span className="h-2.5 w-2.5 rounded-full transition-opacity" style={{ backgroundColor: color, opacity: isHidden ? 0.3 : 1 }} />
                {y}
              </button>
            );
          })}
        </div>
      </div>
      {isLoading && <LoadingSkeleton />}
      {!isLoading && error && <ErrorBanner message={error.message} />}
      {!isLoading && !error && rows.length === 0 && (
        <EmptyState>
          Inventory trends appear once Inventory Movement → Sync has built at least one month of cache.
        </EmptyState>
      )}
      {!isLoading && !error && rows.length > 0 && (
        <Tabs value={innerTab} onValueChange={setInnerTab} className="space-y-4">
          <TabsList className="inline-flex h-10 rounded-2xl border border-border bg-muted p-1 gap-1">
            <TabsTrigger value="sales" title="Year-over-year sales velocity, revenue, and order count" className="rounded-xl px-4 py-1.5 text-sm">
              Sales reports
            </TabsTrigger>
            <TabsTrigger value="mix" title="Revenue and margin by commodity over time" className="rounded-xl px-4 py-1.5 text-sm">
              Mix
            </TabsTrigger>
            <TabsTrigger value="movement" title="Dead stock trend and top movers vs prior year" className="rounded-xl px-4 py-1.5 text-sm">
              Movement
            </TabsTrigger>
            <TabsTrigger value="seasonal" title="Top 10 items per South African season" className="rounded-xl px-4 py-1.5 text-sm">
              Seasonal
            </TabsTrigger>
          </TabsList>

          <TabsContent value="sales" className="space-y-6">
            <YearChart
              title="Sales Velocity"
              subtitle="Units sold per month"
              data={qtyPoints}
              yearKeys={qtyKeys}
              yearList={yearList}
              valueFormatter={formatQty}
            />
            <YearChart
              title="Sales Revenue"
              subtitle="Revenue per month"
              data={revPoints}
              yearKeys={qtyKeys}
              yearList={yearList}
              valueFormatter={formatRand}
            />
            <YearChart
              title="Order Count"
              subtitle="Orders per month"
              data={orderPoints}
              yearKeys={qtyKeys}
              yearList={yearList}
              valueFormatter={formatQty}
            />
          </TabsContent>

          <TabsContent value="mix" className="space-y-6">
            <RevenueByCommodityChart />
            <MarginByCommodityChart />
          </TabsContent>

          <TabsContent value="movement" className="space-y-6">
            <DeadStockChart />
            <TopMoversTable />
          </TabsContent>

          <TabsContent value="seasonal" className="space-y-6">
            <SeasonalTopItems />
          </TabsContent>
        </Tabs>
      )}
    </>
  );
}

export default function Trends() {
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
            Customer record volume + flag rate, and inventory sales velocity + revenue — for this site.
          </p>
        </div>
        <Tabs value={tab} onValueChange={setTab} className="space-y-4">
          <TabsList className="inline-flex h-11 rounded-2xl border border-border bg-muted p-1 gap-1">
            <TabsTrigger
              value="customers"
              title="Customer record-volume and flag-rate trends"
              className="rounded-xl px-5 py-2 text-sm"
            >
              <Users className="w-4 h-4 mr-2" />
              Customers
            </TabsTrigger>
            <TabsTrigger
              value="inventory"
              title="Sales velocity, revenue, orders, and seasonal top-10s"
              className="rounded-xl px-5 py-2 text-sm"
            >
              <Package className="w-4 h-4 mr-2" />
              Inventory
            </TabsTrigger>
          </TabsList>
          <TabsContent value="customers" className="mt-4 space-y-4"><CustomerTrends /></TabsContent>
          <TabsContent value="inventory" className="mt-4 space-y-4"><InventoryTrends /></TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
