import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useColorScheme } from "@/lib/useColorScheme";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useQuery } from "@tanstack/react-query";
import { Package, Search, RefreshCw, X, Download, Printer } from "lucide-react";
import SummaryTile from "@/components/shared/SummaryTile";
import CollapsibleFilterBar from "@/components/shared/CollapsibleFilterBar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { reportClientError } from "@/lib/clientLog";
import { getLedgerFortune, getReportSignature } from "@/lib/fun";

// ── Resizable column widths (mirrors the CustomerBalances pattern) ──────────
const INV_COLUMN_DEFAULTS = {
  itemNumber: 140, description: 380, qty: 100, lastCost: 110,
  price: 110, priceList: 110, uom: 80, site: 140,
};
// v2: switched table from absolute-pixel widths to a CSS width:100% +
// percentage <col> layout. Existing v1 saves are absolute pixel values
// that worked with the old layout but render with off-balance proportions
// under the new percentage-based render; bumping the key gives operators
// a clean default that fills the container.
const INV_COLUMN_WIDTHS_KEY = "inventory.columnWidths.v2";

function useInvColumnWidths(containerRef) {
  const [widths, setWidths] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(INV_COLUMN_WIDTHS_KEY) || "{}");
      return { ...INV_COLUMN_DEFAULTS, ...saved };
    } catch { return INV_COLUMN_DEFAULTS; }
  });
  const widthsRef = useRef(widths);
  // Debounce-flushed localStorage write — see comment in
  // src/lib/useColumnWidths.js. Avoids JSON.stringify + sync
  // localStorage.setItem at 60Hz during a column drag.
  const writeTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  useEffect(() => {
    widthsRef.current = widths;
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(() => {
      try { localStorage.setItem(INV_COLUMN_WIDTHS_KEY, JSON.stringify(widths)); } catch {} // eslint-disable-line no-empty -- hot path on every column drag; localStorage quota errors are non-fatal
      writeTimerRef.current = null;
    }, 200);
    return () => {
      if (writeTimerRef.current) {
        clearTimeout(writeTimerRef.current);
        writeTimerRef.current = null;
        try { localStorage.setItem(INV_COLUMN_WIDTHS_KEY, JSON.stringify(widths)); } catch {} // eslint-disable-line no-empty -- hot path teardown; localStorage quota errors are non-fatal
      }
    };
  }, [widths]);

  const MIN_COL = 40;

  const startResize = useCallback((id, visibleKeys) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = widthsRef.current[id] ?? INV_COLUMN_DEFAULTS[id] ?? 100;
    // Sum of every other *currently rendered* column at drag start.
    const sumOthers = (visibleKeys || Object.keys(widthsRef.current))
      .filter((k) => k !== id)
      .reduce((s, k) => s + (widthsRef.current[k] || 0), 0);

    const onMove = (ev) => {
      const containerInner = containerRef?.current?.clientWidth ?? Infinity;
      const maxThisCol = Math.max(MIN_COL, (containerInner - 1) - sumOthers);
      const proposed = startWidth + (ev.clientX - startX);
      const next = Math.max(MIN_COL, Math.min(maxThisCol, proposed));
      setWidths((w) => ({ ...w, [id]: next }));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [containerRef]);

  const resetColumn = useCallback((id) => {
    setWidths((w) => ({ ...w, [id]: INV_COLUMN_DEFAULTS[id] ?? 100 }));
  }, []);

  return { widths, setWidths, startResize, resetColumn };
}

function InvResizeHandle({ id, startResize, resetColumn, visibleKeys }) {
  return (
    <span
      onMouseDown={startResize(id, visibleKeys)}
      onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); resetColumn(id); }}
      className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-accent/50 active:bg-accent z-30"
      style={{ touchAction: "none" }}
      title="Drag to resize · double-click to reset"
    />
  );
}

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

