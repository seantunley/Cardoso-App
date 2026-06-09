import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

// Debtor AR open-item sync. The Sage SQL for this source (registry key
// 'debtor.ar_invoice') is now managed centrally in Settings → Sage Queries;
// this tab keeps the manual "Sync now" trigger.
export default function DebtorSettingsTab() {
  const qc = useQueryClient();

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

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h3 className="text-base font-semibold mb-1">Debtor sync</h3>
        <p className="text-xs text-muted-foreground">
          The Aged Debtors report ages the AR open-item ledger synced from Sage (AROBL). The Sage SQL for this
          source is now managed centrally in <span className="text-foreground font-medium">Settings → Sage Queries</span>
          {" "}(query <code className="bg-muted px-1 py-0.5 rounded text-[10px]">debtor.ar_invoice</code>). Run the sync
          after changing it.
        </p>
      </div>

      <div className="flex items-center gap-2">
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
    </div>
  );
}
