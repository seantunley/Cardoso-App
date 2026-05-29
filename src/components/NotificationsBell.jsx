// Notifications bell — a single app-wide entry point for "something needs
// attention", driven by the same /api/system/sage-health aggregator the
// dashboard/Operations panel uses (Sage connectivity, stale syncs, 24h errors,
// job failures, active alerts). Shows a dot when the overall status isn't OK;
// the dropdown lists the issues and links to Operations.
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Bell } from "lucide-react";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { apiGet } from "@/components/collections/utils";

export default function NotificationsBell({ collapsed }) {
  const navigate = useNavigate();
  // Same key + fetcher as SageHealthPanel so they share one cache entry and
  // one request/min. On error, data is undefined → the bell simply shows no
  // issues (the panel surfaces the error).
  const { data } = useQuery({
    queryKey: ["sage-health"],
    queryFn: () => apiGet("/api/system/sage-health"),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const issues = [];
  if (data) {
    if (data.sage?.ok === false) issues.push(`Sage connection down (${data.sage.downForMinutes}m)`);
    for (const s of data.sources || []) if (s.stale) issues.push(`${s.label} sync is stale`);
    if (data.criticalAlerts > 0) issues.push(`${data.criticalAlerts} critical alert${data.criticalAlerts === 1 ? "" : "s"}`);
    else if (data.activeAlerts > 0) issues.push(`${data.activeAlerts} active alert${data.activeAlerts === 1 ? "" : "s"}`);
    if (data.jobFailures24h > 0) issues.push(`${data.jobFailures24h} job failure${data.jobFailures24h === 1 ? "" : "s"} (24h)`);
    if (data.errors24h > 0) issues.push(`${data.errors24h} error${data.errors24h === 1 ? "" : "s"} logged (24h)`);
  }
  const status = data?.status || "ok";
  const dotColor = status === "critical" ? "bg-red-500" : status === "warn" ? "bg-amber-500" : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={issues.length ? `${issues.length} item(s) need attention` : "No notifications"}
          aria-label={issues.length ? `Notifications: ${issues.length} item(s) need attention` : "Notifications"}
          className={`relative shrink-0 rounded-md p-2 text-[hsla(var(--sidebar-foreground),0.7)] transition-colors hover:bg-[hsl(var(--sidebar-accent))] hover:text-[hsl(var(--sidebar-foreground))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--phosphor)]`}
        >
          <Bell className="h-4 w-4" />
          {dotColor && (
            <span className={`absolute right-1 top-1 h-2 w-2 rounded-full ${dotColor}`} />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={collapsed ? "right" : "top"} align="start" className="w-64">
        <DropdownMenuLabel>Notifications</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {issues.length === 0 ? (
          <DropdownMenuItem disabled>All clear — nothing needs attention.</DropdownMenuItem>
        ) : (
          issues.map((msg, i) => (
            <DropdownMenuItem key={i} onClick={() => navigate("/Operations")}>
              <span className={`mr-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${dotColor || "bg-muted-foreground"}`} />
              <span className="truncate">{msg}</span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/Operations")}>View Operations →</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
