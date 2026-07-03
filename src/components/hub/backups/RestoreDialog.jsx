// Restore dialog — source-aware (Hub copy vs Off-site), and for the off-site
// (Kopia) source, mode-aware too:
//   • Stage & download — hub extracts the snapshot's DB from Kopia and hands it
//     to you as a download. Safe: never touches the live site.
//   • Push to live site — extract then push to the site (stop/swap/integrity/
//     auto-rollback), same destructive flow as a hub-copy restore.
// The Hub-copy source only pushes (its DB already lives on the hub).
//
// Off-site endpoints are additive; a 404 surfaces plainly rather than failing
// silently.

import { useState, useEffect, useCallback } from "react";
import { Upload, Download, HardDrive, Cloud } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { buildDemoSnapshots } from "./backupDemo.js";

const SOURCES = {
  hub: {
    label: "Hub copy", icon: HardDrive,
    listUrl: (id) => `/api/hub/sites/${encodeURIComponent(id)}/snapshots`,
    pushUrl: (id) => `/api/hub/sites/${encodeURIComponent(id)}/restore`,
    blurb: "Restores from the .db copy the hub pulled over the LAN.",
    canStage: false,
  },
  offsite: {
    label: "Off-site (Kopia)", icon: Cloud,
    listUrl: (id) => `/api/hub/sites/${encodeURIComponent(id)}/kopia-snapshots`,
    pushUrl: (id) => `/api/hub/sites/${encodeURIComponent(id)}/restore-offsite`,
    stageUrl: (id) => `/api/hub/sites/${encodeURIComponent(id)}/kopia-restore-stage`,
    blurb: "Restores from the encrypted off-site Kopia repository — the last-resort copy.",
    canStage: true,
  },
};

const snapId = (s) => s?.id || s?.filename;

