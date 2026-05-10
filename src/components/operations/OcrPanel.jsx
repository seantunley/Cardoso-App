// OCR operations panel — admin-only "what is OCR doing right now" view.
// Powered by:
//   GET  /api/bat/ocr-snapshot      — pause/halt/in-flight, polled 2s
//   GET  /api/bat/ocr-counters      — error_log aggregated counts, polled 10s
//   GET  /api/bat/ocr-recent-runs   — last 20 reconciliations, polled 30s
//   GET  /api/error-log?source=...  — filtered System Log, polled 15s
//   POST /api/bat/ocr-pause         — pause/resume worker
//   POST /api/bat/ocr-clear-halt    — clear regex auto-halt + resume
//
// Designed so an operator looking at this tab can answer:
//   - Is OCR paused?
//   - Is there an active regex auto-halt? Why?
//   - What rows is the worker currently processing, in what stage, for how long?
//   - How many matches/cascade_exhausted/engine_failed in the last hour?
//   - What did recent reconciliations finish with?
//   - What's in the System Log specifically about OCR?

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Activity, AlertTriangle, AlertCircle, CheckCircle2, Pause, Play,
  RefreshCw, Zap, ZapOff, Clock, Skull, FileSearch,
} from "lucide-react";

const fmtZA = (dt) => {
  if (!dt) return "—";
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(dt) ? dt : dt.replace(' ', 'T') + 'Z';
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return dt;
  return d.toLocaleString("en-ZA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
};

const fmtDuration = (s) => {
  if (s == null) return "—";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
};

// Friendly labels for the bat.ocr.* topics. Keeps the counter strip
// readable instead of dumping the raw source name.
const TOPIC_LABELS = {
  'bat.ocr.match':                  { label: 'Matched',           tone: 'good' },
  'bat.ocr.engine_no_match':        { label: 'Regex misses',      tone: 'warn' },
  'bat.ocr.engine_failed':          { label: 'Engine failures',   tone: 'bad' },
  'bat.ocr.engine_cooldown_skip':   { label: 'Cooldown skips',    tone: 'info' },
  'bat.ocr.regex_streak_halt':      { label: 'Auto-halts fired',  tone: 'bad' },
  'bat.ocr.row':                    { label: 'Row exceptions',    tone: 'bad' },
  'bat.ocr.row_update':             { label: 'Row update fails',  tone: 'bad' },
  'bat.ocr.lane_recreate':          { label: 'Lane recreates',    tone: 'warn' },
  'bat.ocr.watchdog_kill':          { label: 'Watchdog kills',    tone: 'bad' },
  'bat.ocr.run_incomplete':         { label: 'Runs cut short',    tone: 'bad' },
  'bat.ocr.halt_cleared':           { label: 'Halts cleared',     tone: 'info' },
  'bat-ocr.pause':                  { label: 'Pause/resume',      tone: 'info' },
  'bat-ocr.worker':                 { label: 'Worker lifecycle',  tone: 'info' },
};

const TONE_STYLES = {
  good: 'border-emerald-700/50 bg-emerald-900/20 text-emerald-400',
  warn: 'border-amber-700/50 bg-amber-900/20 text-amber-400',
  bad:  'border-rose-700/50 bg-rose-900/20 text-rose-400',
  info: 'border-sky-700/50 bg-sky-900/20 text-sky-400',
};

function StatusPill({ kind, children }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono border ${TONE_STYLES[kind] || TONE_STYLES.info}`}>
      {children}
    </span>
  );
}

function RecentRunStatus({ row }) {
  if (row.status === 'completed') return <StatusPill kind="good"><CheckCircle2 className="w-3 h-3" /> completed</StatusPill>;
  if (row.status === 'error')     return <StatusPill kind="bad"><AlertCircle className="w-3 h-3" /> error</StatusPill>;
  if (row.status === 'pending')   return <StatusPill kind="warn"><Clock className="w-3 h-3" /> pending</StatusPill>;
  return <StatusPill kind="info">{row.status || '—'}</StatusPill>;
}

export default function OcrPanel() {
  const qc = useQueryClient();
  const [counterWindow, setCounterWindow] = useState(1);
  const [logWindow, setLogWindow] = useState(24);
  const [logSource, setLogSource] = useState("");
  const [expandedLogId, setExpandedLogId] = useState(null);
  const [haltDetailsOpen, setHaltDetailsOpen] = useState(true);

  const snapshot = useQuery({
    queryKey: ['ocr-snapshot'],
    queryFn: async () => {
      const r = await fetch('/api/bat/ocr-snapshot', { credentials: 'include' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load OCR snapshot');
      return d;
    },
    refetchInterval: 2000,
  });

  const counters = useQuery({
    queryKey: ['ocr-counters', counterWindow],
    queryFn: async () => {
      const r = await fetch(`/api/bat/ocr-counters?window=${counterWindow}`, { credentials: 'include' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load OCR counters');
      return d;
    },
    refetchInterval: 10_000,
  });

  const recentRuns = useQuery({
    queryKey: ['ocr-recent-runs'],
    queryFn: async () => {
      const r = await fetch('/api/bat/ocr-recent-runs?limit=20', { credentials: 'include' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load recent runs');
      return d;
    },
    refetchInterval: 30_000,
  });

  // Filtered System Log — we use the existing /api/error-log endpoint and
  // either narrow to a specific bat.ocr.* topic via ?source=, or pull
  // everything and client-side filter to bat.ocr.* / bat-ocr.* prefixes.
  // The all-OCR view is the common case so we keep client-side filter on
  // a higher limit; the per-topic view uses the server-side filter for
  // efficiency.
  const ocrLog = useQuery({
    queryKey: ['ocr-log', logSource, logWindow],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('limit', '300');
      params.set('sinceHours', String(logWindow));
      if (logSource) params.set('source', logSource);
      const r = await fetch(`/api/error-log?${params}`, { credentials: 'include' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to load log');
      return d;
    },
    refetchInterval: 15_000,
  });

  const visibleLogRows = useMemo(() => {
    const rows = ocrLog.data?.rows || [];
    if (logSource) return rows;
    return rows.filter(r => r.source && (r.source.startsWith('bat.ocr.') || r.source.startsWith('bat-ocr.')));
  }, [ocrLog.data, logSource]);

  // Topic dropdown options derived from the all-source list, narrowed to OCR
  const ocrTopicOptions = useMemo(() => {
    const sources = ocrLog.data?.sources || [];
    return sources.filter(s => s.source && (s.source.startsWith('bat.ocr.') || s.source.startsWith('bat-ocr.')));
  }, [ocrLog.data]);

  const pauseMutation = useMutation({
    mutationFn: async (paused) => {
      const r = await fetch('/api/bat/ocr-pause', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to update pause state');
      return d;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ocr-snapshot'] }),
  });

  const clearHaltMutation = useMutation({
    mutationFn: async (reconId) => {
      const r = await fetch('/api/bat/ocr-clear-halt', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reconciliation_id: reconId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to clear halt');
      return d;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ocr-snapshot'] });
      qc.invalidateQueries({ queryKey: ['ocr-recent-runs'] });
    },
  });

  const snap = snapshot.data;
  const isLoadingSnap = snapshot.isLoading;
  const snapError = snapshot.error;

  return (
    <div className="space-y-6">
      {/* ── Status header ─────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-[0.3em] text-muted-foreground">
              Right now
            </div>
            <div className="flex items-center gap-3 mt-1.5">
              {snap?.paused ? (
                <StatusPill kind="warn"><Pause className="w-3 h-3" /> Paused</StatusPill>
              ) : snap?.worker_running ? (
                <StatusPill kind="good"><Zap className="w-3 h-3" /> Running</StatusPill>
              ) : (
                <StatusPill kind="info"><ZapOff className="w-3 h-3" /> Idle</StatusPill>
              )}
              {snap?.halt && (
                <StatusPill kind="bad"><Skull className="w-3 h-3" /> Auto-halt active</StatusPill>
              )}
              <span className="text-xs text-muted-foreground font-mono">
                concurrency {snap?.concurrency ?? '—'} · {snap?.in_flight?.length ?? 0} in flight · {snap?.pending_total ?? 0} pending
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => snapshot.refetch()}
              disabled={snapshot.isRefetching}
              className="border-border text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${snapshot.isRefetching ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            {/* When an auto-halt is in force, the regular Pause/Resume
                button is hidden — resuming via /api/bat/ocr-pause flips
                the pause flag but doesn't clear last_error, leaving the
                halt banner stuck and the audited Clear-halt action
                bypassed. The "Clear halt + resume" button in the halt
                banner becomes the only resume path, which is what we
                want: every halt-recovery shows up in the audit log. */}
            {!snap?.halt && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => pauseMutation.mutate(!snap?.paused)}
                disabled={pauseMutation.isPending || isLoadingSnap}
                className="border-border"
              >
                {snap?.paused ? (
                  <><Play className="w-3.5 h-3.5 mr-1.5" /> Resume</>
                ) : (
                  <><Pause className="w-3.5 h-3.5 mr-1.5" /> Pause</>
                )}
              </Button>
            )}
          </div>
        </div>

        {snapError && (
          <div className="rounded-md border border-rose-700 bg-rose-900/20 p-3 text-sm text-rose-300">
            {snapError.message}
          </div>
        )}

        {/* Active recon progress */}
        {snap?.active_recon && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs font-mono pt-2 border-t border-border">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Active recon</div>
              <div className="text-foreground mt-0.5">#{snap.active_recon.id} · W{snap.active_recon.week_number}/{snap.active_recon.year}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Found</div>
              <div className="text-emerald-400 mt-0.5">{snap.active_recon.rows_found} / {snap.active_recon.rows_total}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Pending</div>
              <div className="text-amber-400 mt-0.5">{snap.active_recon.rows_pending}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Not found</div>
              <div className="text-muted-foreground mt-0.5">{snap.active_recon.rows_not_found}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Failed</div>
              <div className="text-rose-400 mt-0.5">{snap.active_recon.rows_failed}</div>
            </div>
          </div>
        )}
      </div>

      {/* ── Auto-halt banner ─────────────────────────────────────────── */}
      {snap?.halt && (
        <div className="rounded-xl border border-rose-700/60 bg-rose-900/15 p-5 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <Skull className="w-5 h-5 text-rose-400 mt-0.5 shrink-0" />
              <div>
                <div className="text-sm font-semibold text-rose-300">
                  Regex auto-halt active — recon #{snap.halt.reconciliation_id} (W{snap.halt.week_number}/{snap.halt.year})
                </div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5">
                  Fired {fmtZA(snap.halt.occurred_at)}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setHaltDetailsOpen(o => !o)}
                className="text-muted-foreground hover:text-foreground"
              >
                {haltDetailsOpen ? 'Hide' : 'Show'} reason
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => clearHaltMutation.mutate(snap.halt.reconciliation_id)}
                disabled={!snap.halt.can_clear || clearHaltMutation.isPending}
                className="border-rose-700/50 text-rose-300 hover:bg-rose-900/40"
              >
                <Play className="w-3.5 h-3.5 mr-1.5" />
                Clear halt + resume
              </Button>
            </div>
          </div>
          {haltDetailsOpen && (
            <pre className="text-xs font-mono text-rose-200/80 whitespace-pre-wrap break-words bg-rose-950/40 rounded p-3 border border-rose-800/40">
              {snap.halt.message}
            </pre>
          )}
          {clearHaltMutation.error && (
            <div className="text-xs text-rose-300">
              {clearHaltMutation.error.message}
            </div>
          )}
        </div>
      )}

      {/* ── In-flight rows ───────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <Activity className="w-4 h-4 text-emerald-400" /> In-flight rows
          </div>
          <div className="text-xs text-muted-foreground font-mono">
            {snap?.in_flight?.length ?? 0} of {snap?.concurrency ?? 0} lanes busy
          </div>
        </div>
        {(!snap?.in_flight || snap.in_flight.length === 0) ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {snap?.paused ? 'OCR is paused — no rows in flight.' : 'No rows currently being processed.'}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/20">
                <th className="px-4 py-2 text-left text-[10px] font-medium text-muted-foreground uppercase">ID</th>
                <th className="px-4 py-2 text-left text-[10px] font-medium text-muted-foreground uppercase">Recon</th>
                <th className="px-4 py-2 text-left text-[10px] font-medium text-muted-foreground uppercase">Store</th>
                <th className="px-4 py-2 text-left text-[10px] font-medium text-muted-foreground uppercase">Stage</th>
                <th className="px-4 py-2 text-right text-[10px] font-medium text-muted-foreground uppercase w-28">Stage age</th>
                <th className="px-4 py-2 text-right text-[10px] font-medium text-muted-foreground uppercase w-28">Total</th>
              </tr>
            </thead>
            <tbody>
              {snap.in_flight.map(row => {
                // Highlight rows where the watchdog has flagged them as stuck.
                const flagged = row.kill_attempted || (row.elapsed_seconds || 0) > 120;
                return (
                  <tr key={row.id} className={`border-b border-border last:border-0 ${flagged ? 'bg-rose-950/15' : ''}`}>
                    <td className="px-4 py-2 font-mono text-muted-foreground">#{row.id}</td>
                    <td className="px-4 py-2 font-mono text-muted-foreground">{row.reconciliation_id}</td>
                    <td className="px-4 py-2 text-foreground truncate max-w-[20ch]" title={row.store_name}>{row.store_name || '—'}</td>
                    <td className="px-4 py-2 font-mono text-xs">
                      {row.stage ? (
                        <span className={`px-1.5 py-0.5 rounded ${row.stage.startsWith('engine:') ? 'text-sky-400' : 'text-amber-400'}`}>
                          {row.stage}
                        </span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-muted-foreground">{fmtDuration(row.stage_age_seconds)}</td>
                    <td className={`px-4 py-2 text-right font-mono text-xs ${flagged ? 'text-rose-400' : 'text-muted-foreground'}`}>
                      {fmtDuration(row.elapsed_seconds)}
                      {row.kill_attempted && <span className="ml-1.5 text-rose-400">⚠</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Counter strip ─────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium text-foreground">Activity counters</div>
          <div className="flex items-center gap-2">
            <select
              value={counterWindow}
              onChange={(e) => setCounterWindow(Number(e.target.value))}
              className="h-8 px-2 rounded-md border border-border bg-background text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value={1}>Last hour</option>
              <option value={6}>Last 6 hours</option>
              <option value={24}>Last 24 hours</option>
              <option value={24 * 7}>Last 7 days</option>
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {Object.entries(TOPIC_LABELS).map(([source, meta]) => {
            const n = counters.data?.by_source?.[source] || 0;
            const tone = TONE_STYLES[meta.tone];
            return (
              <div key={source} className={`rounded-md border px-3 py-2 ${n > 0 ? tone : 'border-border bg-muted/10'}`}>
                <div className="text-[10px] uppercase tracking-wider opacity-70">{meta.label}</div>
                <div className={`text-2xl font-mono mt-0.5 ${n === 0 ? 'text-muted-foreground' : ''}`}>{n}</div>
              </div>
            );
          })}
        </div>
        {counters.error && (
          <div className="text-xs text-rose-300">{counters.error.message}</div>
        )}
      </div>

      {/* ── Recent reconciliations ────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <FileSearch className="w-4 h-4 text-sky-400" /> Recent reconciliations
          </div>
          <div className="text-xs text-muted-foreground">last 20</div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/20">
                <th className="px-4 py-2 text-left text-[10px] font-medium text-muted-foreground uppercase">ID</th>
                <th className="px-4 py-2 text-left text-[10px] font-medium text-muted-foreground uppercase">Week</th>
                <th className="px-4 py-2 text-left text-[10px] font-medium text-muted-foreground uppercase">Status</th>
                <th className="px-4 py-2 text-left text-[10px] font-medium text-muted-foreground uppercase">Created</th>
                <th className="px-4 py-2 text-right text-[10px] font-medium text-muted-foreground uppercase">Found</th>
                <th className="px-4 py-2 text-right text-[10px] font-medium text-muted-foreground uppercase">Pending</th>
                <th className="px-4 py-2 text-right text-[10px] font-medium text-muted-foreground uppercase">Not found</th>
                <th className="px-4 py-2 text-right text-[10px] font-medium text-muted-foreground uppercase">Failed</th>
                <th className="px-4 py-2 text-left text-[10px] font-medium text-muted-foreground uppercase">Last error</th>
              </tr>
            </thead>
            <tbody>
              {recentRuns.isLoading ? (
                <tr><td colSpan={9} className="px-4 py-6 text-center text-muted-foreground">Loading…</td></tr>
              ) : (recentRuns.data?.rows?.length ?? 0) === 0 ? (
                <tr><td colSpan={9} className="px-4 py-6 text-center text-muted-foreground">No reconciliations yet.</td></tr>
              ) : (
                recentRuns.data.rows.map(row => (
                  <tr key={row.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                    <td className="px-4 py-2 font-mono text-muted-foreground">#{row.id}</td>
                    <td className="px-4 py-2 font-mono text-foreground">W{row.week_number}/{row.year}</td>
                    <td className="px-4 py-2"><RecentRunStatus row={row} /></td>
                    <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">{fmtZA(row.created_at)}</td>
                    <td className="px-4 py-2 text-right font-mono text-emerald-400">{row.rows_found}</td>
                    <td className={`px-4 py-2 text-right font-mono ${row.rows_pending > 0 ? 'text-amber-400' : 'text-muted-foreground'}`}>{row.rows_pending}</td>
                    <td className="px-4 py-2 text-right font-mono text-muted-foreground">{row.rows_not_found}</td>
                    <td className={`px-4 py-2 text-right font-mono ${row.rows_failed > 0 ? 'text-rose-400' : 'text-muted-foreground'}`}>{row.rows_failed}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground max-w-[40ch] truncate" title={row.last_error || ''}>
                      {row.last_error || '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Filtered System Log (OCR only) ────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <AlertTriangle className="w-4 h-4 text-amber-400" /> OCR system log
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={logSource}
              onChange={(e) => setLogSource(e.target.value)}
              className="h-8 px-2 rounded-md border border-border bg-background text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">All OCR topics</option>
              {ocrTopicOptions.map(s => (
                <option key={s.source} value={s.source}>{s.source} ({s.n})</option>
              ))}
            </select>
            <select
              value={logWindow}
              onChange={(e) => setLogWindow(Number(e.target.value))}
              className="h-8 px-2 rounded-md border border-border bg-background text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value={1}>1h</option>
              <option value={6}>6h</option>
              <option value={24}>24h</option>
              <option value={24 * 7}>7d</option>
              <option value={24 * 30}>30d</option>
            </select>
            <Button
              size="sm"
              variant="outline"
              onClick={() => ocrLog.refetch()}
              disabled={ocrLog.isRefetching}
              className="border-border text-muted-foreground hover:text-foreground h-8"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${ocrLog.isRefetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
        {ocrLog.error ? (
          <div className="px-4 py-4 text-sm text-rose-300">{ocrLog.error.message}</div>
        ) : ocrLog.isLoading ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : visibleLogRows.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            <CheckCircle2 className="w-5 h-5 text-emerald-500 mx-auto mb-1.5" />
            No OCR log entries in the selected window.
          </div>
        ) : (
          <div className="max-h-[520px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/50 backdrop-blur z-10">
                <tr className="border-b border-border">
                  <th className="px-4 py-2 text-left text-[10px] font-medium text-muted-foreground uppercase w-44">When</th>
                  <th className="px-4 py-2 text-left text-[10px] font-medium text-muted-foreground uppercase w-52">Topic</th>
                  <th className="px-4 py-2 text-left text-[10px] font-medium text-muted-foreground uppercase">Message</th>
                </tr>
              </thead>
              <tbody>
                {visibleLogRows.map(r => {
                  const isOpen = expandedLogId === r.id;
                  const hasDetail = r.stack || r.context;
                  const isInfo = (r.level || 'error') === 'info';
                  return [
                    <tr
                      key={r.id}
                      onClick={() => hasDetail && setExpandedLogId(isOpen ? null : r.id)}
                      className={`border-b border-border last:border-0 hover:bg-muted/20 ${hasDetail ? 'cursor-pointer' : ''}`}
                    >
                      <td className="px-4 py-2 text-muted-foreground whitespace-nowrap text-xs font-mono">{fmtZA(r.occurred_at)}</td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono ${isInfo ? 'bg-sky-900/20 text-sky-400 border border-sky-700/40' : 'bg-amber-900/20 text-amber-400 border border-amber-700/40'}`}>
                          {r.source}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-foreground break-words text-xs">{r.message}</td>
                    </tr>,
                    isOpen && hasDetail && (
                      <tr key={`${r.id}-detail`} className="border-b border-border bg-muted/10">
                        <td colSpan={3} className="px-4 py-3 space-y-2">
                          {r.context && (
                            <div>
                              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Context</div>
                              <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">{r.context}</pre>
                            </div>
                          )}
                          {r.stack && (
                            <div>
                              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Stack</div>
                              <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">{r.stack}</pre>
                            </div>
                          )}
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
