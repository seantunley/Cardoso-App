// Forecast configuration modal — edits the global forecast tuning parameters
// (lead time, order cycle, service level, min order qty) over the existing
// /api/inventory-movement/forecast-config GET/PUT endpoints. Admin-only (the
// PUT is admin-gated server-side); on save it optionally kicks a recompute so
// the table reflects the new parameters immediately.
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

async function apiFetch(url, options) {
  const res = await fetch(url, { credentials: "include", ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

const SERVICE_LEVELS = [
  { value: 0.9, label: "90%" },
  { value: 0.95, label: "95%" },
  { value: 0.97, label: "97%" },
  { value: 0.99, label: "99%" },
];

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-foreground">{label}</span>
      {hint && <span className="mb-1 block text-[11px] text-muted-foreground">{hint}</span>}
      {children}
    </label>
  );
}

export default function ForecastSettingsModal({ open, onClose, onSaved }) {
  const [form, setForm] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    apiFetch("/api/inventory-movement/forecast-config")
      .then((cfg) =>
        setForm({
          leadTimeDays: cfg.lead_time_days ?? 7,
          orderCycleDays: cfg.order_cycle_days ?? 14,
          serviceLevel: cfg.service_level ?? 0.95,
          minOrderQty: cfg.min_order_qty ?? 0,
        }),
      )
      .catch((e) => toast.error("Couldn't load forecast settings", { description: e.message }))
      .finally(() => setLoading(false));
  }, [open]);

  const set = (k) => (e) => {
    const v = e.target.value;
    setForm((f) => ({ ...f, [k]: v === "" ? "" : Number(v) }));
  };

  const handleSave = async () => {
    if (!form) return;
    setSaving(true);
    try {
      await apiFetch("/api/inventory-movement/forecast-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      toast.success("Forecast settings saved", { description: "Recomputing forecast…" });
      onSaved?.();
      onClose();
    } catch (e) {
      toast.error("Save failed", { description: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="w-full max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Forecast settings</DialogTitle>
        </DialogHeader>

        {loading || !form ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground"><RefreshCw className="mr-2 h-4 w-4 animate-spin" />Loading…</div>
        ) : (
          <div className="space-y-4">
            <Field label="Lead time (days)" hint="Days from placing an order to receiving stock. Drives reorder point + safety stock.">
              <input type="number" min={0} value={form.leadTimeDays} onChange={set("leadTimeDays")}
                className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm tabular-nums outline-none focus:border-accent" />
            </Field>
            <Field label="Order cycle (days)" hint="How many days of cover each order should target. Drives suggested order qty.">
              <input type="number" min={1} value={form.orderCycleDays} onChange={set("orderCycleDays")}
                className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm tabular-nums outline-none focus:border-accent" />
            </Field>
            <Field label="Service level" hint="Target probability of not stocking out. Higher = more safety stock.">
              <select value={form.serviceLevel} onChange={set("serviceLevel")}
                className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-accent">
                {SERVICE_LEVELS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </Field>
            <Field label="Minimum order qty" hint="Floor applied to any non-zero suggested order. 0 = no minimum.">
              <input type="number" min={0} value={form.minOrderQty} onChange={set("minOrderQty")}
                className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm tabular-nums outline-none focus:border-accent" />
            </Field>

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={onClose} className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground">
                Cancel
              </button>
              <button type="button" onClick={handleSave} disabled={saving}
                className="flex items-center gap-1.5 rounded-lg border border-amber-500 bg-amber-500/15 px-3 py-1.5 text-sm font-medium text-amber-500 hover:bg-amber-500/25 disabled:opacity-50">
                {saving && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
                Save &amp; recompute
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
