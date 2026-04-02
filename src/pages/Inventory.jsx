import { useState, useMemo, useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useQuery } from "@tanstack/react-query";
import { Package, Search, RefreshCw, X } from "lucide-react";

async function fetchInventory({ isHub, search, siteId }) {
  const params = new URLSearchParams();
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
  const [hideZeroQty, setHideZeroQty] = useState(true);
  const [priceListFilter, setPriceListFilter] = useState('all');
  const [commodityFilter, setCommodityFilter] = useState('all');
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

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["inventory", hubMode, debouncedSearch, siteFilter === "all" ? "" : siteFilter],
    queryFn: () =>
      fetchInventory({
        isHub: hubMode,
        search: debouncedSearch,
        siteId: siteFilter === "all" ? "" : siteFilter,

      }),
    staleTime: 60_000,
  });

  const COMMODITY_LABELS = { '1': 'Sweets', '2': 'Cigarettes', '3': 'Tobacco' };
  const allRows = data?.records ?? [];
  const priceLists = useMemo(() => {
    const seen = new Set();
    for (const r of allRows) { if (r.price_list) seen.add(r.price_list); }
    return [...seen].sort();
  }, [allRows]);
  const commodities = useMemo(() => {
    const seen = new Set();
    for (const r of allRows) {
      const v = r.commodity != null ? String(r.commodity).trim() : '';
      if (v) seen.add(v);
    }
    return [...seen].sort();
  }, [allRows]);
  const rows = allRows
    .filter(r => !hideZeroQty || parseFloat(r.qty_on_hand) > 0)
    .filter(r => priceListFilter === 'all' || r.price_list === priceListFilter)
    .filter(r => commodityFilter === 'all' || String(r.commodity ?? '').trim() === commodityFilter);

  const sites = useMemo(() => {
    return sitesData.map((s) => ({ id: s.id, name: s.name || s.slug || s.id }));
  }, [sitesData]);

  const activeFilterCount = [hideZeroQty, priceListFilter !== "all", commodityFilter !== "all", siteFilter !== "all"].filter(Boolean).length;
  const clearAll = () => { setSearch(""); setHideZeroQty(false); setPriceListFilter("all"); setCommodityFilter("all"); setSiteFilter("all"); };

  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
              <Package className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-foreground">Inventory</h1>
              <p className="text-xs text-muted-foreground">
                {rows.length.toLocaleString()} item{rows.length !== 1 ? "s" : ""}
                {debouncedSearch ? ` · "${debouncedSearch}"` : ""}
                {allRows.length > rows.length ? ` of ${allRows.length.toLocaleString()}` : ""}
              </p>
            </div>
          </div>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </button>
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

        {/* Table — virtualised for large datasets */}
        {!isLoading && !isError && rows.length > 0 && (
          <InventoryTable rows={rows} hubMode={hubMode} formatNum={formatNum} formatCurrency={formatCurrency} COMMODITY_LABELS={COMMODITY_LABELS} />
        )}
      </div>
    </div>
  );
}

// ─── Virtualised table ────────────────────────────────────────────────────────
const ROW_HEIGHT = 30;
const TABLE_HEIGHT = 600;

function InventoryTable({ rows, hubMode, formatNum, formatCurrency, COMMODITY_LABELS }) {
  const parentRef = useRef(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const items = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();
  const paddingTop = items.length > 0 ? items[0].start : 0;
  const paddingBottom = items.length > 0 ? totalHeight - items[items.length - 1].end : 0;

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div
        ref={parentRef}
        style={{ height: TABLE_HEIGHT, overflowY: "auto", overflowX: "auto" }}
      >
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-20">
            <tr className="border-b border-border bg-card">
              <th className="px-2 py-1.5 text-left text-xs font-semibold text-muted-foreground">Item Number</th>
              <th className="px-2 py-1.5 text-left text-xs font-semibold text-muted-foreground">Description</th>
              <th className="px-2 py-1.5 text-right text-xs font-semibold text-muted-foreground">Qty on Hand</th>
              <th className="px-2 py-1.5 text-right text-xs font-semibold text-muted-foreground">Last Cost</th>
              <th className="px-2 py-1.5 text-right text-xs font-semibold text-muted-foreground">Price</th>
              <th className="px-2 py-1.5 text-right text-xs font-semibold text-muted-foreground">Price List</th>
              <th className="px-2 py-1.5 text-left text-xs font-semibold text-muted-foreground">UOM</th>
              {hubMode && (
                <th className="px-2 py-1.5 text-left text-xs font-semibold text-muted-foreground">Site</th>
              )}
            </tr>
          </thead>
          <tbody>
            {paddingTop > 0 && <tr><td style={{ height: paddingTop }} colSpan={hubMode ? 8 : 7} /></tr>}
            {items.map((vRow) => {
              const row = rows[vRow.index];
              return (
                <tr
                  key={vRow.key}
                  className="border-b border-border transition-colors hover:bg-muted/30"
                >
                  <td className="px-2 py-1 text-xs font-mono text-foreground whitespace-nowrap">{row.item_number || "—"}</td>
                  <td className="px-2 py-1 text-xs text-foreground">{row.item_description || "—"}</td>
                  <td className="px-2 py-1 text-xs text-right tabular-nums text-foreground">{(row.qty_on_hand === null || row.qty_on_hand === undefined || row.qty_on_hand === '') ? formatNum(0, 0) : formatNum(row.qty_on_hand, 0)}</td>
                  <td className="px-2 py-1 text-xs text-right tabular-nums text-foreground">{formatCurrency(row.last_cost)}</td>
                  <td className="px-2 py-1 text-xs text-right tabular-nums text-foreground">{formatCurrency(row.price)}</td>
                  <td className="px-2 py-1 text-xs text-right tabular-nums text-foreground">{formatNum(row.price_list)}</td>
                  <td className="px-2 py-1 text-xs text-foreground">{row.stocking_uom || "—"}</td>
                  {hubMode && (
                    <td className="px-2 py-1 text-xs text-muted-foreground">{row.site_id || "—"}</td>
                  )}
                </tr>
              );
            })}
            {paddingBottom > 0 && <tr><td style={{ height: paddingBottom }} colSpan={hubMode ? 8 : 7} /></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
