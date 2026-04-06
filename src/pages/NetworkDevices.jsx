import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertCircle,
  ArrowDownUp,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Info,
  Network,
  RefreshCw,
  Server,
  Users,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/AuthContext";

/* ── helpers ─────────────────────────────────────────── */

function fmtBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function fmtNum(n) {
  if (n == null) return "—";
  return n.toLocaleString();
}

async function apiFetch(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

/* ── NtopngStatus chip ───────────────────────────────── */
function StatusChip({ ok, message }) {
  if (ok) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300">
        <CheckCircle2 className="h-3.5 w-3.5" /> Connected — {message}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-xs text-red-300">
      <WifiOff className="h-3.5 w-3.5" /> {message || "Not connected"}
    </span>
  );
}

/* ── Top-talker row ──────────────────────────────────── */
function TalkerRow({ host, rank }) {
  const total = (host.bytes_sent || 0) + (host.bytes_rcvd || 0);
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs text-muted-foreground w-4 shrink-0">{rank}.</span>
        <div className="min-w-0">
          <div className="truncate font-medium text-foreground">
            {host.name || host.ip || "Unknown"}
          </div>
          {host.name && host.ip && (
            <div className="text-xs text-muted-foreground truncate">{host.ip}</div>
          )}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-xs font-medium text-foreground">{fmtBytes(total)}</div>
        <div className="text-[10px] text-muted-foreground">
          ↑{fmtBytes(host.bytes_sent)} ↓{fmtBytes(host.bytes_rcvd)}
        </div>
      </div>
    </div>
  );
}

