// Extracted from SettingsPanel.jsx (was `SystemLogTab`) so the same panel
// can be rendered from both Settings → System Log AND the new Operations
// page. The body is unchanged — only the import location moved.
//
// Reads the error_log table populated by src/lib/errorLog.js. Surfaces
// server crashes, OCR failures, Sage pool errors, and browser-side errors
// so an off-site operator can diagnose without terminal access.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { RefreshCw, AlertTriangle, CheckCircle2 } from "lucide-react";

export default function SystemLogPanel() {
  const [sourceFilter, setSourceFilter] = useState("");
  const [sinceHours, setSinceHours] = useState(24 * 7);
  const [expandedId, setExpandedId] = useState(null);

  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ["error-log", sourceFilter, sinceHours],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", "500");
      params.set("sinceHours", String(sinceHours));
      if (sourceFilter) {
        // Operator picked a specific topic — show it even if it's an
        // OCR topic that the default-view filter would hide. The server
        // honours `source=` over `exclude_prefixes=` so this just works.
        params.set("source", sourceFilter);
      } else {
        // OCR has its own dedicated Operations tab. Hide bat.ocr.* and
        // bat-ocr.* from the System Log default view so the same entry
        // doesn't appear on two screens. Server-side filter so the
        // 500-row cap applies to non-OCR topics.
        params.set("exclude_prefixes", "bat.ocr.,bat-ocr.");
      }
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
        <div className="ml-auto text-xs text-muted-foreground">
          {isLoading ? "Loading…" : `${rows.length} ${rows.length === 1 ? "entry" : "entries"}`}
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
              {rows.map((r) => {
                const isOpen = expandedId === r.id;
                const hasDetail = r.stack || r.context;
                return (
                  <>
                    <tr
                      key={r.id}
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
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
