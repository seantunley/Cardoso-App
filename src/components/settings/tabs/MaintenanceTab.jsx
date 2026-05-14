import { useState } from "react";
import { toast } from "sonner";

// UI
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// Icons
import { RefreshCw, AlertCircle, CheckCircle2, Save, Database } from "lucide-react";

// ─── Update Tab ─────────────────────────────────────────────────────────────
export default function MaintenanceTab() {
  const [preview, setPreview] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [applying, setApplying] = useState(false);
  const [clearImportedOpen, setClearImportedOpen] = useState(false);
  const [clearingImported, setClearingImported] = useState(false);
  const [clearPassword, setClearPassword] = useState('');
  const [clearPasswordError, setClearPasswordError] = useState('');

  // Recompute-recon-totals state. Same dry-run/apply UX as the
  // dedupe-customers tool above. Why this exists: the BAT spreadsheet
  // upload upsert overwrites supplier_total per spreadsheet, so when
  // two branch spreadsheets land on the same week (Welkom + JHB, etc.)
  // the second upload's smaller fees blow away the first's. The
  // headline BAT TOTAL on the recon goes wrong with no operator-visible
  // signal. This button lets an admin scan every recon, see which ones
  // drifted, and heal them in one click without leaving the UI.
  const [reconTotalsPreview, setReconTotalsPreview] = useState(null);
  const [reconTotalsLoadingPreview, setReconTotalsLoadingPreview] = useState(false);
  const [reconTotalsApplying, setReconTotalsApplying] = useState(false);

  // Backup-now state. Mirrors the compact-database / clear-imported
  // pattern: password-confirmed, modal-gated, sticky result panel
  // shows the operator both the local outcome AND the hub-notify
  // outcome separately (one can succeed while the other fails — local
  // backup is the primary goal, hub notify is best-effort).
  const [backupOpen, setBackupOpen] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [backupPassword, setBackupPassword] = useState('');
  const [backupPasswordError, setBackupPasswordError] = useState('');
  const [backupResult, setBackupResult] = useState(null);

  // Compact-database state. Originally added in PR #246 but the
  // merge of PR #248 (Backup-now) silently dropped these declarations
  // while leaving the matching dialog JSX intact, breaking the entire
  // Maintenance tab with ReferenceError on first render. Restored
  // here. Codex catch — same merge-loss class as the v62 migration
  // (PR #228), backup.js imports (PR #223), SiteCard accpac vars
  // (PR #221), and auditlog CHECK (PR #235).
  const [compactOpen, setCompactOpen] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [compactPassword, setCompactPassword] = useState('');
  const [compactPasswordError, setCompactPasswordError] = useState('');
  const [compactResult, setCompactResult] = useState(null);

  const handleCompactDatabase = async () => {
    if (!compactPassword) {
      setCompactPasswordError('Password is required');
      return;
    }
    setCompactPasswordError('');
    setCompacting(true);
    try {
      const r = await fetch('/api/maintenance/compact-database', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: compactPassword }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 401) {
          setCompactPasswordError(d.error || 'Incorrect password');
          return;
        }
        throw new Error(d.error || 'Compact database failed');
      }
      setCompactResult(d);
      setCompactOpen(false);
      setCompactPassword('');
      const integrity = d.integrity_ok ? '' : ' (⚠ post-VACUUM integrity check FAILED — see audit log)';
      toast.success(
        `Database compacted: ${d.size_before_mb} MB → ${d.size_after_mb} MB ` +
        `(reclaimed ${d.reclaimed_mb} MB) in ${(d.elapsed_ms / 1000).toFixed(1)}s${integrity}`,
      );
    } catch (e) {
      toast.error(e.message || 'Compact database failed');
    } finally {
      setCompacting(false);
    }
  };

  const handleBackupNow = async () => {
    if (!backupPassword) {
      setBackupPasswordError('Password is required');
      return;
    }
    setBackupPasswordError('');
    setBackingUp(true);
    try {
      const r = await fetch('/api/maintenance/backup-now', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: backupPassword }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 401) {
          setBackupPasswordError(d.error || 'Incorrect password');
          return;
        }
        throw new Error(d.error || 'Backup failed');
      }
      setBackupResult(d);
      setBackupOpen(false);
      setBackupPassword('');
      const hubNote = d.hub_notified
        ? 'Hub pulled the new backup immediately.'
        : `Hub not notified yet (${d.hub_error || 'no detail'}). Hub will pick it up on its next scheduled cron tick.`;
      toast.success(
        `Backup created: ${d.backup_filename} (${d.size_mb} MB) in ${(d.elapsed_ms / 1000).toFixed(1)}s. ${hubNote}`,
      );
    } catch (e) {
      toast.error(e.message || 'Backup failed');
    } finally {
      setBackingUp(false);
    }
  };

  const handlePreview = async () => {
    setLoadingPreview(true);
    try {
      const r = await fetch('/api/maintenance/dedupe-customers', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Dry-run failed');
      setPreview(d);
      toast.success(`Dry-run complete. ${d.groups || 0} duplicate group${d.groups === 1 ? '' : 's'} found.`);
    } catch (e) {
      toast.error(e.message || 'Dry-run failed');
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleApply = async () => {
    setApplying(true);
    try {
      const r = await fetch('/api/maintenance/dedupe-customers', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Dedupe failed');
      setPreview(d);
      toast.success(`Dedupe complete. Removed ${d.totalRemoved || 0} duplicate record${d.totalRemoved === 1 ? '' : 's'}.`);
    } catch (e) {
      toast.error(e.message || 'Dedupe failed');
    } finally {
      setApplying(false);
    }
  };

  const handleReconTotalsPreview = async () => {
    setReconTotalsLoadingPreview(true);
    try {
      const r = await fetch('/api/maintenance/recompute-recon-totals', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Dry-run failed');
      setReconTotalsPreview(d);
      const n = d.mismatches?.length || 0;
      const skipped = d.skippedIncomplete?.length || 0;
      const skippedTail = skipped > 0 ? `, ${skipped} skipped (incomplete amounts)` : '';
      if (n === 0) {
        toast.success(`Dry-run complete. All ${d.scanned || 0} recon(s) already correct${skippedTail} — nothing to fix.`);
      } else {
        toast.success(`Dry-run complete. ${n} of ${d.scanned || 0} recon(s) need their BAT TOTAL recomputed${skippedTail}.`);
      }
    } catch (e) {
      toast.error(e.message || 'Dry-run failed');
    } finally {
      setReconTotalsLoadingPreview(false);
    }
  };

  const handleReconTotalsApply = async () => {
    setReconTotalsApplying(true);
    try {
      const r = await fetch('/api/maintenance/recompute-recon-totals', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Recompute failed');
      setReconTotalsPreview(d);
      const skipped = d.skippedIncomplete?.length || 0;
      const skippedTail = skipped > 0 ? `; ${skipped} skipped (incomplete amounts — re-run after their next upload)` : '';
      toast.success(`Recompute complete. Updated ${d.updated || 0} recon(s)${skippedTail}.`);
    } catch (e) {
      toast.error(e.message || 'Recompute failed');
    } finally {
      setReconTotalsApplying(false);
    }
  };

  const handleClearImportedData = async () => {
    if (!clearPassword) {
      setClearPasswordError('Password is required');
      return;
    }
    setClearPasswordError('');
    setClearingImported(true);
    try {
      const r = await fetch('/api/maintenance/clear-imported-data', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: clearPassword }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 401) {
          setClearPasswordError(d.error || 'Incorrect password');
          return;
        }
        throw new Error(d.error || 'Clear imported data failed');
      }
      setPreview(null);
      setClearImportedOpen(false);
      setClearPassword('');
      const flagMsg = d.flagsPreserved ? ` ${d.flagsPreserved} flag${d.flagsPreserved === 1 ? '' : 's'} preserved for reimport.` : '';
      toast.success(`Imported data cleared. Removed ${d.totalRemoved || 0} row${d.totalRemoved === 1 ? '' : 's'}.${flagMsg}`);
    } catch (e) {
      toast.error(e.message || 'Clear imported data failed');
    } finally {
      setClearingImported(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Backup now</h4>
          <p className="text-xs text-muted-foreground mt-1">
            Creates a fresh database snapshot in <code className="bg-muted px-1 py-0.5 rounded text-[10px]">database/backups/</code>
            {' '}immediately, instead of waiting for the daily 02:00 cron. Safe to run any time —
            backups are purely additive (a new file is created; the live database is never modified).
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            If <code className="bg-muted px-1 py-0.5 rounded text-[10px]">HUB_URL</code> is configured,
            the site also notifies the hub to pull the new file immediately so the hub mirror stays current.
            The notify is best-effort; if the hub is offline the local backup still succeeds and the hub picks
            it up on its next scheduled cron tick.
          </p>
        </div>
        {backupResult && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs space-y-1">
            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300 font-medium">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Last run: <code className="bg-muted px-1.5 py-0.5 rounded">{backupResult.backup_filename}</code> ({backupResult.size_mb} MB)
            </div>
            <div className="text-muted-foreground">
              Took {(backupResult.elapsed_ms / 1000).toFixed(1)}s · Hub notify: {backupResult.hub_notified ? '✓ pulled immediately' : '○ deferred to next cron'}
            </div>
            {!backupResult.hub_notified && backupResult.hub_error && (
              <div className="text-amber-700 dark:text-amber-400 text-[11px]">{backupResult.hub_error}</div>
            )}
          </div>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setBackupOpen(true)}
          disabled={loadingPreview || applying || clearingImported || backingUp}
        >
          <Save className="h-3.5 w-3.5 mr-1.5" />
          {backingUp ? 'Backing up...' : 'Backup now'}
        </Button>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Compact database</h4>
          <p className="text-xs text-muted-foreground mt-1">
            Reclaims disk space freed by previously-deleted records by rewriting the database
            file. <strong className="text-foreground">Non-destructive</strong> — every current row
            is preserved. The app may briefly slow down during the operation (typically a
            few seconds; up to a few minutes on a recently-bloated database).
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            A backup is taken first as a safety net, and integrity checks run before AND
            after to catch any corruption. The backup file stays on disk so you can restore
            it manually if anything else goes wrong.
          </p>
        </div>
        {compactResult && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs space-y-1">
            <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300 font-medium">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Last run: {compactResult.size_before_mb} MB → {compactResult.size_after_mb} MB
              <span className="text-emerald-600 dark:text-emerald-400">
                (reclaimed {compactResult.reclaimed_mb} MB)
              </span>
            </div>
            <div className="text-muted-foreground">
              Took {(compactResult.elapsed_ms / 1000).toFixed(1)}s · Integrity check: {compactResult.integrity_ok ? '✓ OK' : '✗ FAILED'}
            </div>
            <div className="text-muted-foreground">
              Backup saved as <code className="bg-muted px-1.5 py-0.5 rounded">{compactResult.backup_filename}</code>
            </div>
          </div>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setCompactOpen(true)}
          disabled={loadingPreview || applying || clearingImported || compacting || backingUp}
        >
          <Database className="h-3.5 w-3.5 mr-1.5" />
          {compacting ? 'Compacting...' : 'Compact database'}
        </Button>
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-1">Maintenance</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Site-only admin tools. Customer dedupe keeps the newest record per trimmed customer number, and removes older duplicates.
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handlePreview} disabled={loadingPreview || applying || clearingImported}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loadingPreview ? 'animate-spin' : ''}`} />
            {loadingPreview ? 'Running dry-run...' : 'Dry-run dedupe'}
          </Button>
          <Button size="sm" variant="destructive" onClick={handleApply} disabled={applying || loadingPreview || clearingImported || !preview}>
            <AlertCircle className="h-3.5 w-3.5 mr-1.5" />
            {applying ? 'Applying...' : 'Apply dedupe'}
          </Button>
        </div>
      </div>

      {/* Recompute BAT recon supplier_total. Heals recons whose
          headline BAT TOTAL drifted from the per-row data — usually
          because two branch spreadsheets uploaded to the same week
          and the second upload's smaller fees overwrote the first.
          Dry-run/apply pattern mirrors the Customer Dedupe above. */}
      <div>
        <h3 className="text-sm font-semibold mb-1">Recompute BAT recon totals</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Resyncs each BAT reconciliation's BAT TOTAL with the sum of its non-exception POD amounts.
          Useful when the supplier sent multiple spreadsheets for one week and the headline total drifted.
          Dry-run shows which recons would change before anything is written.
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReconTotalsPreview}
            disabled={reconTotalsLoadingPreview || reconTotalsApplying || loadingPreview || applying || clearingImported}
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${reconTotalsLoadingPreview ? 'animate-spin' : ''}`} />
            {reconTotalsLoadingPreview ? 'Running dry-run...' : 'Dry-run recon totals'}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={handleReconTotalsApply}
            disabled={reconTotalsApplying || reconTotalsLoadingPreview || loadingPreview || applying || clearingImported || !reconTotalsPreview || (reconTotalsPreview?.mismatches?.length || 0) === 0}
          >
            <AlertCircle className="h-3.5 w-3.5 mr-1.5" />
            {reconTotalsApplying ? 'Applying...' : 'Apply recon totals'}
          </Button>
        </div>

        {reconTotalsPreview && (
          <div className="mt-3 rounded-md border border-border bg-muted/20 p-3 space-y-2">
            <div className="text-xs">
              <span className="font-medium text-foreground">
                {reconTotalsPreview.dryRun ? 'Dry-run result' : 'Applied'}:
              </span>{' '}
              <span className="text-foreground tabular-nums">
                {(reconTotalsPreview.mismatches?.length || 0)}
              </span>{' '}
              of {reconTotalsPreview.scanned || 0} recon(s) drifted
              {!reconTotalsPreview.dryRun && (
                <>; updated <span className="text-emerald-400 tabular-nums">{reconTotalsPreview.updated || 0}</span></>
              )}
              {(reconTotalsPreview.skippedIncomplete?.length || 0) > 0 && (
                <>; <span className="text-amber-400 tabular-nums">{reconTotalsPreview.skippedIncomplete.length}</span> skipped (incomplete amounts)</>
              )}.
            </div>
            {(reconTotalsPreview.mismatches?.length || 0) > 0 && (
              <div className="max-h-48 overflow-y-auto pr-1">
                <table className="w-full text-[11px] tabular-nums">
                  <thead>
                    <tr className="text-muted-foreground border-b border-border">
                      <th className="text-left pr-2 pb-1 font-medium">Week</th>
                      <th className="text-right px-2 pb-1 font-medium">Current</th>
                      <th className="text-right px-2 pb-1 font-medium">Derived</th>
                      <th className="text-right pl-2 pb-1 font-medium">Diff</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reconTotalsPreview.mismatches.map((m) => (
                      <tr key={m.id} className="border-b border-border/40 last:border-0">
                        <td className="pr-2 py-1 font-mono">W{String(m.week_number).padStart(2, '0')}/{m.year}</td>
                        <td className="text-right px-2 py-1">R {Number(m.current_total || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        <td className="text-right px-2 py-1">R {Number(m.derived_total || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        <td className={`text-right pl-2 py-1 ${m.diff > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {m.diff > 0 ? '+' : ''}R {Number(m.diff || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(reconTotalsPreview.skippedIncomplete?.length || 0) > 0 && (
              <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/5 p-2 space-y-1.5">
                <div className="text-[11px] font-medium text-amber-300">
                  Skipped — incomplete order_amount data (would corrupt the total if recomputed):
                </div>
                <div className="max-h-32 overflow-y-auto pr-1">
                  <table className="w-full text-[11px] tabular-nums">
                    <thead>
                      <tr className="text-muted-foreground/80 border-b border-amber-500/20">
                        <th className="text-left pr-2 pb-1 font-medium">Week</th>
                        <th className="text-right px-2 pb-1 font-medium">PODs</th>
                        <th className="text-right px-2 pb-1 font-medium">Missing amount</th>
                        <th className="text-right pl-2 pb-1 font-medium">Current total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reconTotalsPreview.skippedIncomplete.map((s) => (
                        <tr key={s.id} className="border-b border-amber-500/10 last:border-0">
                          <td className="pr-2 py-1 font-mono">W{String(s.week_number).padStart(2, '0')}/{s.year}</td>
                          <td className="text-right px-2 py-1">{s.pod_count || 0}</td>
                          <td className="text-right px-2 py-1 text-amber-300">{s.missing_amount_count || 0}</td>
                          <td className="text-right pl-2 py-1">R {Number(s.current_total || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="text-[10px] text-muted-foreground">
                  Order amounts for these recons get filled in by a later week's upload (the cross-week backfill pass). Re-run after the next upload completes — incomplete weeks will move out of this list once their amounts land.
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <Dialog open={backupOpen} onOpenChange={(open) => { setBackupOpen(open); if (!open) { setBackupPassword(''); setBackupPasswordError(''); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create a backup now?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              A timestamped database snapshot is written to <code className="bg-muted px-1 py-0.5 rounded text-[10px]">database/backups/</code>.
              The live database is not modified.
            </p>
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
              <div className="font-medium text-foreground">After the local backup lands:</div>
              <ul className="list-disc pl-5 space-y-0.5">
                <li>The hub is notified (if <code className="bg-muted px-1 py-0.5 rounded text-[10px]">HUB_URL</code> is set) and pulls the new file within seconds</li>
                <li>If the hub is unreachable, the local backup still succeeds; the hub catches up on its next scheduled cron tick</li>
                <li>An audit-log entry records who triggered this and what was created</li>
              </ul>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="backup-password" className="text-xs font-medium text-foreground">Confirm your password</label>
              <input
                id="backup-password"
                type="password"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder="Enter your password"
                value={backupPassword}
                onChange={(e) => { setBackupPassword(e.target.value); setBackupPasswordError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && backupPassword) handleBackupNow(); }}
                disabled={backingUp}
                autoComplete="current-password"
              />
              {backupPasswordError && <p className="text-xs text-destructive">{backupPasswordError}</p>}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setBackupOpen(false)} disabled={backingUp}>Cancel</Button>
              <Button onClick={handleBackupNow} disabled={backingUp || !backupPassword}>
                <Save className="h-3.5 w-3.5 mr-1.5" />
                {backingUp ? 'Backing up...' : 'Yes, back up now'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 space-y-3">
        <div>
          <h4 className="text-sm font-semibold text-foreground">Clear imported SQL data</h4>
          <p className="text-xs text-muted-foreground mt-1">
            Permanently removes imported customer records, imported inventory, and sync history from this site. Users and SQL connections stay intact.
          </p>
        </div>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => setClearImportedOpen(true)}
          disabled={loadingPreview || applying || clearingImported}
        >
          <AlertCircle className="h-3.5 w-3.5 mr-1.5" />
          {clearingImported ? 'Clearing...' : 'Clear imported data'}
        </Button>
      </div>

      <Dialog open={compactOpen} onOpenChange={(open) => { setCompactOpen(open); if (!open) { setCompactPassword(''); setCompactPasswordError(''); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Compact the database?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              This rewrites the database file to reclaim disk space freed by previously-deleted
              records. <strong className="text-foreground">It does NOT remove any current data</strong>
              {' '}— every row in every table is preserved.
            </p>
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-amber-700 dark:text-amber-300 text-xs space-y-1">
              <div className="font-medium">During the operation:</div>
              <ul className="list-disc pl-5 space-y-0.5">
                <li>The database is exclusively locked — other users may briefly see slow responses</li>
                <li>Typical run is a few seconds; up to a few minutes on a heavily-bloated DB</li>
                <li>The service stays running throughout — no restart needed</li>
              </ul>
            </div>
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
              <div className="font-medium text-foreground">Safety steps run automatically:</div>
              <ul className="list-disc pl-5 space-y-0.5">
                <li>A timestamped backup of the live database is saved to <code className="bg-muted px-1 py-0.5 rounded text-[10px]">database/</code> first</li>
                <li>Pre-VACUUM integrity check — refuses if the database is already corrupt</li>
                <li>Post-VACUUM integrity check — surfaces any new issue immediately</li>
                <li>Full audit-log entry recording the before/after sizes and your password-confirmed action</li>
              </ul>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="compact-password" className="text-xs font-medium text-foreground">Confirm your password</label>
              <input
                id="compact-password"
                type="password"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder="Enter your password"
                value={compactPassword}
                onChange={(e) => { setCompactPassword(e.target.value); setCompactPasswordError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && compactPassword) handleCompactDatabase(); }}
                disabled={compacting}
                autoComplete="current-password"
              />
              {compactPasswordError && <p className="text-xs text-destructive">{compactPasswordError}</p>}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setCompactOpen(false)} disabled={compacting}>Cancel</Button>
              <Button onClick={handleCompactDatabase} disabled={compacting || !compactPassword}>
                <Database className="h-3.5 w-3.5 mr-1.5" />
                {compacting ? 'Compacting...' : 'Yes, compact the database'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={clearImportedOpen} onOpenChange={(open) => { setClearImportedOpen(open); if (!open) { setClearPassword(''); setClearPasswordError(''); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Clear imported SQL data?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-destructive">
              Warning: this permanently removes imported customer records, inventory records, and sync history from this site database.
            </div>
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-amber-700 dark:text-amber-300">
              Customer flags and notes will be preserved and automatically restored when data is reimported.
            </div>
            <p className="text-muted-foreground">
              Users and SQL connections will be kept.
            </p>
            <div className="space-y-1.5">
              <label htmlFor="clear-password" className="text-xs font-medium text-foreground">Confirm your password</label>
              <input
                id="clear-password"
                type="password"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                placeholder="Enter your password"
                value={clearPassword}
                onChange={(e) => { setClearPassword(e.target.value); setClearPasswordError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && clearPassword) handleClearImportedData(); }}
                disabled={clearingImported}
                autoComplete="current-password"
              />
              {clearPasswordError && <p className="text-xs text-destructive">{clearPasswordError}</p>}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setClearImportedOpen(false)} disabled={clearingImported}>Cancel</Button>
              <Button variant="destructive" onClick={handleClearImportedData} disabled={clearingImported || !clearPassword}>
                <AlertCircle className="h-3.5 w-3.5 mr-1.5" />
                {clearingImported ? 'Clearing...' : 'Yes, clear it permanently'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {preview && (
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div className="flex flex-wrap gap-4 text-sm">
            <div><span className="text-muted-foreground">Mode:</span> <span className="font-medium text-foreground">{preview.dryRun ? 'Dry-run' : 'Applied'}</span></div>
            <div><span className="text-muted-foreground">Duplicate groups:</span> <span className="font-medium text-foreground">{preview.groups ?? 0}</span></div>
            <div><span className="text-muted-foreground">Rows to remove:</span> <span className="font-medium text-foreground">{preview.totalRemoved ?? 0}</span></div>
          </div>
          <div className="max-h-80 overflow-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase">Customer #</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase">Keep ID</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase">Remove</th>
                </tr>
              </thead>
              <tbody>
                {(preview.report || []).slice(0, 100).map((group) => (
                  <tr key={group.customer_number} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-mono text-xs text-foreground">{group.customer_number}</td>
                    <td className="px-3 py-2 text-muted-foreground">{group.kept_id}</td>
                    <td className="px-3 py-2 text-muted-foreground">{group.removed_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.groups > 100 && (
            <p className="text-xs text-muted-foreground">Showing first 100 duplicate groups.</p>
          )}
        </div>
      )}
    </div>
  );
}
