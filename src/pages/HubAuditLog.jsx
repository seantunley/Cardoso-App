import { useQuery } from "@tanstack/react-query";
import { ClipboardList, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

async function fetchHubAuditLog() {
  const response = await fetch("/api/hub/audit-log?limit=100", { credentials: "include" });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json();
}

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-ZA", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function HubAuditLog() {
  const { data = [], isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["hub-audit-log"],
    queryFn: fetchHubAuditLog,
    refetchInterval: 60_000,
  });

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-7xl space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold">Hub Audit Log</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">Latest hub admin actions, newest first.</p>
          </div>
          <Button variant="outline" onClick={() => refetch()} disabled={isFetching} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-border border-t-foreground" />
          </div>
        )}

        {isError && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
            {error?.message || "Failed to load audit log"}
          </div>
        )}

        {!isLoading && !isError && data.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card py-16 text-center">
            <ClipboardList className="mb-4 h-12 w-12 text-muted-foreground" />
            <h2 className="text-lg font-medium">No hub audit entries yet</h2>
            <p className="mt-1 text-sm text-muted-foreground">Actions like user pushes, resyncs, and backup pulls will show here.</p>
          </div>
        )}

        {!isLoading && !isError && data.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Time</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Action</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">By</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Target</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Detail</th>
                </tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <tr key={row.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(row.created_at)}</td>
                    <td className="px-4 py-3 font-medium text-foreground">{row.action || "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{row.performed_by || "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{row.target || "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{row.detail || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
