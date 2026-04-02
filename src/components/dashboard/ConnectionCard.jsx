import { Database, RefreshCw, Settings, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";

export default function ConnectionCard({ connection, onSync, onEdit, onDelete, isSyncing }) {
  const statusColors = {
    active: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    inactive: "bg-slate-500/15 text-slate-400 border-slate-500/30",
    error: "bg-rose-500/15 text-rose-400 border-rose-500/30",
    testing: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  };

  const statusBgGradient = {
    active: "from-emerald-900/20 to-transparent",
    inactive: "from-slate-900/20 to-transparent",
    error: "from-rose-900/20 to-transparent",
    testing: "from-blue-900/20 to-transparent",
  };

  return (
    <div className={`group relative bg-card rounded-2xl border-2 p-6 transition-all duration-300 hover:shadow-xl ${
      connection.status === "active" ? "border-emerald-700" :
      connection.status === "error" ? "border-rose-700" :
      connection.status === "testing" ? "border-blue-700" :
      "border-border"
    }`}>
      <div className={cn("absolute inset-0 bg-gradient-to-br rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity", statusBgGradient[connection.status])} />
      
      <div className="relative space-y-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-muted rounded-xl">
              <Database className="w-5 h-5 text-muted-foreground" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground">{connection.name}</h3>
              <p className="text-sm text-muted-foreground">{connection.host}</p>
            </div>
          </div>
          <Badge className={cn("border", statusColors[connection.status])}>
            {connection.status}
          </Badge>
        </div>

        <div className="grid grid-cols-2 gap-4 py-4 border-y border-border">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Database</p>
            <p className="text-sm font-medium text-foreground mt-1">{connection.database_name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Tables</p>
            <p className="text-sm font-medium text-foreground mt-1">{connection.table_configs?.length || 0}</p>
          </div>
          <div className="col-span-2">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Port</p>
            <p className="text-sm font-medium text-foreground mt-1">{connection.port || 1433}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Records</p>
            <p className="text-sm font-medium text-foreground mt-1">{connection.record_count?.toLocaleString('en-US') || 0}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wide">Last Sync</p>
            <p className="text-sm font-medium text-foreground mt-1">
              {connection.last_sync
                ? formatDistanceToNow(new Date(connection.last_sync), { addSuffix: true })
                : "Never"}
            </p>
          </div>
          {connection.status === "error" && connection.last_error && (
            <div className="col-span-2">
              <p className="text-xs text-muted-foreground uppercase tracking-wide">Error</p>
              <p className="text-xs font-medium text-rose-400 mt-1 break-words">{connection.last_error}</p>
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
            {isSyncing ? "Syncing..." : "Sync Now"}
          </Button>
          {typeof onEdit === "function" && (
            <Button variant="outline" size="icon" onClick={() => onEdit(connection)} className="border-border text-muted-foreground hover:bg-muted hover:text-foreground">
              <Settings className="w-4 h-4" />
            </Button>
          )}
          {typeof onDelete === "function" && (
            <Button variant="outline" size="icon" onClick={() => onDelete(connection)} className="border-border text-rose-400 hover:text-rose-300 hover:bg-rose-900/20">
              <Trash2 className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
