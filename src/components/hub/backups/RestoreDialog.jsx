// Restore dialog — now source-aware. The old page could only restore from the
// hub's PULLED .db copies; this adds the off-site (Kopia) repo as a peer
// source, so the deepest backup layer is one click like the rest. The two
// sources load their snapshot list and submit to their own endpoints; the UI
// is otherwise identical, so an operator learns it once.
//
// Off-site endpoints (kopia-snapshots / restore-offsite) are additive and may
// not exist on an older hub build — a 404 surfaces as a plain message here
// rather than failing silently.

import { useState, useEffect, useCallback } from "react";
import { Upload, HardDrive, Cloud } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { buildDemoSnapshots } from "./backupDemo.js";

const SOURCES = {
  hub: {
    label: "Hub copy", icon: HardDrive,
    listUrl: (id) => `/api/hub/sites/${encodeURIComponent(id)}/snapshots`,
    restoreUrl: (id) => `/api/hub/sites/${encodeURIComponent(id)}/restore`,
    blurb: "Restores from the .db copy the hub pulled over the LAN.",
  },
  offsite: {
    label: "Off-site (Kopia)", icon: Cloud,
    listUrl: (id) => `/api/hub/sites/${encodeURIComponent(id)}/kopia-snapshots`,
    restoreUrl: (id) => `/api/hub/sites/${encodeURIComponent(id)}/restore-offsite`,
    blurb: "Restores from the encrypted off-site Kopia repository — the last-resort copy.",
  },
};

export default function RestoreDialog({ site, source = "hub", demo, onClose }) {
  const { toast } = useToast();
  const [tab, setTab] = useState(source);
  const [snapshots, setSnapshots] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(null);
  const [includePreviews, setIncludePreviews] = useState(true);
  const [password, setPassword] = useState("");
  const [pwError, setPwError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { setTab(source); }, [source, site]);

  // Load snapshots whenever the site or the selected source tab changes.
  useEffect(() => {
    if (!site) return;
    let cancelled = false;
    setSnapshots(null);
    setSelected(null);
    setLoading(true);
    const finish = (list) => { if (!cancelled) { setSnapshots(list); setLoading(false); } };

    if (demo) { finish(buildDemoSnapshots(tab)); return () => { cancelled = true; }; }

    fetch(SOURCES[tab].listUrl(site.site_id), { credentials: "include" })
      .then(async (r) => {
        if (r.status === 404) throw new Error("Off-site restore isn't available on this hub build yet.");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        finish(d.snapshots || []);
      })
      .catch((err) => {
        if (!cancelled) { toast({ title: "Couldn't load snapshots", description: err.message, variant: "destructive" }); finish([]); }
      });
    return () => { cancelled = true; };
  }, [site, tab, demo, toast]);

  const submit = useCallback(async () => {
    if (!site || !selected) return;
    if (!password) { setPwError("Password is required"); return; }
    setPwError("");
    setSubmitting(true);
    try {
      if (demo) {
        await new Promise((r) => setTimeout(r, 600));
        toast({ title: "Restore initiated (demo)", description: `${site.site_name}: nothing was changed — this is demo data.` });
        onClose();
        return;
      }
      const r = await fetch(SOURCES[tab].restoreUrl(site.site_id), {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          snapshot_filename: selected.filename,
          include_previews: includePreviews && !!selected.previews_filename,
          password,
        }),
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
    } finally {
      setSubmitting(false);
    }
  }, [site, selected, includePreviews, password, tab, demo, toast, onClose]);

  return (
    <Dialog open={!!site} onOpenChange={(o) => { if (!o && !submitting) onClose(); }}>
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
                <button key={key} type="button" onClick={() => setTab(key)} disabled={submitting}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${tab === key ? "border-accent/50 bg-accent/10 text-accent" : "border-border text-muted-foreground hover:bg-muted/30"}`}>
                  <Icon className="h-4 w-4" />{s.label}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">{SOURCES[tab].blurb}</p>

          <div className="rounded-lg border border-status-critical/40 bg-status-critical/5 p-3 text-xs">
            <div className="font-medium text-status-critical">⚠ This replaces the live database on the site.</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
              <li>Site stops, files swap, integrity check, restart (~30s offline)</li>
              <li>Current DB saved as <code className="rounded bg-black/30 px-1 py-0.5 text-[10px]">cardoso.db.before-restore-&lt;ts&gt;</code></li>
              <li>If the integrity check fails, the restore auto-rolls back</li>
            </ul>
          </div>

          <div>
            <div className="mb-2 text-xs font-medium text-foreground">Pick a snapshot:</div>
            {loading ? (
              <div className="text-xs text-muted-foreground">Loading snapshots…</div>
            ) : !snapshots || snapshots.length === 0 ? (
              <div className="rounded border border-dashed border-border p-3 text-xs text-muted-foreground">
                No snapshots available from {SOURCES[tab].label.toLowerCase()} for this site.
              </div>
            ) : (
              <div className="max-h-60 overflow-y-auto rounded border border-border">
                {snapshots.map((snap) => {
                  const sel = selected?.filename === snap.filename;
                  const sizeMb = snap.size_bytes != null ? (snap.size_bytes / 1048576).toFixed(1) : "?";
                  const prev = snap.previews_size_bytes != null ? `+ previews ${(snap.previews_size_bytes / 1048576).toFixed(1)} MB` : "no previews";
                  const iCls = snap.integrity === "ok" ? "text-status-ok" : snap.integrity ? "text-status-critical" : "text-muted-foreground";
                  return (
                    <button key={snap.filename} type="button" onClick={() => setSelected(snap)}
                      className={`w-full border-b border-border px-3 py-2 text-left last:border-0 hover:bg-muted/30 ${sel ? "border-l-2 border-l-accent bg-accent/10" : ""}`}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate font-mono text-[11px] text-foreground">{snap.filename}</span>
                        <span className={`font-mono text-[10px] ${iCls}`}>{snap.integrity || "unchecked"}</span>
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {snap.mtime ? new Date(snap.mtime).toLocaleString() : "unknown"} · {sizeMb} MB · {prev}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {selected?.previews_filename && (
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={includePreviews} onChange={(e) => setIncludePreviews(e.target.checked)} disabled={submitting} className="mt-0.5 h-3.5 w-3.5" />
              <span>Also restore BAT preview JPEGs from this snapshot ({(selected.previews_size_bytes / 1048576).toFixed(1)} MB).</span>
            </label>
          )}

          <div className="space-y-1.5 border-t border-border pt-2">
            <label htmlFor="restore-pw" className="text-xs font-medium text-foreground">Confirm your password</label>
            <input id="restore-pw" type="password" autoComplete="current-password"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              placeholder="Enter your password" value={password} disabled={submitting}
              onChange={(e) => { setPassword(e.target.value); setPwError(""); }}
              onKeyDown={(e) => { if (e.key === "Enter" && password && selected) submit(); }} />
            {pwError && <p className="text-xs text-status-critical">{pwError}</p>}
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
            <Button variant="destructive" onClick={submit} disabled={submitting || !selected || !password}>
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              {submitting ? "Pushing restore…" : "Yes, restore this site"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
