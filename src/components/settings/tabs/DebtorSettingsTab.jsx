import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Save, RotateCcw } from "lucide-react";
import { toast } from "sonner";

// Operator-editable Sage SQL for the AR open-item source (AROBL), feeding the
// Aged Debtors report. The default is the standard Sage 300 AROBL schema but
// MUST be confirmed against the live install — paste your verified query here
// if a column name differs. Empty = use the built-in default. Mirrors the
// Creditor settings tab (which does the same for AP/APOBL).

const SOURCE = {
  key: "ar_invoice_sql_override",
  defaultKey: "ar_invoice_sql",
  label: "Open AR invoices (AROBL)",
  hint: "Aliases: customer_code, document_number, document_type, document_date_int (YYYYMMDD), due_date_int, original_amount, outstanding_amount, reference",
};

export default function DebtorSettingsTab() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["debtor-sync-settings"],
    queryFn: async () => {
      const r = await fetch("/api/debtors/sync-settings", { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
  });

  const [override, setOverride] = useState("");

  useEffect(() => {
    if (!data) return;
    setOverride(data.settings?.[SOURCE.key] || "");
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      // Empty string clears the override (server COALESCE keeps the existing
      // value on null; '' explicitly falls back to the built-in default).
      const r = await fetch("/api/debtors/sync-settings", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [SOURCE.key]: override || "" }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Save failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success("AR SQL override saved");
      qc.invalidateQueries({ queryKey: ["debtor-sync-settings"] });
    },
    onError: (err) => toast.error(err.message),
  });

  const sync = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/debtors/sync", { method: "POST", credentials: "include" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Sync failed");
      return d;
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["aged-debtors"] });
      qc.invalidateQueries({ queryKey: ["debtors-sync-meta"] });
      const errs = Object.entries(result?.summary?.sources || {})
        .filter(([, v]) => v?.error)
        .map(([k, v]) => `${k}: ${v.error}`);
      if (errs.length) toast.warning(`Sync failed: ${errs.join("; ")}`);
      else toast.success(`Synced AR open items from Sage (${result?.summary?.sources?.ar_invoices?.upserted ?? 0} documents)`);
    },
    onError: (err) => toast.error(err.message),
  });

  if (isLoading) return <div className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>;
  if (isError) return <div className="text-sm text-red-400">{String(error?.message)}</div>;

  const defaults = data?.defaults || {};
  const isOverridden = override.trim().length > 0;

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h3 className="text-base font-semibold mb-1">Debtor sync — Sage SQL override</h3>
        <p className="text-xs text-muted-foreground">
          The Aged Debtors report ages the AR open-item ledger synced from Sage (AROBL). The default query
          uses the standard AROBL columns — confirm them against your install and paste a corrected query here
          if any differ. Leave blank to use the default. Then run the sync.
        </p>
      </div>

      <div className="flex items-center justify-end gap-2">
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
          title="Run the AR open-item sync now"
          className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${sync.isPending ? "animate-spin" : ""}`} />
          Sync now
        </button>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">{SOURCE.label}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{SOURCE.hint}</div>
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
          value={override}
          onChange={(e) => setOverride(e.target.value)}
          placeholder={`Leave blank to use the default shown below.\n\n${defaults[SOURCE.defaultKey] || ""}`}
          spellCheck={false}
          rows={10}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring resize-y"
        />
        <div className="flex items-center justify-between">
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
              Show default query
            </summary>
            <pre className="mt-2 rounded-md bg-muted/30 p-3 text-[11px] overflow-auto whitespace-pre-wrap">
{defaults[SOURCE.defaultKey] || "(default not available)"}
            </pre>
          </details>
          <button
            type="button"
            onClick={() => setOverride("")}
            disabled={!isOverridden}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
            title="Clear the override and fall back to the built-in default"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset to default
          </button>
        </div>
      </div>
    </div>
  );
}
