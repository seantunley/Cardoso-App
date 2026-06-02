import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Save, RotateCcw } from "lucide-react";
import { toast } from "sonner";

// Operator-editable Sage SQL for each creditor source. Defaults were
// verified against the live Sage 300 schema (APVEN/APOBL/APTCR/POPORH1/
// POPORL) but any column rename in a future Sage upgrade can be patched
// here without a code release. Empty textarea = use the built-in default.

const SOURCES = [
  {
    key: "vendor_sql_override",
    defaultKey: "vendor_sql",
    label: "Vendor master (APVEN)",
    hint: "One row per vendor. Required aliases: vendor_code, vendor_name, terms, contact, phone, email, is_active",
  },
  {
    key: "ap_invoice_sql_override",
    defaultKey: "ap_invoice_sql",
    label: "Open AP invoices (APOBL)",
    hint: "Aliases: vendor_code, document_number, document_type, document_date_int (YYYYMMDD), due_date_int, original_amount, outstanding_amount, reference",
  },
  {
    key: "ap_payment_sql_override",
    defaultKey: "ap_payment_sql",
    label: "AP payments (APTCR)",
    hint: "Aliases: vendor_code, payment_number, payment_date_int, payment_method, amount, reference, bank_code. @from / @to parameters get YYYYMMDD ints.",
  },
  {
    key: "po_header_sql_override",
    defaultKey: "po_header_sql",
    label: "Purchase orders — header (POPORH1)",
    hint: "Aliases: po_number, vendor_code, vendor_name, po_date_int, expected_date_int, status, total_amount",
  },
  {
    key: "po_line_sql_override",
    defaultKey: "po_line_sql",
    label: "Purchase orders — lines (POPORL)",
    hint: "Aliases: po_number, line_no, item_number, item_description, qty_ordered, qty_received, unit_cost, extended_cost",
  },
];

export default function CreditorSettingsTab() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["creditor-sync-settings"],
    queryFn: async () => {
      const r = await fetch("/api/creditors/sync-settings", { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
  });

  const [overrides, setOverrides] = useState({});
  const [historyMonths, setHistoryMonths] = useState("24");

  useEffect(() => {
    if (!data) return;
    const next = {};
    for (const s of SOURCES) next[s.key] = data.settings?.[s.key] || "";
    setOverrides(next);
    setHistoryMonths(String(data.settings?.history_months || 24));
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        history_months: Number(historyMonths) || 24,
      };
      // Empty string clears the override (server's COALESCE preserves the
      // existing value when null is sent; sending '' lets the operator
      // explicitly fall back to the built-in default).
      for (const s of SOURCES) body[s.key] = overrides[s.key] || "";
      const r = await fetch("/api/creditors/sync-settings", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Save failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success("Creditor SQL overrides saved");
      qc.invalidateQueries({ queryKey: ["creditor-sync-settings"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const sync = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/creditors/sync", { method: "POST", credentials: "include" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Sync failed");
      return d;
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["creditors"] });
      qc.invalidateQueries({ queryKey: ["creditors-sync-meta"] });
      const errs = Object.entries(result?.summary?.sources || {})
        .filter(([, v]) => v?.error)
        .map(([k, v]) => `${k}: ${v.error}`);
      if (errs.length) toast.warning(`Some sources failed: ${errs.join("; ")}`);
      else toast.success("Synced from Sage");
    },
    onError: (err) => toast.error(err.message),
  });

  if (isLoading) return <div className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>;
  if (isError) return <div className="text-sm text-red-400">{String(error?.message)}</div>;

  const setOverride = (key, val) => setOverrides((o) => ({ ...o, [key]: val }));
  const resetOverride = (key) => setOverrides((o) => ({ ...o, [key]: "" }));
  const defaults = data?.defaults || {};

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h3 className="text-base font-semibold mb-1">Creditor sync — Sage SQL overrides</h3>
        <p className="text-xs text-muted-foreground">
          Defaults below were verified against the live Sage 300 schema. Override any source if your install
          uses different column names or you need a tighter / wider filter. Leave a field blank to use the default.
        </p>
      </div>

      <div className="flex items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
            History window
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="1"
              max="120"
              value={historyMonths}
              onChange={(e) => setHistoryMonths(e.target.value)}
              className="h-9 w-24 rounded-lg border border-border bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <span className="text-sm text-muted-foreground">months of AP payments + POs to pull</span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate()}
            className="inline-flex items-center gap-2 rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50"
          >
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save
          </button>
          <button
            type="button"
            disabled={sync.isPending}
            onClick={() => sync.mutate()}
            title="Run the creditor sync now (does not require Save first if you only changed Sage credentials elsewhere)"
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${sync.isPending ? "animate-spin" : ""}`} />
            Sync now
          </button>
        </div>
      </div>

      <div className="space-y-5">
        {SOURCES.map((s) => {
          const val = overrides[s.key] ?? "";
          const isOverridden = val.trim().length > 0;
          return (
            <div key={s.key} className="rounded-xl border border-border bg-card p-4 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold">{s.label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{s.hint}</div>
                </div>
                <span
                  className={`text-[10px] uppercase tracking-wider rounded-full px-2 py-0.5 ${
                    isOverridden ? "bg-amber-500/15 text-amber-300" : "bg-muted text-muted-foreground"
                  }`}
                >
                  {isOverridden ? "Override active" : "Using default"}
                </span>
              </div>
              <textarea
                value={val}
                onChange={(e) => setOverride(s.key, e.target.value)}
                placeholder={`Leave blank to use the default shown below.\n\n${defaults[s.defaultKey] || ""}`}
                spellCheck={false}
                rows={8}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring resize-y"
              />
              <div className="flex items-center justify-between">
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
                    Show default query
                  </summary>
                  <pre className="mt-2 rounded-md bg-muted/30 p-3 text-[11px] overflow-auto whitespace-pre-wrap">
{defaults[s.defaultKey] || "(default not available)"}
                  </pre>
                </details>
                <button
                  type="button"
                  onClick={() => resetOverride(s.key)}
                  disabled={!isOverridden}
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Clear this override and fall back to the built-in default"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reset to default
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
