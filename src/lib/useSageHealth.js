// Shared poll of /api/system/sage-health — THE aggregator for "is this
// install healthy" (Sage probe, per-source sync freshness, request-time
// backup health, active alert counts). NotificationsBell, SageHealthPanel
// and the sidebar HealthStrip all consume the same query key, so however
// many of them are mounted there is exactly one request per interval and
// one shared cache entry — they can never disagree.
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/components/collections/utils";

export function useSageHealth() {
  return useQuery({
    queryKey: ["sage-health"],
    queryFn: () => apiGet("/api/system/sage-health"),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

// Shared poll of /api/bat/sage-health — the BAT Sage MSSQL probe. Layout's
// "Sage unreachable" banner and the Reconciliation status pill share this
// key; every fetch restarts each observer's interval, so with both mounted
// it is still one request per minute. Pauses while the tab is hidden.
export function useBatSageHealth({ enabled = true } = {}) {
  return useQuery({
    queryKey: ["bat-sage-health"],
    queryFn: () => apiGet("/api/bat/sage-health"),
    refetchInterval: 60_000,
    enabled,
  });
}
