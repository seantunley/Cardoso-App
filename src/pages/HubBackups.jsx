// src/pages/HubBackups.jsx
// Hub admin page — backup health across all registered sites. This is now a
// thin CONTAINER: it fetches the three data sources, owns the mutation
// handlers + restore dialog, and hands a normalized per-site model to the pure
// <BackupsFleet> view. Append ?demo=1 to preview the redesign with fixture data
// covering every state (see components/hub/backups/backupDemo.js).

import { useState, useCallback, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/components/ui/use-toast";
import { reportClientError } from "@/lib/clientLog";
import BackupsFleet from "@/components/hub/backups/BackupsFleet.jsx";
import RestoreDialog from "@/components/hub/backups/RestoreDialog.jsx";
import { normalizeSites } from "@/components/hub/backups/backupModel.js";
import { buildDemoData } from "@/components/hub/backups/backupDemo.js";

async function getJson(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default function HubBackups() {
  const { toast } = useToast();
  const demo = useMemo(() => new URLSearchParams(window.location.search).get("demo") === "1", []);

  const [downloading, setDownloading] = useState(null);
  const [downloadingConfig, setDownloadingConfig] = useState(null);
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [togglingSync, setTogglingSync] = useState(false);
  const [pullingNow, setPullingNow] = useState(false);
  const [restoreSite, setRestoreSite] = useState(null);
  const [restoreSource, setRestoreSource] = useState("hub");

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["hub-backup-status"], queryFn: () => getJson("/api/hub/backup-status"),
    refetchInterval: 60_000, enabled: !demo,
  });
  const { data: hubBackupData } = useQuery({
    queryKey: ["hub-hub-backup-status"], queryFn: () => getJson("/api/hub/hub-backup-status"),
    refetchInterval: 60_000, enabled: !demo,
  });
  const { data: kopiaData } = useQuery({
    queryKey: ["hub-kopia-status"], queryFn: () => getJson("/api/hub/kopia-status"),
    refetchInterval: 60_000, enabled: !demo,
  });

  useEffect(() => {
    if (demo) return;
    getJson("/api/hub/backup-settings")
      .then((d) => setSyncEnabled(d.backup_sync_enabled))
      .catch((err) => { toast({ title: "Couldn't load backup settings", description: err.message, variant: "destructive" }); reportClientError("HubBackups.settings", err); });
  }, [demo, toast]);

  // Assemble the normalized model — from demo fixtures or the live queries.
  const { models, kopiaEnabled, kopiaError, loading } = useMemo(() => {
    if (demo) {
      const d = buildDemoData();
      const hubMap = d.hubBackupMap;
      const kMap = d.kopiaMap;
      return {
        models: normalizeSites({ backupStatus: d.backupStatus, hubBackupMap: hubMap, kopiaMap: kMap, kopiaEnabled: true }),
        kopiaEnabled: true, kopiaError: null, loading: false,
      };
    }
    const hubMap = Object.fromEntries((hubBackupData?.sites || []).map((s) => [s.site_id, s]));
    const kMap = Object.fromEntries((kopiaData?.sites || []).filter((s) => s.site_id).map((s) => [s.site_id, s]));
    return {
      models: normalizeSites({ backupStatus: data, hubBackupMap: hubMap, kopiaMap: kMap, kopiaEnabled: !!kopiaData?.enabled }),
      kopiaEnabled: !!kopiaData?.enabled,
      kopiaError: kopiaData?.enabled && kopiaData?.error ? kopiaData.error : null,
      loading: isLoading,
    };
  }, [demo, data, hubBackupData, kopiaData, isLoading]);

  const openRestore = useCallback((site, source = "hub") => { setRestoreSource(source); setRestoreSite(site); }, []);
  const closeRestore = useCallback(() => setRestoreSite(null), []);

  const handleToggleSync = useCallback(async () => {
    if (demo) { setSyncEnabled((v) => !v); return; }
    setTogglingSync(true);
    try {
      const res = await fetch("/api/hub/backup-settings", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ backup_sync_enabled: !syncEnabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      setSyncEnabled(d.backup_sync_enabled);
      toast({ title: d.backup_sync_enabled ? "Backup sync enabled" : "Backup sync disabled" });
    } catch (err) {
      toast({ title: "Failed to update setting", description: err.message, variant: "destructive" });
    } finally { setTogglingSync(false); }
  }, [demo, syncEnabled, toast]);

  const handlePullNow = useCallback(async () => {
    if (demo) { toast({ title: "Pull started (demo)" }); return; }
    setPullingNow(true);
    try {
      const res = await fetch("/api/hub/pull-backups-now", { method: "POST", credentials: "include" });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
      toast({ title: "Backup pull started", description: "Hub is pulling from all sites now." });
      setTimeout(() => refetch(), 8000);
    } catch (err) {
      toast({ title: "Pull failed", description: err.message, variant: "destructive" });
    } finally { setPullingNow(false); }
  }, [demo, toast, refetch]);

  const downloadProxy = useCallback(async (site, kind) => {
    const setBusy = kind === "config" ? setDownloadingConfig : setDownloading;
    setBusy(site.site_id);
    try {
      if (demo) { await new Promise((r) => setTimeout(r, 500)); toast({ title: `${kind === "config" ? ".env" : "Backup"} downloaded (demo)`, description: site.site_name }); return; }
      const path = kind === "config" ? "proxy-config" : "proxy-backup";
      const res = await fetch(`/api/hub/${path}?site_id=${encodeURIComponent(site.site_id)}`, { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cardoso-${kind === "config" ? "config-" : ""}${site.site_id}-${new Date().toISOString().slice(0, 10)}.${kind === "config" ? "env" : "db"}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      toast({ title: `${kind === "config" ? ".env" : "Backup"} downloaded`, description: site.site_name });
    } catch (err) {
      toast({ title: "Download failed", description: err.message, variant: "destructive" });
    } finally { setBusy(null); }
  }, [demo, toast]);

  return (
    <>
      <BackupsFleet
        models={models}
        kopiaEnabled={kopiaEnabled}
        loading={loading}
        isError={!demo && isError}
        kopiaError={kopiaError}
        demo={demo}
        syncEnabled={syncEnabled}
        onToggleSync={handleToggleSync}
        togglingSync={togglingSync}
        onPullNow={handlePullNow}
        pullingNow={pullingNow}
        onRefresh={() => (demo ? null : refetch())}
        refreshing={!demo && isFetching}
        onPullDb={(site) => downloadProxy(site, "db")}
        onPullConfig={(site) => downloadProxy(site, "config")}
        downloading={downloading}
        downloadingConfig={downloadingConfig}
        onRestore={openRestore}
      />
      {restoreSite && (
        <RestoreDialog site={restoreSite} source={restoreSource} demo={demo} onClose={closeRestore} />
      )}
    </>
  );
}
