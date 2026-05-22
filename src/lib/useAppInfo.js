import { useQuery } from "@tanstack/react-query";

async function fetchAppInfo() {
  const res = await fetch("/api/app-info", { credentials: "include" });
  if (!res.ok) {
    // Throw — do NOT swallow into a {} success payload. A swallowed
    // failure here gets cached for the whole SPA session (staleTime:
    // Infinity), and useHubMode() would silently pin to `false`, so a
    // hub install would render site-mode navigation until a hard reload.
    // Letting React Query see this as an error lets retry semantics work
    // and avoids persisting the wrong app mode.
    throw new Error(`/api/app-info HTTP ${res.status}`);
  }
  return res.json();
}

// Shared cache for /api/app-info. Multiple pages used to fire this fetch
// independently on every mount (App, Layout, Inventory, Operations,
// Reconciliation, …) — React Query's single-flight + Infinity staleTime
// collapses successful results into one network call per session, while
// errors retry on every mount.
export function useAppInfo() {
  return useQuery({
    queryKey: ["appInfo"],
    queryFn: fetchAppInfo,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    // Retry transient infra blips (proxy, 5xx) before giving up.
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
  });
}

export function useHubMode() {
  const { data } = useAppInfo();
  return !!data?.hub_mode;
}
