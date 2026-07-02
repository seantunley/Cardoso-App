import { Database, RefreshCw, Settings, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";

export default function ConnectionCard({ connection, onSync, onEdit, onDelete, isSyncing }) {
  const statusColors = {
    active:   "bg-status-ok/10 text-status-ok border-status-ok/30",
    inactive: "bg-muted text-muted-foreground border-border",
    error:    "bg-destructive/10 text-destructive border-destructive/30",
    testing:  "bg-accent/10 text-accent border-accent/30",
  };

  const accentBar = {
    active:   "hsl(var(--status-ok))",
    inactive: "hsl(30 10% 42%)",
    error:    "hsl(var(--destructive))",
    testing:  "var(--phosphor)",
  }[connection.status] || "hsl(var(--border))";

  const accentGlow = {
    active:   "hsl(var(--status-ok) / 0.3)",
    inactive: "transparent",
    error:    "hsl(var(--status-critical) / 0.3)",
    testing:  "hsla(33, 95%, 55%, 0.35)",
  }[connection.status] || "transparent";

  const lastSync = connection.last_sync
    ? formatDistanceToNow(new Date(connection.last_sync), { addSuffix: true })
    : "never";

  return (
    <div className="group relative overflow-hidden bg-card border border-border p-4 transition-colors hover:border-[var(--phosphor)]" style={{ borderRadius: "12px" }}>
      <div
        className="absolute left-0 top-0 bottom-0 w-[2px]"
        style={{ background: accentBar, boxShadow: `0 0 12px ${accentGlow}` }}
      />

      <div className="relative space-y-3 pl-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <Database className="w-4 h-4 text-muted-foreground shrink-0" strokeWidth={1.5} />
            <div className="min-w-0">
              <h3 className="font-display text-base text-foreground leading-tight truncate">{connection.name}</h3>
              <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5 truncate">{connection.host}</p>
            </div>
          </div>
          <Badge className={cn("border font-mono text-[10px] uppercase tracking-[0.15em] shrink-0", statusColors[connection.status])} style={{ borderRadius: "12px" }}>
            {connection.status}
          </Badge>
        </div>

        {/* Compact single-row stats — db / port / tables / records / last sync */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-2.5 font-mono text-[11px] text-muted-foreground">
          <span className="truncate max-w-[40%]"><span className="text-muted-subtle">db </span><span className="text-foreground">{connection.database_name}</span></span>
          <span><span className="text-muted-subtle">port </span><span className="text-foreground tabular-nums">{connection.port || 1433}</span></span>
          <span><span className="text-foreground tabular-nums">{connection.table_configs?.length || 0}</span> tables</span>
          <span><span className="text-foreground tabular-nums">{connection.record_count?.toLocaleString("en-US") || "0"}</span> records</span>
          <span><span className="text-muted-subtle">synced </span><span className="text-foreground">{lastSync}</span></span>
        </div>

        {connection.status === "error" && connection.last_error && (
          <p className="text-[11px] text-destructive/90 break-words leading-relaxed">{connection.last_error}</p>
        )}

        <div className="flex items-center gap-2">
          <Button onClick={() => onSync(connection)} disabled={isSyncing} variant="outline" size="sm" className="flex-1">
            <RefreshCw className={cn("w-4 h-4 mr-2", isSyncing && "animate-spin")} />
            {isSyncing ? "Syncing…" : "Sync Now"}
          </Button>
          {typeof onEdit === "function" && (
            <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => onEdit(connection)}>
              <Settings className="w-4 h-4" />
            </Button>
          )}
          {typeof onDelete === "function" && (
            <Button variant="outline" size="icon" className="h-9 w-9 text-destructive hover:border-[hsl(var(--destructive))] hover:bg-status-critical/[0.18]" onClick={() => onDelete(connection)}>
              <Trash2 className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
