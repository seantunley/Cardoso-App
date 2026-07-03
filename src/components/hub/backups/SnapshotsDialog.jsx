// Read-only viewer for what's actually in the off-site (Kopia) repository for
// one site: every snapshot, newest first, with when it was taken, its size and
// file count, and the snapshot id. Loads from GET
// /api/hub/sites/:id/kopia-snapshots (or the ?demo=1 fixtures). Safe — it only
// lists; restoring is a separate, deliberate action.
//
// For deeper work (file-tree browse, retention, restore) it offers a jump to
// Kopia's own web UI when KOPIA_UI_URL is configured.

import { useState, useEffect } from "react";
import { Cloud, ExternalLink, RefreshCw, FileArchive } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { fmtBytes, fmtRelative, fmtDate } from "./backupModel.js";
import { buildDemoKopiaSnapshots } from "./backupDemo.js";

export default function SnapshotsDialog({ site, demo, kopiaUiUrl, onOpenKopiaUi, onClose }) {
  const { toast } = useToast();
  const [snapshots, setSnapshots] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!site) return;
    let cancelled = false;
    setSnapshots(null); setError(null); setLoading(true);
    const done = (list, err = null) => { if (!cancelled) { setSnapshots(list); setError(err); setLoading(false); } };

    if (demo) { done(buildDemoKopiaSnapshots(site.site_name || site.site_id)); return () => { cancelled = true; }; }

    fetch(`/api/hub/sites/${encodeURIComponent(site.site_id)}/kopia-snapshots`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (d.enabled === false) return done([], "Off-site (Kopia) backups are not enabled on this hub.");
        done(d.snapshots || [], d.error || null);
      })
      .catch((err) => done([], err.message));
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
          {/* Summary line */}
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
              <div className="grid grid-cols-[1.4fr_0.8fr_0.8fr_1fr] gap-2 border-b border-border bg-muted/30 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                <span>When</span><span>Size</span><span>Files</span><span>Snapshot ID</span>
              </div>
              {snapshots.map((s) => (
                <div key={s.id || s.endTime} className="grid grid-cols-[1.4fr_0.8fr_0.8fr_1fr] gap-2 border-b border-border/60 px-3 py-2 text-xs last:border-0">
                  <div className="min-w-0">
                    <div className="text-foreground">{fmtRelative(s.endTime)}</div>
                    <div className="text-[10px] text-muted-foreground">{fmtDate(s.endTime)}</div>
                  </div>
                  <span className="font-mono tabular-nums text-foreground">{fmtBytes(s.totalSize)}</span>
                  <span className="font-mono tabular-nums text-muted-foreground">{s.fileCount != null ? s.fileCount.toLocaleString() : "—"}</span>
                  <span className="truncate font-mono text-[10px] text-muted-foreground" title={s.id || ""}>{s.id || "—"}{s.incomplete ? " (partial)" : ""}</span>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
            <span className="text-[11px] text-muted-foreground">Read-only view · file-tree browse &amp; restore live in the full Kopia UI</span>
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
