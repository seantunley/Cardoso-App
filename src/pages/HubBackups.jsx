// src/pages/HubBackups.jsx
// Hub admin page — monitors backup health across all registered sites.

import { useState, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Database, RefreshCw, Download, CheckCircle2,
  AlertTriangle, XCircle, Clock, HardDrive, CloudOff, Power,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";

// ── helpers ────────────────────────────────────────────────────────────────
function fmtBytes(b) {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function fmtRelative(iso) {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 2)   return "Just now";
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-ZA", {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

const STATUS_META = {
  ok:          { label: "OK",        icon: CheckCircle2,  cls: "bg-emerald-500/10 border border-emerald-500/30 text-emerald-400" },
  warning:     { label: "Overdue",   icon: AlertTriangle, cls: "bg-amber-500/10 border border-amber-500/30 text-amber-400" },
  stale:       { label: "Stale",     icon: AlertTriangle, cls: "bg-red-500/10 border border-red-500/30 text-red-400" },
  never:       { label: "No Backup", icon: XCircle,       cls: "bg-red-500/10 border border-red-500/30 text-red-400" },
  error:       { label: "Error",     icon: XCircle,       cls: "bg-red-500/10 border border-red-500/30 text-red-400" },
  unreachable: { label: "Offline",   icon: CloudOff,      cls: "bg-slate-500/10 border border-slate-500/30 text-slate-400" },
  unknown:     { label: "Unknown",   icon: Clock,         cls: "bg-slate-500/10 border border-slate-500/30 text-slate-400" },
};

// ── fetch ──────────────────────────────────────────────────────────────────
async function fetchBackupSettings() {
  const res = await fetch("/api/hub/backup-settings", { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchBackupStatus() {
  const res = await fetch("/api/hub/backup-status", { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── SiteCard ───────────────────────────────────────────────────────────────
function SiteCard({ site, onDownload, downloading }) {
  const meta  = STATUS_META[site.status] || STATUS_META.unknown;
  const Icon  = meta.icon;
  const lb    = site.last_backup;

  return (
    <div
      className={`bg-card rounded-xl p-5 flex flex-col gap-4 ${meta.cls}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center bg-blue-500/15 border border-blue-500/30"
          >
            <Database className="w-4 h-4 text-blue-400" />
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-white text-sm truncate">{site.site_name || site.site_id}</div>
            <div className="text-xs text-slate-500 truncate">{site.url || "No URL"}</div>
          </div>
        </div>
        {/* Status badge */}
        <span
          className={`flex-shrink-0 flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${meta.cls}`}
        >
          <Icon className="w-3.5 h-3.5" />
          {meta.label}
        </span>
      </div>

      {/* Stats */}
      {site.error ? (
        <p className="text-xs text-red-400">{site.error}</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Last Backup" value={lb ? fmtRelative(lb.mtime) : "Never"} sub={lb ? fmtDate(lb.mtime) : ""} />
          <Stat label="Backup Size" value={fmtBytes(lb?.size)} />
          <Stat label="Live DB Size" value={fmtBytes(site.db_size)} />
          <Stat label="Backups Stored" value={lb?.total_backups ?? "0"} />
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-1 border-t border-white/5">
        <Button
          size="sm"
          variant="outline"
          disabled={!site.url || downloading === site.site_id}
          onClick={() => onDownload(site)}
          className="text-xs h-7 px-3 border-border text-primary"
        >
          {downloading === site.site_id
            ? <><RefreshCw className="w-3 h-3 mr-1.5 animate-spin" />Downloading…</>
            : <><Download className="w-3 h-3 mr-1.5" />Pull backup now</>}
        </Button>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div>
      <div className="text-[11px] text-slate-500 uppercase tracking-wide mb-0.5">{label}</div>
      <div className="text-sm font-semibold text-foreground">{value ?? "—"}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

// ── Summary bar ────────────────────────────────────────────────────────────
function SummaryBar({ sites }) {
  const counts = sites.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});
  const ok      = counts.ok || 0;
  const warning = (counts.warning || 0) + (counts.stale || 0);
  const problem = (counts.never || 0) + (counts.error || 0) + (counts.unreachable || 0);

  return (
    <div className="flex flex-wrap gap-3 mb-6">
      {[
        { label: "Healthy",  count: ok,      cls: "bg-emerald-500/10 border border-emerald-500/30 text-emerald-400" },
        { label: "Overdue",  count: warning, cls: "bg-amber-500/10 border border-amber-500/30 text-amber-400" },
        { label: "Problems", count: problem, cls: "bg-red-500/10 border border-red-500/30 text-red-400" },
        { label: "Total Sites", count: sites.length, cls: "bg-blue-500/10 border border-blue-500/30 text-blue-300" },
      ].map(p => (
        <div
          key={p.label}
          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium ${p.cls}`}
        >
          <span className="text-xl font-bold leading-none">{p.count}</span>
          <span className="text-xs opacity-80">{p.label}</span>
        </div>
      ))}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function HubBackups() {
  const { toast } = useToast();
  const [downloading, setDownloading] = useState(null);
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [togglingSync, setTogglingSync] = useState(false);

  useEffect(() => {
    fetchBackupSettings().then(d => setSyncEnabled(d.backup_sync_enabled)).catch(() => {});
  }, []);

  const handleToggleSync = useCallback(async () => {
    setTogglingSync(true);
    try {
      const res = await fetch("/api/hub/backup-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ backup_sync_enabled: !syncEnabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      setSyncEnabled(d.backup_sync_enabled);
      toast({ title: d.backup_sync_enabled ? "Backup sync enabled" : "Backup sync disabled" });
    } catch (err) {
      toast({ title: "Failed to update setting", description: err.message, variant: "destructive" });
    } finally {
      setTogglingSync(false);
    }
  }, [syncEnabled, toast]);

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["hub-backup-status"],
    queryFn: fetchBackupStatus,
    refetchInterval: 60_000,
  });

  const sites = data?.sites || [];

  const handleDownload = useCallback(async (site) => {
    setDownloading(site.site_id);
    try {
      const res = await fetch(`${site.url}/api/backup/download`, {
        headers: { "x-reporting-token": "" }, // token managed server-side when going through hub proxy
        credentials: "include",
      });
      // Use hub proxy instead to avoid CORS
      const proxyRes = await fetch(
        `/api/hub/proxy-backup?site_id=${encodeURIComponent(site.site_id)}`,
        { credentials: "include" }
      );
      if (!proxyRes.ok) throw new Error(`HTTP ${proxyRes.status}`);
      const blob = await proxyRes.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `cardoso-${site.site_id}-${new Date().toISOString().slice(0,10)}.db`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Backup downloaded", description: site.site_name });
    } catch (err) {
      toast({ title: "Download failed", description: err.message, variant: "destructive" });
    } finally {
      setDownloading(null);
    }
  }, [toast]);

  return (
    <div
      className="min-h-screen p-6 bg-background"
    >
      <div className="max-w-5xl mx-auto">
        {/* Page header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center bg-blue-500/15 border border-blue-500/30"
            >
              <HardDrive className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Site Backups</h1>
              <p className="text-xs text-muted-foreground">Live backup health across all registered sites</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleToggleSync}
              disabled={togglingSync}
              className="text-xs"
              className={syncEnabled ? "border-emerald-500/40 text-emerald-300" : "border-red-500/40 text-red-300"}
            >
              <Power className="w-3.5 h-3.5 mr-1.5" />
              {syncEnabled ? "Sync On" : "Sync Off"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              className="text-xs"
              className="border-border text-muted-foreground"
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
            <span>Polling sites…</span>
          </div>
        )}

        {/* Error */}
        {isError && (
          <div className="rounded-xl p-4 text-red-300 text-sm bg-red-500/10 border border-red-500/30">
            Failed to load backup status. Make sure you are logged in as an admin.
          </div>
        )}

        {/* Content */}
        {!isLoading && !isError && (
          <>
            {sites.length === 0 ? (
              <div className="text-center py-16 text-slate-500">
                <Database className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p>No sites registered yet.</p>
              </div>
            ) : (
              <>
                <SummaryBar sites={sites} />
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {sites.map(site => (
                    <SiteCard
                      key={site.site_id}
                      site={site}
                      onDownload={handleDownload}
                      downloading={downloading}
                    />
                  ))}
                </div>
                <p className="text-xs text-slate-600 mt-6 text-center">
                  Auto-refreshes every 60s · Backup health: OK = within 25h, Overdue = 25–48h, Stale = &gt;48h
                </p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
