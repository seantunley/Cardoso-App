// src/pages/HubMetrics.jsx
// Hub admin page — speed test metrics across all registered sites.

import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart2, RefreshCw, Wifi, ArrowDown, ArrowUp, Activity, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";

// ── helpers ────────────────────────────────────────────────────────────────
function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-ZA", {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function downloadBadgeCls(mbps) {
  if (mbps == null) return "bg-slate-500/10 border border-slate-500/30 text-slate-400";
  if (mbps >= 50)   return "bg-emerald-500/10 border border-emerald-500/30 text-emerald-400";
  if (mbps >= 10)   return "bg-amber-500/10 border border-amber-500/30 text-amber-400";
  return "bg-red-500/10 border border-red-500/30 text-red-400";
}

function fmt(val, unit = "") {
  if (val == null) return "—";
  return `${Number(val).toFixed(1)}${unit}`;
}

function StatusBadge({ pingInfo }) {
  if (!pingInfo) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-slate-500/10 border border-slate-500/30 text-slate-400">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
        Unknown
      </span>
    );
  }
  if (pingInfo.online) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        Online{pingInfo.latency_ms != null ? ` · ${pingInfo.latency_ms}ms` : ""}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-red-500/10 border border-red-500/30 text-red-400">
      <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
      Offline
    </span>
  );
}

