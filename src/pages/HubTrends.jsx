import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TrendingUp } from "lucide-react";
import { Tooltip as UITooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

async function fetchTrends(period) {
  const res = await fetch(`/api/hub/trends?period=${period}`, { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to load trends");
  return data;
}

function buildSeries(data) {
  const periods = [...new Set(data.map((row) => row.period))].sort();
  const sites = [...new Set(data.map((row) => row.site_name))];

  const recordVolume = periods.map((period) => {
    const point = { period };
    for (const site of sites) {
      const row = data.find((item) => item.period === period && item.site_name === site);
      point[site] = row?.total_records ?? 0;
    }
    return point;
  });

  const flagRate = periods.map((period) => {
    const point = { period };
    for (const site of sites) {
      const row = data.find((item) => item.period === period && item.site_name === site);
      point[site] = row?.flag_rate ?? 0;
    }
    return point;
  });

  return { sites, recordVolume, flagRate };
}

function ChartCard({ title, subtitle, data, sites, valueSuffix = "", valueDomain }) {
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
            <YAxis stroke="#94a3b8" fontSize={12} domain={valueDomain} />
            <Tooltip
              contentStyle={{ background: "#020817", border: "1px solid #1e293b", borderRadius: 12 }}
              formatter={(value) => [`${value}${valueSuffix}`, ""]}
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

export default function HubTrends() {
  const [period, setPeriod] = useState("weekly");
  const { data, isLoading, error } = useQuery({
    queryKey: ["hub-trends", period],
    queryFn: () => fetchTrends(period),
    staleTime: 60_000,
  });

  const rows = data?.data || [];
  const { sites, recordVolume, flagRate } = useMemo(() => buildSeries(rows), [rows]);

  return (
    <div className="min-h-screen bg-background px-4 py-6 text-foreground sm:px-6">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between border-b border-border pb-5">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">§ Trends</div>
            <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
              The shape of <em className="text-phosphor">time</em>.
            </h1>
            <p className="text-sm text-muted-foreground mt-3">
              Weekly and monthly record volume plus flag-rate trends per site.
            </p>
          </div>
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
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {isLoading && (
          <div className="space-y-4">
            <div className="h-[420px] animate-pulse rounded-xl border border-border bg-card" />
            <div className="h-[420px] animate-pulse rounded-xl border border-border bg-card" />
          </div>
        )}

        {!isLoading && error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-sm text-red-300">
            {error.message || "Failed to load trends"}
          </div>
        )}

        {!isLoading && !error && rows.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card px-6 py-16 text-center">
            <TrendingUp className="mb-4 h-12 w-12 text-muted-foreground" />
            <h2 className="text-lg font-semibold text-foreground">No trend data yet</h2>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Trends will appear once the hub has enough synced record history to bucket over time.
            </p>
          </div>
        )}

        {!isLoading && !error && rows.length > 0 && (
          <div className="space-y-6">
            <ChartCard
              title="Record Volume"
              subtitle={`Showing ${period} totals per site`}
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
      </div>
    </div>
  );
}
