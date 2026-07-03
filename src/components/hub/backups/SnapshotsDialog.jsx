// Read-only inspector for one site's off-site (Kopia) repository. Two views:
//
//   • List — every snapshot (newest first) + a "SQL backups off-site" panel that
//     confirms the site's SQL Server .bak files actually reached the hub and are
//     fresh, per database. This is the answer to "is SQL really backing up?".
//   • Browse — click a snapshot to walk its file tree (folders → drill in,
//     breadcrumb → back up). Lets you eyeball database/sql-backups/… directly.
//
// Everything is read-only; restoring is a separate, deliberate action. Data:
//   GET /api/hub/sites/:id/kopia-snapshots            (list)
//   GET /api/hub/sites/:id/sql-offsite                (SQL panel)
//   GET /api/hub/sites/:id/kopia-snapshots/:root/ls   (tree)
// or the ?demo=1 fixtures.

import { useState, useEffect, useCallback } from "react";
import {
  Cloud, ExternalLink, RefreshCw, FileArchive, Database, ShieldCheck,
  Folder, File as FileIcon, ChevronLeft, ChevronRight, HardDrive,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toneFor } from "./backupTone.js";
import { fmtBytes, fmtRelative, fmtDate } from "./backupModel.js";
import { buildDemoKopiaSnapshots } from "./backupDemo.js";

function api(siteId, suffix) {
  return `/api/hub/sites/${encodeURIComponent(siteId)}/${suffix}`;
}

// ── SQL off-site confirmation panel ────────────────────────────────────────
function SqlOffsitePanel({ verdict }) {
  if (!verdict) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />Checking SQL backups off-site…
      </div>
    );
  }
  const tone = toneFor(verdict.status === "ok" ? "ok" : verdict.status === "stale" ? "stale" : "unknown");
  const heading =
    verdict.status === "ok" ? "SQL backups are reaching the hub"
      : verdict.status === "stale" ? "SQL backups off-site are STALE"
        : "No SQL backups in the off-site snapshot";
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${tone.chip}`}>
      <div className="flex items-center gap-2 text-xs font-semibold">
        <ShieldCheck className="h-4 w-4" />
        {heading}
        {verdict.newest_at && <span className="font-normal opacity-80">· newest {fmtRelative(verdict.newest_at)}</span>}
      </div>
      {verdict.error && <div className="mt-1 text-[11px] opacity-80">Could not read: {verdict.error}</div>}
      {verdict.databases?.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {verdict.databases.map((d) => {
            const dt = toneFor(d.status === "ok" ? "ok" : "stale");
            return (
              <span
                key={d.name}
                className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-mono ${dt.chip}`}
                title={`FULL: ${d.full_at ? fmtDate(d.full_at) : "—"}\nDIFF: ${d.diff_at ? fmtDate(d.diff_at) : "—"}`}
              >
                <Database className="h-3 w-3" />
                {d.name} · {d.newest_at ? fmtRelative(d.newest_at) : "—"}
              </span>
            );
          })}
        </div>
      ) : (
        verdict.status !== "stale" && (
          <div className="mt-1 text-[11px] opacity-80">
            This site isn't sending SQL Server backups off-site (or SQL isn't configured here).
          </div>
        )
      )}
    </div>
  );
}

