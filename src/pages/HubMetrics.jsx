// src/pages/HubMetrics.jsx
// Hub admin page — machine health across all registered sites.

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart2,
  RefreshCw,
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

function MetricChip({ icon: Icon, label, value, sub, tone = "default" }) {
  const toneClasses = {
    default: "bg-background/70 border-border/60 text-foreground",
    good: "bg-emerald-500/10 border-emerald-500/30 text-emerald-400",
    warning: "bg-amber-500/10 border-amber-500/30 text-amber-400",
    danger: "bg-red-500/10 border-red-500/30 text-red-400",
    info: "bg-accent/10 border-accent/30 text-accent",
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
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-accent/10 border border-accent/30 shrink-0">
              <MonitorSmartphone className="w-4 h-4 text-accent" />
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
                    <div className="text-[11px] text-accent/80 font-mono cursor-default">v{site.app_version}</div>
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
                  <span key={ip} className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium bg-accent/10 border border-accent/30 text-accent">
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
          <p>Failed to load machine health. Make sure you are logged in with access to Site Metrics.</p>
          <button
            type="button"
            onClick={() => refetch()}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-red-500/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </button>
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

  return (
    <div className="min-h-screen p-6 bg-background">
      <div className="max-w-[1600px] mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-8 pb-5 border-b border-border">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3 flex items-center gap-2">
              <BarChart2 className="w-3 h-3 text-accent" strokeWidth={1.5} />
              § Site Metrics
            </div>
            <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
              Network <em className="text-phosphor">vitals</em>.
            </h1>
            <p className="text-sm text-muted-foreground mt-3">Windows machine health across all registered sites</p>
          </div>
        </div>

        <MachineHealthTab
          data={machineHealthQuery.data}
          pingBySite={pingBySite}
          isLoading={machineHealthQuery.isLoading}
          isError={machineHealthQuery.isError}
          isFetching={machineHealthQuery.isFetching}
          refetch={machineHealthQuery.refetch}
        />
      </div>
    </div>
  );
}
