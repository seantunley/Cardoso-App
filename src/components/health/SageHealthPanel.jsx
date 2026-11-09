// SageHealthPanel — a compact "is the data current and healthy?" strip.
//
// Reused on the Reporting dashboard and the Operations page. It reads the
// consolidated GET /api/system/sage-health snapshot (which composes the Sage
// connectivity probe, per-source sync freshness, recent errors, job failures
// and active alerts) and renders one colour-coded chip per signal with an
// overall status badge. Clicking a chip expands its detail.
//
// Freshness for sync sources is rendered from the server-computed `age_hours`
// (calculated against now_local() in SQLite) rather than the raw timestamp —
// the stored timestamps are local time, so client-side UTC parsing would skew
// them by the UTC+2 offset.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, XCircle, RefreshCw } from "lucide-react";
import { apiGet, apiSend } from "@/components/collections/utils";
import { useAuth } from "@/lib/AuthContext";

const STATUS_META = {
  ok: { label: "Healthy", dot: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400", Icon: CheckCircle2 },
  warn: { label: "Attention", dot: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", Icon: AlertTriangle },
  critical: { label: "Critical", dot: "bg-red-500", text: "text-red-600 dark:text-red-400", Icon: XCircle },
  loading: { label: "Loading…", dot: "bg-slate-400", text: "text-muted-foreground", Icon: RefreshCw },
  unknown: { label: "Unavailable", dot: "bg-slate-400", text: "text-muted-foreground", Icon: AlertTriangle },
};

function humanizeHours(hours) {
  if (hours == null) return "never";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m ago`;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// One chip = one signal. tone drives the dot colour.
function Chip({ tone, label, sub, active, onClick, title }) {
  const dot =
    tone === "critical" ? "bg-red-500" : tone === "warn" ? "bg-amber-500" : tone === "ok" ? "bg-emerald-500" : "bg-slate-400";
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-left text-sm transition-colors ${
        active ? "border-primary bg-accent" : "border-border bg-background hover:bg-accent/50"
      }`}
    >
      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />
      <span className="font-medium text-foreground">{label}</span>
      {sub ? <span className="text-muted-foreground">{sub}</span> : null}
    </button>
  );
}