// ── Snapshot file-tree browser ─────────────────────────────────────────────
function TreeBrowser({ siteId, snapshot, demo, onBack }) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null); setError(null); setLoading(true);
    const done = (list, err = null) => { if (!cancelled) { setEntries(list); setError(err); setLoading(false); } };

    if (demo) {
      const demoTree = {
        "": [
          { name: "database", isDir: true },
          { name: "uploads", isDir: true },
          { name: ".env", isDir: false, size: 2048, mtime: snapshot.endTime },
        ],
        database: [
          { name: "backups", isDir: true },
          { name: "sql-backups", isDir: true },
        ],
        "database/sql-backups": [{ name: "SRV01$SQL2019", isDir: true }],
        "database/sql-backups/SRV01$SQL2019": [
          { name: "CARDAT", isDir: true }, { name: "CARSYS", isDir: true }, { name: "PPDdata", isDir: true },
        ],
        "database/sql-backups/SRV01$SQL2019/CARDAT": [{ name: "FULL", isDir: true }, { name: "DIFF", isDir: true }],
        "database/sql-backups/SRV01$SQL2019/CARDAT/FULL": [
          { name: "SRV01$SQL2019_CARDAT_FULL_20260702_013000.bak", isDir: false, size: 10_400_000_000, mtime: snapshot.endTime },
        ],
      };
      done(demoTree[path] || []);
      return () => { cancelled = true; };
    }

    fetch(api(siteId, `kopia-snapshots/${encodeURIComponent(snapshot.rootID)}/ls?path=${encodeURIComponent(path)}`), { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        done(d.entries || [], d.error || null);
      })
      .catch((err) => done([], err.message));
    return () => { cancelled = true; };
  }, [siteId, snapshot, path, demo]);

  const segments = path ? path.split("/") : [];
  const goUp = useCallback(() => setPath(segments.slice(0, -1).join("/")), [segments]);

  return (
    <div className="space-y-2 text-sm">
      {/* Breadcrumb */}
      <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
        <button onClick={onBack} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-accent hover:bg-muted/40">
          <ChevronLeft className="h-3 w-3" />Snapshots
        </button>
        <span>/</span>
        <button onClick={() => setPath("")} className="rounded px-1.5 py-0.5 hover:bg-muted/40">{fmtRelative(snapshot.endTime)}</button>
        {segments.map((seg, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            <span>/</span>
            <button onClick={() => setPath(segments.slice(0, i + 1).join("/"))} className="rounded px-1.5 py-0.5 font-mono hover:bg-muted/40">{seg}</button>
          </span>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-xs text-muted-foreground"><RefreshCw className="h-4 w-4 animate-spin" />Reading snapshot…</div>
      ) : error ? (
        <div className="rounded-lg border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-xs text-status-critical">{error}</div>
      ) : (
        <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
          {path && (
            <button onClick={goUp} className="flex w-full items-center gap-2 border-b border-border/60 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/30">
              <ChevronLeft className="h-3.5 w-3.5" />..
            </button>
          )}
          {(!entries || entries.length === 0) ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">Empty folder.</div>
          ) : entries.map((e) => (
            e.isDir ? (
              <button
                key={e.name}
                onClick={() => setPath(path ? `${path}/${e.name}` : e.name)}
                className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-2 border-b border-border/60 px-3 py-2 text-left text-xs last:border-0 hover:bg-muted/30"
              >
                <Folder className="h-4 w-4 text-accent" />
                <span className="truncate font-medium text-foreground">{e.name}</span>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            ) : (
              <div key={e.name} className="grid grid-cols-[auto_1fr_auto] items-center gap-2 border-b border-border/60 px-3 py-2 text-xs last:border-0">
                <FileIcon className="h-4 w-4 text-muted-foreground" />
                <span className="truncate font-mono text-foreground" title={e.name}>{e.name}</span>
                <span className="whitespace-nowrap font-mono tabular-nums text-muted-foreground">{fmtBytes(e.size)}</span>
              </div>
            )
          ))}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">Read-only · restoring a backup is a separate action from the site row.</p>
    </div>
  );
}

export default function SnapshotsDialog({ site, demo, kopiaUiUrl, onOpenKopiaUi, onClose }) {
  const [snapshots, setSnapshots] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sql, setSql] = useState(null);
  const [browse, setBrowse] = useState(null); // selected snapshot to browse

  useEffect(() => {
    if (!site) return;
    let cancelled = false;
    setSnapshots(null); setError(null); setLoading(true); setSql(null); setBrowse(null);
    const done = (list, err = null) => { if (!cancelled) { setSnapshots(list); setError(err); setLoading(false); } };

    if (demo) {
      done(buildDemoKopiaSnapshots(site.site_name || site.site_id));
      setSql({
        status: "ok", newest_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
        databases: [
          { name: "CARDAT", status: "ok", newest_at: new Date(Date.now() - 2 * 3600_000).toISOString(), full_at: new Date(Date.now() - 30 * 3600_000).toISOString(), diff_at: new Date(Date.now() - 2 * 3600_000).toISOString() },
          { name: "CARSYS", status: "ok", newest_at: new Date(Date.now() - 2 * 3600_000).toISOString(), full_at: new Date(Date.now() - 30 * 3600_000).toISOString(), diff_at: new Date(Date.now() - 2 * 3600_000).toISOString() },
          { name: "PPDdata", status: "ok", newest_at: new Date(Date.now() - 2 * 3600_000).toISOString(), full_at: new Date(Date.now() - 30 * 3600_000).toISOString(), diff_at: new Date(Date.now() - 2 * 3600_000).toISOString() },
        ],
      });
      return () => { cancelled = true; };
    }

    fetch(api(site.site_id, "kopia-snapshots"), { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (d.enabled === false) return done([], "Off-site (Kopia) backups are not enabled on this hub.");
        done(d.snapshots || [], d.error || null);
      })
      .catch((err) => done([], err.message));

    fetch(api(site.site_id, "sql-offsite"), { credentials: "include" })
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setSql(d); })
      .catch(() => { if (!cancelled) setSql({ status: "never", databases: [], error: "Could not check SQL backups." }); });

    return () => { cancelled = true; };
  }, [site, demo]);

  const total = snapshots?.reduce((s, x) => s + (x.totalSize || 0), 0) ?? 0;

  return (
    <Dialog open={!!site} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cloud className="h-4 w-4 text-accent" />
            Off-site snapshots — {site?.site_name || site?.site_id}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          {browse ? (
            <TreeBrowser siteId={site.site_id} snapshot={browse} demo={demo} onBack={() => setBrowse(null)} />
          ) : (
            <>
              {/* SQL off-site confirmation — the "is SQL really backing up?" answer */}
              <SqlOffsitePanel verdict={sql} />

              {/* Snapshot summary line */}
              {!loading && snapshots && (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  <span><span className="font-semibold text-foreground tabular-nums">{snapshots.length}</span> snapshot{snapshots.length === 1 ? "" : "s"} in the repository</span>
                  <span>total <span className="font-mono text-foreground">{fmtBytes(total)}</span></span>
                </div>
              )}

              {loading ? (
                <div className="flex items-center gap-2 py-8 text-xs text-muted-foreground"><RefreshCw className="h-4 w-4 animate-spin" />Reading the Kopia repository…</div>
              ) : error ? (
                <div className="rounded-lg border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-xs text-status-critical">{error}</div>
              ) : !snapshots || snapshots.length === 0 ? (
                <div className="rounded border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                  <FileArchive className="mx-auto mb-2 h-6 w-6 opacity-40" />
                  No off-site snapshots for this site yet.
                </div>
              ) : (
                <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
                  <div className="grid grid-cols-[1.4fr_0.8fr_0.8fr_auto] gap-2 border-b border-border bg-muted/30 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <span>When</span><span>Size</span><span>Files</span><span>Browse</span>
                  </div>
                  {snapshots.map((s) => (
                    <div key={s.id || s.endTime} className="grid grid-cols-[1.4fr_0.8fr_0.8fr_auto] items-center gap-2 border-b border-border/60 px-3 py-2 text-xs last:border-0">
                      <div className="min-w-0">
                        <div className="text-foreground">{fmtRelative(s.endTime)}</div>
                        <div className="text-[10px] text-muted-foreground">{fmtDate(s.endTime)}{s.incomplete ? " · partial" : ""}</div>
                      </div>
                      <span className="font-mono tabular-nums text-foreground">{fmtBytes(s.totalSize)}</span>
                      <span className="font-mono tabular-nums text-muted-foreground">{s.fileCount != null ? s.fileCount.toLocaleString() : "—"}</span>
                      <Button
                        variant="outline" size="sm" className="h-7 px-2 text-[11px]"
                        disabled={!s.rootID} title={s.rootID ? "Browse this snapshot's files" : "This snapshot can't be browsed"}
                        onClick={() => setBrowse(s)}
                      >
                        <HardDrive className="mr-1 h-3 w-3" />Browse
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
            <span className="text-[11px] text-muted-foreground">Read-only view · full retention &amp; restore live in the Kopia UI</span>
            <div className="flex gap-2">
              {kopiaUiUrl && (
                <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => onOpenKopiaUi(kopiaUiUrl)}>
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />Open Kopia UI
                </Button>
              )}
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onClose}>Close</Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
