import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { humanizeApiError } from "@/lib/humanizeApiError";

// UI
import { Button } from "@/components/ui/button";

// Icons
import { RefreshCw, AlertTriangle } from "lucide-react";
import ReconResetModal from "@/components/reconciliation/ReconResetModal";

// Re-queues every "not_found" / "failed" OCR row back to "pending" so the
// next worker run re-attempts them. Already-matched ("found") rows are left
// alone — no risk of redoing successful extractions.
function ResetPendingOcrTool({ embedded = false }) {
  const [count, setCount] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const refresh = useCallback(() => {
    fetch('/api/bat/reset-pending-count', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setCount(d.count); })
      .catch(() => {});
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const reset = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/bat/reset-pending', { method: 'POST', credentials: 'include' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Reset failed');
      toast.success(`Re-queued ${d.reset} extraction${d.reset === 1 ? '' : 's'} for OCR.`);
      setConfirming(false);
      refresh();
    } catch (err) {
      toast.error(err.message || 'Reset failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`space-y-3 ${embedded ? '' : 'pt-4 border-t border-border'}`}>
      <div>
        <h3 className="text-sm font-semibold mb-1">Re-queue failed OCRs</h3>
        <p className="text-xs text-muted-foreground">
          Flips every <span className="font-mono">not_found</span> and <span className="font-mono">failed</span> extraction back to <span className="font-mono">pending</span> so the OCR worker re-attempts them on the next run. Already-found rows are left alone.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <div className="text-sm text-muted-foreground">
          {count == null ? 'Counting…' : count === 0 ? 'Nothing to re-queue.' : `${count} extraction${count === 1 ? '' : 's'} eligible.`}
        </div>
        {!confirming ? (
          <Button
            onClick={() => setConfirming(true)}
            disabled={busy || !count}
            variant="outline"
            size="sm"
            className="border-border text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Re-queue {count || 0}
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <Button onClick={reset} disabled={busy} variant="default" size="sm">
              {busy ? 'Working…' : `Confirm: re-queue ${count}`}
            </Button>
            <Button onClick={() => setConfirming(false)} disabled={busy} variant="outline" size="sm" className="border-border">
              Cancel
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// Per-recon reset list — companion to the global Re-queue button above.
// Lists the most recent reconciliations and lets the operator open the
// shared ReconResetModal for any one of them. Same modal the recon page
// uses; same three scopes (ALL / failed+not_found / duplicates only).
//
// Why a separate Settings entry rather than only the recon-page button:
// after an engine swap (PDFium round 6) the operator wants to walk
// through a backlog of historical recons and re-OCR each. From the recon
// page that's "navigate → reset → wait → navigate to next"; from
// Settings it's a flat list, much faster.
function PerReconResetTool({ embedded = false }) {
  const [recons, setRecons] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [openId, setOpenId] = useState(null);
  const [openLabel, setOpenLabel] = useState('');

  const refresh = useCallback(() => {
    setLoadError('');
    fetch('/api/bat/reconciliations', { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) {
          let detail = `HTTP ${r.status}`;
          try { detail = (await r.json()).error || detail; } catch {}
          throw new Error(detail);
        }
        return r.json();
      })
      .then((data) => {
        const list = Array.isArray(data?.reconciliations) ? data.reconciliations : [];
        // Most-recent-first; year DESC, then week DESC.
        list.sort((a, b) => (b.year - a.year) || (b.week_number - a.week_number));
        setRecons(list);
      })
      .catch((err) => setLoadError(err.message));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className={`space-y-3 ${embedded ? '' : 'pt-4 border-t border-border'}`}>
      <div>
        <h3 className="text-sm font-semibold mb-1">Per-recon reset</h3>
        <p className="text-xs text-muted-foreground">
          Pick a reconciliation to reset extractions for, then choose a scope:
          ALL rows, only failed/not_found, or only duplicates. Same dialog the
          Reset button on the recon page opens — convenient when working through
          a backlog after an OCR engine change.
        </p>
      </div>

      {loadError && (
        <div className="text-xs text-destructive flex items-start gap-2">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          Couldn't load reconciliations: {loadError}
        </div>
      )}

      {recons == null ? (
        <div className="text-xs text-muted-foreground">Loading reconciliations…</div>
      ) : recons.length === 0 ? (
        <div className="text-xs text-muted-foreground">No reconciliations yet.</div>
      ) : (
        <div className="border border-border bg-card overflow-hidden" style={{ borderRadius: '8px' }}>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground bg-muted/30">
                <th className="px-3 py-2">Week</th>
                <th className="px-3 py-2">Year</th>
                <th className="px-3 py-2 text-right">Rows</th>
                <th className="px-3 py-2 text-right">Found</th>
                <th className="px-3 py-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {recons.map((r) => {
                const label = `Week ${r.week_number}/${r.year}`;
                return (
                  <tr key={r.id} className="border-b border-border/40 last:border-b-0">
                    <td className="px-3 py-1.5 font-mono">{r.week_number}</td>
                    <td className="px-3 py-1.5 font-mono">{r.year}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                      {r.pod_count ?? 0}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-muted-foreground">
                      {r.found_count ?? 0}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { setOpenId(r.id); setOpenLabel(label); }}
                        className="h-7 px-2.5 text-[11px] border-border text-muted-foreground hover:text-foreground"
                      >
                        <RefreshCw className="w-3 h-3 mr-1.5" />
                        Reset…
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ReconResetModal
        open={openId != null}
        onOpenChange={(open) => { if (!open) { setOpenId(null); setOpenLabel(''); } }}
        reconciliationId={openId}
        reconLabel={openLabel}
        onResetComplete={() => refresh()}
      />
    </div>
  );
}

function OcrPauseToggle({ embedded = false }) {
  const [status, setStatus] = useState(null); // { paused, pending }
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    fetch('/api/bat/ocr-status', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setStatus(d); })
      .catch(() => {});
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const toggle = async () => {
    if (!status) return;
    const next = !status.paused;
    setBusy(true);
    try {
      const r = await fetch('/api/bat/ocr-pause', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: next }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setStatus((s) => ({ ...(s || {}), paused: d.paused }));
      toast.success(d.paused ? 'OCR paused' : (d.resumed ? 'OCR resumed — worker started' : 'OCR resumed'));
      refresh();
    } catch (err) {
      toast.error(humanizeApiError(err, "toggle OCR pause"));
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;
  const paused = !!status.paused;

  return (
    <div className={`space-y-3 ${embedded ? '' : 'pt-6 mt-6 border-t border-border'}`}>
      <div>
        <h3 className="text-sm font-semibold mb-1">Worker</h3>
        <p className="text-xs text-muted-foreground">
          When paused, no new POD invoices will be processed and the worker won't auto-resume on server restart. The currently in-flight invoice (if any) finishes before the worker stops.
        </p>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-muted-foreground tabular-nums">
          Status:{' '}
          <span className={paused ? 'text-destructive' : 'text-[hsl(145_55%_45%)]'}>
            {paused ? '● Paused' : '● Running'}
          </span>
          {' · '}
          <span className="text-foreground">{status.pending}</span> pending invoice{status.pending === 1 ? '' : 's'}
        </p>
        <button
          onClick={toggle}
          disabled={busy}
          className="px-4 py-2 border font-mono text-[10px] uppercase tracking-[0.2em] transition-colors disabled:opacity-50"
          style={{
            borderRadius: '12px',
            borderColor: paused ? 'hsl(145 55% 45%)' : 'var(--phosphor)',
            color: paused ? 'hsl(145 55% 45%)' : 'var(--phosphor)',
            background: 'transparent',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = paused ? 'hsla(145, 55%, 45%, 0.12)' : 'hsla(33, 95%, 55%, 0.12)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
        >
          {busy ? 'Working…' : (paused ? 'Resume OCR' : 'Pause OCR')}
        </button>
      </div>
    </div>
  );
}

function ReplicateSupplierTool({ embedded = false }) {
  const [stats, setStats] = useState(null);
  const [running, setRunning] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pwd, setPwd] = useState('');

  const refresh = useCallback(() => {
    fetch('/api/bat/cardoso-invoices/overwrite-stats', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setStats(d); })
      .catch(() => {});
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const handleRun = async (e) => {
    e?.preventDefault?.();
    if (!pwd) { toast.error('Admin password required'); return; }
    setRunning(true);
    try {
      const r = await fetch('/api/bat/cardoso-invoices/replicate-supplier', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast.success(`Overwrote ${d.updated} cardoso rows · ${d.totalOverwritten} total · ${d.remainingNotOverwritten} remaining`);
      setConfirmOpen(false);
      setPwd('');
      refresh();
    } catch (err) {
      toast.error(`Overwrite failed: ${err.message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className={`space-y-6 ${embedded ? '' : 'pt-6 mt-6 border-t border-border'}`}>
      <div className="flex items-baseline justify-between border-b border-border pb-2">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">§ Section</div>
          <h2 className="font-display text-2xl text-foreground leading-tight mt-0.5">Cardoso replication</h2>
        </div>
      </div>
      <div className="space-y-3">
        <h3 className="text-sm font-semibold mb-1">Replicate Supplier → Cardoso</h3>
        <p className="text-xs text-muted-foreground">
          Copies S.Pricing and S.Discount onto matching Cardoso rows (C.Pricing / C.Discount). C.DelFee is preserved. Idempotent — only touches rows that haven't been overwritten yet. <span className="text-destructive">Admin password required.</span>
        </p>
      </div>
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-muted-foreground tabular-nums">
          {stats ? `${stats.overwritten}/${stats.total} cardoso rows overwritten · ${stats.remaining} remaining` : 'Loading…'}
        </p>
        {!confirmOpen ? (
          <button
            onClick={() => setConfirmOpen(true)}
            className="px-4 py-2 border font-mono text-[10px] uppercase tracking-[0.2em] transition-colors"
            style={{
              borderRadius: '12px',
              borderColor: 'hsl(var(--destructive))',
              color: 'hsl(var(--destructive))',
              background: 'hsla(0, 72%, 50%, 0.08)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'hsla(0, 72%, 50%, 0.18)';
              e.currentTarget.style.boxShadow = '0 0 12px hsla(0, 72%, 50%, 0.35)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'hsla(0, 72%, 50%, 0.08)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          >
            Run overwrite
          </button>
        ) : (
          <form onSubmit={handleRun} className="flex items-center gap-2">
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
              placeholder="Admin password"
              className="rounded-[2px] border border-input bg-transparent px-3 py-2 text-xs font-mono focus:border-destructive focus:ring-1 focus:ring-destructive outline-none w-44"
            />
            <button
              type="submit"
              disabled={running || !pwd}
              className="px-3 py-2 border font-mono text-[10px] uppercase tracking-[0.2em] transition-colors disabled:opacity-50"
              style={{
                borderRadius: '12px',
                borderColor: 'hsl(var(--destructive))',
                color: 'hsl(var(--destructive))',
                background: 'hsla(0, 72%, 50%, 0.08)',
              }}
              onMouseEnter={(e) => {
                if (e.currentTarget.disabled) return;
                e.currentTarget.style.background = 'hsla(0, 72%, 50%, 0.18)';
                e.currentTarget.style.boxShadow = '0 0 12px hsla(0, 72%, 50%, 0.35)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'hsla(0, 72%, 50%, 0.08)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              {running ? 'Running…' : 'Confirm'}
            </button>
            <button
              type="button"
              onClick={() => { setConfirmOpen(false); setPwd(''); }}
              disabled={running}
              className="px-3 py-2 border border-border text-muted-foreground font-mono text-[10px] uppercase tracking-[0.2em] hover:text-foreground transition-colors"
              style={{ borderRadius: '12px' }}
            >
              Cancel
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// ─── Reconciliation Settings Tab ──────────────────────────────────────────
export default function ReconciliationSettingsTab() {
  const [settings, setSettings] = useState({ google_vision_key: '', ocr_space_key: '', invoice_in_digit_length: '9' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showGvKey, setShowGvKey] = useState(false);
  const [showOcrKey, setShowOcrKey] = useState(false);

  useEffect(() => {
    fetch('/api/bat/settings', { credentials: 'include' })
      .then(r => r.ok ? r.json() : {})
      .then(d => { setSettings(s => ({ ...s, ...d })); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/bat/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      if (res.ok) toast.success('Reconciliation settings saved');
      else toast.error('Failed to save');
    } catch { toast.error('Network error'); }
    finally { setSaving(false); }
  };

  const maskKey = (key) => key ? key.substring(0, 8) + '•'.repeat(Math.max(0, key.length - 12)) + key.substring(key.length - 4) : '';

  if (loading) return <div className="flex items-center justify-center py-12"><div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-foreground" /></div>;

  return (
    <div className="space-y-8">
      {/* ── OCR ─────────────────────────────────────────────────────────── */}
      <section className="space-y-6">
        <div className="flex items-baseline justify-between border-b border-border pb-2">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">§ Section</div>
            <h2 className="font-display text-2xl text-foreground leading-tight mt-0.5">OCR</h2>
          </div>
          <p className="font-mono text-[10px] text-muted-foreground">
            Pipeline · Google Vision → ocr.space E1 → E3 → Tesseract → E2
          </p>
        </div>

        {/* API keys */}
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">API keys</h3>
            <p className="text-xs text-muted-foreground">Override the env-var defaults. Stored locally in <span className="font-mono">bat_settings</span>.</p>
          </div>

          <div className="space-y-4 pl-3 border-l-2 border-border/40">
            <div className="space-y-2">
              <label className="text-xs font-medium text-foreground flex items-center justify-between">
                Google Vision API Key
                <span className="text-[10px] text-accent font-mono uppercase tracking-wider">Primary OCR</span>
              </label>
              <div className="flex gap-2">
                <input
                  type={showGvKey ? 'text' : 'password'}
                  value={settings.google_vision_key || ''}
                  onChange={e => setSettings(s => ({ ...s, google_vision_key: e.target.value }))}
                  placeholder="AIzaSy..."
                  className="flex-1 rounded-[2px] border border-input bg-transparent px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:border-[var(--phosphor)] focus:ring-1 focus:ring-[var(--phosphor)] outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowGvKey(v => !v)}
                  className="px-3 py-2 border border-border rounded-[2px] text-xs text-muted-foreground hover:text-foreground hover:border-[var(--phosphor)] transition-colors"
                >
                  {showGvKey ? 'Hide' : 'Show'}
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                From Google Cloud Console → APIs &amp; Services → Credentials. Requires Cloud Vision API enabled with billing.
              </p>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-foreground flex items-center justify-between">
                ocr.space API Key
                <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-wider">Fallback OCR</span>
              </label>
              <div className="flex gap-2">
                <input
                  type={showOcrKey ? 'text' : 'password'}
                  value={settings.ocr_space_key || ''}
                  onChange={e => setSettings(s => ({ ...s, ocr_space_key: e.target.value }))}
                  placeholder="K890..."
                  className="flex-1 rounded-[2px] border border-input bg-transparent px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:border-[var(--phosphor)] focus:ring-1 focus:ring-[var(--phosphor)] outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowOcrKey(v => !v)}
                  className="px-3 py-2 border border-border rounded-[2px] text-xs text-muted-foreground hover:text-foreground hover:border-[var(--phosphor)] transition-colors"
                >
                  {showOcrKey ? 'Hide' : 'Show'}
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                From ocr.space → My Account → API Key. Free key has rate limits. Paid key recommended.
              </p>
            </div>

            <div className="flex justify-end">
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 border font-mono text-[10px] uppercase tracking-[0.2em] transition-colors disabled:opacity-50"
                style={{
                  borderRadius: '12px',
                  borderColor: 'var(--phosphor)',
                  color: 'var(--phosphor)',
                  background: 'hsla(33, 95%, 55%, 0.08)',
                }}
                onMouseEnter={(e) => {
                  if (e.currentTarget.disabled) return;
                  e.currentTarget.style.background = 'hsla(33, 95%, 55%, 0.18)';
                  e.currentTarget.style.boxShadow = '0 0 12px hsla(33,95%,55%,0.35)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'hsla(33, 95%, 55%, 0.08)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                {saving ? 'Saving…' : 'Save Keys'}
              </button>
            </div>
          </div>
        </div>

        {/* Invoice number format — drives findInvoiceNumber's pad behaviour.
            Legacy stores use IN + 9 digits (IN000xxxxxx); newer onboarded
            sites use IN + 8 digits (IN00xxxxxx). Wrong length here means
            correctly-read invoices get padded to a non-existent number and
            never match Cardoso. */}
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Invoice number format</h3>
            <p className="text-xs text-muted-foreground">
              How many digits follow the <span className="font-mono">IN</span> prefix on this site's invoices. Used to recover dropped-zero OCR errors without over-padding correctly-read shorter numbers.
            </p>
          </div>
          <div className="space-y-2 pl-3 border-l-2 border-border/40">
            <label className="text-xs font-medium text-foreground">IN digit length</label>
            <select
              value={settings.invoice_in_digit_length || '9'}
              onChange={e => setSettings(s => ({ ...s, invoice_in_digit_length: e.target.value }))}
              className="rounded-[2px] border border-input bg-background text-foreground px-3 py-2 text-sm font-mono focus:border-[var(--phosphor)] focus:ring-1 focus:ring-[var(--phosphor)] outline-none"
            >
              <option value="8" className="bg-background text-foreground">8 digits — IN00xxxxxx</option>
              <option value="9" className="bg-background text-foreground">9 digits — IN000xxxxxx (default)</option>
            </select>
            <p className="text-[10px] text-muted-foreground">
              Saved with the API keys above via <span className="font-mono">Save Keys</span>.
            </p>
          </div>
        </div>

        {/* Worker + Re-queue — share the same section as API keys since they
            all configure the OCR pipeline. The components handle their own
            internal layout; the wrapper just gives them consistent indentation. */}
        <div className="space-y-6">
          <OcrPauseToggle embedded />
          <ResetPendingOcrTool embedded />
          <PerReconResetTool embedded />
        </div>
      </section>

      {/* ── Cardoso replication (not OCR — separate concern) ────────────── */}
      <section>
        <ReplicateSupplierTool embedded />
      </section>
    </div>
  );
}
