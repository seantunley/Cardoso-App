import { useState, useMemo, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Package } from "lucide-react";

async function fetchInventory({ isHub, search, siteId, limit }) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (search) params.set("search", search);
  const url = isHub
    ? `/api/hub/inventory?${siteId ? `site_id=${encodeURIComponent(siteId)}&` : ""}${params}`
    : `/api/inventory?${params}`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || "Failed to load inventory");
  }
  return res.json();
}

async function fetchHubSites() {
  const res = await fetch("/api/hub/sites", { credentials: "include" });
  if (!res.ok) return [];
  return res.json();
}

const formatNum = (val, decimals = 2) => {
  if (val === null || val === undefined || val === '') return '—';
  const n = parseFloat(String(val).replace(/,/g, ''));
  if (isNaN(n)) return val;
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};
const formatCurrency = (val) => {
  const f = formatNum(val);
  return f === '—' ? '—' : `R ${f}`;
};

export default function Inventory() {
  const [hubMode, setHubMode] = useState(false);
  const [siteFilter, setSiteFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    fetch("/api/app-info")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.hub_mode) setHubMode(true); })
      .catch(() => {});
  }, []);

  // Debounce search 200ms
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 200);
    return () => clearTimeout(t);
  }, [search]);

  const { data: sitesData = [] } = useQuery({
    queryKey: ["hub-sites-inventory"],
    queryFn: fetchHubSites,
    enabled: hubMode,
    staleTime: 60_000,
  });

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["inventory", hubMode, debouncedSearch, siteFilter === "all" ? "" : siteFilter],
    queryFn: () =>
      fetchInventory({
        isHub: hubMode,
        search: debouncedSearch,
        siteId: siteFilter === "all" ? "" : siteFilter,
        limit: 500,
      }),
    staleTime: 60_000,
  });

  const rows = data?.records ?? [];

  const sites = useMemo(() => {
    return sitesData.map((s) => ({ id: s.id, name: s.name || s.slug || s.id }));
  }, [sitesData]);

  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Package className="h-6 w-6 text-muted-foreground" />
            <div>
              <h1 className="text-2xl font-bold text-foreground">Inventory</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                {rows.length} item{rows.length !== 1 ? "s" : ""}
                {debouncedSearch ? ` matching "${debouncedSearch}"` : ""}
              </p>
            </div>
          </div>
          <button
            onClick={() => refetch()}
            className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 4v6h-6M1 20v-6h6"/>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
            Refresh
          </button>
        </div>

        {/* Filters row */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          {/* Search */}
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search item number or description…"
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring min-w-[220px]"
          />
          {/* Site filter — hub only */}
          {hubMode && sites.length > 0 && (
            <>
              <label className="text-xs text-muted-foreground whitespace-nowrap">Site:</label>
              <select
                value={siteFilter}
                onChange={(e) => setSiteFilter(e.target.value)}
                className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="all">All sites</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              {siteFilter !== "all" && (
                <button
                  onClick={() => setSiteFilter("all")}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Clear
                </button>
              )}
            </>
          )}
        </div>

        {/* State: loading */}
        {isLoading && (
          <div className="flex items-center justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-border border-t-foreground" />
          </div>
        )}

        {/* State: error */}
        {isError && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-center text-sm text-red-400">
            {error?.message || "Failed to load inventory"}
          </div>
        )}

        {/* State: empty */}
        {!isLoading && !isError && rows.length === 0 && (
          <div className="rounded-xl border border-border bg-card p-12 text-center text-sm text-muted-foreground">
            {debouncedSearch ? `No inventory items matching "${debouncedSearch}".` : "No inventory records found."}
          </div>
        )}

        {/* Table */}
        {!isLoading && !isError && rows.length > 0 && (
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="px-2 py-1.5 text-left text-xs font-semibold text-muted-foreground">Item Number</th>
                    <th className="px-2 py-1.5 text-left text-xs font-semibold text-muted-foreground">Description</th>
                    <th className="px-2 py-1.5 text-right text-xs font-semibold text-muted-foreground">Qty on Hand</th>
                    <th className="px-2 py-1.5 text-right text-xs font-semibold text-muted-foreground">Last Cost</th>
                    <th className="px-2 py-1.5 text-right text-xs font-semibold text-muted-foreground">Price List</th>
                    <th className="px-2 py-1.5 text-right text-xs font-semibold text-muted-foreground">Price</th>
                    {hubMode && (
                      <th className="px-2 py-1.5 text-left text-xs font-semibold text-muted-foreground">Site</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, idx) => (
                    <tr
                      key={`${row.site_id ?? row.source_table}-${row.item_number}-${idx}`}
                      className="border-b border-border last:border-0 transition-colors hover:bg-muted/30"
                    >
                      <td className="px-2 py-1 text-xs font-mono text-foreground">{row.item_number || "—"}</td>
                      <td className="px-2 py-1 text-xs text-foreground">{row.item_description || "—"}</td>
                      <td className="px-2 py-1 text-xs text-right tabular-nums text-foreground">{(row.qty_on_hand === null || row.qty_on_hand === undefined || row.qty_on_hand === '') ? formatNum(0) : formatNum(row.qty_on_hand)}</td>
                      <td className="px-2 py-1 text-xs text-right tabular-nums text-foreground">{formatCurrency(row.last_cost)}</td>
                      <td className="px-2 py-1 text-xs text-right tabular-nums text-foreground">{formatNum(row.price_list)}</td>
                      <td className="px-2 py-1 text-xs text-right tabular-nums text-foreground">{formatCurrency(row.price)}</td>
                      {hubMode && (
                        <td className="px-2 py-1 text-xs text-muted-foreground">{row.site_id || "—"}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