export default function RestoreDialog({ site, source = "hub", demo, onClose }) {
  const { toast } = useToast();
  const [tab, setTab] = useState(source);
  const [snapshots, setSnapshots] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [includePreviews, setIncludePreviews] = useState(true);
  const [password, setPassword] = useState("");
  const [pwError, setPwError] = useState("");
  const [busy, setBusy] = useState(false);       // push in flight
  const [staging, setStaging] = useState(false);  // stage-download in flight

  useEffect(() => { setTab(source); }, [source, site]);

  useEffect(() => {
    if (!site) return;
    let cancelled = false;
    setSnapshots(null); setSelected(null); setLoading(true);
    const finish = (list) => { if (!cancelled) { setSnapshots(list); setLoading(false); } };

    if (demo) { finish(buildDemoSnapshots(tab)); return () => { cancelled = true; }; }

    fetch(SOURCES[tab].listUrl(site.site_id), { credentials: "include" })
      .then(async (r) => {
        if (r.status === 404) throw new Error("Off-site restore isn't available on this hub build yet.");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (d.enabled === false) throw new Error("Off-site (Kopia) backups are not enabled on this hub.");
        finish(d.snapshots || []);
      })
      .catch((err) => {
        if (!cancelled) { toast({ title: "Couldn't load snapshots", description: err.message, variant: "destructive" }); finish([]); }
      });
    return () => { cancelled = true; };
  }, [site, tab, demo, toast]);

  const src = SOURCES[tab];

  const stageDownload = useCallback(async () => {
    if (!site || !selected) return;
    setStaging(true);
    try {
      if (demo) { await new Promise((r) => setTimeout(r, 700)); toast({ title: "Staged (demo)", description: "Would extract the DB from Kopia and download it — nothing was changed." }); onClose(); return; }
      const r = await fetch(src.stageUrl(site.site_id), {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshot_id: snapId(selected) }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `HTTP ${r.status}`); }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `cardoso-offsite-${site.site_name || site.site_id}.db`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      toast({ title: "Off-site DB downloaded", description: `${site.site_name}: place it on the target machine deliberately.` });
      onClose();
    } catch (err) {
      toast({ title: "Stage failed", description: err.message, variant: "destructive" });
    } finally { setStaging(false); }
  }, [site, selected, src, demo, toast, onClose]);

  const pushRestore = useCallback(async () => {
    if (!site || !selected) return;
    if (!password) { setPwError("Password is required"); return; }
    setPwError(""); setBusy(true);
    try {
      if (demo) { await new Promise((r) => setTimeout(r, 700)); toast({ title: "Restore initiated (demo)", description: `${site.site_name}: nothing was changed — this is demo data.` }); onClose(); return; }
      const isOffsite = tab === "offsite";
      const body = isOffsite
        ? { snapshot_id: snapId(selected), password }
        : { snapshot_filename: selected.filename, include_previews: includePreviews && !!selected.previews_filename, password };
      const r = await fetch(src.pushUrl(site.site_id), {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 401) { setPwError(d.error || "Incorrect password"); return; }
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      toast({ title: "Restore initiated", description: `${site.site_name}: site is stopping, swapping files, and restarting. Watch the tile.` });
      onClose();
    } catch (err) {
      toast({ title: "Restore failed", description: err.message, variant: "destructive" });
    } finally { setBusy(false); }
  }, [site, selected, includePreviews, password, tab, src, demo, toast, onClose]);

  const anyBusy = busy || staging;

  return (
    <Dialog open={!!site} onOpenChange={(o) => { if (!o && !anyBusy) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Restore {site?.site_name || site?.site_id}?</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          {/* Source tabs */}
          <div className="flex gap-2">
            {Object.entries(SOURCES).map(([key, s]) => {
              const Icon = s.icon;
              return (
                <button key={key} type="button" onClick={() => setTab(key)} disabled={anyBusy}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${tab === key ? "border-accent/50 bg-accent/10 text-accent" : "border-border text-muted-foreground hover:bg-muted/30"}`}>
                  <Icon className="h-4 w-4" />{s.label}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">{src.blurb}</p>

          {/* Snapshot picker */}
          <div>
            <div className="mb-2 text-xs font-medium text-foreground">Pick a snapshot:</div>
            {loading ? (
              <div className="text-xs text-muted-foreground">Loading snapshots…</div>
            ) : !snapshots || snapshots.length === 0 ? (
              <div className="rounded border border-dashed border-border p-3 text-xs text-muted-foreground">
                No snapshots available from {src.label.toLowerCase()} for this site.
              </div>
            ) : (
              <div className="max-h-56 overflow-y-auto rounded border border-border">
                {snapshots.map((snap) => {
                  const sel = snapId(selected) === snapId(snap);
                  const sizeMb = snap.size_bytes != null ? (snap.size_bytes / 1048576).toFixed(1) : "?";
                  const prev = snap.previews_size_bytes != null ? `+ previews ${(snap.previews_size_bytes / 1048576).toFixed(1)} MB` : null;
                  const iCls = snap.integrity === "ok" ? "text-status-ok" : snap.integrity ? "text-status-critical" : "text-muted-foreground";
                  return (
                    <button key={snapId(snap)} type="button" onClick={() => setSelected(snap)}
                      className={`w-full border-b border-border px-3 py-2 text-left last:border-0 hover:bg-muted/30 ${sel ? "border-l-2 border-l-accent bg-accent/10" : ""}`}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate font-mono text-[11px] text-foreground">{snap.filename || snap.id}</span>
                        {snap.integrity && <span className={`font-mono text-[10px] ${iCls}`}>{snap.integrity}</span>}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {snap.mtime ? new Date(snap.mtime).toLocaleString() : "unknown"} · {sizeMb} MB{prev ? ` · ${prev}` : ""}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {tab === "hub" && selected?.previews_filename && (
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={includePreviews} onChange={(e) => setIncludePreviews(e.target.checked)} disabled={anyBusy} className="mt-0.5 h-3.5 w-3.5" />
              <span>Also restore BAT preview JPEGs from this snapshot ({(selected.previews_size_bytes / 1048576).toFixed(1)} MB).</span>
            </label>
          )}

          {/* Off-site safe option */}
          {src.canStage && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
              <div className="text-xs text-muted-foreground">
                <div className="font-medium text-foreground">Stage &amp; download</div>
                Extract the DB from Kopia and download it — the live site is untouched.
              </div>
              <Button variant="outline" size="sm" className="h-8 shrink-0 text-xs" disabled={!selected || anyBusy} onClick={stageDownload}>
                <Download className="mr-1.5 h-3.5 w-3.5" />{staging ? "Staging…" : "Stage & download"}
              </Button>
            </div>
          )}

          {/* Destructive push */}
          <div className="space-y-2 rounded-lg border border-status-critical/40 bg-status-critical/5 p-3">
            <div className="text-xs font-medium text-status-critical">⚠ Push to the live site — replaces its database</div>
            <ul className="list-disc space-y-0.5 pl-5 text-[11px] text-muted-foreground">
              <li>Site stops, files swap, integrity check, restart (~30s offline)</li>
              <li>Current DB saved as <code className="rounded bg-black/30 px-1 py-0.5 text-[10px]">cardoso.db.before-restore-&lt;ts&gt;</code></li>
              <li>If the integrity check fails, the restore auto-rolls back</li>
            </ul>
            <div className="space-y-1.5 pt-1">
              <label htmlFor="restore-pw" className="text-xs font-medium text-foreground">Confirm your password</label>
              <input id="restore-pw" type="password" autoComplete="current-password"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder="Enter your password" value={password} disabled={anyBusy}
                onChange={(e) => { setPassword(e.target.value); setPwError(""); }}
                onKeyDown={(e) => { if (e.key === "Enter" && password && selected) pushRestore(); }} />
              {pwError && <p className="text-xs text-status-critical">{pwError}</p>}
            </div>
            <div className="flex justify-end pt-1">
              <Button variant="destructive" size="sm" onClick={pushRestore} disabled={anyBusy || !selected || !password}>
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                {busy ? "Pushing restore…" : tab === "offsite" ? "Push to live site" : "Yes, restore this site"}
              </Button>
            </div>
          </div>

          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={onClose} disabled={anyBusy}>Cancel</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
