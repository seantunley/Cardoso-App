import { useState, useEffect, useCallback } from "react";
import { RefreshCw, AlertCircle, CheckCircle2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const STATUS_META = {
  success: { icon: CheckCircle2, cls: "text-green-500", tip: "Sync completed — all records pulled successfully" },
  error:   { icon: AlertCircle,  cls: "text-red-500",   tip: "Sync failed — check the note column for details" },
  partial: { icon: AlertCircle,  cls: "text-amber-500", tip: "Sync partially completed — some records may be missing" },
};

export default function HubSyncLog() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const fetchLog = useCallback(async () => {
    try {
      const res = await fetch("/api/hub/sync-log?limit=50", { credentials: "include" });
      if (res.ok) setRows(await res.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchLog(); }, [fetchLog]);

  const triggerSync = async () => {
    setSyncing(true);
    try {
      await fetch("/api/hub/sync", { method: "POST", credentials: "include" });
      setTimeout(() => { fetchLog(); setSyncing(false); }, 3000);
    } catch { setSyncing(false); }
  };

  return (
    <div className="min-h-screen bg-background">
    <div className="max-w-6xl mx-auto px-8 py-10 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 border-b border-border pb-5">
        <div>

          <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
            Every <em className="text-phosphor">event</em>.
          </h1>
          <p className="text-sm text-muted-foreground mt-3">Last 50 hub sync events</p>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button onClick={triggerSync} disabled={syncing} variant="outline" className="gap-2">
              <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} />
              {syncing ? "Syncing…" : "Sync Now"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Trigger an immediate sync pull from all registered sites</TooltipContent>
        </Tooltip>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-border border-t-foreground" />
        </div>
      ) : !rows.length ? (
        <div className="flex flex-col items-center justify-center h-40 text-muted-foreground gap-2">
          <Clock className="h-8 w-8" />
          <p className="text-sm">No sync events yet.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Site</th>
                <Tooltip><TooltipTrigger asChild><th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-default">Status</th></TooltipTrigger><TooltipContent>Whether the sync run succeeded, partially completed, or failed</TooltipContent></Tooltip>
                <Tooltip><TooltipTrigger asChild><th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-default">Records</th></TooltipTrigger><TooltipContent>Number of records pulled from this site in the sync run</TooltipContent></Tooltip>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Started</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const statusKey = row.status === "success" ? "success" : row.status === "error" ? "error" : row.status === "partial" ? "partial" : null;
                const meta = statusKey ? STATUS_META[statusKey] : null;
                const Icon = meta?.icon || Clock;
                return (
                  <tr key={i} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-2.5 text-foreground font-medium">{row.site_slug}</td>
                    <td className="px-4 py-2.5">
                      {meta ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-default inline-flex">
                              <Icon className={`h-4 w-4 ${meta.cls}`} />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>{meta.tip}</TooltipContent>
                        </Tooltip>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-default inline-flex">
                              <Clock className="h-4 w-4 text-muted-foreground" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>Sync status unknown</TooltipContent>
                        </Tooltip>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {row.records_fetched != null ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="cursor-default">{row.records_fetched}</span>
                          </TooltipTrigger>
                          <TooltipContent>{row.records_fetched} record{row.records_fetched !== 1 ? "s" : ""} fetched from {row.site_slug} in this sync run</TooltipContent>
                        </Tooltip>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap">
                      {row.started_at ? new Date(row.started_at).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground text-xs max-w-[240px] truncate">{row.error_message || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
    </div>
  );
}
