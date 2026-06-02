// Per-recon reset dialog — three scopes (ALL / failed + not_found /
// duplicates only) shown as three side-by-side cards inside one modal.
// Each card shows what would be wiped BEFORE the operator clicks, so
// the action is never a surprise.
//
// Used in two places:
//   - InvoiceMatching.jsx (the recon detail page) — opened from a
//     "Reset…" button alongside the existing "Retry" control.
//   - SettingsPanel.jsx Reconciliation section — opened from a
//     "Reset…" button per row in the recon list.
//
// The endpoint side-effects are SQL UPDATEs that take a fraction of a
// second; no progress polling needed. The operator gets a toast on
// success and onResetComplete() fires so the parent can refresh.
//
// Permission gating happens at the route — this component just calls.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, AlertTriangle, RefreshCw } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export default function ReconResetModal({
  open,
  onOpenChange,
  reconciliationId,
  reconLabel,
  onResetComplete,
}) {
  const [counts, setCounts] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');  // scope being run, '' when idle
  const [error, setError] = useState('');

  // Refetch counts every time the dialog opens — the recon's row state
  // can change between opens (manual edits, OCR progress, etc.).
  useEffect(() => {
    if (!open || !reconciliationId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setCounts(null);
    fetch(`/api/bat/reconciliations/${reconciliationId}/reset-counts`, { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) {
          let detail = `HTTP ${r.status}`;
          try { detail = (await r.json()).error || detail; } catch {} // eslint-disable-line no-empty -- error-body parse fallback; default HTTP detail is the documented contract
          throw new Error(detail);
        }
        return r.json();
      })
      .then((data) => { if (!cancelled) setCounts(data); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, reconciliationId]);

  async function runReset(scope) {
    setBusy(scope);
    setError('');
    try {
      const r = await fetch(`/api/bat/reconciliations/${reconciliationId}/reset`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      const summary =
        scope === 'duplicates'
          ? `Reset ${data.reset} row${data.reset === 1 ? '' : 's'} (${data.duplicateInvoices} duplicate invoice value${data.duplicateInvoices === 1 ? '' : 's'}). Click Extract to re-run OCR.`
          : `Reset ${data.reset} extraction${data.reset === 1 ? '' : 's'} back to pending. Click Extract to re-run OCR.`;
      toast.success(summary);
      if (typeof onResetComplete === 'function') onResetComplete(scope, data);
      onOpenChange(false);
    } catch (err) {
      setError(err.message);
      toast.error(`Reset (${scope}) failed: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-muted-foreground" />
            Reset extractions — {reconLabel || `recon #${reconciliationId}`}
          </DialogTitle>
          <DialogDescription>
            Pick a scope. Reset wipes ``extracted_invoice`` for the matching rows
            and flips them back to ``pending``. Re-run OCR via the Extract button
            on the recon page afterwards. None of these scopes touch any other
            reconciliation.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
            <Loader2 className="h-4 w-4 animate-spin" />
            Counting rows…
          </div>
        ) : error && !counts ? (
          <div className="flex items-start gap-2 text-sm text-destructive py-4">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
            <span>Couldn't load counts: {error}</span>
          </div>
        ) : counts && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 py-2">
              <ScopeCard
                title="Reset ALL"
                tone="destructive"
                impact={`${counts.total} row${counts.total === 1 ? '' : 's'}`}
                description="Wipes every row in the recon — found, not_found, failed, AND any manual edits. Use after an engine swap or when in-recon results are systematically suspect."
                disabled={busy !== '' || counts.total === 0}
                busy={busy === 'all'}
                onClick={() => runReset('all')}
              />
              <ScopeCard
                title="Reset failed + not_found"
                tone="default"
                impact={`${counts.unsuccessful} row${counts.unsuccessful === 1 ? '' : 's'}`}
                description="Cheapest re-OCR. Keeps successful (found) rows alone. Same scope as the global Re-queue Failed OCRs button, narrowed to this recon."
                disabled={busy !== '' || counts.unsuccessful === 0}
                busy={busy === 'unsuccessful'}
                onClick={() => runReset('unsuccessful')}
              />
              <ScopeCard
                title="Reset duplicates only"
                tone="warning"
                impact={
                  counts.duplicates.invoices === 0
                    ? 'No duplicates'
                    : `${counts.duplicates.rows} row${counts.duplicates.rows === 1 ? '' : 's'} across ${counts.duplicates.invoices} duplicate invoice${counts.duplicates.invoices === 1 ? '' : 's'}`
                }
                description="Wipes only rows whose extracted_invoice value appears on 2+ found rows in this recon. Targets the recurring-letterhead case where the same wrong number lands on multiple PODs."
                disabled={busy !== '' || counts.duplicates.rows === 0}
                busy={busy === 'duplicates'}
                onClick={() => runReset('duplicates')}
              />
            </div>
            {error && (
              <div className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ScopeCard({ title, tone, impact, description, disabled, busy, onClick }) {
  const toneStyle = tone === 'destructive'
    ? { borderColor: 'hsl(var(--destructive))', color: 'hsl(var(--destructive))' }
    : tone === 'warning'
      ? { borderColor: 'var(--phosphor)', color: 'var(--phosphor)' }
      : { borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' };

  return (
    <div
      className="border bg-card p-3 flex flex-col gap-2"
      style={{ borderRadius: '10px', borderColor: toneStyle.borderColor }}
    >
      <div className="font-mono text-[10px] uppercase tracking-[0.18em]" style={{ color: toneStyle.color }}>
        {title}
      </div>
      <div className="text-base font-semibold text-foreground">{impact}</div>
      <p className="text-xs text-muted-foreground leading-relaxed flex-grow">{description}</p>
      <Button
        type="button"
        variant={tone === 'destructive' ? 'destructive' : 'outline'}
        size="sm"
        disabled={disabled}
        onClick={onClick}
        className="mt-1"
      >
        {busy ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : null}
        {busy ? 'Resetting…' : 'Reset'}
      </Button>
    </div>
  );
}
