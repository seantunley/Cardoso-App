import { useQuery } from "@tanstack/react-query";

async function fetchAppInfo() {
  const res = await fetch("/api/app-info", { credentials: "include" });
  if (!res.ok) return {};
  return res.json();
}

// Shared cache for /api/app-info. Multiple pages used to fire this fetch
// independently on every mount (App, Layout, Inventory, Operations,
// Reconciliation, …) — React Query's single-flight + Infinity staleTime
// collapses those into one network call per session.
export function useAppInfo() {
  return useQuery({
    queryKey: ["appInfo"],
    queryFn: fetchAppInfo,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });
}

export function useHubMode() {
  const { data } = useAppInfo();
  return !!data?.hub_mode;
}
