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
