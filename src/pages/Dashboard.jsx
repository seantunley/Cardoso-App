import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/apiClient";
import { FileText, Database, Flag, Clock, AlertCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

function relativeTime(dateStr) {
  if (!dateStr) return "never";
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins !== 1 ? "s" : ""} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs !== 1 ? "s" : ""} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days !== 1 ? "s" : ""} ago`;
}

const FLAG_COLORS = {
  red: "bg-red-500",
  orange: "bg-orange-400",
  green: "bg-green-500",
  none: "bg-muted-foreground/40",
};

const FLAG_TOOLTIPS = {
  red: "Red — blocked or high-risk customers",
  orange: "Orange — caution, requires attention",
  green: "Green — good standing",
  none: "No flag — unflagged records",
};

export default function Dashboard() {
  const { data: kpis, isError: kpisError } = useQuery({
    queryKey: ["kpis"],
    queryFn: () => api.kpis(),
    staleTime: 30_000,
  });

  const { data: connections = [] } = useQuery({
    queryKey: ["connections"],
    queryFn: () => api.entities.DatabaseConnection.list(),
  });

  const totalRecords = kpisError ? "--" : (kpis?.total_records?.toLocaleString("en-US") ?? "--");
  const flags = kpis?.records_by_flag ?? {};
  const lastSync = kpis?.last_sync_at ?? null;
  const activeCount = connections.filter((c) => c.status === "active").length;

  if (connections.length === 0 && !kpis) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-7xl mx-auto p-6 lg:p-8 space-y-8">
          <div>
            <h1 className="text-2xl font-bold text-foreground tracking-tight">Dashboard</h1>
            <p className="text-muted-foreground mt-1">Overview of your data sync system</p>
          </div>
          <div className="flex flex-col items-center justify-center py-20 rounded-2xl border border-border bg-card">
            <Database className="w-12 h-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium text-foreground">No connections set up yet</h3>
            <p className="text-muted-foreground mt-1">Set up a connection to start syncing data</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-7xl mx-auto p-6 lg:p-8 space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground mt-1">Overview of your data sync system</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {/* Total Records */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="rounded-2xl border border-border bg-card p-6 cursor-default">
                <div className="flex items-start justify-between">
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Total Records</p>
                    <p className="text-4xl font-bold text-foreground tracking-tight">{totalRecords}</p>
                  </div>
                  <div className="p-3 rounded-xl bg-muted">
                    <FileText className="w-6 h-6 text-muted-foreground" />
                  </div>
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent>Total customer records synced from all active connections</TooltipContent>
          </Tooltip>

          {/* Connections */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="rounded-2xl border border-border bg-card p-6 cursor-default">
                <div className="flex items-start justify-between">
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Connections</p>
                    <p className="text-4xl font-bold text-foreground tracking-tight">{connections.length}</p>
                    <p className="text-sm text-muted-foreground">{activeCount} active</p>
                  </div>
                  <div className="p-3 rounded-xl bg-muted">
                    <Database className="w-6 h-6 text-muted-foreground" />
                  </div>
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent>Configured database connections — {activeCount} currently active and syncing</TooltipContent>
          </Tooltip>

          {/* Flags */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="rounded-2xl border border-border bg-card p-6 cursor-default">
                <div className="flex items-start justify-between">
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Flags</p>
                    <div className="flex items-center gap-2 pt-1">
                      {["red", "orange", "green", "none"].map((color) => (
                        <Tooltip key={color}>
                          <TooltipTrigger asChild>
                            <div className="flex items-center gap-1 cursor-default">
                              <span className={`inline-block h-3 w-3 rounded-full ${FLAG_COLORS[color]}`} />
                              <span className="text-sm font-semibold text-foreground">{flags[color] ?? 0}</span>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent>{FLAG_TOOLTIPS[color]}</TooltipContent>
                        </Tooltip>
                      ))}
                    </div>
                  </div>
                  <div className="p-3 rounded-xl bg-muted">
                    <Flag className="w-6 h-6 text-muted-foreground" />
                  </div>
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent>Records broken down by flag colour — hover each dot for details</TooltipContent>
          </Tooltip>

          {/* Last Synced */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="rounded-2xl border border-border bg-card p-6 cursor-default">
                <div className="flex items-start justify-between">
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Last Synced</p>
                    <p className="text-2xl font-bold text-foreground tracking-tight">{relativeTime(lastSync)}</p>
                  </div>
                  <div className="p-3 rounded-xl bg-muted">
                    <Clock className="w-6 h-6 text-muted-foreground" />
                  </div>
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              {lastSync
                ? `Last sync completed: ${new Date(lastSync).toLocaleString("en-ZA")}`
                : "No sync has completed yet"}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
