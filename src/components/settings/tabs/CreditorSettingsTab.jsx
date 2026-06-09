import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";

// Creditor sync settings. The Sage SQL for each creditor source (registry keys
// 'creditor.*') is now managed centrally in Settings → Sage Queries; this tab
// keeps the history window + the manual "Sync now" trigger.
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

  const [historyMonths, setHistoryMonths] = useState("24");

  useEffect(() => {
    if (!data) return;
    setHistoryMonths(String(data.settings?.history_months || 24));
  }, [data]);

  const save = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/creditors/sync-settings", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history_months: Number(historyMonths) || 24 }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Save failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success("Saved");
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

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h3 className="text-base font-semibold mb-1">Creditor sync</h3>
        <p className="text-xs text-muted-foreground">
          The Sage SQL for each creditor source (vendors, AP invoices, AP payments, PO header/lines) is now managed
          centrally in <span className="text-foreground font-medium">Settings → Sage Queries</span> (queries{" "}
          <code className="bg-muted px-1 py-0.5 rounded text-[10px]">creditor.*</code>). Set the history window here,
          then run the sync.
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
            title="Run the creditor sync now"
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${sync.isPending ? "animate-spin" : ""}`} />
            Sync now
          </button>
        </div>
      </div>
    </div>
  );
}
