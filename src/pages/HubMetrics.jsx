// src/pages/HubMetrics.jsx
// Hub admin page — speed test metrics and machine health across all registered sites.

import { useMemo, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart2,
  RefreshCw,
  Wifi,
  ArrowDown,
  ArrowUp,
  Activity,
  Play,
  MonitorSmartphone,
  Cpu,
  HardDrive,
  MemoryStick,
  Clock3,
  ServerCog,
  AlertTriangle,
  CheckCircle2,
  CloudOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-ZA", {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtRelative(iso) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 2) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function fmtDuration(seconds) {
  if (seconds == null) return "—";
  const total = Math.max(0, Math.floor(Number(seconds)));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function fmt(val, unit = "") {
  if (val == null) return "—";
  return `${Number(val).toFixed(1)}${unit}`;
}

function fmtBytes(bytes) {
  if (bytes == null) return "—";
  const value = Number(bytes);
  if (!Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function downloadBadgeCls(mbps) {
  if (mbps == null) return "bg-slate-500/10 border border-slate-500/30 text-slate-400";
  if (mbps >= 50) return "bg-emerald-500/10 border border-emerald-500/30 text-emerald-400";
  if (mbps >= 10) return "bg-amber-500/10 border border-amber-500/30 text-amber-400";
  return "bg-red-500/10 border border-red-500/30 text-red-400";
}

const HEALTH_META = {
  ok: { label: "Healthy", icon: CheckCircle2, cls: "bg-emerald-500/10 border border-emerald-500/30 text-emerald-400" },
  warning: { label: "Attention", icon: AlertTriangle, cls: "bg-amber-500/10 border border-amber-500/30 text-amber-400" },
  critical: { label: "Critical", icon: AlertTriangle, cls: "bg-red-500/10 border border-red-500/30 text-red-400" },
  unavailable: { label: "Unavailable", icon: CloudOff, cls: "bg-slate-500/10 border border-slate-500/30 text-slate-400" },
};

function StatusBadge({ pingInfo }) {
  const badge = !pingInfo ? (
    <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-slate-500/10 border border-slate-500/30 text-slate-400 cursor-default">
      <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
      Unknown
    </span>
  ) : pingInfo.online ? (
    <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 cursor-default">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
      Online{pingInfo.latency_ms != null ? ` · ${pingInfo.latency_ms}ms` : ""}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-red-500/10 border border-red-500/30 text-red-400 cursor-default">
      <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
      Offline
    </span>
  );
  const tipText = !pingInfo
    ? "Ping status unknown for this site"
    : pingInfo.online
    ? `Site is reachable over Tailscale${pingInfo.latency_ms != null ? ` — ${pingInfo.latency_ms}ms round-trip` : ""}`
    : "Site is not responding over Tailscale";
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent>{tipText}</TooltipContent>
    </Tooltip>
  );
}

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

async function fetchMachineHealth() {
  const res = await fetch("/api/hub/machine-health", { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function SiteSection({ slug, rows, pingInfo, onRunNow }) {
  const latest = rows[0] ?? null;
  const tableRows = rows.slice(0, 3);
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
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 px-4 py-2.5 border-b border-border">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md flex items-center justify-center bg-indigo-500/15 border border-indigo-500/30">
            <Wifi className="w-3 h-3 text-indigo-400" />
          </div>
          <h2 className="text-sm font-semibold text-foreground">{slug}</h2>
          <StatusBadge pingInfo={pingInfo} />
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRunNow}
              disabled={running || (pingInfo && !pingInfo.online)}
              className="text-xs border-indigo-500/40 text-indigo-300 gap-1.5 h-7"
            >
              {running ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              {running ? "Running…" : "Run now"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{pingInfo && !pingInfo.online ? "Site is offline" : "Run a speed test on this site now"}</TooltipContent>
        </Tooltip>
      </div>

      {!latest ? (
        <div className="flex flex-col items-center py-10 text-slate-500 gap-2">
          <Activity className="w-8 h-8 opacity-30" />
          <p className="text-sm">No data yet — click "Run now" or wait for the next scheduled test</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2 px-4 py-2.5 border-b border-border">
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] text-slate-500 uppercase tracking-wide">↓ Download</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className={`inline-flex items-center gap-1 text-sm font-bold px-2 py-1 rounded-md self-start cursor-default ${downloadBadgeCls(latest.download_mbps)}`}>
                    <ArrowDown className="w-3 h-3" />
                    {fmt(latest.download_mbps, " Mbps")}
                  </span>
                </TooltipTrigger>
                <TooltipContent>Download speed measured at last scheduled test</TooltipContent>
              </Tooltip>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] text-slate-500 uppercase tracking-wide">↑ Upload</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 text-sm font-bold px-2 py-1 rounded-md self-start cursor-default bg-blue-500/10 border border-blue-500/30 text-blue-400">
                    <ArrowUp className="w-3 h-3" />
                    {fmt(latest.upload_mbps, " Mbps")}
                  </span>
                </TooltipTrigger>
                <TooltipContent>Upload speed measured at last scheduled test</TooltipContent>
              </Tooltip>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] text-slate-500 uppercase tracking-wide">Ping</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center gap-1 text-sm font-bold px-2 py-1 rounded-md self-start cursor-default bg-purple-500/10 border border-purple-500/30 text-purple-400">
                    {fmt(latest.ping_ms, " ms")}
                  </span>
                </TooltipTrigger>
                <TooltipContent>Round-trip latency to test server from this site</TooltipContent>
              </Tooltip>
            </div>
          </div>

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
                  <tr key={row.id ?? i} className="border-b border-border/50 last:border-0 hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-1.5 text-muted-foreground whitespace-nowrap">{fmtTime(row.timestamp)}</td>
                    <td className="px-3 py-1.5 text-right">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-semibold ${downloadBadgeCls(row.download_mbps)}`}>
                        {fmt(row.download_mbps)}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right font-medium text-blue-400">{fmt(row.upload_mbps)}</td>
                    <td className="px-3 py-1.5 text-right font-medium text-purple-400">{fmt(row.ping_ms)}</td>
                    <td className="px-3 py-1.5 text-muted-foreground truncate max-w-[180px]">{row.server_name ?? row.isp ?? "—"}</td>
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

function MetricChip({ icon: Icon, label, value, sub, tone = "default" }) {
  const toneClasses = {
    default: "bg-background/70 border-border/60 text-foreground",
    good: "bg-emerald-500/10 border-emerald-500/30 text-emerald-400",
    warning: "bg-amber-500/10 border-amber-500/30 text-amber-400",
    danger: "bg-red-500/10 border-red-500/30 text-red-400",
    info: "bg-blue-500/10 border-blue-500/30 text-blue-300",
  };

  return (
    <div className={`rounded-lg border px-3 py-2 ${toneClasses[tone] || toneClasses.default}`}>
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide opacity-80">
        <Icon className="w-3.5 h-3.5" />
        <span>{label}</span>
      </div>
      <div className="mt-1 text-sm font-semibold">{value}</div>
      {sub ? <div className="text-[11px] opacity-75 mt-0.5">{sub}</div> : null}
    </div>
  );
}

function metricTone(percent, warningAt = 80, dangerAt = 90, invert = false) {
  if (percent == null || !Number.isFinite(percent)) return "default";
  if (invert) {
    if (percent <= dangerAt) return "danger";
    if (percent <= warningAt) return "warning";
    return "good";
  }
  if (percent >= dangerAt) return "danger";
  if (percent >= warningAt) return "warning";
  return "good";
}

function MachineHealthCard({ site, pingInfo }) {
  const health = site.health || { status: "unavailable", reasons: [] };
  const meta = HEALTH_META[health.status] || HEALTH_META.unavailable;
  const HealthIcon = meta.icon;
  const service = site.cardoso_service;
  const memory = site.memory || {};
  const disks = Array.isArray(site.disks) ? site.disks : [];
  const ips = Array.isArray(site.machine?.local_ips) ? site.machine.local_ips : [];

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      <div className="flex flex-col gap-3 px-4 py-3 border-b border-border">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-indigo-500/15 border border-indigo-500/30 shrink-0">
              <MonitorSmartphone className="w-4 h-4 text-indigo-400" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-sm font-semibold text-foreground truncate">{site.site_name || site.site_slug || site.site_id}</h2>
                <StatusBadge pingInfo={pingInfo} />
              </div>
              <div className="text-xs text-muted-foreground truncate">
                {site.machine?.hostname || site.site_slug || "Unknown host"}
                {site.machine?.os_version ? ` · ${site.machine.os_version}` : ""}
              </div>
              {site.app_version && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="text-[11px] text-blue-400/80 font-mono cursor-default">v{site.app_version}</div>
                  </TooltipTrigger>
                  <TooltipContent>Installed Cardoso App version at this site</TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
          <span className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium ${meta.cls}`}>
            <HealthIcon className="w-3.5 h-3.5" />
            {meta.label}
          </span>
        </div>

        <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
          <span>Checked {fmtRelative(site.checked_at)}</span>
          {site.machine?.last_boot_at ? <span>Last reboot {fmtTime(site.machine.last_boot_at)}</span> : null}
        </div>

        {health.reasons?.length ? (
          <div className="flex flex-wrap gap-2">
            {health.reasons.slice(0, 3).map((reason) => (
              <span key={reason} className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] bg-amber-500/10 border border-amber-500/30 text-amber-400">
                <AlertTriangle className="w-3 h-3" />
                {reason}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {!site.ok ? (
        <div className="px-4 py-10 text-center text-slate-500">
          <CloudOff className="w-8 h-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">{site.message || "Machine health unavailable."}</p>
        </div>
      ) : (
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <Tooltip><TooltipTrigger asChild><div><MetricChip
              icon={Cpu}
              label="CPU"
              value={site.cpu?.usage_percent != null ? `${Number(site.cpu.usage_percent).toFixed(1)}%` : "—"}
              sub={site.cpu?.sampled ? `Sampled over ${site.cpu.sample_seconds || 3}s` : "No sample"}
              tone={metricTone(Number(site.cpu?.usage_percent), 75, 90)}
            /></div></TooltipTrigger><TooltipContent>CPU usage across all processor cores at time of last check</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger asChild><div><MetricChip
              icon={MemoryStick}
              label="RAM"
              value={memory.used_percent != null ? `${Number(memory.used_percent).toFixed(1)}% used` : "—"}
              sub={memory.total_bytes != null ? `${fmtBytes(memory.used_bytes)} / ${fmtBytes(memory.total_bytes)}` : undefined}
              tone={metricTone(Number(memory.used_percent), 80, 90)}
            /></div></TooltipTrigger><TooltipContent>Physical memory in use vs total available</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger asChild><div><MetricChip
              icon={Clock3}
              label="Uptime"
              value={fmtDuration(site.machine?.uptime_seconds)}
              sub={site.machine?.last_boot_at ? `Booted ${fmtTime(site.machine.last_boot_at)}` : undefined}
              tone="info"
            /></div></TooltipTrigger><TooltipContent>How long the machine has been running without a restart</TooltipContent></Tooltip>
            <MetricChip
              icon={ServerCog}
              label="Cardoso Service"
              value={service?.present ? (service.status || "Unknown") : "Not installed"}
              sub={service?.start_type ? `Start: ${service.start_type}` : undefined}
              tone={service?.present ? (service.status === "Running" ? "good" : "warning") : "default"}
            />
          </div>

          <div className="rounded-lg border border-border/60 bg-background/60 p-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-2">Disk Space</div>
            {disks.length === 0 ? (
              <p className="text-xs text-slate-500">No local drive data available.</p>
            ) : (
              <div className="space-y-2">
                {disks.map((disk) => {
                  const usedPercent = Number(disk.used_percent);
                  const freePercent = Number(disk.free_percent);
                  const diskTone = metricTone(freePercent, 20, 10, true);
                  const barTone = Number.isFinite(usedPercent)
                    ? (usedPercent >= 90 ? "bg-red-500" : usedPercent >= 80 ? "bg-amber-500" : "bg-emerald-500")
                    : "bg-slate-500";
                  return (
                    <div key={disk.drive} className="rounded-md border border-border/50 px-3 py-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-foreground">{disk.drive}{disk.volume_name ? ` · ${disk.volume_name}` : ""}</div>
                          <div className="text-[11px] text-slate-500">{fmtBytes(disk.free_bytes)} free of {fmtBytes(disk.total_bytes)}</div>
                        </div>
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ${diskTone === "danger" ? "bg-red-500/10 border border-red-500/30 text-red-400" : diskTone === "warning" ? "bg-amber-500/10 border border-amber-500/30 text-amber-400" : diskTone === "good" ? "bg-emerald-500/10 border border-emerald-500/30 text-emerald-400" : "bg-slate-500/10 border border-slate-500/30 text-slate-400"}`}>
                          <HardDrive className="w-3 h-3" />
                          {Number.isFinite(freePercent) ? `${freePercent.toFixed(1)}% free` : "Unknown"}
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-muted overflow-hidden">
                        <div className={`h-full ${barTone}`} style={{ width: `${Number.isFinite(usedPercent) ? Math.min(100, Math.max(0, usedPercent)) : 0}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border/60 bg-background/60 p-3">
            <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-2">Local IPs</div>
            {ips.length ? (
              <div className="flex flex-wrap gap-2">
                {ips.map((ip) => (
                  <span key={ip} className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium bg-blue-500/10 border border-blue-500/30 text-blue-300">
                    {ip}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500">No IPv4 addresses reported.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SpeedtestTab({ data, pingBySite, isLoading, isError, isFetching, refetch, onPullNow, pulling, onRunNow, queryClient }) {
  const grouped = {};
  for (const row of data?.results ?? []) {
    if (!grouped[row.site_slug]) grouped[row.site_slug] = [];
    grouped[row.site_slug].push(row);
  }

  const allSlugs = Array.from(new Set([
    ...Object.keys(grouped),
    ...Object.keys(pingBySite),
  ])).sort();

  return (
    <>
      <div className="flex items-center gap-2 mb-6">
        <Button
          variant="outline"
          size="sm"
          onClick={onPullNow}
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

      {isLoading && (
        <div className="flex items-center gap-3 text-slate-400 py-12 justify-center">
          <RefreshCw className="w-5 h-5 animate-spin" />
          <span>Loading metrics…</span>
        </div>
      )}

      {isError && (
        <div className="rounded-xl p-4 text-red-300 text-sm bg-red-500/10 border border-red-500/30">
          Failed to load speedtest results. Make sure you are logged in with access to Site Metrics.
        </div>
      )}

      {!isLoading && !isError && (
        allSlugs.length === 0 ? (
          <div className="text-center py-16 text-slate-500">
            <BarChart2 className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>No site data yet. Click "Pull all" or wait for the next scheduled run.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {allSlugs.map((slug) => (
              <SiteSection
                key={slug}
                slug={slug}
                rows={grouped[slug] ?? []}
                pingInfo={pingBySite[slug] ?? null}
                onRunNow={onRunNow}
              />
            ))}
          </div>
        )
      )}
    </>
  );
}

function MachineHealthTab({ data, pingBySite, isLoading, isError, isFetching, refetch }) {
  const sites = useMemo(() => {
    const rows = [...(data?.sites ?? [])];
    return rows.sort((a, b) => {
      const order = { critical: 0, warning: 1, unavailable: 2, ok: 3 };
      const aScore = order[a.health?.status] ?? 9;
      const bScore = order[b.health?.status] ?? 9;
      if (aScore !== bScore) return aScore - bScore;
      return String(a.site_name || a.site_slug || "").localeCompare(String(b.site_name || b.site_slug || ""));
    });
  }, [data]);

  return (
    <>
      <div className="flex items-center gap-2 mb-6">
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
          className="text-xs border-border text-muted-foreground"
        >
          <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {isLoading && (
        <div className="flex items-center gap-3 text-slate-400 py-12 justify-center">
          <RefreshCw className="w-5 h-5 animate-spin" />
          <span>Loading machine health…</span>
        </div>
      )}

      {isError && (
        <div className="rounded-xl p-4 text-red-300 text-sm bg-red-500/10 border border-red-500/30">
          Failed to load machine health. Make sure you are logged in with access to Site Metrics.
        </div>
      )}

      {!isLoading && !isError && (
        sites.length === 0 ? (
          <div className="text-center py-16 text-slate-500">
            <MonitorSmartphone className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>No site machine health data yet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
            {sites.map((site) => (
              <MachineHealthCard key={site.site_id || site.site_slug} site={site} pingInfo={pingBySite[site.site_slug] ?? null} />
            ))}
          </div>
        )
      )}
    </>
  );
}

export default function HubMetrics() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [pulling, setPulling] = useState(false);
  const [activeTab, setActiveTab] = useState("speedtest");

  const speedtestQuery = useQuery({
    queryKey: ["hub-speedtest"],
    queryFn: fetchSpeedtestResults,
    refetchInterval: 300_000,
  });

  const pingQuery = useQuery({
    queryKey: ["hub-ping-status"],
    queryFn: fetchPingStatus,
    refetchInterval: 60_000,
  });

  const machineHealthQuery = useQuery({
    queryKey: ["hub-machine-health"],
    queryFn: fetchMachineHealth,
    refetchInterval: 300_000,
  });

  const pingBySite = {};
  for (const p of pingQuery.data?.sites ?? []) {
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

  return (
    <div className="min-h-screen p-6 bg-background">
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-indigo-500/15 border border-indigo-500/30">
              <BarChart2 className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">Site Metrics</h1>
              <p className="text-xs text-muted-foreground">Speedtest and Windows machine health across all registered sites</p>
            </div>
          </div>
        </div>

        <div className="inline-flex items-center rounded-xl border border-border bg-card p-1 mb-6">
          {[
            { key: "speedtest", label: "Speedtest" },
            { key: "machine-health", label: "Machine Health" },
          ].map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${activeTab === tab.key ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === "speedtest" ? (
          <SpeedtestTab
            data={speedtestQuery.data}
            pingBySite={pingBySite}
            isLoading={speedtestQuery.isLoading}
            isError={speedtestQuery.isError}
            isFetching={speedtestQuery.isFetching}
            refetch={speedtestQuery.refetch}
            onPullNow={handlePullNow}
            pulling={pulling}
            onRunNow={handleRunNow}
            queryClient={queryClient}
          />
        ) : (
          <MachineHealthTab
            data={machineHealthQuery.data}
            pingBySite={pingBySite}
            isLoading={machineHealthQuery.isLoading}
            isError={machineHealthQuery.isError}
            isFetching={machineHealthQuery.isFetching}
            refetch={machineHealthQuery.refetch}
          />
        )}
      </div>
    </div>
  );
}
