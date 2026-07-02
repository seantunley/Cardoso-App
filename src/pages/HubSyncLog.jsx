import { useState, useEffect, useCallback } from "react";
import { RefreshCw, AlertCircle, CheckCircle2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import DataTable from "@/components/shared/DataTable";

const STATUS_META = {
  success: { icon: CheckCircle2, cls: "text-green-500", tip: "Sync completed — all records pulled successfully" },
  error:   { icon: AlertCircle,  cls: "text-red-500",   tip: "Sync failed — check the note column for details" },
  partial: { icon: AlertCircle,  cls: "text-amber-500", tip: "Sync partially completed — some records may be missing" },
};

const statusKeyOf = (row) =>
  (row.status === "success" || row.status === "ok") ? "success"
    : row.status === "error" ? "error"
    : row.status === "partial" ? "partial"
    : null;

function StatusCell({ row }) {
  const meta = STATUS_META[statusKeyOf(row)] || null;
  const Icon = meta?.icon || Clock;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default inline-flex">
          <Icon className={cn("h-4 w-4", meta?.cls || "text-muted-foreground")} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{meta?.tip || "Sync status unknown"}</TooltipContent>
    </Tooltip>
  );
}

// Columns for the shared DataTable. Status renders an icon but sorts and
// exports on the raw status string; timestamps sort on the raw ISO value.
const SYNC_COLUMNS = [
  { key: "site_slug", label: "Site" },
  {
    key: "status", label: "Status",
    format: (_v, row) => <StatusCell row={row} />,
    sortValue: (row) => statusKeyOf(row) || "unknown",
    csv: (v) => v || "unknown",
  },
  {
    key: "records_fetched", label: "Records", align: "right",
    format: (v) => (v != null ? v : "—"),
  },
  {
    key: "started_at", label: "Started",
    format: (v) => (v ? new Date(v).toLocaleString() : "—"),
    sortValue: (row) => row.started_at || "",
    csv: (v) => v || "",
  },
  { key: "error_message", label: "Note", format: (v) => v || "—", csv: (v) => v || "" },
];

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
        <DataTable
          columns={SYNC_COLUMNS}
          rows={rows}
          rowKey={(r) => r.id ?? `${r.site_slug}-${r.started_at}`}
          storageKey="cardoso.table.hub-sync-log"
          exportName="hub-sync-log"
          toolbar
          filterPlaceholder="Filter by site, status, or note…"
          defaultSortKey="started_at"
          defaultSortDir="desc"
          defaultWidths={{ site_slug: 160, status: 90, records_fetched: 110, started_at: 200, error_message: 320 }}
          maxHeight="65vh"
        />
      )}
    </div>
    </div>
  );
}
