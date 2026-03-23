import { Database, RefreshCw, Settings, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import moment from "moment";

export default function ConnectionCard({ connection, onSync, onEdit, onDelete, isSyncing }) {
  const statusColors = {
    active: "bg-emerald-100 text-emerald-700 border-emerald-200",
    inactive: "bg-slate-100 text-slate-600 border-slate-200",
    error: "bg-rose-100 text-rose-700 border-rose-200",
    testing: "bg-blue-100 text-blue-700 border-blue-200",
  };

  const statusBgGradient = {
    active: "from-emerald-900/20 to-transparent",
    inactive: "from-slate-900/20 to-transparent",
    error: "from-rose-900/20 to-transparent",
    testing: "from-blue-900/20 to-transparent",
  };

  return (
    <div className={`group relative bg-gray-900 rounded-2xl border-2 p-6 transition-all duration-300 hover:shadow-xl hover:shadow-gray-800/50 ${
      connection.status === "active" ? "border-emerald-700" :
      connection.status === "error" ? "border-rose-700" :
      connection.status === "testing" ? "border-blue-700" :
      "border-gray-700"
    }`}>
      <div className={cn("absolute inset-0 bg-gradient-to-br rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity", statusBgGradient[connection.status])} />
      
      <div className="relative space-y-4">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-gradient-to-br from-gray-800 to-gray-850 rounded-xl">
              <Database className="w-5 h-5 text-gray-400" />
            </div>
            <div>
              <h3 className="font-semibold text-white">{connection.name}</h3>
              <p className="text-sm text-gray-400">{connection.host}</p>
            </div>
          </div>
          <Badge className={cn("border", statusColors[connection.status])}>
            {connection.status}
          </Badge>
        </div>

        <div className="grid grid-cols-2 gap-4 py-4 border-y border-gray-800">
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">Database</p>
            <p className="text-sm font-medium text-gray-300 mt-1">{connection.database_name}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">Tables</p>
            <p className="text-sm font-medium text-gray-300 mt-1">{connection.table_configs?.length || 0}</p>
          </div>
          <div className="col-span-2">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Port</p>
            <p className="text-sm font-medium text-gray-300 mt-1">{connection.port || 1433}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">Records</p>
            <p className="text-sm font-medium text-gray-300 mt-1">{connection.record_count?.toLocaleString() || 0}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase tracking-wide">Last Sync</p>
            <p className="text-sm font-medium text-gray-300 mt-1">
              {connection.last_sync ? moment(connection.last_sync).fromNow() : "Never"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button 
            onClick={() => onSync(connection)}
            disabled={isSyncing}
            className="flex-1 bg-white hover:bg-gray-100 text-gray-900"
          >
            <RefreshCw className={cn("w-4 h-4 mr-2", isSyncing && "animate-spin")} />
            {isSyncing ? "Syncing..." : "Sync Now"}
          </Button>
          <Button variant="outline" size="icon" onClick={() => onEdit(connection)} className="border-gray-700 text-gray-400 hover:bg-gray-800 hover:text-white">
            <Settings className="w-4 h-4" />
          </Button>
          <Button variant="outline" size="icon" onClick={() => onDelete(connection)} className="border-gray-700 text-rose-400 hover:text-rose-300 hover:bg-rose-900/20">
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}