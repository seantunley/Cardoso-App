// Extracted from SettingsPanel.jsx (was `SystemLogTab`) so the same panel
// can be rendered from both Settings → System Log AND the new Operations
// page. The body is unchanged — only the import location moved.
//
// Reads the error_log table populated by src/lib/errorLog.js. Surfaces
// server crashes, OCR failures, Sage pool errors, and browser-side errors
// so an off-site operator can diagnose without terminal access.

import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { RefreshCw, AlertTriangle, CheckCircle2, ChevronRight, ChevronDown } from "lucide-react";

// Normalise a message for grouping comparison so messages that share a
// shape but differ in numeric ID/timestamp bits collapse onto the same
// group. Examples that this correctly clusters:
//   "Extraction id=1278: PDF timeout"  →  "Extraction id=#: PDF timeout"
//   "Extraction id=1272: PDF timeout"  →  "Extraction id=#: PDF timeout"
//   "Hub pull from site at 16:42:11 timed out"
//                                      →  "Hub pull from site at #:#:# timed out"
// We keep the operator-facing message itself verbatim — only the
// grouping key uses this normalised form.
const _normaliseForGrouping = (msg) => String(msg ?? '').replace(/\d+/g, '#');

export default function SystemLogPanel() {
  const [sourceFilter, setSourceFilter] = useState("");
  const [sinceHours, setSinceHours] = useState(24 * 7);
  const [expandedId, setExpandedId] = useState(null);
  const [expandedGroupKey, setExpandedGroupKey] = useState(null);
  // Dedupe defaults on — the whole point is to make the default view
  // scannable. Toggle in the toolbar lets the operator flip it off when
  // they need the raw chronological stream (debugging cadence, counting
  // events).
  const [dedupeOn, setDedupeOn] = useState(true);

  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ["error-log", sourceFilter, sinceHours],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", "500");
      params.set("sinceHours", String(sinceHours));
      // ALWAYS send exclude_prefixes — even when a specific source is
      // selected. The server applies it to two queries:
      //   1. The rows query: `source=` overrides exclude_prefixes here
      //      (so picking a source still works as expected — Operator
      //      can still drill into anything via direct URL).
      //   2. The sources aggregate (powering the dropdown): the
      //      exclude_prefixes filter is applied unconditionally so OCR
      //      topics never re-appear in the dropdown after the operator
      //      picks a non-OCR source.
      // Previous version only sent exclude_prefixes when sourceFilter was
      // empty, which let the next refetch's sources list re-introduce
      // bat.ocr.* topics whenever the operator drilled into a specific
      // source — Codex catch on PR #229.
      params.set("exclude_prefixes", "bat.ocr.,bat-ocr.");
      if (sourceFilter) params.set("source", sourceFilter);
      const r = await fetch(`/api/error-log?${params}`, { credentials: "include" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed to load");
      return d;
    },
    refetchInterval: 30_000,
  });

  const fmt = (dt) => {
    if (!dt) return "—";
    // logError writes ISO strings (with trailing Z), but SQLite's
    // datetime('now') default uses space-separated UTC (no Z). Normalise:
    // if no Z/offset, treat as UTC by appending Z so the toLocaleString
    // call below converts to the user's display zone correctly.
    const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(dt)
      ? dt
      : dt.replace(' ', 'T') + 'Z';
    const d = new Date(normalized);
    if (isNaN(d.getTime())) return dt; // last resort — show raw rather than "Invalid Date"
    return d.toLocaleString("en-ZA", {
      timeZone: "Africa/Johannesburg",
      year: "numeric", month: "short", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
  };
  const rows = data?.rows || [];
  const sources = data?.sources || [];

  // Group same-source rows whose normalised messages match — globally
  // across the visible window, NOT only when consecutive. The previous
  // consecutive-only algorithm fell over the moment two sites failed
  // in alternating cycles ("Welkom timeout, Ermelo timeout, Welkom
  // timeout, …") because no two same-shape rows were ever adjacent —
  // the operator saw 30+ rows where they should have seen 2 groups.
  //
  // Global grouping does NOT hide brand-new errors: a fresh signature
  // becomes its own group, and groups are sorted by the timestamp of
  // their newest member, so anything new floats to the top exactly
  // like a fresh row would. The "important things never get hidden"
  // property the consecutive version aimed for is preserved without
  // requiring adjacency — the only thing that ever joins an existing
  // group is another row with the SAME normalised message + source.
  //
  // Each group's representative row is the most recent one (rows[0])
  // since the API returns DESC order; the earliest is rows[length-1],
  // and the badge shows both timestamps when the group spans more
  // than the same minute. Within a group, rows stay newest-first.
  const groups = useMemo(() => {
    if (!dedupeOn) {
      // Pass-through: every row is its own "group" of size 1, so the
      // render path is uniform regardless of dedupe state.
      return rows.map((r) => ({ key: String(r.id), source: r.source, rows: [r] }));
    }
    const byKey = new Map();
    for (const r of rows) {
      const groupKey = `${r.source}|${_normaliseForGrouping(r.message)}`;
      const existing = byKey.get(groupKey);
      if (existing) {
        existing.rows.push(r);
      } else {
        byKey.set(groupKey, { key: groupKey, source: r.source, rows: [r] });
      }
    }
    // Sort by newest member of each group so the freshest activity
    // stays at the top of the table. Rows within each group are
    // already newest-first because we iterated `rows` in order.
    return Array.from(byKey.values()).sort((a, b) => {
      const aT = new Date(a.rows[0].occurred_at).getTime();
      const bT = new Date(b.rows[0].occurred_at).getTime();
      return bT - aT;
    });
  }, [rows, dedupeOn]);

  // Render-time helper — short relative range like "16:35→16:48" or
  // "16:48 only" when the whole group landed in a single minute. Keeps
  // the timestamp column readable.
  const fmtRange = (group) => {
    const newest = group.rows[0];
    const oldest = group.rows[group.rows.length - 1];
    if (newest === oldest) return null;
    // Pull just the HH:mm pieces from the formatted string. fmt() returns
    // a localised string like "10 May 2026, 16:48:09" so the trailing
    // chunk is "HH:mm:ss" — slice off the seconds for a tighter span.
    const newestStr = fmt(newest.occurred_at);
    const oldestStr = fmt(oldest.occurred_at);
    const newestTime = newestStr.split(', ').pop()?.slice(0, 5);
    const oldestTime = oldestStr.split(', ').pop()?.slice(0, 5);
    if (!newestTime || !oldestTime || newestTime === oldestTime) return null;
    return `${oldestTime}→${newestTime}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Source</label>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="h-9 px-3 rounded-md border border-border bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">All sources</option>
            {sources.map(s => (
              <option key={s.source} value={s.source}>{s.source} ({s.n})</option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Window</label>
          <select
            value={sinceHours}
            onChange={(e) => setSinceHours(Number(e.target.value))}
            className="h-9 px-3 rounded-md border border-border bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value={1}>Last hour</option>
            <option value={24}>Last 24 hours</option>
            <option value={24 * 7}>Last 7 days</option>
            <option value={24 * 30}>Last 30 days</option>
            <option value={24 * 90}>Last 90 days</option>
          </select>
        </div>
        <Button onClick={() => refetch()} disabled={isRefetching} variant="outline" size="sm" className="border-border text-muted-foreground hover:text-foreground">
          <RefreshCw className={`w-4 h-4 mr-2 ${isRefetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
        <label className="inline-flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none ml-2">
          <input
            type="checkbox"
            checked={dedupeOn}
            onChange={(e) => setDedupeOn(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-border accent-foreground cursor-pointer"
          />
          Group repeats
        </label>
        <div className="ml-auto text-xs text-muted-foreground">
          {isLoading
            ? "Loading…"
            : dedupeOn && groups.length !== rows.length
              ? `${groups.length} ${groups.length === 1 ? "group" : "groups"} · ${rows.length} ${rows.length === 1 ? "entry" : "entries"}`
              : `${rows.length} ${rows.length === 1 ? "entry" : "entries"}`}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-700 bg-rose-900/20 p-4 text-sm text-rose-300">
          {error.message || "Failed to load error log"}
        </div>
      )}

      {isLoading ? (
        <div className="h-20 animate-pulse bg-muted rounded-xl" />
      ) : rows.length === 0 ? (
        <div className="text-center py-10 text-muted-foreground text-sm border border-dashed border-border rounded-xl">
          <CheckCircle2 className="w-6 h-6 text-emerald-500 mx-auto mb-2" />
          No errors recorded in the selected window.
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase w-44">When</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase w-40">Source</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase">Message</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                // Single-row group → render as the original raw row UI.
                // Lets the operator click to expand stack/context, exactly
                // like before this change.
                if (group.rows.length === 1) {
                  const r = group.rows[0];
                  const isOpen = expandedId === r.id;
                  const hasDetail = r.stack || r.context;
                  return (
                    <Fragment key={r.id}>
                      <tr
                        onClick={() => hasDetail && setExpandedId(isOpen ? null : r.id)}
                        className={`border-b border-border last:border-0 hover:bg-muted/20 ${hasDetail ? "cursor-pointer" : ""}`}
                      >
                        <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">{fmt(r.occurred_at)}</td>
                        <td className="px-4 py-2.5">
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono bg-muted/60 text-foreground">
                            <AlertTriangle className="w-3 h-3 text-amber-500" />
                            {r.source}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-foreground break-words">{r.message}</td>
                      </tr>
                      {isOpen && hasDetail && (
                        <tr className="border-b border-border bg-muted/10">
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
                      )}
                    </Fragment>
                  );
                }

                // Multi-row group → render the most-recent row's content
                // with a "× N" badge prefixed, plus an expand chevron.
                // Clicking the row toggles the group open; when open, the
                // individual rows render indented underneath, each one
                // still click-to-expand for stack/context as a regular
                // single-row would. Group key combines source+normalised
                // message+newest-id so it remains stable across refetches
                // (as long as the newest row's id is still in the page).
                const newest = group.rows[0];
                const oldest = group.rows[group.rows.length - 1];
                const groupKey = `${group.key}|${newest.id}`;
                const isGroupOpen = expandedGroupKey === groupKey;
                const range = fmtRange(group);
                return (
                  <Fragment key={groupKey}>
                    <tr
                      onClick={() => setExpandedGroupKey(isGroupOpen ? null : groupKey)}
                      className="border-b border-border last:border-0 hover:bg-muted/20 cursor-pointer"
                    >
                      <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap align-top">
                        <div>{fmt(newest.occurred_at)}</div>
                        {range && (
                          <div className="text-[10px] text-muted-foreground/60 mt-0.5">range: {range}</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 align-top">
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-mono bg-muted/60 text-foreground">
                          <AlertTriangle className="w-3 h-3 text-amber-500" />
                          {group.source}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-foreground break-words align-top">
                        <div className="flex items-start gap-2">
                          {isGroupOpen
                            ? <ChevronDown className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-muted-foreground" />
                            : <ChevronRight className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-muted-foreground" />}
                          <span className="px-1.5 py-0.5 text-xs font-mono bg-amber-500/15 text-amber-200 rounded flex-shrink-0">
                            ×{group.rows.length}
                          </span>
                          <span className="break-words">{newest.message}</span>
                        </div>
                        {!isGroupOpen && oldest !== newest && (
                          <div className="text-[10px] text-muted-foreground/60 mt-1 ml-6">
                            earliest: {newest.message === oldest.message ? "same" : oldest.message}
                          </div>
                        )}
                      </td>
                    </tr>
                    {isGroupOpen && group.rows.map((r) => {
                      const isRowOpen = expandedId === r.id;
                      const hasDetail = r.stack || r.context;
                      return (
                        <Fragment key={`g-${r.id}`}>
                          <tr
                            onClick={(e) => {
                              // Don't bubble the click up to the group-row
                              // toggle handler — clicking a row inside an
                              // expanded group should toggle that row's
                              // detail, not collapse the group itself.
                              e.stopPropagation();
                              if (hasDetail) setExpandedId(isRowOpen ? null : r.id);
                            }}
                            className={`border-b border-border last:border-0 bg-muted/5 hover:bg-muted/15 ${hasDetail ? "cursor-pointer" : ""}`}
                          >
                            <td className="px-4 py-2 pl-10 text-muted-foreground whitespace-nowrap text-xs">{fmt(r.occurred_at)}</td>
                            <td className="px-4 py-2 text-xs text-muted-foreground/70">↳</td>
                            <td className="px-4 py-2 text-foreground/90 break-words text-xs">{r.message}</td>
                          </tr>
                          {isRowOpen && hasDetail && (
                            <tr className="border-b border-border bg-muted/15">
                              <td colSpan={3} className="px-4 py-3 pl-10 space-y-2">
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
                          )}
                        </Fragment>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