/* ── Site card ───────────────────────────────────────── */
function SiteCard({ site }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Card header */}
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={`flex h-9 w-9 items-center justify-center rounded-lg border shrink-0 ${
              site.connected
                ? "border-emerald-500/30 bg-emerald-500/10"
                : "border-slate-500/30 bg-slate-500/10"
            }`}
          >
            {site.connected ? (
              <Wifi className="h-4 w-4 text-emerald-300" />
            ) : (
              <WifiOff className="h-4 w-4 text-slate-400" />
            )}
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-foreground truncate">{site.name || site.slug}</div>
            <div className="text-xs text-muted-foreground">
              {site.connected ? (
                <span className="text-emerald-400">nProbe connected — {site.ifname}</span>
              ) : (
                <span className="text-slate-400">No flows received from nProbe</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-6 shrink-0">
          {site.connected && (
            <>
              <div className="text-center hidden sm:block">
                <div className="text-lg font-bold text-foreground">{fmtNum(site.num_hosts)}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Hosts</div>
              </div>
              <div className="text-center hidden sm:block">
                <div className="text-lg font-bold text-foreground">{fmtNum(site.num_flows)}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Flows</div>
              </div>
              <div className="text-center hidden md:block">
                <div className="text-sm font-medium text-foreground">{fmtBytes(site.bytes_sent)}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">↑ Sent</div>
              </div>
              <div className="text-center hidden md:block">
                <div className="text-sm font-medium text-foreground">{fmtBytes(site.bytes_rcvd)}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">↓ Rcvd</div>
              </div>
            </>
          )}

          {site.connected && site.top_talkers?.length > 0 && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-muted-foreground hover:text-foreground"
            >
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          )}
        </div>
      </div>

      {/* Top talkers (expanded) */}
      {expanded && site.connected && site.top_talkers?.length > 0 && (
        <div className="border-t border-border px-4 pb-4 pt-3">
          <div className="flex items-center gap-2 mb-2 text-xs uppercase tracking-wide text-muted-foreground">
            <ArrowDownUp className="h-3 w-3" />
            Top bandwidth consumers
          </div>
          <div className="divide-y divide-border/50">
            {site.top_talkers.map((host, i) => (
              <TalkerRow key={host.ip || i} host={host} rank={i + 1} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Setup guide (site mode) ─────────────────────────── */
function SetupGuide({ guide }) {
  if (!guide) return null;
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 p-4">
        <div className="flex items-start gap-3">
          <Info className="h-4 w-4 mt-0.5 shrink-0 text-blue-300" />
          <div className="text-sm text-blue-100">
            Network monitoring on site machines is powered by <strong>nProbe</strong>. nProbe captures
            all LAN traffic and exports flows to <strong>ntopng</strong> running on the Hub. The Hub
            then shows live bandwidth and device data per site — no PowerShell scanning required.
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {guide.steps.map((step) => (
          <div key={step.step} className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/20 text-xs font-bold text-primary">
                {step.step}
              </div>
              <div className="min-w-0">
                <div className="font-semibold text-foreground mb-1">{step.title}</div>
                <div className="text-sm text-muted-foreground mb-2">{step.detail}</div>
                {step.config_snippet && (
                  <pre className="rounded-lg bg-black/40 border border-border p-3 text-xs text-green-300 overflow-x-auto whitespace-pre-wrap">
                    {step.config_snippet}
                  </pre>
                )}
                {step.link && (
                  <a
                    href={step.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline mt-1"
                  >
                    Download / docs <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Hub: ntopng not configured banner ───────────────── */
function NotConfiguredBanner({ isAdmin }) {
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-5">
      <div className="flex items-start gap-3">
        <AlertCircle className="h-5 w-5 text-amber-300 mt-0.5 shrink-0" />
        <div>
          <div className="font-semibold text-amber-200 mb-1">ntopng not configured</div>
          <div className="text-sm text-amber-100/80">
            Network monitoring requires <strong>ntopng</strong> running on the Hub machine and <strong>nProbe</strong> on
            each site. Once installed, enter your ntopng credentials in{" "}
            <strong>Settings → Network</strong> on the Hub.
          </div>
          {isAdmin && (
            <div className="mt-3 text-sm text-amber-100/60">
              <strong>Quick start:</strong>{" "}
              <code className="text-xs bg-black/30 px-1 py-0.5 rounded">
                sudo apt install ntopng nprobe
              </code>{" "}
              on the Hub, then set{" "}
              <code className="text-xs bg-black/30 px-1 py-0.5 rounded">ntopng_url</code>,{" "}
              <code className="text-xs bg-black/30 px-1 py-0.5 rounded">ntopng_user</code>, and{" "}
              <code className="text-xs bg-black/30 px-1 py-0.5 rounded">ntopng_password</code> in
              Hub Settings.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Main page ───────────────────────────────────────── */
export default function NetworkDevices() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const appInfoQuery = useQuery({
    queryKey: ["app-info"],
    queryFn: () => apiFetch("/api/app-info"),
    staleTime: 60_000,
  });

  const hubMode = !!appInfoQuery.data?.hub_mode;

  /* Hub: ntopng status */
  const statusQuery = useQuery({
    queryKey: ["ntopng-status"],
    queryFn: () => apiFetch("/api/hub/ntopng/status"),
    enabled: hubMode && appInfoQuery.isSuccess,
    refetchInterval: 60_000,
  });

  /* Hub: per-site network data */
  const devicesQuery = useQuery({
    queryKey: ["hub-network-devices"],
    queryFn: () => apiFetch("/api/hub/network-devices"),
    enabled: hubMode && appInfoQuery.isSuccess,
    refetchInterval: 60_000,
  });

  /* Site: setup guide */
  const setupQuery = useQuery({
    queryKey: ["network-setup-guide"],
    queryFn: () => apiFetch("/api/network-devices/setup"),
    enabled: !hubMode && appInfoQuery.isSuccess,
    staleTime: Infinity,
  });

  const sites = devicesQuery.data?.sites || [];
  const configured = devicesQuery.data?.configured ?? false;
  const ntopngOk = statusQuery.data?.ok ?? false;

  const connectedCount = sites.filter((s) => s.connected).length;
  const totalHosts = sites.reduce((acc, s) => acc + (s.num_hosts || 0), 0);
  const totalFlows = sites.reduce((acc, s) => acc + (s.num_flows || 0), 0);

  return (
    <div className="min-h-screen bg-background p-4 md:p-6 text-foreground">
      <div className="mx-auto max-w-5xl space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-500/30 bg-cyan-500/10">
              <Network className="h-5 w-5 text-cyan-300" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">Network Devices</h1>
              <p className="text-sm text-muted-foreground">
                {hubMode
                  ? "Live network visibility via ntopng + nProbe — per-site flows, hosts, and bandwidth."
                  : "nProbe setup guide — configure network flow export to the Hub."}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {hubMode && (
              <>
                {statusQuery.isSuccess && (
                  <StatusChip ok={statusQuery.data.ok} message={statusQuery.data.message} />
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    statusQuery.refetch();
                    devicesQuery.refetch();
                  }}
                  disabled={devicesQuery.isFetching}
                >
                  <RefreshCw className={`h-4 w-4 mr-2 ${devicesQuery.isFetching ? "animate-spin" : ""}`} />
                  Refresh
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Hub mode */}
        {hubMode && (
          <>
            {/* Not configured */}
            {!configured && <NotConfiguredBanner isAdmin={isAdmin} />}

            {/* Configured: summary tiles */}
            {configured && (
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-2">
                    <Wifi className="h-3.5 w-3.5" /> Sites connected
                  </div>
                  <div className="text-2xl font-bold">{connectedCount}/{sites.length}</div>
                </div>
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-2">
                    <Users className="h-3.5 w-3.5" /> Total hosts
                  </div>
                  <div className="text-2xl font-bold">{fmtNum(totalHosts)}</div>
                </div>
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-2">
                    <Activity className="h-3.5 w-3.5" /> Active flows
                  </div>
                  <div className="text-2xl font-bold">{fmtNum(totalFlows)}</div>
                </div>
                <div className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-2">
                    <Server className="h-3.5 w-3.5" /> ntopng
                  </div>
                  <div className={`text-sm font-semibold ${ntopngOk ? "text-emerald-400" : "text-red-400"}`}>
                    {ntopngOk ? "Online" : "Unreachable"}
                  </div>
                </div>
              </div>
            )}

            {/* Site cards */}
            {configured && (
              <div className="space-y-3">
                {devicesQuery.isLoading ? (
                  <div className="flex items-center justify-center py-16 text-muted-foreground">
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Loading…
                  </div>
                ) : devicesQuery.isError ? (
                  <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
                    {devicesQuery.error?.message || "Failed to load network data"}
                  </div>
                ) : sites.length === 0 ? (
                  <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
                    No sites configured. Add sites in Hub Settings.
                  </div>
                ) : (
                  sites.map((site) => <SiteCard key={site.id} site={site} />)
                )}
              </div>
            )}
          </>
        )}

        {/* Site mode: setup guide */}
        {!hubMode && (
          <>
            {setupQuery.isLoading ? (
              <div className="flex items-center justify-center py-16 text-muted-foreground">
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" /> Loading setup guide…
              </div>
            ) : (
              <SetupGuide guide={setupQuery.data?.guide} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
