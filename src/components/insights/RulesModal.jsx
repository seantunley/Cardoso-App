// No-code insight rule builder. Lists custom rules and lets an admin add /
// toggle / delete them. A rule is { metric (from the engine's catalog),
// operator, threshold, severity, name } — no SQL — and the insights engine
// emits a card whenever the live metric satisfies the comparison.
import { useEffect, useState } from "react";
import { Trash2, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

async function api(url, options) {
  const res = await fetch(url, { credentials: "include", ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

const OPERATORS = [
  { value: "gt", label: "greater than (>)" },
  { value: "gte", label: "at least (≥)" },
  { value: "lt", label: "less than (<)" },
  { value: "lte", label: "at most (≤)" },
];
const SEVERITIES = ["high", "medium", "low", "info"];
const OP_SYM = { gt: ">", gte: "≥", lt: "<", lte: "≤" };

const blankDraft = (metrics) => ({
  name: "", metric: metrics[0]?.key || "", operator: "lt", threshold: "", severity: "medium", category: "Custom",
});

export default function RulesModal({ open, onClose, onChanged }) {
  const [rules, setRules] = useState([]);
  const [metrics, setMetrics] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(blankDraft([]));

  const load = () => {
    setLoading(true);
    api("/api/insights/rules")
      .then((d) => { setRules(d.rules || []); setMetrics(d.metrics || []); setDraft((cur) => cur.metric ? cur : blankDraft(d.metrics || [])); })
      .catch((e) => toast.error("Couldn't load rules", { description: e.message }))
      .finally(() => setLoading(false));
  };
  useEffect(() => { if (open) load(); }, [open]);

  if (!open) return null;
  const metricLabel = (key) => metrics.find((m) => m.key === key)?.label || key;

  const create = async () => {
    setSaving(true);
    try {
      await api("/api/insights/rules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...draft, threshold: Number(draft.threshold) }) });
      toast.success("Rule added");
      setDraft(blankDraft(metrics));
      load();
      onChanged?.();
    } catch (e) {
      toast.error("Couldn't add rule", { description: e.message });
    } finally { setSaving(false); }
  };
  const toggle = async (rule) => {
    try { await api(`/api/insights/rules/${rule.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: rule.enabled ? 0 : 1 }) }); load(); onChanged?.(); }
    catch (e) { toast.error("Update failed", { description: e.message }); }
  };
  const remove = async (rule) => {
    if (!window.confirm(`Delete rule "${rule.name}"?`)) return;
    try { await api(`/api/insights/rules/${rule.id}`, { method: "DELETE" }); load(); onChanged?.(); }
    catch (e) { toast.error("Delete failed", { description: e.message }); }
  };

  const inputCls = "w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-accent";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] w-full max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Insight rules</DialogTitle>
          <DialogDescription className="normal-case tracking-normal text-sm text-muted-foreground">
            Get an insight card whenever a metric crosses a threshold you set.
          </DialogDescription>
        </DialogHeader>

        {/* Add a rule */}
        <div className="rounded-lg border border-border bg-background p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Add a rule</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="sm:col-span-2">
              <span className="mb-1 block text-xs text-muted-foreground">Name</span>
              <input className={inputCls} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Revenue dropped sharply" />
            </label>
            <label title="The business metric to watch. Computed from the latest synced data each time insights run.">
              <span className="mb-1 block text-xs text-muted-foreground">When this metric</span>
              <select className={inputCls} value={draft.metric} onChange={(e) => setDraft({ ...draft, metric: e.target.value })}>
                {metrics.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
              </select>
            </label>
            <label title="How to compare the metric against your threshold.">
              <span className="mb-1 block text-xs text-muted-foreground">Is</span>
              <select className={inputCls} value={draft.operator} onChange={(e) => setDraft({ ...draft, operator: e.target.value })}>
                {OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label title="The value to compare against. For percentages use the number (e.g. -10 for a 10% drop); for Rand amounts use the full figure (e.g. 50000).">
              <span className="mb-1 block text-xs text-muted-foreground">Threshold</span>
              <input type="number" className={inputCls} value={draft.threshold} onChange={(e) => setDraft({ ...draft, threshold: e.target.value })} placeholder="e.g. -10 or 50000" />
            </label>
            <label title="How prominently the insight card shows when this rule fires.">
              <span className="mb-1 block text-xs text-muted-foreground">Severity</span>
              <select className={inputCls} value={draft.severity} onChange={(e) => setDraft({ ...draft, severity: e.target.value })}>
                {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          </div>
          <div className="mt-3 flex justify-end">
            <button type="button" onClick={create} disabled={saving || !draft.name || draft.threshold === ""}
              className="flex items-center gap-1.5 rounded-lg border border-amber-500 bg-amber-500/15 px-3 py-1.5 text-sm font-medium text-amber-500 hover:bg-amber-500/25 disabled:opacity-50">
              {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Add rule
            </button>
          </div>
        </div>

        {/* Existing rules */}
        <div className="mt-4">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Your rules</div>
          {loading ? (
            <p className="py-6 text-center text-sm text-muted-foreground"><RefreshCw className="mr-2 inline h-4 w-4 animate-spin" />Loading…</p>
          ) : rules.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No custom rules yet.</p>
          ) : (
            <div className="space-y-2">
              {rules.map((r) => (
                <div key={r.id} className="flex items-center gap-3 rounded-lg border border-border bg-background p-2.5">
                  <input type="checkbox" checked={!!r.enabled} onChange={() => toggle(r)} title={r.enabled ? "Enabled" : "Disabled"} className="cursor-pointer" />
                  <div className="min-w-0 flex-1">
                    <div className={`text-sm font-medium ${r.enabled ? "text-foreground" : "text-muted-foreground line-through"}`}>{r.name}</div>
                    <div className="text-xs text-muted-foreground">{metricLabel(r.metric)} {OP_SYM[r.operator]} {r.threshold} · {r.severity}</div>
                  </div>
                  <button type="button" onClick={() => remove(r)} className="rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-500" title="Delete rule">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
