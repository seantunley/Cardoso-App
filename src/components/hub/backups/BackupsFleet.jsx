// The revamped Hub Backups page body — a scannable fleet table over all sites.
// Pure: everything it needs arrives as props (data + handlers), so the same
// component renders live data and the ?demo=1 fixtures, and can be tested
// without a hub. The container (pages/HubBackups.jsx) owns fetching + dialogs.

import { useMemo, useState } from "react";
import { RefreshCw, CloudDownload, Power, Search, CloudOff, ArrowUpDown, Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import SiteBackupRow from "./SiteBackupRow.jsx";
import { fleetCounts, sortModels } from "./backupModel.js";
import { TONE } from "./backupTone.js";

const SUMMARY = [
  { key: "ok", label: "Healthy", tone: TONE.ok },
  { key: "warn", label: "Overdue", tone: TONE.warn },
  { key: "critical", label: "Problems", tone: TONE.critical },
];

function SummaryTile({ label, count, tone, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-3 rounded-xl border px-4 py-2.5 text-left transition-all ${tone.chip} ${active ? `ring-2 ${tone.ring}` : "opacity-90 hover:opacity-100"}`}
    >
      <span className="text-2xl font-bold leading-none tabular-nums">{count}</span>
      <span className="text-xs font-medium opacity-80">{label}</span>
    </button>
  );
}

export default function BackupsFleet({
  models, kopiaEnabled, loading, isError, kopiaError, demo,
  syncEnabled, onToggleSync, togglingSync,
  onPullNow, pullingNow, onRefresh, refreshing,
  onPullDb, onPullConfig, downloading, downloadingConfig, onRestore,
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState({ key: "health", dir: "asc" });
  const [toneFilter, setToneFilter] = useState(null);

  const counts = useMemo(() => fleetCounts(models), [models]);

  const visible = useMemo(() => {
    let list = models;
    if (toneFilter) list = list.filter((m) => m.overallTone === toneFilter);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((m) => m.name.toLowerCase().includes(q) || (m.url || "").toLowerCase().includes(q));
    return sortModels(list, sort);
  }, [models, query, sort, toneFilter]);

  const toggleSort = (key) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-[1400px]">
        {/* Header */}
        <div className="mb-8 flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="font-display text-4xl leading-tight tracking-tight text-foreground lg:text-5xl">
                Safe, <em className="text-phosphor">every night</em>.
              </h1>
              {demo && (
                <span className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">
                  Demo data
                </span>
              )}
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              Local · Hub copy{kopiaEnabled ? " · Off-site" : ""} · SQL — one row per site, worst first.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onToggleSync} disabled={togglingSync}
              className={`h-10 text-xs ${syncEnabled ? "border-status-ok/40 text-status-ok" : "border-status-critical/40 text-status-critical"}`}>
              <Power className="mr-1.5 h-3.5 w-3.5" />{syncEnabled ? "Sync On" : "Sync Off"}
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" onClick={onPullNow} disabled={pullingNow} className="h-10 border-accent/40 text-xs text-accent">
                  {pullingNow ? <><RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />Pulling…</> : <><CloudDownload className="mr-1.5 h-3.5 w-3.5" />Pull Now</>}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Trigger an immediate backup pull from all sites</TooltipContent>
            </Tooltip>
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing} className="h-10 border-border text-xs text-muted-foreground">
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />Refresh
            </Button>
          </div>
        </div>

        {/* Off-site global failure banner */}
        {kopiaError && (
          <div className={`mb-6 flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${TONE.critical.chip}`}>
            <CloudOff className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <div className="font-semibold">Off-site (Kopia) backups are not reachable</div>
              <div className="mt-0.5 text-xs opacity-80">{kopiaError}</div>
            </div>
          </div>
        )}

        {/* Summary tiles (click to filter) */}
        <div className="mb-5 flex flex-wrap gap-3">
          {SUMMARY.map((s) => (
            <SummaryTile key={s.key} label={s.label} count={counts[s.key] || 0} tone={s.tone}
              active={toneFilter === s.key} onClick={() => setToneFilter((t) => (t === s.key ? null : s.key))} />
          ))}
          <div className="flex items-center gap-3 rounded-xl border border-accent/30 bg-accent/10 px-4 py-2.5 text-accent">
            <span className="text-2xl font-bold leading-none tabular-nums">{models.length}</span>
            <span className="text-xs font-medium opacity-80">Sites</span>
          </div>
        </div>

        {/* Toolbar */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter sites…"
              className="h-9 w-56 rounded-md border border-border bg-background pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => toggleSort("health")} className={`h-9 text-xs ${sort.key === "health" ? "border-accent/40 text-accent" : "text-muted-foreground"}`}>
            <ArrowUpDown className="mr-1.5 h-3 w-3" />Health {sort.key === "health" ? (sort.dir === "asc" ? "▼" : "▲") : ""}
          </Button>
          <Button variant="outline" size="sm" onClick={() => toggleSort("name")} className={`h-9 text-xs ${sort.key === "name" ? "border-accent/40 text-accent" : "text-muted-foreground"}`}>
            <ArrowUpDown className="mr-1.5 h-3 w-3" />Name {sort.key === "name" ? (sort.dir === "asc" ? "▼" : "▲") : ""}
          </Button>
          {(toneFilter || query) && (
            <span className="text-xs text-muted-foreground">{visible.length} of {models.length}</span>
          )}
        </div>

        {/* Table */}
        <div className="overflow-hidden rounded-xl border border-border bg-card/60">
          {/* Column header */}
          <div className="grid grid-cols-[1.4fr_auto_1fr_1fr_1fr_1fr_auto] items-center gap-3 border-b border-border bg-muted/30 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span className="pl-6">Site</span>
            <span>Health</span>
            <span className="hidden sm:block">Local</span>
            <span className="hidden sm:block">Hub copy</span>
            <span className="hidden sm:block">Off-site</span>
            <span className="hidden sm:block" title="SQL Server (DAT) backup on the remote site — separate from the local app backup">SQL</span>
            <span />
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-3 py-16 text-muted-foreground">
              <RefreshCw className="h-5 w-5 animate-spin" /><span>Polling sites…</span>
            </div>
          ) : isError ? (
            <div className={`m-3 rounded-lg border px-4 py-3 text-sm ${TONE.critical.chip}`}>
              Failed to load backup status. Make sure you're logged in with Site Backups access.
            </div>
          ) : visible.length === 0 ? (
            <div className="py-16 text-center text-muted-foreground">
              <Database className="mx-auto mb-3 h-9 w-9 opacity-30" />
              <p>{models.length === 0 ? "No sites registered yet." : "No sites match the filter."}</p>
            </div>
          ) : (
            visible.map((m) => (
              <SiteBackupRow
                key={m.id}
                model={m}
                kopiaEnabled={kopiaEnabled}
                onPullDb={onPullDb}
                onPullConfig={onPullConfig}
                downloading={downloading}
                downloadingConfig={downloadingConfig}
                onRestore={onRestore}
              />
            ))
          )}
        </div>

        <p className="mt-5 text-center text-xs text-muted-foreground/70">
          Auto-refreshes every 60s · Local OK ≤ 25h, Overdue 25–48h, Stale &gt; 48h · Click a row for detail &amp; restore
        </p>
      </div>
    </div>
  );
}