function FilterToggle({ active, onClick, children, tooltip }) {
  const btn = (
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
  if (!tooltip) return btn;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
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
  const res = await fetch("/api/hub/my-sites", { credentials: "include" });
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
  // Controlled <details> open state so the filter panel doesn't collapse
  // when filter state changes cause re-renders (native <details> loses
  // its open flag when its DOM subtree is recreated).
  const [filtersOpen, setFiltersOpen] = useState(false);
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
      .catch(err => reportClientError("Inventory.appInfo", err));
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
  const EXCLUDED_COMMODITIES = new Set(['10']);
  const allRows = data?.records ?? [];
  // The hub-side endpoint paginates and silently caps at 1000 rows
  // when no limit/offset is sent (which is our case — we don't send
  // them today). Without a "showing N of M" indicator the operator
  // has no way to know they're seeing a truncated view of an inventory
  // larger than the cap. data.total is the total matching rows, count
  // is what was returned in this page; surface the gap when they differ.
  const totalAvailable = data?.total ?? null;
  const returnedCount = data?.count ?? allRows.length;
  const isTruncated = Number.isFinite(totalAvailable) && totalAvailable > returnedCount;
  const priceLists = useMemo(() => {
    const seen = new Set();
    for (const r of allRows) { if (r.price_list) seen.add(r.price_list); }
    return [...seen].sort();
  }, [allRows]);
  const commodities = useMemo(() => {
    const seen = new Set();
    for (const r of allRows) {
      const v = r.commodity != null ? String(r.commodity).trim() : '';
      if (v && !EXCLUDED_COMMODITIES.has(v)) seen.add(v);
    }
    return [...seen].sort();
  }, [allRows, EXCLUDED_COMMODITIES]);
  const rows = useMemo(() => {
    const isBelowCost = (r) => {
      const price = parseFloat(String(r.price || '').replace(/[^0-9.-]/g, ''));
      const cost = parseFloat(String(r.last_cost || '').replace(/[^0-9.-]/g, ''));
      return !isNaN(price) && !isNaN(cost) && cost > 0 && price <= cost;
    };
    const filtered = allRows
      .filter(r => !hideZeroQty || parseFloat(r.qty_on_hand) > 0)
      .filter(r => !EXCLUDED_COMMODITIES.has(String(r.commodity ?? '').trim()))
      .filter(r => priceListFilter === 'all' || r.price_list === priceListFilter)
      .filter(r => commodityFilter === 'all' || String(r.commodity ?? '').trim() === commodityFilter)
      .filter(r => !highlightBelowCost || isBelowCost(r));
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
  }, [allRows, hideZeroQty, highlightBelowCost, priceListFilter, commodityFilter, sortField, sortDir, EXCLUDED_COMMODITIES]);

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
    <div className="inventory-page min-h-screen bg-background text-foreground px-6 pt-4 pb-6">
      <style>{`
        @page {
          size: auto;
          margin: 8mm;
        }

        @media print {
          html, body {
            margin: 0 !important;
            padding: 0 !important;
            background: #fff !important;
            color: #000 !important;
          }

          body * { visibility: hidden; }
          .inventory-print-scope, .inventory-print-scope * { visibility: visible; }
          .inventory-print-scope {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            margin: 0 !important;
            padding: 0 !important;
          }

          .inventory-page {
            min-height: auto !important;
            padding: 0 !important;
            background: #fff !important;
            color: #000 !important;
          }

          nav, header, aside, [data-sidebar], .no-print, .inv-filter-bar, .inv-screen-only { display: none !important; }
          .inv-print-header, .inv-print-only { display: block !important; }
          .inv-print-header { margin-bottom: 4mm !important; padding-bottom: 2mm !important; border-bottom: 1.5px solid #000 !important; }
          .print-table-wrap { overflow: visible !important; height: auto !important; max-height: none !important; }
          .print-table-shell {
            border: 0 !important;
            border-radius: 0 !important;
            box-shadow: none !important;
            background: #fff !important;
          }

          table { font-size: 10px; width: 100%; border-collapse: collapse; }
          th, td { padding: 2px 5px !important; border: 1px solid #ccc !important; }
          thead { display: table-header-group; }
          thead.sticky { position: static !important; }
          tr { page-break-inside: avoid; }
        }
      `}</style>
      <div className="inventory-print-scope">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between mb-8 gap-4 border-b border-border pb-5">
          <div>

            <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
              Every <em className="text-phosphor">unit</em>.
            </h1>
            <p className="text-sm text-muted-foreground mt-3 font-mono">
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
          <div className="flex items-center gap-2 no-print">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => window.print()}
                  disabled={rows.length === 0}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50 min-h-[44px]"
                >
                  <Printer className="h-3.5 w-3.5" />
                  Print
                </button>
              </TooltipTrigger>
              <TooltipContent>Print current filtered view</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={exportCSV}
                  disabled={rows.length === 0}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50 min-h-[44px]"
                >
                  <Download className="h-3.5 w-3.5" />
                  Export CSV
                </button>
              </TooltipTrigger>
              <TooltipContent>Export current filtered view to CSV</TooltipContent>
            </Tooltip>
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


        {/* Filter bar — collapsible. Mirrors the pattern on Customer
            Balances: pill-style filters stack as labelled rows, dropdown
            + toggles share the bottom row. Search lives BELOW the
            filter block so it stays accessible when filters are
            collapsed. */}
        {(() => {
          const totalHolding = (() => {
            const src = rows.length > 0 ? rows : allRows;
            return src.reduce((sum, r) => {
              const pre = parseFloat(String(r.inventory_value || "").replace(/[^0-9.-]/g, ""));
              if (Number.isFinite(pre) && pre !== 0) return sum + pre;
              const q = parseFloat(String(r.qty_on_hand || "").replace(/[^0-9.-]/g, ""));
              const c = parseFloat(String(r.last_cost || "").replace(/[^0-9.-]/g, ""));
              if (Number.isFinite(q) && Number.isFinite(c)) return sum + q * c;
              return sum;
            }, 0);
          })();
          return (
        <>
        <CollapsibleFilterBar
          open={filtersOpen}
          onOpenChange={setFiltersOpen}
          className="mb-3 no-print inv-filter-bar"
          chips={/** @type {Array<{ key: string, label: any, onClear: () => void }>} */ ([
            commodityFilter !== "all" && { key: "commodity", label: COMMODITY_LABELS[commodityFilter] || commodityFilter, onClear: () => setCommodityFilter("all") },
            priceListFilter !== "all" && { key: "priceList", label: `Price list ${priceListFilter}`, onClear: () => setPriceListFilter("all") },
            hubMode && siteFilter !== "all" && { key: "site", label: (sites.find(s => s.id === siteFilter)?.name) || siteFilter, onClear: () => setSiteFilter("all") },
            hideZeroQty && { key: "hidezero", label: "Hide zero qty", onClear: () => setHideZeroQty(false) },
            highlightBelowCost && { key: "below", label: "Price ≤ cost only", onClear: () => setHighlightBelowCost(false) },
          ].filter(Boolean))}
          onClearAll={clearAll}
        >
          <>
            {commodities.length > 0 && (
              <div className="space-y-1.5">
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

            {priceLists.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Price list</div>
                <div className="flex flex-wrap gap-2">
                  <FilterPill active={priceListFilter === "all"} onClick={() => setPriceListFilter("all")}>All</FilterPill>
                  {priceLists.map((pl) => (
                    <FilterPill key={pl} active={priceListFilter === pl} onClick={() => setPriceListFilter(pl)}>{pl}</FilterPill>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-end gap-3 pt-1">
              {hubMode && sites.length > 0 && (
                <div className="flex flex-col gap-1.5 min-w-[180px]">
                  <label className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Site</label>
                  <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}
                    style={{ colorScheme }}
                    className="h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring">
                    <option value="all">All sites</option>
                    {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              )}

              <div className="flex items-center gap-2 ml-auto flex-wrap">
                <FilterToggle active={hideZeroQty} onClick={() => setHideZeroQty((v) => !v)} tooltip="Hide items with no stock on hand">
                  {hideZeroQty ? "⊘ " : ""}Hide zero qty
                </FilterToggle>
                <FilterToggle active={highlightBelowCost} onClick={() => setHighlightBelowCost((v) => !v)} tooltip="Highlight rows where the selling price is at or below the last cost">
                  {highlightBelowCost ? "⊘ " : ""}Highlight price ≤ cost
                </FilterToggle>
              </div>
            </div>
          </>
        </CollapsibleFilterBar>

        {/* Search row — sits beneath the filter block so it stays
            available while filters are collapsed. */}
        <div className="mb-3 flex items-center gap-3 no-print">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search item number or description…"
              className="w-full rounded-lg border border-border bg-background py-2 pl-8 pr-8 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
            {search && (<button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>)}
          </div>
          {/* Clear-all button now lives in the filter summary header
              alongside the active-filter chips. */}
        </div>

        {/* Summary tile — total Rand value of stock on hand. Prefer the
            sync's pre-computed inventory_value column, fall back to
            qty × last_cost. Tracks filtered rows when filters are
            active, otherwise the full dataset. */}
        {allRows.length > 0 && (
          <div className="mb-4 grid gap-4 md:grid-cols-2 no-print">
            <SummaryTile
              label={`Total inventory holding (${(rows.length || allRows.length).toLocaleString("en-ZA")} items${activeFilterCount > 0 || search ? " · filtered" : ""})`}
              value={`R ${formatCurrency(totalHolding).replace(/^R\s*/, "")}`}
            />
          </div>
        )}
        </>
          );
        })()}
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
            <p className="text-sm text-muted-foreground mt-1">{getLedgerFortune()}</p>
          </div>
        )}

        {/* State: empty (filtered) */}
        {!isLoading && !isError && allRows.length > 0 && rows.length === 0 && (
          <div className="rounded-xl border border-border bg-card p-12 text-center text-sm text-muted-foreground">
            {debouncedSearch ? `No inventory items matching "${debouncedSearch}".` : getLedgerFortune()}
          </div>
        )}

        {/* Print-only header */}
        <div className="inv-print-header hidden border-b border-border mb-3 pb-2">
          <h1 className="text-lg font-bold">Inventory</h1>
          <p className="text-xs text-gray-600">
            Printed: {new Date().toLocaleString("en-ZA")} ·{' '}
            {rows.length} item{rows.length !== 1 ? "s" : ""}
            {highlightBelowCost && ' · Below-cost only'}
            {activeFilterCount > 0 && ` · ${activeFilterCount} filter${activeFilterCount !== 1 ? 's' : ''} applied`}
            <br />
            {getReportSignature()}
          </p>
        </div>

        {/* Print-only full table */}
        {!isLoading && !isError && rows.length > 0 && (
          <InventoryPrintTable
            rows={rows}
            hubMode={hubMode}
            formatNum={formatNum}
            formatCurrency={formatCurrency}
            highlightBelowCost={highlightBelowCost}
          />
        )}

        {/* Screen table */}
        {!isLoading && !isError && rows.length > 0 && (
          <InventoryTable
            rows={rows}
            hubMode={hubMode}
            formatNum={formatNum}
            formatCurrency={formatCurrency}
            COMMODITY_LABELS={COMMODITY_LABELS}
            highlightBelowCost={highlightBelowCost}
            sortField={sortField}
            sortDir={sortDir}
            onSort={handleSort}
          />
        )}

        {/* Truncation banner — when the hub-side endpoint capped the
            response and there are more rows than we received. Without
            this the operator has no way to know they're seeing a
            partial view. */}
        {!isLoading && !isError && isTruncated && (
          <div className="mt-3 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 rounded px-3 py-2">
            Showing <strong>{returnedCount.toLocaleString()}</strong> of <strong>{totalAvailable.toLocaleString()}</strong> items.
            The server caps results to keep the page snappy; refine your search to see the rest.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Tables ───────────────────────────────────────────────────────────────────
const ROW_HEIGHT = 30;
const TABLE_HEIGHT = typeof window !== "undefined" ? Math.max(300, window.innerHeight - 260) : 600;

function InventoryPrintTable({ rows, hubMode, formatNum, formatCurrency, highlightBelowCost }) {
  const isBelowCost = (row) => {
    const price = parseFloat(String(row.price || '').replace(/[^0-9.-]/g, ''));
    const cost = parseFloat(String(row.last_cost || '').replace(/[^0-9.-]/g, ''));
    return !isNaN(price) && !isNaN(cost) && cost > 0 && price <= cost;
  };
  const printRows = rows;

  return (
    <div className="inv-print-only hidden print-table-shell rounded-xl border border-border bg-card overflow-hidden">
      <div className="print-table-wrap">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-card">
              <th className="px-2 py-1.5 text-left text-xs font-medium uppercase tracking-wide">Item Number</th>
              <th className="px-2 py-1.5 text-left text-xs font-medium uppercase tracking-wide">Description</th>
              <th className="px-2 py-1.5 text-right text-xs font-medium uppercase tracking-wide">Qty on Hand</th>
              <th className="px-2 py-1.5 text-right text-xs font-medium uppercase tracking-wide">Last Cost</th>
              <th className="px-2 py-1.5 text-right text-xs font-medium uppercase tracking-wide">Price</th>
              <th className="px-2 py-1.5 text-right text-xs font-medium uppercase tracking-wide">Price List</th>
              <th className="px-2 py-1.5 text-left text-xs font-medium uppercase tracking-wide">UOM</th>
              {hubMode && <th className="px-2 py-1.5 text-left text-xs font-medium uppercase tracking-wide">Site</th>}
            </tr>
          </thead>
          <tbody>
            {printRows.map((row, idx) => (
              <tr
                key={`print-${row.site_id || 'site'}-${row.item_number || idx}-${idx}`}
                className={`border-b border-border ${highlightBelowCost && isBelowCost(row) ? 'bg-red-500/10' : ''}`}
              >
                <td className="px-2 py-1 text-xs font-mono whitespace-nowrap">{row.item_number || '—'}</td>
                <td className="px-2 py-1 text-xs">{row.item_description || '—'}</td>
                <td className="px-2 py-1 text-xs text-right tabular-nums">{(row.qty_on_hand === null || row.qty_on_hand === undefined || row.qty_on_hand === '') ? formatNum(0, 0) : formatNum(row.qty_on_hand, 0)}</td>
                <td className="px-2 py-1 text-xs text-right tabular-nums">{formatCurrency(row.last_cost)}</td>
                <td className="px-2 py-1 text-xs text-right tabular-nums">{formatCurrency(row.price)}</td>
                <td className="px-2 py-1 text-xs text-right tabular-nums">{formatNum(row.price_list)}</td>
                <td className="px-2 py-1 text-xs">{row.stocking_uom || '—'}</td>
                {hubMode && <td className="px-2 py-1 text-xs">{row.site_name || row.site_id || '—'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InventoryTable({ rows, hubMode, formatNum, formatCurrency, COMMODITY_LABELS, highlightBelowCost, sortField, sortDir, onSort }) {
  function SA({ field }) {
    if (sortField !== field) return <span className="ml-0.5 opacity-30">⇅</span>;
    return <span className="ml-0.5 opacity-80">{sortDir === "asc" ? "↑" : "↓"}</span>;
  }
  // `relative` so the absolute-positioned ResizeHandle anchors correctly.
  const sh = "relative px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none hover:text-foreground transition-colors";
  const parentRef = useRef(/** @type {HTMLDivElement | null} */ (null));

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const { widths, setWidths, startResize, resetColumn } = useInvColumnWidths(parentRef);
  const visibleKeys = useMemo(
    () => ['itemNumber', 'description', 'qty', 'lastCost', 'price', 'priceList', 'uom', ...(hubMode ? ['site'] : [])],
    [hubMode],
  );
  const totalWidth = useMemo(
    () => visibleKeys.reduce((s, k) => s + (widths[k] || 100), 0),
    [visibleKeys, widths],
  );

  // Auto-fit: scale visible columns proportionally so they ALWAYS fill the
  // container exactly — no empty band on the right when total < container,
  // no overflow when total > container.
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const fit = () => {
      const inner = el.clientWidth;
      if (!inner) return;
      const target = inner - 1;
      const total = visibleKeys.reduce((s, k) => s + (widths[k] || 100), 0);
      if (Math.abs(total - target) < 2) return;
      const scale = target / total;
      setWidths((w) => {
        const next = { ...w };
        for (const k of visibleKeys) next[k] = Math.max(40, Math.round((w[k] || 100) * scale));
        return next;
      });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKeys.join('|')]);

  const items = virtualizer.getVirtualItems();
  const totalHeight = virtualizer.getTotalSize();
  const paddingTop = items.length === 0 ? 0 : items[0].start;
  const paddingBottom = items.length === 0 ? 0 : totalHeight - items[items.length - 1].end;

  const isBelowCost = (row) => {
    const price = parseFloat(String(row.price || '').replace(/[^0-9.-]/g, ''));
    const cost = parseFloat(String(row.last_cost || '').replace(/[^0-9.-]/g, ''));
    return !isNaN(price) && !isNaN(cost) && cost > 0 && price <= cost;
  };

  return (
    <div className="inv-screen-only print-table-shell rounded-xl border border-border bg-card overflow-hidden">
      <div
        ref={parentRef}
        className="print-table-wrap"
        style={{ height: "min(900px, calc(100vh - 180px))", overflowY: "auto", overflowX: "hidden" }}
      >
        {/* Same percentage-fill layout as InvoiceMatching / CustomerBalances:
            table is width:100%, each column is a percentage of the total
            so the browser fills the container natively. The pixel widths
            in `widths` only matter as proportions; resize handles still
            update those pixel values, and we re-render percentages on
            every keystroke. Eliminates the "table wider than container"
            and "empty band on the right" failure modes the JS auto-fit
            loop used to produce. */}
        <table className="text-sm w-full" style={{ tableLayout: "fixed" }}>
          <colgroup>
            {visibleKeys.map((k) => (
              <col
                key={k}
                style={{ width: `${((widths[k] || 100) / (totalWidth || 1)) * 100}%` }}
              />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-20">
            <tr className="border-b border-border bg-card">
              <Tooltip><TooltipTrigger asChild><th onClick={() => onSort("item_number")} className={`${sh} text-left`}><span className="block truncate">Item Number<SA field="item_number" /></span><InvResizeHandle id="itemNumber" startResize={startResize} resetColumn={resetColumn} visibleKeys={visibleKeys} /></th></TooltipTrigger><TooltipContent>Unique stock item code — click to sort</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild><th onClick={() => onSort("item_description")} className={`${sh} text-left`}><span className="block truncate">Description<SA field="item_description" /></span><InvResizeHandle id="description" startResize={startResize} resetColumn={resetColumn} visibleKeys={visibleKeys} /></th></TooltipTrigger><TooltipContent>Item name or description — click to sort</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild><th onClick={() => onSort("qty_on_hand")} className={`${sh} text-right`}><span className="block truncate">Qty on Hand<SA field="qty_on_hand" /></span><InvResizeHandle id="qty" startResize={startResize} resetColumn={resetColumn} visibleKeys={visibleKeys} /></th></TooltipTrigger><TooltipContent>Current stock quantity on hand — click to sort</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild><th onClick={() => onSort("last_cost")} className={`${sh} text-right`}><span className="block truncate">Last Cost<SA field="last_cost" /></span><InvResizeHandle id="lastCost" startResize={startResize} resetColumn={resetColumn} visibleKeys={visibleKeys} /></th></TooltipTrigger><TooltipContent>Most recent purchase cost per unit — click to sort</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild><th onClick={() => onSort("price")} className={`${sh} text-right`}><span className="block truncate">Price<SA field="price" /></span><InvResizeHandle id="price" startResize={startResize} resetColumn={resetColumn} visibleKeys={visibleKeys} /></th></TooltipTrigger><TooltipContent>Current selling price per unit — click to sort</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild><th onClick={() => onSort("price_list")} className={`${sh} text-right`}><span className="block truncate">Price List<SA field="price_list" /></span><InvResizeHandle id="priceList" startResize={startResize} resetColumn={resetColumn} visibleKeys={visibleKeys} /></th></TooltipTrigger><TooltipContent>Price list this item belongs to — click to sort</TooltipContent></Tooltip>
              <Tooltip><TooltipTrigger asChild><th className="relative px-2 py-1.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide"><span className="block truncate">UOM</span><InvResizeHandle id="uom" startResize={startResize} resetColumn={resetColumn} visibleKeys={visibleKeys} /></th></TooltipTrigger><TooltipContent>Stocking unit of measure (e.g. Each, Box, Carton)</TooltipContent></Tooltip>
              {hubMode && (
                <Tooltip><TooltipTrigger asChild><th onClick={() => onSort("site_name")} className={`${sh} text-left`}><span className="block truncate">Site<SA field="site_name" /></span><InvResizeHandle id="site" startResize={startResize} resetColumn={resetColumn} visibleKeys={visibleKeys} /></th></TooltipTrigger><TooltipContent>Site this inventory record belongs to — click to sort</TooltipContent></Tooltip>
              )}
            </tr>
          </thead>
          <tbody>
            {paddingTop > 0 && <tr><td style={{ height: paddingTop }} colSpan={hubMode ? 8 : 7} /></tr>}
            {items.map((vRow) => ({ index: vRow.index, key: vRow.key, row: rows[vRow.index] })).map(({ key, row }) => {
              return (
                <tr
                  key={key}
                  className={`border-b border-border transition-colors ${highlightBelowCost && isBelowCost(row) ? "bg-red-500/10 hover:bg-red-500/15" : "hover:bg-muted/30"}`}
                >
                  <td className="px-2 py-1 text-xs font-mono text-foreground whitespace-nowrap overflow-hidden text-ellipsis">{row.item_number || "—"}</td>
                  <td className="px-2 py-1 text-xs text-foreground overflow-hidden text-ellipsis">{row.item_description || "—"}</td>
                  <td className="px-2 py-1 text-xs text-right tabular-nums text-foreground">{(row.qty_on_hand === null || row.qty_on_hand === undefined || row.qty_on_hand === '') ? formatNum(0, 0) : formatNum(row.qty_on_hand, 0)}</td>
                  <td className={`px-2 py-1 text-xs text-right tabular-nums ${highlightBelowCost && isBelowCost(row) ? "text-red-400 font-semibold" : "text-foreground"}`}>{formatCurrency(row.last_cost)}</td>
                  <td className={`px-2 py-1 text-xs text-right tabular-nums ${highlightBelowCost && isBelowCost(row) ? "text-red-400 font-semibold" : "text-foreground"}`}>{formatCurrency(row.price)}</td>
                  <td className="px-2 py-1 text-xs text-right tabular-nums text-foreground">{formatNum(row.price_list)}</td>
                  <td className="px-2 py-1 text-xs text-foreground overflow-hidden text-ellipsis">{row.stocking_uom || "—"}</td>
                  {hubMode && (
                    <td className="px-2 py-1 text-xs text-muted-foreground overflow-hidden text-ellipsis">{row.site_name || row.site_id || "—"}</td>
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
