import { useState, useEffect } from "react";
import { toast } from "sonner";
import { useConfirm } from "@/components/shared/ConfirmProvider";

// ─── Accounting Settings Tab ──────────────────────────────────────────────
// Stores company-wide accounting parameters (currently just VAT %) used by
// the Reconciliation page to detect VAT-shaped variances between BAT and
// Sage credit notes. Backed by the bat_settings key/value table; the
// /api/bat/settings endpoint is already gated behind requireAdmin so the
// PUT here is admin-only by construction. The confirm before save is a
// guard so an admin doesn't fat-finger the rate (the value retroactively
// changes how every weekly variance is interpreted).
const VAT_DEFAULT = 15;
export default function AccountingTab() {
  const confirm = useConfirm();
  const [vatPercent, setVatPercent] = useState(VAT_DEFAULT);
  const [originalVat, setOriginalVat] = useState(VAT_DEFAULT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/bat/settings', { credentials: 'include' })
      .then(r => r.ok ? r.json() : {})
      .then(d => {
        const raw = d.vat_percent;
        const parsed = raw === undefined || raw === null || raw === ''
          ? VAT_DEFAULT
          : Number(raw);
        const v = Number.isFinite(parsed) ? parsed : VAT_DEFAULT;
        setVatPercent(v);
        setOriginalVat(v);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    const v = Number(vatPercent);
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      toast.error('VAT must be a number between 0 and 100');
      return;
    }
    if (v === originalVat) {
      toast.info('No change');
      return;
    }
    const ok = await confirm({
      title: `Change VAT rate from ${originalVat}% to ${v}%?`,
      description:
        `This affects how every weekly BAT-vs-Sage variance is interpreted on the Reconciliation page. ` +
        `Existing reconciliations are not modified, but the "Missing VAT" indicator will recalculate using the new rate.`,
      confirmLabel: "Change rate",
    });
    if (!ok) return;
    setSaving(true);
    try {
      const res = await fetch('/api/bat/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vat_percent: String(v) }),
      });
      if (res.ok) {
        toast.success(`VAT rate set to ${v}%`);
        setOriginalVat(v);
      } else {
        toast.error('Failed to save');
      }
    } catch { toast.error('Network error'); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="flex items-center justify-center py-12"><div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-foreground" /></div>;

  const dirty = Number(vatPercent) !== originalVat;

  return (
    <div className="space-y-8">
      <section className="space-y-6">
        <div className="flex items-baseline justify-between border-b border-border pb-2">
          <div>

            <h2 className="font-display text-2xl text-foreground leading-tight mt-0.5">VAT</h2>
          </div>
          <p className="font-mono text-[10px] text-muted-foreground">
            Used by Reconciliation · "Missing VAT" detector
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Standard VAT rate</h3>
            <p className="text-xs text-muted-foreground">
              The percentage applied when comparing BAT (excl. VAT) to Sage credit-note totals.
              When the variance for a week equals this percentage of the BAT amount, the Reconciliation
              page flags the row as <span className="font-mono">missing VAT</span>.
            </p>
          </div>

          <div className="space-y-4 pl-3 border-l-2 border-border/40">
            <div className="space-y-2 max-w-xs">
              <label className="text-xs font-medium text-foreground">VAT (%)</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={vatPercent}
                  onChange={e => setVatPercent(e.target.value)}
                  className="flex-1 rounded-[2px] border border-input bg-transparent px-3 py-2 text-sm font-mono placeholder:text-muted-subtle focus:border-[var(--phosphor)] focus:ring-1 focus:ring-[var(--phosphor)] outline-none"
                />
                <span className="text-sm text-muted-foreground font-mono">%</span>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Default <span className="font-mono">{VAT_DEFAULT}%</span>. Changes apply immediately to all weekly variance calculations.
              </p>
            </div>

            <div className="flex justify-end">
              <button
                onClick={handleSave}
                disabled={saving || !dirty}
                className="px-4 py-2 border font-mono text-[10px] uppercase tracking-[0.2em] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  borderRadius: '12px',
                  borderColor: 'var(--phosphor)',
                  color: 'var(--phosphor)',
                  background: dirty ? 'hsla(33, 95%, 55%, 0.08)' : 'transparent',
                }}
              >
                {saving ? 'Saving…' : dirty ? 'Save VAT rate' : 'Saved'}
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
