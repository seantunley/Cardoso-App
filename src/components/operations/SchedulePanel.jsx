// SchedulePanel — read-only "what's scheduled to run" view.
//
// Pairs with JobRunsPanel: that one shows what HAS run, this one shows
// what WILL run. Backed by GET /api/system/scheduled-jobs which returns
// the in-memory registry from src/lib/scheduledJobs.js + computed
// next-fire times for cron jobs (via node-cron task.getNextRun()).
//
// Sorted with the soonest-next-cron at the top so the operator sees
// the imminent stuff first. One-shots that have already passed sink
// to the bottom (they're informational — "this fired 45s after boot").

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RefreshCw, Calendar, Repeat, Zap, Server, Cloud } from "lucide-react";

const TYPE_META = {
  cron:       { icon: Calendar, label: 'Cron',     tone: 'phosphor' },
  interval:   { icon: Repeat,   label: 'Every',    tone: 'muted' },
  'one-shot': { icon: Zap,      label: 'One-shot', tone: 'muted' },
};
const MODE_META = {
  site: { icon: Server, label: 'Site' },
  hub:  { icon: Cloud,  label: 'Hub' },
  all:  { icon: null,   label: 'Both' },
};
// Last-run status dot colours — from job_runs.status.
const STATUS_DOT = {
  succeeded: 'hsl(var(--status-ok))',
  failed:    'hsl(var(--status-critical))',
  started:   'hsl(var(--status-warn))',
};

function humanizeMs(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms} ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const hr = Math.round(min / 60);
  return `${hr} h`;
}

// Parse '0 2 1 * *' style → "1st of every month, 02:00".
// Best-effort; falls back to the raw expression.
function describeCron(expr) {
  if (!expr || typeof expr !== 'string') return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mo, dow] = parts;
  // A few common shapes the codebase uses.
  if (expr === '0 2 1 * *') return '1st of every month at 02:00';
  if (expr === '0 2 * * *') return 'Daily at 02:00';
  if (expr === '30 3 * * *') return 'Daily at 03:30';
  if (expr === '0 3 * * *') return 'Daily at 03:00';
  if (expr === '0 4 * * *') return 'Daily at 04:00';
  if (expr === '15 4 * * *') return 'Daily at 04:15';
  if (expr === '30 4 * * *') return 'Daily at 04:30';
  if (expr === '45 4 1 * *') return '1st of every month at 04:45';
  if (expr === '0 17 * * 1-5') return 'Weekdays at 17:00';
  if (expr === '0,30 6-16 * * 1-5') return 'Every 30 min, 06:00–16:30 on weekdays';
  if (expr === '0 7,10,13,16 * * 1-5') return 'Weekdays at 07:00 / 10:00 / 13:00 / 16:00';
  // Generic — show the daily/hourly hint.
  if (mo === '*' && dow === '*' && dom === '*') return `Daily at ${h.padStart(2,'0')}:${m.padStart(2,'0')}`;
  return null;
}

function formatRelative(iso, serverTimeIso) {
  if (!iso) return '—';
  const target = new Date(iso).getTime();
  const now = serverTimeIso ? new Date(serverTimeIso).getTime() : Date.now();
  if (Number.isNaN(target)) return iso;
  const deltaMs = target - now;
  const past = deltaMs < 0;
  const abs = Math.abs(deltaMs);
  const sec = Math.round(abs / 1000);
  if (sec < 60) return past ? `${sec}s ago` : `in ${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return past ? `${min}m ago` : `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return past ? `${hr}h ago` : `in ${hr}h`;
  const day = Math.round(hr / 24);
  return past ? `${day}d ago` : `in ${day}d`;
}

