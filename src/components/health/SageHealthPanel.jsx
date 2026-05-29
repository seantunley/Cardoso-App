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
import { apiGet } from "@/components/collections/utils";

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
function Chip({ tone, label, sub, active, onClick }) {
  const dot =
    tone === "critical" ? "bg-red-500" : tone === "warn" ? "bg-amber-500" : tone === "ok" ? "bg-emerald-500" : "bg-slate-400";
  return (
    <button
      type="button"
      onClick={onClick}
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

export default function SageHealthPanel() {
  const [openKey, setOpenKey] = useState(null);
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
              />
            ))}

            {/* Errors (24h) */}
            <Chip
              tone={data?.errors24h > 0 ? "warn" : "ok"}
              label="Errors 24h"
              sub={String(data?.errors24h ?? 0)}
              active={openKey === "errors"}
              onClick={() => toggle("errors")}
            />

            {/* Job failures (24h) */}
            <Chip
              tone={data?.jobFailures24h > 0 ? "warn" : "ok"}
              label="Job failures 24h"
              sub={String(data?.jobFailures24h ?? 0)}
              active={openKey === "jobs"}
              onClick={() => toggle("jobs")}
            />

            {/* Active alerts */}
            <Chip
              tone={data?.criticalAlerts > 0 ? "critical" : data?.activeAlerts > 0 ? "warn" : "ok"}
              label="Active alerts"
              sub={String(data?.activeAlerts ?? 0)}
              active={openKey === "alerts"}
              onClick={() => toggle("alerts")}
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
              {openKey === "alerts" && (
                <p className="text-muted-foreground">
                  {data.activeAlerts > 0
                    ? `${data.activeAlerts} active alert(s)${data.criticalAlerts > 0 ? `, ${data.criticalAlerts} critical` : ""} — see Operations → Alerts.`
                    : "No active alerts."}
                </p>
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