// ── fetch ──────────────────────────────────────────────────────────────────
async function fetchSpeedtestResults() {
  const res = await fetch("/api/hub/speedtest", { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchPingStatus() {
  const res = await fetch("/api/hub/ping-status", { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── SiteSection ────────────────────────────────────────────────────────────
function SiteSection({ slug, rows, pingInfo, onRunNow }) {
  const latest = rows[0] ?? null;
  const tableRows = rows.slice(0, 10);
  const [running, setRunning] = useState(false);

  const handleRunNow = useCallback(async () => {
    setRunning(true);
    try {
      await onRunNow(slug);
    } finally {
      setRunning(false);
    }
  }, [slug, onRunNow]);

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      {/* Site heading */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 px-4 py-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md flex items-center justify-center bg-indigo-500/15 border border-indigo-500/30">
            <Wifi className="w-3 h-3 text-indigo-400" />
          </div>
          <h2 className="text-sm font-semibold text-foreground">{slug}</h2>
          <StatusBadge pingInfo={pingInfo} />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRunNow}
          disabled={running || (pingInfo && !pingInfo.online)}
          title={pingInfo && !pingInfo.online ? "Site is offline" : "Run speed test now"}
          className="text-xs border-indigo-500/40 text-indigo-300 gap-1.5 h-7"
        >
          {running ? (
            <RefreshCw className="w-3 h-3 animate-spin" />
          ) : (
            <Play className="w-3 h-3" />
          )}
          {running ? "Running…" : "Run now"}
        </Button>
      </div>

      {/* No data */}
      {!latest ? (
        <div className="flex flex-col items-center py-10 text-slate-500 gap-2">
          <Activity className="w-8 h-8 opacity-30" />
          <p className="text-sm">No data yet — click "Run now" or wait for the next scheduled test</p>
        </div>
      ) : (
        <>
          {/* Latest reading highlight */}
          <div className="grid grid-cols-3 gap-2 px-4 py-2.5 border-b border-border">
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] text-slate-500 uppercase tracking-wide">↓ Download</span>
              <span className={`inline-flex items-center gap-1 text-sm font-bold px-2 py-1 rounded-md self-start ${downloadBadgeCls(latest.download_mbps)}`}>
                <ArrowDown className="w-3 h-3" />
                {fmt(latest.download_mbps, " Mbps")}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] text-slate-500 uppercase tracking-wide">↑ Upload</span>
              <span className="inline-flex items-center gap-1 text-sm font-bold px-2 py-1 rounded-md self-start bg-blue-500/10 border border-blue-500/30 text-blue-400">
                <ArrowUp className="w-3 h-3" />
                {fmt(latest.upload_mbps, " Mbps")}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] text-slate-500 uppercase tracking-wide">Ping</span>
              <span className="inline-flex items-center gap-1 text-sm font-bold px-2 py-1 rounded-md self-start bg-purple-500/10 border border-purple-500/30 text-purple-400">
                {fmt(latest.ping_ms, " ms")}
              </span>
            </div>
          </div>

          {/* History table */}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] text-slate-500 uppercase tracking-wide border-b border-border">
                  <th className="text-left px-4 py-1.5 font-medium">Time</th>
                  <th className="text-right px-3 py-1.5 font-medium">↓ Mbps</th>
                  <th className="text-right px-3 py-1.5 font-medium">↑ Mbps</th>
                  <th className="text-right px-3 py-1.5 font-medium">Ping ms</th>
                  <th className="text-left px-3 py-1.5 font-medium">Server</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((row, i) => (
                  <tr
                    key={row.id ?? i}
                    className="border-b border-border/50 last:border-0 hover:bg-muted/30 transition-colors"
                  >
                    <td className="px-4 py-1.5 text-muted-foreground whitespace-nowrap">{fmtTime(row.timestamp)}</td>
                    <td className="px-3 py-1.5 text-right">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-semibold ${downloadBadgeCls(row.download_mbps)}`}>
                        {fmt(row.download_mbps)}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right font-medium text-blue-400">{fmt(row.upload_mbps)}</td>
                    <td className="px-3 py-1.5 text-right font-medium text-purple-400">{fmt(row.ping_ms)}</td>
                    <td className="px-3 py-1.5 text-muted-foreground truncate max-w-[180px]">
                      {row.server_name ?? row.isp ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function HubMetrics() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [pulling, setPulling] = useState(false);

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["hub-speedtest"],
    queryFn: fetchSpeedtestResults,
    refetchInterval: 300_000,
  });

  const { data: pingData } = useQuery({
    queryKey: ["hub-ping-status"],
    queryFn: fetchPingStatus,
    refetchInterval: 60_000, // refresh ping display every minute
  });

  // Build ping lookup by slug
  const pingBySite = {};
  for (const p of pingData?.sites ?? []) {
    pingBySite[p.site_slug] = p;
  }

  const handlePullNow = useCallback(async () => {
    setPulling(true);
    try {
      const res = await fetch("/api/hub/speedtest/pull", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      toast({ title: `Pulled from ${d.pulled} site(s)` });
      queryClient.invalidateQueries({ queryKey: ["hub-speedtest"] });
    } catch (err) {
      toast({ title: "Pull failed", description: err.message, variant: "destructive" });
    } finally {
      setPulling(false);
    }
  }, [toast, queryClient]);

  const handleRunNow = useCallback(async (slug) => {
    try {
      toast({ title: `Running speed test on ${slug}…`, description: "This may take up to 60 seconds." });
      const res = await fetch("/api/hub/speedtest/run-site", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      toast({ title: `Speed test complete for ${slug}` });
      queryClient.invalidateQueries({ queryKey: ["hub-speedtest"] });
    } catch (err) {
      toast({ title: `Failed for ${slug}`, description: err.message, variant: "destructive" });
    }
  }, [toast, queryClient]);

  // Group results by site_slug
  const grouped = {};
  for (const row of data?.results ?? []) {
    if (!grouped[row.site_slug]) grouped[row.site_slug] = [];
    grouped[row.site_slug].push(row);
  }

  // Merge slugs from speedtest data AND ping data so offline sites still appear
  const allSlugs = Array.from(new Set([
    ...Object.keys(grouped),
    ...Object.keys(pingBySite),
  ])).sort();

  return (
    <div className="min-h-screen p-6 bg-background">
      <div className="max-w-5xl mx-auto">
        {/* Page header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-indigo-500/15 border border-indigo-500/30">
              <BarChart2 className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">Site Metrics</h1>
              <p className="text-xs text-muted-foreground">Speed test results · ping status every 15 min</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePullNow}
              disabled={pulling}
              className="text-xs border-indigo-500/40 text-indigo-300"
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${pulling ? "animate-spin" : ""}`} />
              {pulling ? "Pulling…" : "Pull all"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                refetch();
                queryClient.invalidateQueries({ queryKey: ["hub-ping-status"] });
              }}
              disabled={isFetching}
              className="text-xs border-border text-muted-foreground"
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center gap-3 text-slate-400 py-12 justify-center">
            <RefreshCw className="w-5 h-5 animate-spin" />
            <span>Loading metrics…</span>
          </div>
        )}

        {/* Error */}
        {isError && (
          <div className="rounded-xl p-4 text-red-300 text-sm bg-red-500/10 border border-red-500/30">
            Failed to load speedtest results. Make sure you are logged in as an admin.
          </div>
        )}

        {/* Content */}
        {!isLoading && !isError && (
          <>
            {allSlugs.length === 0 ? (
              <div className="text-center py-16 text-slate-500">
                <BarChart2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p>No site data yet. Click "Pull all" or wait for the next scheduled run.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {allSlugs.map(slug => (
                  <SiteSection
                    key={slug}
                    slug={slug}
                    rows={grouped[slug] ?? []}
                    pingInfo={pingBySite[slug] ?? null}
                    onRunNow={handleRunNow}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
