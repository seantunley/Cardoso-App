import { Database, RefreshCw, Settings, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";

export default function ConnectionCard({ connection, onSync, onEdit, onDelete, isSyncing }) {
  const statusColors = {
    active:   "bg-[hsl(145_55%_45%)]/10 text-[hsl(145_55%_45%)] border-[hsl(145_55%_45%)]/30",
    inactive: "bg-muted text-muted-foreground border-border",
    error:    "bg-destructive/10 text-destructive border-destructive/30",
    testing:  "bg-accent/10 text-accent border-accent/30",
  };

  const accentBar = {
    active:   "hsl(145 55% 45%)",
    inactive: "hsl(30 10% 42%)",
    error:    "hsl(var(--destructive))",
    testing:  "var(--phosphor)",
  }[connection.status] || "hsl(var(--border))";

  const accentGlow = {
    active:   "hsla(145, 55%, 45%, 0.3)",
    inactive: "transparent",
    error:    "hsla(0, 72%, 50%, 0.3)",
    testing:  "hsla(33, 95%, 55%, 0.35)",
  }[connection.status] || "transparent";

  return (
    <div className="group relative bg-card border border-border p-6 transition-colors hover:border-[var(--phosphor)]" style={{ borderRadius: "2px" }}>
      <div
        className="absolute left-0 top-0 bottom-0 w-[2px]"
        style={{ background: accentBar, boxShadow: `0 0 12px ${accentGlow}` }}
      />

      <div className="relative space-y-5 pl-2">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <Database className="w-4 h-4 text-muted-foreground shrink-0" strokeWidth={1.5} />
            <div className="min-w-0">
              <h3 className="font-display text-xl text-foreground leading-tight truncate">{connection.name}</h3>
              <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5 truncate">{connection.host}</p>
            </div>
          </div>
          <Badge className={cn("border font-mono text-[10px] uppercase tracking-[0.15em]", statusColors[connection.status])} style={{ borderRadius: "2px" }}>
            {connection.status}
          </Badge>
        </div>

        <div className="grid grid-cols-2 gap-4 py-4 border-y border-border">
          <InfoBlock label="Database" value={connection.database_name} />
          <InfoBlock label="Tables" value={(connection.table_configs?.length || 0).toString()} mono />
          <div className="col-span-2">
            <InfoBlock label="Port" value={(connection.port || 1433).toString()} mono />
          </div>
          <InfoBlock label="Records" value={connection.record_count?.toLocaleString('en-US') || "0"} mono />
          <InfoBlock
            label="Last Sync"
            value={connection.last_sync ? formatDistanceToNow(new Date(connection.last_sync), { addSuffix: true }) : "Never"}
          />
          {connection.status === "error" && connection.last_error && (
            <div className="col-span-2">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Error</p>
              <p className="text-xs font-medium text-destructive mt-1 break-words font-mono">{connection.last_error}</p>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={() => onSync(connection)}
            disabled={isSyncing}
            variant="outline"
            className="flex-1"
          >
            <RefreshCw className={cn("w-4 h-4 mr-2", isSyncing && "animate-spin")} />
            {isSyncing ? "Syncing…" : "Sync Now"}
          </Button>
          {typeof onEdit === "function" && (
            <Button variant="outline" size="icon" onClick={() => onEdit(connection)}>
              <Settings className="w-4 h-4" />
            </Button>
          )}
          {typeof onDelete === "function" && (
            <Button variant="outline" size="icon" onClick={() => onDelete(connection)} className="text-destructive hover:border-[hsl(var(--destructive))] hover:bg-[hsla(0,72%,50%,0.18)] hover:shadow-[0_0_12px_hsla(0,72%,50%,0.35)]">
              <Trash2 className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function InfoBlock({ label, value, mono }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{label}</p>
      <p className={cn("text-sm font-medium text-foreground mt-1 truncate", mono && "font-mono tabular-nums")}>{value}</p>
    </div>
  );
}
