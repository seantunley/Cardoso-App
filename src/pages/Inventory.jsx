import { useState, useMemo, useEffect, useRef } from "react";
import { useColorScheme } from "@/lib/useColorScheme";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useQuery } from "@tanstack/react-query";
import { Package, Search, RefreshCw, X, Download, Filter } from "lucide-react";

function FilterPill({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-[36px] rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-all ${
        active
          ? "border-amber-500 bg-amber-500 text-black shadow-[0_0_0_1px_rgba(245,158,11,0.2)]"
          : "border-border bg-background text-muted-foreground hover:border-amber-500/40 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function FilterToggle({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`min-h-[36px] rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors ${
        active ? "border-amber-500 bg-amber-500/15 text-amber-400"
               : "border-border bg-card text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

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
  const colorScheme = useColorScheme();
  const [hubMode, setHubMode] = useState(false);
  const [siteFilter, setSiteFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [hideZeroQty, setHideZeroQty] = useState(true);
  const [highlightBelowCost, setHighlightBelowCost] = useState(false);
  const [priceListFilter, setPriceListFilter] = useState('all');
  const [commodityFilter, setCommodityFilter] = useState('all');
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortField, setSortField] = useState("item_description");
  const [sortDir, setSortDir] = useState("asc");

  function handleSort(field) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(["qty_on_hand", "last_cost", "price", "inventory_value"].includes(field) ? "desc" : "asc");
    }
  }

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
    placeholderData: (prev) => prev,
  });

  const COMMODITY_LABELS = { '1': 'Sweets', '2': 'Cigarettes', '3': 'Tobacco', '4': 'Mixed' };
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
  const rows = useMemo(() => {
    const filtered = allRows
      .filter(r => !hideZeroQty || parseFloat(r.qty_on_hand) > 0)
      .filter(r => priceListFilter === 'all' || r.price_list === priceListFilter)
      .filter(r => commodityFilter === 'all' || String(r.commodity ?? '').trim() === commodityFilter);
    return [...filtered].sort((a, b) => {
      let va, vb;
      const numFields = ["qty_on_hand", "last_cost", "price", "inventory_value"];
      if (numFields.includes(sortField)) {
        va = parseFloat(a[sortField]) || 0;
        vb = parseFloat(b[sortField]) || 0;
        return sortDir === "asc" ? va - vb : vb - va;
      } else {
        va = String(a[sortField] ?? "").toLowerCase();
        vb = String(b[sortField] ?? "").toLowerCase();
        return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      }
    });
  }, [allRows, hideZeroQty, priceListFilter, commodityFilter, sortField, sortDir]);

  const sites = useMemo(() => {
    return sitesData.map((s) => ({ id: s.id, name: s.name || s.slug || s.id }));
  }, [sitesData]);

  const activeFilterCount = [hideZeroQty, highlightBelowCost, priceListFilter !== "all", commodityFilter !== "all", siteFilter !== "all"].filter(Boolean).length;
  const clearAll = () => { setSearch(""); setHideZeroQty(false); setHighlightBelowCost(false); setPriceListFilter("all"); setCommodityFilter("all"); setSiteFilter("all"); };

  const exportCSV = () => {
    const escape = (v) => {
      const s = String(v ?? "");
      return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const headers = ["Item Number", "Description", "Qty on Hand", "Last Cost", "Price", "Price List", "UOM", "Commodity"];
    if (hubMode) headers.push("Site");
    const csvRows = [headers.join(",")];
    for (const row of rows) {
      const vals = [
        row.item_number || "",
        row.item_description || "",
        row.qty_on_hand ?? "",
        row.last_cost ?? "",
        row.price ?? "",
        row.price_list ?? "",
        row.stocking_uom || "",
        COMMODITY_LABELS[row.commodity] || row.commodity || "",
      ];
      if (hubMode) vals.push(row.site_name || "");
      csvRows.push(vals.map(escape).join(","));
    }
    const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `inventory-export-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-background text-foreground px-6 pt-4 pb-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-5 gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
              <Package className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">Inventory</h1>
              <p className="text-sm text-muted-foreground mt-0.5">
                {(() => {
                  const subtitleParts = [];
                  subtitleParts.push(`${rows.length}${allRows.length !== rows.length ? " of " + allRows.length : ""} item${rows.length !== 1 ? "s" : ""}`);
                  if (debouncedSearch) subtitleParts.push(`"${debouncedSearch}"`);
                  if (commodityFilter !== "all") subtitleParts.push(COMMODITY_LABELS[commodityFilter] || commodityFilter);
                  if (priceListFilter !== "all") subtitleParts.push(priceListFilter);
                  if (hubMode && siteFilter !== "all") {
                    const siteName = sites.find(s => String(s.id) === String(siteFilter))?.name || siteFilter;
                    subtitleParts.push(siteName);
                  }
                  if (highlightBelowCost) subtitleParts.push("Price \u2264 cost");
                  return subtitleParts.join(" \u00b7 ");
                })()}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={exportCSV}
              disabled={rows.length === 0}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50 min-h-[44px]"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </button>
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50 min-h-[44px]"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>
        </div>


        {/* Filter bar */}
        <div className="mb-4 rounded-2xl border border-border bg-card/80 p-4">
          {/* Search row */}
          <div className="mb-3 flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search item number or description…"
                className="w-full rounded-lg border border-border bg-background py-2 pl-8 pr-8 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
              {search && (<button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>)}
            </div>
            {(activeFilterCount > 0 || search) && (
              <button onClick={clearAll} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap">
                <X className="h-3 w-3" />Clear all
                {activeFilterCount > 0 && <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-xs font-semibold text-primary">{activeFilterCount}</span>}
              </button>
            )}
          </div>

          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Filter className="h-4 w-4 text-amber-400" />
                Filters
              </div>

              {/* Commodity pills */}
              {commodities.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Commodity</div>
                  <div className="flex flex-wrap gap-2">
                    <FilterPill active={commodityFilter === "all"} onClick={() => setCommodityFilter("all")}>All</FilterPill>
                    {commodities.map((v) => (
                      <FilterPill key={v} active={commodityFilter === v} onClick={() => setCommodityFilter(v)}>
                        {COMMODITY_LABELS[v] || v}
                      </FilterPill>
                    ))}
                  </div>
                </div>
              )}

              {/* Price list pills */}
              {priceLists.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Price list</div>
                  <div className="flex flex-wrap gap-2">
                    <FilterPill active={priceListFilter === "all"} onClick={() => setPriceListFilter("all")}>All</FilterPill>
                    {priceLists.map((pl) => (
                      <FilterPill key={pl} active={priceListFilter === pl} onClick={() => setPriceListFilter(pl)}>{pl}</FilterPill>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="flex w-full flex-col gap-3 lg:w-auto lg:min-w-[220px]">
              {/* Site select (hub only) */}
              {hubMode && sites.length > 0 && (
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Site</label>
                  <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}
                    style={{ colorScheme }}
                    className="min-h-[40px] rounded-xl border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring">
                    <option value="all">All sites</option>
                    {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              )}

              {/* Toggle filters */}
              <div className="flex flex-col gap-2">
                <FilterToggle active={hideZeroQty} onClick={() => setHideZeroQty((v) => !v)}>
                  {hideZeroQty ? "⊘ " : ""}Hide zero qty
                </FilterToggle>
                <FilterToggle active={highlightBelowCost} onClick={() => setHighlightBelowCost((v) => !v)}>
                  {highlightBelowCost ? "⊘ " : ""}Highlight price ≤ cost
                </FilterToggle>
              </div>
            </div>
          </div>
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

        {/* State: empty (no data at all) */}
        {!isLoading && !isError && allRows.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 rounded-xl border border-border bg-card">
            <Package className="w-12 h-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium text-foreground">No inventory data yet</h3>
            <p className="text-sm text-muted-foreground mt-1">Sync your connections to see inventory.</p>
          </div>
        )}

        {/* State: empty (filtered) */}
        {!isLoading && !isError && allRows.length > 0 && rows.length === 0 && (
          <div className="rounded-xl border border-border bg-card p-12 text-center text-sm text-muted-foreground">
            {debouncedSearch ? `No inventory items matching "${debouncedSearch}".` : "No inventory records found."}
          </div>
        )}

        {/* Table — virtualised for large datasets */}
        {!isLoading && !isError && rows.length > 0 && (
          <InventoryTable rows={rows} hubMode={hubMode} formatNum={formatNum} formatCurrency={formatCurrency} COMMODITY_LABELS={COMMODITY_LABELS} highlightBelowCost={highlightBelowCost} sortField={sortField} sortDir={sortDir} onSort={handleSort} />
        )}
      </div>
    </div>
  );
}

// ─── Virtualised table ────────────────────────────────────────────────────────
const ROW_HEIGHT = 30;
const TABLE_HEIGHT = typeof window !== "undefined" ? Math.max(300, window.innerHeight - 260) : 600;

function InventoryTable({ rows, hubMode, formatNum, formatCurrency, COMMODITY_LABELS, highlightBelowCost, sortField, sortDir, onSort }) {
  function SA({ field }) {
    if (sortField !== field) return <span className="ml-0.5 opacity-30">⇅</span>;
    return <span className="ml-0.5 opacity-80">{sortDir === "asc" ? "↑" : "↓"}</span>;
  }
  const sh = "px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none hover:text-foreground transition-colors";
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

  const isBelowCost = (row) => {
    const price = parseFloat(String(row.price || '').replace(/[^0-9.-]/g, ''));
    const cost = parseFloat(String(row.last_cost || '').replace(/[^0-9.-]/g, ''));
    return !isNaN(price) && !isNaN(cost) && cost > 0 && price <= cost;
  };

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div
        ref={parentRef}
        style={{ height: "min(900px, calc(100vh - 180px))", overflowY: "auto", overflowX: "auto" }}
      >
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-20">
            <tr className="border-b border-border bg-card">
              <th onClick={() => onSort("item_number")} className={`${sh} text-left`}>Item Number<SA field="item_number" /></th>
              <th onClick={() => onSort("item_description")} className={`${sh} text-left`}>Description<SA field="item_description" /></th>
              <th onClick={() => onSort("qty_on_hand")} className={`${sh} text-right`}>Qty on Hand<SA field="qty_on_hand" /></th>
              <th onClick={() => onSort("last_cost")} className={`${sh} text-right`}>Last Cost<SA field="last_cost" /></th>
              <th onClick={() => onSort("price")} className={`${sh} text-right`}>Price<SA field="price" /></th>
              <th onClick={() => onSort("price_list")} className={`${sh} text-right`}>Price List<SA field="price_list" /></th>
              <th className="px-2 py-1.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">UOM</th>
              {hubMode && (
                <th onClick={() => onSort("site_name")} className={`${sh} text-left`}>Site<SA field="site_name" /></th>
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
                  className={`border-b border-border transition-colors ${highlightBelowCost && isBelowCost(row) ? "bg-red-500/10 hover:bg-red-500/15" : "hover:bg-muted/30"}`}
                >
                  <td className="px-2 py-1 text-xs font-mono text-foreground whitespace-nowrap">{row.item_number || "—"}</td>
                  <td className="px-2 py-1 text-xs text-foreground">{row.item_description || "—"}</td>
                  <td className="px-2 py-1 text-xs text-right tabular-nums text-foreground">{(row.qty_on_hand === null || row.qty_on_hand === undefined || row.qty_on_hand === '') ? formatNum(0, 0) : formatNum(row.qty_on_hand, 0)}</td>
                  <td className={`px-2 py-1 text-xs text-right tabular-nums ${highlightBelowCost && isBelowCost(row) ? "text-red-400 font-semibold" : "text-foreground"}`}>{formatCurrency(row.last_cost)}</td>
                  <td className={`px-2 py-1 text-xs text-right tabular-nums ${highlightBelowCost && isBelowCost(row) ? "text-red-400 font-semibold" : "text-foreground"}`}>{formatCurrency(row.price)}</td>
                  <td className="px-2 py-1 text-xs text-right tabular-nums text-foreground">{formatNum(row.price_list)}</td>
                  <td className="px-2 py-1 text-xs text-foreground">{row.stocking_uom || "—"}</td>
                  {hubMode && (
                    <td className="px-2 py-1 text-xs text-muted-foreground">{row.site_name || row.site_id || "—"}</td>
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
