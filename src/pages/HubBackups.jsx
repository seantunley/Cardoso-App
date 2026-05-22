// src/pages/HubBackups.jsx
// Hub admin page — monitors backup health across all registered sites.

import { useState, useCallback, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Database, RefreshCw, Download, CheckCircle2,
  AlertTriangle, XCircle, Clock, HardDrive, CloudOff, Power, CloudDownload, ShieldCheck, Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/use-toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { reportClientError } from "@/lib/clientLog";

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

const FMT_DATE = new Intl.DateTimeFormat("en-ZA", {
  year: "numeric", month: "short", day: "2-digit",
  hour: "2-digit", minute: "2-digit",
});
function fmtDate(iso) {
  if (!iso) return "—";
  return FMT_DATE.format(new Date(iso));
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

// view: 'app' | 'sql' — controls which backup-type block renders
// inside the per-site card. Default 'app' for back-compat with any
// caller that doesn't pass it. Codex catch (post-merge): the prop
// was previously dropped from this destructure during a merge while
// the conditional `view === 'app'` / `view === 'sql'` JSX further
// down was preserved, so reading `view` at render time threw
// ReferenceError and crashed the entire Hub Backups page before any
// site cards rendered. Same merge-loss class as the SettingsPanel
// compact-state issue fixed in the same commit, and the v62 /
// auditlog / backup.js / SiteCard chain from earlier this week.
function SiteCard({ site, hubData, onDownload, downloading, onDownloadConfig, downloadingConfig, onRestore, view = 'app' }) {
  const meta = STATUS_META[site.status] || STATUS_META.unknown;
  const Icon = meta.icon;
  const lb = site.last_backup;
  const integrityMeta = hubData?.integrity ? INTEGRITY_META[hubData.integrity] : null;
  const sqlHealth = site.sql_backup?.health || { status: "unavailable", last_success_at: null };
  const sqlMeta = SQL_STATUS_META[sqlHealth.status] || SQL_STATUS_META.unavailable;
  const SqlIcon = sqlMeta.icon;

  return (
    <div className="rounded-2xl border border-border/70 bg-card/95 p-5 shadow-sm shadow-black/5">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl border border-accent/30 bg-accent/10">
              <Database className="h-4 w-4 text-accent" />
            </div>
            <div className="min-w-0">
              <div className="text-base font-semibold text-foreground truncate">{site.site_name || site.site_id}</div>
              <div className="text-xs text-slate-500 truncate">{site.url || "No URL"}</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 sm:justify-end">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold cursor-default ${meta.cls}`}>
                  <Icon className="h-3.5 w-3.5" />
                  App {meta.label}
                </span>
              </TooltipTrigger>
              <TooltipContent>{
                site.status === "ok" ? "App backup is current and healthy" :
                site.status === "warning" ? "App backup is overdue — check if scheduled task is running" :
                site.status === "stale" ? "App backup is stale — may not have run recently" :
                site.status === "never" ? "No app backup has been recorded for this site" :
                site.status === "error" ? "App backup encountered an error" :
                site.status === "unreachable" ? "Site is offline or unreachable" :
                "App backup status unknown"
              }</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold cursor-default ${sqlMeta.cls}`}>
                  <SqlIcon className="h-3.5 w-3.5" />
                  {sqlMeta.label}
                </span>
              </TooltipTrigger>
              <TooltipContent>{
                sqlHealth.status === "ok" ? "SQL backup is current" :
                sqlHealth.status === "stale" ? "SQL backup is overdue" :
                sqlHealth.status === "failed" ? "SQL backup job failed — check SQL Server agent" :
                "SQL backup status unavailable for this site"
              }</TooltipContent>
            </Tooltip>
            {integrityMeta && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold cursor-default ${integrityMeta.cls}`}>
                    Hub {integrityMeta.label}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{integrityMeta.label === "OK" ? "Hub backup copy is intact" : "Hub backup copy may be corrupt — re-pull recommended"}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {site.error ? (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-xs text-red-400">
            {site.error}
          </div>
        ) : (
          // Single-column layout post-tabs: only one of the two backup
          // blocks renders per site card. Conditional below picks the
          // App or SQL block based on the `view` prop.
          <div className="grid gap-4">
            {view === 'app' && (
            <div className={`rounded-xl border bg-background/80 p-4 ${meta.cls}`}>
              {/* ── App Backup header ── */}
              <div className="mb-4 flex items-center justify-between gap-3 pb-3 border-b border-border/40">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 border border-accent/25">
                    <Database className="h-3.5 w-3.5 text-accent" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-foreground">App Backup</div>
                    <div className="text-[11px] text-slate-500">
                      {lb ? fmtRelative(lb.mtime) : "Never"}
                      {lb?.mtime && <> &middot; {fmtDate(lb.mtime)}</>}
                    </div>
                  </div>
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
            )}
            {view === 'sql' && (
            <div className={`rounded-xl border bg-background/80 p-4 ${sqlMeta.cls}`}>
              {/* ── SQL Backup header ── */}
              <div className="mb-4 flex items-center justify-between gap-3 pb-3 border-b border-border/40">
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-violet-500/15 border border-violet-500/25">
                    <ShieldCheck className="h-3.5 w-3.5 text-violet-400" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-foreground">SQL Backup</div>
                    <div className="text-[11px] text-slate-500">
                      {sqlHealth.last_success_at
                        ? <>{fmtRelative(sqlHealth.last_success_at)} &middot; {fmtDate(sqlHealth.last_success_at)}</>
                        : "Unavailable"}
                    </div>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium ${sqlMeta.cls}`}>
                    <SqlIcon className="h-3 w-3" />
                    {sqlMeta.label}
                  </span>
                  {site.sql_backup?.lastJob?.size != null && (
                    <span className="text-[11px] text-slate-500">
                      Last job: {fmtBytes(site.sql_backup.lastJob.size)}
                      {site.sql_backup.lastJob.archiveSize != null && site.sql_backup.lastJob.archiveSize !== site.sql_backup.lastJob.size
                        ? ` · compressed ${fmtBytes(site.sql_backup.lastJob.archiveSize)}`
                        : ""}
                    </span>
                  )}
                </div>
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
            )}
            {/* Restore lives outside the view-conditional blocks because
                a restore replaces the live DB on the site — it's a
                site-level action, not an App-tab-only one. Originally
                rendered inside the App block; Codex flagged that the
                workflow vanished when an operator switched to the SQL
                tab, which contradicts the always-visible behaviour
                the action had pre-tabs. Pull DB / Pull .env stay in
                the App block because those are App-backup-specific. */}
            <div className="flex justify-end border-t border-border/40 pt-3">
              <Button
                size="sm"
                variant="outline"
                disabled={!site.url}
                onClick={() => onRestore(site)}
                className="h-7 border-rose-500/40 px-3 text-xs text-rose-400 hover:text-rose-300 hover:border-rose-500/60"
                title="Push a snapshot from the hub back to this site"
              >
                <Upload className="mr-1.5 h-3 w-3" />
                Restore…
              </Button>
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
        { label: "Total Sites", count: sites.length, cls: "bg-accent/10 border border-accent/30 text-accent" },
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

  // Restore modal state. Open when operator clicks "Restore…" on a
  // site card. Loads snapshots-list for that site, lets operator pick
  // one + password, posts to /api/hub/sites/:id/restore.
  const [restoreSite, setRestoreSite] = useState(null);
  const [restoreSnapshots, setRestoreSnapshots] = useState(null);
  const [restoreLoadingList, setRestoreLoadingList] = useState(false);
  const [restoreSelected, setRestoreSelected] = useState(null);
  const [restoreIncludePreviews, setRestoreIncludePreviews] = useState(true);
  const [restorePassword, setRestorePassword] = useState('');
  const [restorePasswordError, setRestorePasswordError] = useState('');
  const [restoring, setRestoring] = useState(false);

  const openRestoreModal = useCallback((site) => {
    setRestoreSite(site);
    setRestoreSelected(null);
    setRestoreSnapshots(null);
    setRestorePassword('');
    setRestorePasswordError('');
    setRestoreIncludePreviews(true);
    setRestoreLoadingList(true);
    fetch(`/api/hub/sites/${encodeURIComponent(site.site_id)}/snapshots`, { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        setRestoreSnapshots(d.snapshots || []);
      })
      .catch((err) => {
        toast({ title: 'Failed to load snapshots', description: err.message, variant: 'destructive' });
        setRestoreSnapshots([]);
      })
      .finally(() => setRestoreLoadingList(false));
  }, [toast]);

  const closeRestoreModal = useCallback(() => {
    if (restoring) return; // can't cancel mid-restore
    setRestoreSite(null);
    setRestoreSelected(null);
    setRestoreSnapshots(null);
    setRestorePassword('');
    setRestorePasswordError('');
  }, [restoring]);

  const handleRestoreSubmit = useCallback(async () => {
    if (!restoreSite || !restoreSelected) return;
    if (!restorePassword) { setRestorePasswordError('Password is required'); return; }
    setRestorePasswordError('');
    setRestoring(true);
    try {
      const r = await fetch(`/api/hub/sites/${encodeURIComponent(restoreSite.site_id)}/restore`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snapshot_filename: restoreSelected.filename,
          include_previews: restoreIncludePreviews && !!restoreSelected.previews_filename,
          password: restorePassword,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 401) { setRestorePasswordError(d.error || 'Incorrect password'); return; }
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      toast({
        title: 'Restore initiated',
        description: `${restoreSite.site_name || restoreSite.site_id}: site is stopping, swapping files, and restarting. Watch the tile.`,
      });
      setRestoreSite(null);
      setRestoreSelected(null);
      setRestorePassword('');
    } catch (err) {
      toast({ title: 'Restore failed', description: err.message, variant: 'destructive' });
    } finally {
      setRestoring(false);
    }
  }, [restoreSite, restoreSelected, restoreIncludePreviews, restorePassword, toast]);

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
    fetchBackupSettings()
      .then((d) => setSyncEnabled(d.backup_sync_enabled))
      .catch((err) => { toast({ title: "Couldn't load backup settings", description: err.message, variant: "destructive" }); reportClientError("HubBackups.settings", err); });
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

  const sites = data?.sites || [];
  const hubBackupMap = useMemo(
    () => Object.fromEntries((hubBackupData?.sites || []).map((s) => [s.site_id, s])),
    [hubBackupData?.sites],
  );

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
      setTimeout(() => URL.revokeObjectURL(url), 0);
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
      setTimeout(() => URL.revokeObjectURL(url), 0);
      toast({ title: ".env downloaded", description: site.site_name });
    } catch (err) {
      toast({ title: ".env download failed", description: err.message, variant: "destructive" });
    } finally {
      setDownloadingConfig(null);
    }
  }, [toast]);

  return (
    <div className="min-h-screen p-6 bg-background">
      <div className="mx-auto max-w-[1600px]">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-8 pb-5 border-b border-border">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3 flex items-center gap-2">
              <HardDrive className="w-3 h-3 text-accent" strokeWidth={1.5} />
              § Backups
            </div>
            <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
              Safe, <em className="text-phosphor">every night</em>.
            </h1>
            <p className="text-sm text-muted-foreground mt-3">Live backup health across all registered sites</p>
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
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePullNow}
                  disabled={pullingNow}
                  className="text-xs h-10 border-accent/40 text-accent"
                >
                  {pullingNow
                    ? <><RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />Pulling…</>
                    : <><CloudDownload className="w-3.5 h-3.5 mr-1.5" />Pull Now</>}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Trigger an immediate backup pull from all sites</TooltipContent>
            </Tooltip>
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
                {/* App / SQL tabs split per-site detail blocks. The five
                    summary tiles above already cover both backup types so
                    they render once, outside the tabs. SiteCard branches
                    on the `view` prop and only renders the matching detail
                    block — pre-tabs the layout stacked both blocks side by
                    side per site, which scaled badly past ~3 sites.
                    Originally landed in PR #250; the parent-side <Tabs>
                    UI was lost in the subsequent merge of PR #251 (the
                    inner SiteCard branching survived but had no toggle).
                    Same merge-loss class as #221, #223, #228, #235, #253. */}
                <Tabs defaultValue="app" className="w-full">
                  <TabsList className="grid w-full max-w-md grid-cols-2 mb-4">
                    <TabsTrigger value="app">App Backup</TabsTrigger>
                    <TabsTrigger value="sql">SQL Backup</TabsTrigger>
                  </TabsList>
                  <TabsContent value="app" className="mt-0">
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
                          onRestore={openRestoreModal}
                          view="app"
                        />
                      ))}
                    </div>
                  </TabsContent>
                  <TabsContent value="sql" className="mt-0">
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
                          onRestore={openRestoreModal}
                          view="sql"
                        />
                      ))}
                    </div>
                  </TabsContent>
                </Tabs>
                <p className="text-xs text-slate-600 mt-6 text-center">
                  Auto-refreshes every 60s · File backup health: OK = within 25h, Overdue = 25–48h, Stale = &gt;48h · SQL attention = failed, unavailable, or no successful full DAT backup within 24h
                </p>
              </>
            )}
          </>
        )}
      </div>

      {/* Restore modal — opens when operator clicks Restore on a site card.
          Lists snapshots the hub has for that site, lets operator pick one,
          confirm with password, then pushes to the site. */}
      <Dialog open={!!restoreSite} onOpenChange={(open) => { if (!open) closeRestoreModal(); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Restore {restoreSite?.site_name || restoreSite?.site_id}?
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/5 p-3 text-rose-200 text-xs space-y-1">
              <div className="font-medium">⚠ This replaces the live database on the site.</div>
              <ul className="list-disc pl-5 space-y-0.5">
                <li>Site service stops, file swaps, integrity check, restarts</li>
                <li>Current cardoso.db saved as <code className="bg-black/30 px-1 py-0.5 rounded text-[10px]">cardoso.db.before-restore-&lt;ts&gt;</code> — manual rollback possible</li>
                <li>If integrity check fails, restore auto-rolls back</li>
                <li>Site is offline for ~30s during the swap</li>
              </ul>
            </div>

            <div>
              <div className="text-xs font-medium text-foreground mb-2">Pick a snapshot to restore from:</div>
              {restoreLoadingList ? (
                <div className="text-xs text-muted-foreground">Loading snapshots from the hub…</div>
              ) : !restoreSnapshots || restoreSnapshots.length === 0 ? (
                <div className="text-xs text-muted-foreground rounded border border-dashed border-border p-3">
                  No snapshots available for this site on the hub yet.
                </div>
              ) : (
                <div className="max-h-64 overflow-y-auto rounded border border-border">
                  {restoreSnapshots.map((snap) => {
                    const isSel = restoreSelected?.filename === snap.filename;
                    const sizeMb = snap.size_bytes != null ? (snap.size_bytes / 1024 / 1024).toFixed(1) : '?';
                    const previewSize = snap.previews_size_bytes != null ? `+ previews ${(snap.previews_size_bytes / 1024 / 1024).toFixed(1)} MB` : 'no previews';
                    const integrityCls = snap.integrity === 'ok' ? 'text-emerald-400' : snap.integrity ? 'text-rose-400' : 'text-muted-foreground';
                    return (
                      <button
                        key={snap.filename}
                        type="button"
                        onClick={() => setRestoreSelected(snap)}
                        className={`w-full text-left px-3 py-2 border-b border-border last:border-0 hover:bg-muted/30 ${isSel ? 'bg-accent/10 border-l-2 border-l-accent' : ''}`}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-mono text-[11px] text-foreground truncate">{snap.filename}</span>
                          <span className={`text-[10px] font-mono ${integrityCls}`}>{snap.integrity || 'unchecked'}</span>
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {snap.mtime ? new Date(snap.mtime).toLocaleString() : 'unknown date'} · {sizeMb} MB · {previewSize}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {restoreSelected?.previews_filename && (
              <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={restoreIncludePreviews}
                  onChange={(e) => setRestoreIncludePreviews(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 rounded border-border accent-foreground cursor-pointer"
                  disabled={restoring}
                />
                <span>
                  Also restore BAT preview JPEGs from this snapshot
                  ({(restoreSelected.previews_size_bytes / 1024 / 1024).toFixed(1)} MB).
                  Without this, the site keeps its current uploads/bat-previews/.
                </span>
              </label>
            )}

            {restoreSelected && !restoreSelected.previews_filename && (
              <div className="text-[11px] text-amber-400/80">
                ⓘ This snapshot doesn't have a matching previews zip on the hub. Only the database will be restored.
              </div>
            )}

            <div className="space-y-1.5 pt-2 border-t border-border">
              <label htmlFor="restore-password" className="text-xs font-medium text-foreground">Confirm your password</label>
              <input
                id="restore-password"
                type="password"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder="Enter your password"
                value={restorePassword}
                onChange={(e) => { setRestorePassword(e.target.value); setRestorePasswordError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && restorePassword && restoreSelected) handleRestoreSubmit(); }}
                disabled={restoring}
                autoComplete="current-password"
              />
              {restorePasswordError && <p className="text-xs text-rose-400">{restorePasswordError}</p>}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={closeRestoreModal} disabled={restoring}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={handleRestoreSubmit}
                disabled={restoring || !restoreSelected || !restorePassword}
              >
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                {restoring ? 'Pushing restore…' : 'Yes, restore this site'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