// Active alerts, most serious first, each with Acknowledge (admin). An alert
// whose condition still holds is raised again by the next rule pass (within a
// minute) — acknowledging hides it only once the cause is fixed.
function AlertList({ alerts, total, onChanged, canAcknowledge }) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  if (total === 0) return <p className="text-muted-foreground">No active alerts.</p>;
  // Non-admins get counts only (the server withholds alert text from them).
  if (!alerts) return <p className="text-muted-foreground">{total} active alert{total === 1 ? "" : "s"} — an administrator can see the details here.</p>;
  const acknowledge = async (id) => {
    setBusyId(id);
    setError(null);
    try {
      await apiSend(`/api/system/alerts/${id}/acknowledge`, "POST");
      onChanged();
    } catch (e) {
      setError(`Couldn't acknowledge the alert: ${e.message}`);
    } finally {
      setBusyId(null);
    }
  };
  return (
    <div className="space-y-2">
      {alerts.map((a) => (
        <div key={a.id} className="flex items-start gap-2">
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${a.severity === "critical" ? "bg-red-500" : "bg-amber-500"}`} />
          <p className="flex-1 text-foreground">
            {a.message}
            <span className="text-muted-foreground"> · raised {a.fired_at ? new Date(a.fired_at).toLocaleString("en-ZA") : "—"}</span>
          </p>
          {canAcknowledge && (
            <button
              type="button"
              onClick={() => acknowledge(a.id)}
              disabled={busyId === a.id}
              className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
            >
              {busyId === a.id ? "…" : "Acknowledge"}
            </button>
          )}
        </div>
      ))}
      {total > alerts.length && <p className="text-muted-foreground">…and {total - alerts.length} more.</p>}
      {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

export default function SageHealthPanel() {
  const [openKey, setOpenKey] = useState(null);
  // Acknowledging is admin-only on the server; only offer it to admins.
  const isAdmin = useAuth()?.user?.role === "admin";
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["sage-health"],
    queryFn: () => apiGet("/api/system/sage-health"),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const statusKey = error ? "unknown" : isLoading ? "loading" : data?.status || "ok";
  const meta = STATUS_META[statusKey] || STATUS_META.ok;
  const toggle = (key) => setOpenKey((k) => (k === key ? null : key));

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <meta.Icon className={`h-5 w-5 ${meta.text}`} />
          <h2 className="text-base font-semibold text-foreground">Sage health</h2>
          <span className={`text-sm font-medium ${meta.text}`}>{meta.label}</span>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
          title="Refresh"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400">Couldn't load health: {error.message}</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {/* Sage connectivity */}
            <Chip
              tone={data?.sage?.ok === false ? (data.sage.downForMinutes > 5 ? "critical" : "warn") : isLoading ? "loading" : "ok"}
              label="Sage connection"
              sub={
                isLoading
                  ? ""
                  : data?.sage?.ok === false
                    ? `down ${data.sage.downForMinutes}m`
                    : "connected"
              }
              active={openKey === "sage"}
              onClick={() => toggle("sage")}
              title="Live connectivity to the Sage SQL server. Click for the last error and per-connection status."
            />

            {/* Per-source sync freshness */}
            {(data?.sources || []).map((s) => (
              <Chip
                key={s.key}
                tone={s.stale ? "warn" : "ok"}
                label={s.label}
                sub={humanizeHours(s.age_hours)}
                active={openKey === `src:${s.key}`}
                onClick={() => toggle(`src:${s.key}`)}
                title={`When ${s.label.toLowerCase()} last synced from Sage. Amber if it hasn't synced in over 24 hours.`}
              />
            ))}

            {/* Errors (24h) */}
            <Chip
              tone={data?.errors24h > 0 ? "warn" : "ok"}
              label="Errors 24h"
              sub={String(data?.errors24h ?? 0)}
              active={openKey === "errors"}
              onClick={() => toggle("errors")}
              title="Errors logged in the last 24 hours. Click to see the most recent ones."
            />

            {/* Job failures (24h) */}
            <Chip
              tone={data?.jobFailures24h > 0 ? "warn" : "ok"}
              label="Job failures 24h"
              sub={String(data?.jobFailures24h ?? 0)}
              active={openKey === "jobs"}
              onClick={() => toggle("jobs")}
              title="Background job failures in the last 24 hours (syncs, backups, archives). Click for detail."
            />

            {/* Backup health — read live from the backup files on disk, so a
                frozen scheduler can't mask a missing/stale backup. Only present
                on site installs (the hub omits it). */}
            {data?.backup ? (
              <Chip
                tone={data.backup.status === "critical" ? "critical" : data.backup.status === "warn" ? "warn" : "ok"}
                label="Backup"
                sub={data.backup.age_hours != null ? humanizeHours(data.backup.age_hours) : "none"}
                active={openKey === "backup"}
                onClick={() => toggle("backup")}
                title="Most recent local database backup, checked live on disk (not via the scheduler). Red if missing, stale, empty, or its integrity verification failed."
              />
            ) : null}

            {/* Active alerts */}
            <Chip
              tone={data?.criticalAlerts > 0 ? "critical" : data?.activeAlerts > 0 ? "warn" : "ok"}
              label="Active alerts"
              sub={String(data?.activeAlerts ?? 0)}
              active={openKey === "alerts"}
              onClick={() => toggle("alerts")}
              title="Unresolved system alerts. Critical alerts turn this red."
            />
          </div>

          {/* Detail expansion */}
          {openKey && data ? (
            <div className="mt-3 rounded-lg border border-border bg-background p-3 text-sm">
              {openKey === "sage" && (
                <div className="space-y-1 text-muted-foreground">
                  <p>Status: <span className="text-foreground">{data.sage?.ok === false ? "down" : data.sage?.ok ? "connected" : "unknown"}</span></p>
                  {data.sage?.consecutiveFailures > 0 && <p>Consecutive failures: {data.sage.consecutiveFailures}</p>}
                  {data.sage?.lastError && <p className="text-red-600 dark:text-red-400">Last error: {data.sage.lastError}</p>}
                  {Array.isArray(data.connections) && data.connections.length > 0 && (
                    <div className="pt-1">
                      {data.connections.map((c) => (
                        <p key={c.name}>
                          {c.name}: <span className="text-foreground">{c.status || "—"}</span>
                          {c.last_error ? <span className="text-red-600 dark:text-red-400"> — {c.last_error}</span> : null}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {openKey?.startsWith("src:") &&
                (() => {
                  const s = (data.sources || []).find((x) => `src:${x.key}` === openKey);
                  if (!s) return null;
                  return (
                    <p className="text-muted-foreground">
                      {s.label} last synced {humanizeHours(s.age_hours)}
                      {s.stale ? <span className="text-amber-600 dark:text-amber-400"> — stale (over 24h)</span> : null}
                    </p>
                  );
                })()}
              {openKey === "errors" && (
                <div className="space-y-1 text-muted-foreground">
                  {(data.recentErrors || []).length === 0 ? (
                    <p>No errors in the last 24 hours.</p>
                  ) : (
                    data.recentErrors.map((e, i) => (
                      <p key={i}>
                        <span className="text-foreground">{e.source}</span>: {e.message}
                      </p>
                    ))
                  )}
                </div>
              )}
              {openKey === "jobs" && (
                <p className="text-muted-foreground">
                  {data.jobFailures24h > 0
                    ? `${data.jobFailures24h} background job failure(s) in the last 24 hours — see Operations → Job Runs.`
                    : "No background job failures in the last 24 hours."}
                </p>
              )}
              {openKey === "backup" && data.backup && (
                <div className="space-y-1 text-muted-foreground">
                  <p
                    className={
                      data.backup.status === "critical"
                        ? "text-red-600 dark:text-red-400"
                        : data.backup.status === "warn"
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-foreground"
                    }
                  >
                    {data.backup.message}
                  </p>
                  {data.backup.last_backup_at && (
                    <p>
                      Latest: <span className="text-foreground">{data.backup.file}</span> ({humanizeHours(data.backup.age_hours)})
                    </p>
                  )}
                  {data.backup.total_backups > 0 && (
                    <p>
                      {data.backup.total_backups} backup{data.backup.total_backups === 1 ? "" : "s"} on disk
                      {typeof data.backup.total_bytes === "number"
                        ? ` · ${(data.backup.total_bytes / 1e9).toFixed(2)} GB total`
                        : ""}
                    </p>
                  )}
                  {data.backup.verify?.status && (
                    <p>
                      Last verification: <span className="text-foreground">{data.backup.verify.status}</span>
                      {data.backup.verify.age_hours != null ? ` (${humanizeHours(data.backup.verify.age_hours)})` : ""}
                      {data.backup.verify.status === "failed" && data.backup.verify.error ? (
                        <span className="text-red-600 dark:text-red-400"> — {data.backup.verify.error}</span>
                      ) : null}
                    </p>
                  )}
                </div>
              )}
              {openKey === "alerts" && (
                <AlertList alerts={data.alerts} total={data.activeAlerts || 0} onChanged={refetch} canAcknowledge={isAdmin} />
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
