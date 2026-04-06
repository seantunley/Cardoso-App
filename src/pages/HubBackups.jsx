// src/pages/HubBackups.jsx
// Hub admin page — monitors backup health across all registered sites.

import { useState, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Database, RefreshCw, Download, CheckCircle2,
  AlertTriangle, XCircle, Clock, HardDrive, CloudOff, Power, CloudDownload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";

function fmtBytes(b) {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function fmtRelative(iso) {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 2) return "Just now";
  if (mins < 60) return `${mins}m ago`;
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

const SQL_STATUS_META = {
  ok:          { label: "SQL OK",          icon: CheckCircle2,  cls: "bg-emerald-500/10 border border-emerald-500/30 text-emerald-400" },
  stale:       { label: "SQL Overdue",     icon: AlertTriangle, cls: "bg-amber-500/10 border border-amber-500/30 text-amber-400" },
  failed:      { label: "SQL Failed",      icon: XCircle,       cls: "bg-red-500/10 border border-red-500/30 text-red-400" },
  unavailable: { label: "SQL Unavailable", icon: CloudOff,      cls: "bg-slate-500/10 border border-slate-500/30 text-slate-400" },
};

const INTEGRITY_META = {
  ok: { label: "OK", cls: "bg-emerald-500/10 border border-emerald-500/30 text-emerald-400" },
  corrupt: { label: "Corrupt", cls: "bg-red-500/10 border border-red-500/30 text-red-400" },
};

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

async function fetchHubBackupStatus() {
  const res = await fetch("/api/hub/hub-backup-status", { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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

function SiteCard({ site, hubData, onDownload, downloading, onDownloadConfig, downloadingConfig }) {
  const meta = STATUS_META[site.status] || STATUS_META.unknown;
  const Icon = meta.icon;
  const lb = site.last_backup;
  const integrityMeta = hubData?.integrity ? INTEGRITY_META[hubData.integrity] : null;
  const sqlHealth = site.sql_backup?.health || { status: "unavailable", last_success_at: null };
  const sqlMeta = SQL_STATUS_META[sqlHealth.status] || SQL_STATUS_META.unavailable;
  const SqlIcon = sqlMeta.icon;

  return (
    <div className="rounded-2xl border border-border/70 bg-card/95 p-5 shadow-sm shadow-black/5 backdrop-blur-sm">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-blue-500/30 bg-blue-500/15">
              <Database className="h-4 w-4 text-blue-400" />
            </div>
            <div className="min-w-0">
              <div className="text-base font-semibold text-foreground truncate">{site.site_name || site.site_id}</div>
              <div className="text-xs text-slate-500 truncate">{site.url || "No URL"}</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 sm:justify-end">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${meta.cls}`}>
              <Icon className="h-3.5 w-3.5" />
              App {meta.label}
            </span>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${sqlMeta.cls}`}>
              <SqlIcon className="h-3.5 w-3.5" />
              {sqlMeta.label}
            </span>
            {integrityMeta && (
              <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${integrityMeta.cls}`}>
                Hub {integrityMeta.label}
              </span>
            )}
          </div>
        </div>

        {site.error ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-400">
            {site.error}
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            <div className={`rounded-xl border bg-background/80 p-4 ${meta.cls}`}>
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">App Backup</div>
                  <div className="mt-1 text-sm font-semibold text-foreground">
                    {lb ? fmtRelative(lb.mtime) : "Never"}
                  </div>
                  {lb?.mtime && <div className="text-[11px] text-slate-500">{fmtDate(lb.mtime)}</div>}
                </div>
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium ${meta.cls}`}>
                  <Icon className="h-3 w-3" />
                  {meta.label}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Stat label="Backup Size" value={fmtBytes(lb?.size)} />
                <Stat label="Live DB Size" value={fmtBytes(site.db_size)} />
                <Stat label="On Site" value={lb?.total_backups ?? "0"} />
                <Stat label="On Hub" value={hubData?.hub_backup_count ?? "0"} sub={hubData?.hub_last_backup ? fmtRelative(hubData.hub_last_backup) : ""} />
                <Stat label="Hub Latest" value={fmtBytes(hubData?.hub_last_size)} />
                <Stat label="Hub Time" value={hubData?.hub_last_backup ? fmtDate(hubData.hub_last_backup) : "—"} />
              </div>

              <div className="mt-4 flex gap-2 border-t border-border/50 pt-4 flex-wrap">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!site.url || downloading === site.site_id}
                  onClick={() => onDownload(site)}
                  className="h-7 border-border px-3 text-xs text-primary"
                >
                  {downloading === site.site_id
                    ? <><RefreshCw className="mr-1.5 h-3 w-3 animate-spin" />Downloading…</>
                    : <><Download className="mr-1.5 h-3 w-3" />Pull DB</>}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!site.url || downloadingConfig === site.site_id}
                  onClick={() => onDownloadConfig(site)}
                  className="h-7 border-border px-3 text-xs text-amber-400"
                  title="Download .env (site identity + secrets)"
                >
                  {downloadingConfig === site.site_id
                    ? <><RefreshCw className="mr-1.5 h-3 w-3 animate-spin" />Downloading…</>
                    : <><Download className="mr-1.5 h-3 w-3" />Pull .env</>}
                </Button>
              </div>
            </div>

            <div className={`rounded-xl border bg-background/80 p-4 ${sqlMeta.cls}`}>
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <div className="text-[11px] uppercase tracking-[0.18em] text-slate-500">SQL Backup</div>
                  <div className="mt-1 text-sm font-semibold text-foreground">
                    {sqlHealth.last_success_at ? fmtRelative(sqlHealth.last_success_at) : "Unavailable"}
                  </div>
                  {sqlHealth.last_success_at && (
                    <div className="text-[11px] text-slate-500">{fmtDate(sqlHealth.last_success_at)}</div>
                  )}
                </div>
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium ${sqlMeta.cls}`}>
                  <SqlIcon className="h-3 w-3" />
                  {sqlMeta.label}
                </span>
              </div>

              {!site.sql_backup?.ok ? (
                <p className="text-xs text-slate-500">{site.sql_backup?.message || "SQL backup status unavailable."}</p>
              ) : site.sql_backup?.databases?.length ? (
                <div className="space-y-2">
                  {site.sql_backup.databases.map((database) => {
                    const good = database.isSuccess === true;
                    const bad = database.isSuccess === false;
                    return (
                      <div key={database.name} className="flex items-start justify-between gap-3 rounded-lg border border-border/60 bg-card/70 px-3 py-2.5">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-foreground truncate">{database.name}</div>
                          <div className="text-[11px] text-slate-500">{database.backupAt ? fmtDate(database.backupAt) : "No timestamp"}</div>
                          {database.objectStatus && (
                            <div className="text-[11px] text-slate-500 truncate">{database.objectStatus}</div>
                          )}
                        </div>
                        <span className={`inline-flex items-center rounded-full px-2 py-1 text-[11px] font-semibold ${good ? "bg-emerald-500/10 border border-emerald-500/30 text-emerald-400" : bad ? "bg-red-500/10 border border-red-500/30 text-red-400" : "bg-slate-500/10 border border-slate-500/30 text-slate-400"}`}>
                          {good ? "Success" : bad ? "Failed" : "Unknown"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-slate-500">{site.sql_backup?.message || "No DAT backup objects found."}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryBar({ sites }) {
  const counts = sites.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});
  const sqlAttention = sites.filter((s) => s.sql_backup?.health?.needs_attention).length;
  const ok = counts.ok || 0;
  const warning = (counts.warning || 0) + (counts.stale || 0);
  const problem = (counts.never || 0) + (counts.error || 0) + (counts.unreachable || 0);

  return (
    <div className="flex flex-wrap gap-3 mb-6">
      {[
        { label: "Healthy", count: ok, cls: "bg-emerald-500/10 border border-emerald-500/30 text-emerald-400" },
        { label: "Overdue", count: warning, cls: "bg-amber-500/10 border border-amber-500/30 text-amber-400" },
        { label: "Problems", count: problem, cls: "bg-red-500/10 border border-red-500/30 text-red-400" },
        { label: "SQL Attention", count: sqlAttention, cls: "bg-cyan-500/10 border border-cyan-500/30 text-cyan-300" },
        { label: "Total Sites", count: sites.length, cls: "bg-blue-500/10 border border-blue-500/30 text-blue-300" },
      ].map((p) => (
        <div key={p.label} className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium ${p.cls}`}>
          <span className="text-xl font-bold leading-none">{p.count}</span>
          <span className="text-xs opacity-80">{p.label}</span>
        </div>
      ))}
    </div>
  );
}

export default function HubBackups() {
  const { toast } = useToast();
  const [downloading, setDownloading] = useState(null);
  const [downloadingConfig, setDownloadingConfig] = useState(null);
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [togglingSync, setTogglingSync] = useState(false);
  const [pullingNow, setPullingNow] = useState(false);

  const handlePullNow = useCallback(async () => {
    setPullingNow(true);
    try {
      const res = await fetch("/api/hub/pull-backups-now", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      toast({ title: "Backup pull started", description: "Hub is pulling backups from all sites now. Refresh in a moment." });
      // Refresh status after a short delay to show updated results
      setTimeout(() => refetch(), 8000);
    } catch (err) {
      toast({ title: "Pull failed", description: err.message, variant: "destructive" });
    } finally {
      setPullingNow(false);
    }
  }, [toast, refetch]);

  useEffect(() => {
    fetchBackupSettings().then((d) => setSyncEnabled(d.backup_sync_enabled)).catch(() => {});
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

  const { data: hubBackupData } = useQuery({
    queryKey: ["hub-hub-backup-status"],
    queryFn: fetchHubBackupStatus,
    refetchInterval: 60_000,
  });

  const sites = data?.sites || [];
  const hubBackupMap = Object.fromEntries((hubBackupData?.sites || []).map((s) => [s.site_id, s]));

  const handleDownload = useCallback(async (site) => {
    setDownloading(site.site_id);
    try {
      const proxyRes = await fetch(`/api/hub/proxy-backup?site_id=${encodeURIComponent(site.site_id)}`, { credentials: "include" });
      if (!proxyRes.ok) throw new Error(`HTTP ${proxyRes.status}`);
      const blob = await proxyRes.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cardoso-${site.site_id}-${new Date().toISOString().slice(0, 10)}.db`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Backup downloaded", description: site.site_name });
    } catch (err) {
      toast({ title: "Download failed", description: err.message, variant: "destructive" });
    } finally {
      setDownloading(null);
    }
  }, [toast]);

  const handleDownloadConfig = useCallback(async (site) => {
    setDownloadingConfig(site.site_id);
    try {
      const proxyRes = await fetch(`/api/hub/proxy-config?site_id=${encodeURIComponent(site.site_id)}`, { credentials: "include" });
      if (!proxyRes.ok) throw new Error(`HTTP ${proxyRes.status}`);
      const blob = await proxyRes.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cardoso-config-${site.site_id}-${new Date().toISOString().slice(0, 10)}.env`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: ".env downloaded", description: site.site_name });
    } catch (err) {
      toast({ title: ".env download failed", description: err.message, variant: "destructive" });
    } finally {
      setDownloadingConfig(null);
    }
  }, [toast]);

  return (
    <div className="min-h-screen p-6 bg-background">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-blue-500/15 border border-blue-500/30">
              <HardDrive className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">Site Backups</h1>
              <p className="text-xs text-muted-foreground">Live backup health across all registered sites</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleToggleSync}
              disabled={togglingSync}
              className={`text-xs h-10 ${syncEnabled ? "border-emerald-500/40 text-emerald-300" : "border-red-500/40 text-red-300"}`}
            >
              <Power className="w-3.5 h-3.5 mr-1.5" />
              {syncEnabled ? "Sync On" : "Sync Off"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handlePullNow}
              disabled={pullingNow}
              className="text-xs h-10 border-blue-500/40 text-blue-300"
              title="Pull backups from all sites right now"
            >
              {pullingNow
                ? <><RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />Pulling…</>
                : <><CloudDownload className="w-3.5 h-3.5 mr-1.5" />Pull Now</>}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              className="text-xs h-10 border-border text-muted-foreground"
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        {isLoading && (
          <div className="flex items-center gap-3 text-slate-400 py-12 justify-center">
            <RefreshCw className="w-5 h-5 animate-spin" />
            <span>Polling sites…</span>
          </div>
        )}

        {isError && (
          <div className="rounded-xl p-4 text-red-300 text-sm bg-red-500/10 border border-red-500/30">
            Failed to load backup status. Make sure you are logged in with access to Site Backups.
          </div>
        )}

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
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                  {sites.map((site) => (
                    <SiteCard
                      key={site.site_id}
                      site={site}
                      hubData={hubBackupMap[site.site_id]}
                      onDownload={handleDownload}
                      downloading={downloading}
                      onDownloadConfig={handleDownloadConfig}
                      downloadingConfig={downloadingConfig}
                    />
                  ))}
                </div>
                <p className="text-xs text-slate-600 mt-6 text-center">
                  Auto-refreshes every 60s · File backup health: OK = within 25h, Overdue = 25–48h, Stale = &gt;48h · SQL attention = failed, unavailable, or no successful full DAT backup within 24h
                </p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
