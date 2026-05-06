// Extracted from SettingsPanel.jsx (was `UpdateTab`) so the same panel can
// be rendered from both Settings → Updates AND the new Operations page.
// The body is unchanged — only the import location moved.

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { reportClientError } from "@/lib/clientLog";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  RefreshCw, AlertCircle, CheckCircle2, AlertTriangle, Download,
} from "lucide-react";

export default function UpdatesPanel() {
  const [status, setStatus] = useState(null);
  const [info, setInfo] = useState(null);
  // Live in-progress state, populated from /api/app-version-status while an
  // update is running. `tick` is just a counter that re-renders once a second
  // so the elapsed-time string keeps updating between 4 s polls.
  const [progress, setProgress] = useState(null); // { phase, startedAt }
  const [tick, setTick] = useState(0);
  // Update-log viewer state. Populated on demand by clicking "View update log"
  // (cheap to fetch, but ~100 lines so we don't preload it on mount).
  const [logLines, setLogLines] = useState(null);
  const [logLoading, setLogLoading] = useState(false);

  useEffect(() => {
    fetch("/api/app-version-status", { credentials: "include" })
      .then(r => r.json())
      .then(d => setInfo(d))
      .catch(err => reportClientError("UpdatesPanel.versionStatus", err));
  }, []);

  const fetchUpdateLog = async () => {
    setLogLoading(true);
    try {
      const r = await fetch("/api/app-update-log", { credentials: "include" });
      const d = await r.json();
      setLogLines(d.lines || []);
    } catch (err) {
      toast.error(`Couldn't load update log: ${err.message}`);
    } finally {
      setLogLoading(false);
    }
  };

  // 1-Hz tick while an update is in progress so "(2m 18s)" advances visibly.
  useEffect(() => {
    if (status !== "updating") return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [status]);

  const handleCheck = async () => {
    setStatus("checking");
    try {
      const r = await fetch("/api/app-version-status", { credentials: "include" });
      const d = await r.json();
      setInfo(d);
      setStatus(d.updateAvailable ? "update-available" : "up-to-date");
    } catch {
      setStatus("error");
    }
  };

  const handleUpdate = async () => {
    setStatus("updating");
    try {
      const r = await fetch("/api/app-update-trigger", { method: "POST", credentials: "include" });
      const d = await r.json();
      // Backend returns { ok: true, message, mode? } on success, { ok: false, error }
      // on failure (status 500). Older check was looking for d.success or
      // d.message containing "download" — neither matches the actual response,
      // so success branch never fired and the UI hung.
      if (d.ok) {
        setStatus("updating");
        const note = d.mode === 'delta'
          ? "Delta update started — the page will reload automatically once ready."
          : "Update started — the page will reload automatically once ready.";
        toast.success(note);
        // Poll until the version changes, then reload. Each poll also
        // refreshes the live phase/startedAt so the UI message tracks where
        // the install actually is.
        const targetVersion = info?.latestVersion;
        const pollStartedAt = Date.now();
        const POLL_HARD_CAP_MS = 12 * 60 * 1000; // give up after 12 min total
        const poll = async () => {
          try {
            const pr = await fetch("/api/app-version-status", { credentials: "include" });
            if (!pr.ok) throw new Error("not ready");
            const pd = await pr.json();
            if (pd.updateRunning) {
              setProgress({ phase: pd.updatePhase, startedAt: pd.updateStartedAt });
            }
            // Update landed — reload to pick up the new bundle.
            if (pd.currentVersion && pd.currentVersion === targetVersion) {
              window.location.reload();
              return;
            }
            // Marker says the update finished but didn't land (rollback or
            // hard fail). Stop polling and surface the error — previously
            // the UI just span forever in this state until the user gave up.
            if (pd.lastUpdateFailed) {
              setInfo(pd);
              setStatus("error");
              toast.error(pd.lastUpdateError
                ? `Update failed: ${String(pd.lastUpdateError).slice(0, 200)}`
                : 'Update finished but did not land. View the log for details.');
              return;
            }
          } catch { /* service still restarting */ }
          if (Date.now() - pollStartedAt > POLL_HARD_CAP_MS) {
            setStatus("error");
            toast.error('Update did not complete within 12 minutes. Check the update log.');
            // Force a fresh fetch so the failure banner appears if the marker
            // has been written by now.
            try {
              const r = await fetch("/api/app-version-status", { credentials: "include" });
              if (r.ok) setInfo(await r.json());
            } catch {}
            return;
          }
          setTimeout(poll, 4000);
        };
        setTimeout(poll, 8000); // give it 8s before first check
      } else {
        setStatus("error");
        toast.error(d.error || d.reason || "Update failed.");
      }
    } catch {
      setStatus("error");
      toast.error("Update request failed.");
    }
  };

  // Format milliseconds since startedAt as "2m 18s". Reads `tick` only to
  // ensure React re-runs this on every interval fire.
  const formatElapsed = (startedAt) => {
    void tick;
    if (!startedAt) return null;
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  const phaseLabel = (phase) => {
    switch (phase) {
      case 'downloading': return 'Downloading installer';
      case 'verifying':   return 'Verifying SHA-256';
      case 'installing':  return 'Installing';
      case 'restarting':  return 'Restarting service';
      default:            return 'Updating';
    }
  };

  const elapsedSec = progress?.startedAt
    ? Math.floor((Date.now() - progress.startedAt) / 1000)
    : 0;
  const isStuck = elapsedSec > 8 * 60; // 8 min — sanity threshold

  return (
    <div className="space-y-6 max-w-lg">
      <div>
        <h3 className="text-sm font-semibold mb-1">Application Version</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Current: <span className="font-mono font-medium">{info?.currentVersion ?? "—"}</span>
          {info?.latestVersion && info.latestVersion !== info.currentVersion && (
            <span className="ml-3 text-amber-500 font-medium">Latest: {info.latestVersion}</span>
          )}
        </p>

        {/* Sticky failure banner. Surfaces partial-update failures that the
            in-app updater previously swallowed — e.g. file lock during the
            file swap that triggered a rollback, leaving the service running
            on the OLD version while the UI showed "Update successful". */}
        {info?.lastUpdateFailed && (
          <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 space-y-2">
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <div className="space-y-1">
                <div className="font-medium">
                  Last update did not land
                  {info.lastUpdateExpectedVersion && (
                    <span className="font-mono text-xs ml-1.5 opacity-80">
                      (tried {info.lastUpdateExpectedVersion}, still on {info.currentVersion})
                    </span>
                  )}
                </div>
                <div className="text-xs opacity-90">
                  State: <span className="font-mono">{info.lastUpdateState || 'unknown'}</span>
                  {info.lastUpdateError && (
                    <span className="block mt-1 break-words">{info.lastUpdateError}</span>
                  )}
                </div>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={fetchUpdateLog} disabled={logLoading}>
              <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", logLoading && "animate-spin")} />
              {logLoading ? 'Loading log…' : 'View update log'}
            </Button>
          </div>
        )}

        {/* Inline log viewer — shown after clicking "View update log" from
            either the failure banner above or the standalone button below. */}
        {logLines && (
          <div className="mb-4 rounded-md border border-border bg-muted/30 max-h-64 overflow-auto p-2">
            <pre className="text-[10px] font-mono leading-relaxed whitespace-pre-wrap">
              {logLines.length === 0 ? '(empty)' : logLines.join('\n')}
            </pre>
          </div>
        )}

        {status === null && (
          <Button variant="outline" size="sm" onClick={handleCheck}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Check for updates
          </Button>
        )}
        {status === "checking" && (
          <Button variant="outline" size="sm" disabled>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Checking...
          </Button>
        )}
        {status === "up-to-date" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-green-600">
              <CheckCircle2 className="h-4 w-4" /> You are on the latest version.
            </div>
            <Button variant="outline" size="sm" onClick={handleCheck}>
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Check again
            </Button>
          </div>
        )}
        {status === "update-available" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-amber-600">
              <Download className="h-4 w-4" /> Version {info?.latestVersion} is available.
            </div>
            <Button size="sm" onClick={handleUpdate}>
              <Download className="h-3.5 w-3.5 mr-1.5" /> Install update
            </Button>
          </div>
        )}
        {status === "updating" && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-accent">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              <span>
                {phaseLabel(progress?.phase)}
                {progress?.startedAt && (
                  <span className="text-muted-foreground ml-1.5">
                    ({formatElapsed(progress.startedAt)})
                  </span>
                )}
                {!progress && <span className="text-muted-foreground ml-1.5">(starting…)</span>}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              The page will reload automatically once the new service comes back up.
            </p>
            {isStuck && (
              <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400 mt-2 p-2 rounded border border-amber-500/30 bg-amber-500/5">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <span>
                  This is taking longer than expected ({formatElapsed(progress?.startedAt)}). Typical updates finish in 2–4 minutes. Check the server log on the host (<code className="text-[11px] bg-muted px-1 py-0.5 rounded">C:\Cardoso Customer App\logs\service*.log</code>) for installer errors. If the service is genuinely wedged, restart it manually.
                </span>
              </div>
            )}
          </div>
        )}
        {status === "error" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" /> Something went wrong. Check server logs.
            </div>
            <Button variant="outline" size="sm" onClick={() => { setStatus(null); }}>
              Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