function formatAbsolute(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// Sort: soonest future fire first (cron + future one-shots), then past
// one-shots, then intervals (no nextRun) at the bottom.
function compareJobs(a, b, now) {
  const aT = a.nextRun ? new Date(a.nextRun).getTime() : null;
  const bT = b.nextRun ? new Date(b.nextRun).getTime() : null;
  const aPast = aT != null && aT < now;
  const bPast = bT != null && bT < now;
  // Future first
  if (aT != null && bT != null && !aPast && !bPast) return aT - bT;
  if (aT != null && !aPast && (bT == null || bPast)) return -1;
  if (bT != null && !bPast && (aT == null || aPast)) return 1;
  // Both intervals (no nextRun): sort alphabetically
  if (aT == null && bT == null) return a.name.localeCompare(b.name);
  // Both past one-shots: most recent first
  if (aPast && bPast) return bT - aT;
  return 0;
}

export default function SchedulePanel() {
  const [tick, setTick] = useState(0);

  // Re-render every 30s so the "in 5m" / "in 12h" labels stay fresh
  // without re-fetching from server.
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ['scheduled-jobs'],
    queryFn: async () => {
      const r = await fetch('/api/system/scheduled-jobs', { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 5 * 60_000,  // server-side data only changes on restart
  });

  const jobs = data?.jobs || [];
  const serverTime = data?.serverTime;
  const nowMs = Date.now() + (tick * 0); // touch tick so the list re-sorts
  const sorted = [...jobs].sort((a, b) => compareJobs(a, b, nowMs));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Calendar className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />
        <h2 className="font-display text-lg text-foreground">Scheduled jobs</h2>
        <span className="text-xs text-muted-subtle">
          {jobs.length} registered · server time {serverTime ? formatAbsolute(serverTime) : '—'}
        </span>
        <Button onClick={() => refetch()} disabled={isRefetching} variant="outline" size="sm" className="ml-auto border-border text-muted-foreground hover:text-foreground">
          <RefreshCw className={`w-4 h-4 mr-2 ${isRefetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        What the scheduler is registered to run. To see what HAS run, switch to the Job Runs tab.
        Cron jobs show the next computed fire time (server local). Boot one-shots show when they fired (relative to server start).
      </p>

      {isLoading && (
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          Loading…
        </div>
      )}
      {error && (
        <div className="border border-destructive bg-card px-3 py-2" style={{ borderRadius: '8px' }}>
          <p className="font-mono text-xs text-destructive">Couldn't load schedule: {error.message}</p>
        </div>
      )}

      {!isLoading && !error && jobs.length === 0 && (
        <div className="border border-dashed border-border px-4 py-6 text-center" style={{ borderRadius: '8px' }}>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">No registered jobs</p>
          <p className="text-xs text-muted-subtle mt-1">
            Either the scheduler hasn't started or registerJob() isn't being called from scheduler.js.
          </p>
        </div>
      )}

      {sorted.length > 0 && (
        <div className="overflow-x-auto border border-border" style={{ borderRadius: '8px' }}>
          <table className="w-full text-sm">
            <thead className="bg-muted/30">
              <tr className="border-b border-border text-left font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                <th className="py-2 px-3">Job</th>
                <th className="py-2 px-3">Type</th>
                <th className="py-2 px-3">Mode</th>
                <th className="py-2 px-3">Schedule</th>
                <th className="py-2 px-3">Last run</th>
                <th className="py-2 px-3">Next run</th>
                <th className="py-2 px-3">When</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((j, i) => {
                const TypeIcon = TYPE_META[j.type]?.icon || Calendar;
                const ModeIcon = MODE_META[j.mode]?.icon;
                const cronHint = j.type === 'cron' ? describeCron(j.cronExpression) : null;
                return (
                  <tr key={`${j.name}-${j.type}-${i}`} className="border-b border-border/40 last:border-b-0 hover:bg-muted/10">
                    <td className="py-2.5 px-3">
                      <div className="font-mono text-xs text-foreground">{j.name}</div>
                      {j.description && (
                        <div className="text-[11px] text-muted-subtle mt-0.5 max-w-[420px]">{j.description}</div>
                      )}
                    </td>
                    <td className="py-2.5 px-3">
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground border border-border" style={{ borderRadius: '4px' }}>
                        <TypeIcon className="w-2.5 h-2.5" strokeWidth={2} />
                        {TYPE_META[j.type]?.label || j.type}
                      </span>
                    </td>
                    <td className="py-2.5 px-3">
                      <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                        {ModeIcon && <ModeIcon className="w-2.5 h-2.5" strokeWidth={2} />}
                        {MODE_META[j.mode]?.label || j.mode}
                      </span>
                    </td>
                    <td className="py-2.5 px-3">
                      {j.type === 'cron' && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="font-mono text-xs text-foreground">
                              {cronHint || j.cronExpression}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className="font-mono text-xs">{j.cronExpression}</p>
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {j.type === 'interval' && (
                        <span className="font-mono text-xs text-foreground">
                          every {humanizeMs(j.intervalMs)}
                        </span>
                      )}
                      {j.type === 'one-shot' && (
                        <span className="font-mono text-xs text-foreground">
                          +{humanizeMs(j.delayMs)} after boot
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-3">
                      {j.lastRun ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex items-center gap-1.5">
                              <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS_DOT[j.lastRun.status] || 'hsl(var(--muted-foreground))' }} />
                              <span className={`text-xs ${j.lastRun.status === 'failed' ? 'text-rose-400' : 'text-muted-foreground'}`}>
                                {formatRelative(j.lastRun.started_at, serverTime)}
                              </span>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className="font-mono text-xs">
                              {j.lastRun.status} · {formatAbsolute(j.lastRun.started_at)}
                              {j.lastRun.error_message ? ` · ${j.lastRun.error_message}` : ''}
                            </p>
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="text-xs text-muted-subtle">never</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3">
                      {j.nextRun
                        ? <span className="text-xs text-foreground">{formatAbsolute(j.nextRun)}</span>
                        : <span className="text-xs text-muted-subtle">—</span>}
                      {j.nextRunError && (
                        <div className="text-[10px] text-rose-400 mt-0.5">err: {j.nextRunError}</div>
                      )}
                    </td>
                    <td className="py-2.5 px-3">
                      {j.nextRun
                        ? <span className="text-xs text-muted-foreground">{formatRelative(j.nextRun, serverTime)}</span>
                        : <span className="text-xs text-muted-subtle">—</span>}
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
