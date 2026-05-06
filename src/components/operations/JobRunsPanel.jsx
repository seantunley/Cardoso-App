// Job runs panel — read-only view of every scheduled background job's
// recent history. Backed by GET /api/system/jobs, which returns the
// latest run per job + failure count in a configurable window.
//
// Read-only by intent. The original 30/60/90 plan called for "run now /
// retry / pause" buttons but the agreed-on MVP shape is glance-and-see
// only. Action buttons land in follow-up PRs as we discover which ones
// the operator actually reaches for.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  RefreshCw, CheckCircle2, AlertCircle, Clock, Activity,
} from "lucide-react";

// Friendly labels + descriptions per job name. The job_runs table stores
// short technical identifiers — the dashboard renders these so an operator
// reads "Daily backup verify (03:30)" instead of "backup-verify".
const JOB_LABELS = {
  'scheduled-sync':      { label: 'Connection sync',          schedule: 'Every 30 min, 06:00–17:00 weekdays' },
  'sage-cache-refresh':  { label: 'Sage week-totals cache',   schedule: '07:00 / 10:00 / 13:00 / 16:00 weekdays' },
  'local-backup':        { label: 'Local DB backup',          schedule: 'Daily 02:00' },
  'backup-verify':       { label: 'Backup verification',      schedule: 'Daily 03:30' },
  'credit-logic-sync':   { label: 'Credit logic sync (hub)',  schedule: 'Every 10 min' },
  'auto-sync-cycle':     { label: 'Per-connection auto-sync', schedule: 'Every 5 min' },
  'hub-sync':            { label: 'Hub: pull all sites',      schedule: 'Every 5 min (hub mode)' },
  'hub-backup-pull':     { label: 'Hub: pull site backups',   schedule: 'Daily 03:00 (hub mode)' },
  'hub-ping':            { label: 'Hub: site reachability',   schedule: 'Every 15 min (hub mode)' },
};

function StatusBadge({ status, failuresInWindow }) {
  if (status === 'succeeded') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono bg-emerald-900/20 text-emerald-400 border border-emerald-700/50">
        <CheckCircle2 className="w-3 h-3" /> succeeded
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono bg-rose-900/20 text-rose-400 border border-rose-700/50">
        <AlertCircle className="w-3 h-3" /> failed
        {failuresInWindow > 1 && <span className="ml-1 opacity-70">({failuresInWindow}× in 24h)</span>}
      </span>
    );
  }
  if (status === 'started') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono bg-amber-900/20 text-amber-400 border border-amber-700/50">
        <Clock className="w-3 h-3 animate-pulse" /> running
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono bg-muted/40 text-muted-foreground border border-border">
      —
    </span>
  );
}

// Parse the ISO timestamp the server returns. Falls back to raw string if
// it doesn't parse, so a malformed value doesn't blank the cell.
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-ZA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

// "2m 18s" / "458ms" — short human-friendly duration.
function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
}

// "5 min ago" — relative-time string for last_started_at, easier to scan
// than a full timestamp at a glance.
function fmtAgo(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  return `${days}d ago`;
}

export default function JobRunsPanel() {
  const [tick, setTick] = useState(0);

  // Refresh "min ago" labels every 30 sec without re-fetching from server.
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ["system-jobs"],
    queryFn: async () => {
      const r = await fetch("/api/system/jobs", { credentials: "include" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed to load");
      return d;
    },
    // 60s server-side aligns with the cheapest visible cadence — most jobs
    // run on the order of minutes or hours.
    refetchInterval: 60_000,
  });

  const jobs = data?.jobs || [];

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Background job runs</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Latest run of every scheduled job. Read-only — refreshes every 60 seconds.
          </p>
        </div>
        <Button onClick={() => refetch()} disabled={isRefetching} variant="outline" size="sm" className="ml-auto border-border text-muted-foreground hover:text-foreground">
          <RefreshCw className={`w-4 h-4 mr-2 ${isRefetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-700 bg-rose-900/20 p-4 text-sm text-rose-300">
          {error.message || "Failed to load job runs"}
        </div>
      )}

      {isLoading ? (
        <div className="h-20 animate-pulse bg-muted rounded-xl" />
      ) : jobs.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground text-sm border border-dashed border-border rounded-xl">
          <Activity className="w-6 h-6 text-muted-foreground mx-auto mb-2" />
          No job runs recorded yet. Jobs land here as the scheduler ticks
          (sync runs every 5 min; backup runs nightly at 02:00).
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase">Job</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase w-32">Status</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase w-44">Last run</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase w-24">Duration</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase">Last error</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const meta = JOB_LABELS[j.name] || { label: j.name, schedule: '' };
                // Use `tick` to defeat memoisation on the relative-time label.
                void tick;
                const ago = fmtAgo(j.last_started_at);
                return (
                  <tr key={j.name} className="border-b border-border last:border-0 hover:bg-muted/20">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-foreground">{meta.label}</div>
                      {meta.schedule && (
                        <div className="text-[10px] text-muted-foreground font-mono mt-0.5">{meta.schedule}</div>
                      )}
                      <div className="text-[10px] text-muted-foreground/60 font-mono mt-0.5">{j.name}</div>
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={j.last_status} failuresInWindow={j.failures_in_window} />
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">
                      <div>{fmtTime(j.last_started_at)}</div>
                      {ago && <div className="text-[10px] text-muted-foreground/70">{ago}</div>}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground font-mono">{fmtDuration(j.last_duration_ms)}</td>
                    <td className="px-4 py-2.5 text-foreground break-words">
                      {j.last_error ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-rose-400 cursor-help">
                              {j.last_error.length > 80 ? j.last_error.slice(0, 80) + '…' : j.last_error}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xl">
                            <pre className="text-xs whitespace-pre-wrap break-words">{j.last_error}</pre>
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
