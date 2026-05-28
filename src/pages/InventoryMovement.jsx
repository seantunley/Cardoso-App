import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  TrendingUp, Package, RefreshCw, Search, ArrowUpDown,
  BarChart3, AlertTriangle, ChevronLeft, ShoppingCart, Printer,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";

async function apiFetch(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

const COMMODITY_LABELS = { '1': 'Sweets', '2': 'Cigarettes', '3': 'Tobacco', '4': 'Mixed' };

const formatCurrency = (v) => {
  if (v == null) return "—";
  const n = parseFloat(v);
  if (isNaN(n)) return "—";
  const abs = Math.abs(n).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-R ${abs}` : `R ${abs}`;
};
const formatNum = (v) => {
  if (v == null) return "—";
  const n = parseFloat(v);
  if (isNaN(n)) return "—";
  return n.toLocaleString("en-ZA", { maximumFractionDigits: 0 });
};

const THRESHOLD_OPTIONS = [
  { value: 30, label: "30 days" },
  { value: 60, label: "60 days" },
  { value: 90, label: "90 days" },
  { value: 180, label: "180 days" },
  { value: 365, label: "1 year" },
];

function QueryError({ error, label }) {
  const msg = error?.message || "An unexpected error occurred";
  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-center text-sm text-red-400">
      <AlertTriangle className="h-8 w-8 mx-auto mb-3 opacity-70" />
      <p className="font-semibold mb-1">Failed to load {label}</p>
      <p className="text-red-400/70 text-xs max-w-md mx-auto">{msg}</p>
    </div>
  );
}

function AgeBadge({ days }) {
  if (days == null || days === 999999) return <span className="text-red-400 font-semibold text-xs">Never sold</span>;
  const cls = days <= 30
    ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
    : days <= 90
      ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
      : "bg-red-500/15 text-red-400 border-red-500/30";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cls}`}>
      {days}d
    </span>
  );
}

function PeriodSelector({ from, to, onChange }) {
  const presets = [
    { label: "Last 3 months", months: 3 },
    { label: "Last 6 months", months: 6 },
    { label: "YTD", months: 0 },
    { label: "Last 12 months", months: 12 },
  ];
  const getRange = (months) => {
    const now = new Date();
    const curMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    if (months === 0) {
      return { from: `${now.getFullYear()}-01`, to: curMonth };
    }
    // "Last N months" = the N months before the current one.
    // E.g. in May, "Last 3 months" = Feb–Apr (months 2,3,4), not Feb–May.
    const fromDate = new Date(now.getFullYear(), now.getMonth() - months, 1);
    const toDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return {
      from: `${fromDate.getFullYear()}-${String(fromDate.getMonth() + 1).padStart(2, '0')}`,
      to: `${toDate.getFullYear()}-${String(toDate.getMonth() + 1).padStart(2, '0')}`,
    };
  };
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {presets.map((p) => {
        const range = getRange(p.months);
        const active = from === range.from && to === range.to;
        return (
          <button
            key={p.label}
            onClick={() => onChange(range)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              active
                ? "border-amber-500 bg-amber-500/15 text-amber-400"
                : "border-border bg-card text-muted-foreground hover:text-foreground"
            }`}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

function SortHeader({ label, field, current, dir, onSort, className = "" }) {
  const active = current === field;
  return (
    <th
      onClick={() => onSort(field)}
      className={`px-3 py-2 text-xs font-medium uppercase tracking-wide cursor-pointer select-none hover:text-foreground transition-colors ${className} ${active ? "text-foreground" : "text-muted-foreground"}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (dir === "asc" ? " ↑" : " ↓") : <ArrowUpDown className="h-3 w-3 opacity-30" />}
      </span>
    </th>
  );
}

export default function InventoryMovement() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("topMovers");
  const [search, setSearch] = useState("");
  const [siteFilter, setSiteFilter] = useState("all");

  const now = new Date();
  const defaultFrom = `${now.getFullYear()}-01`;
  const defaultTo = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [commodity, setCommodity] = useState("all");
  const [threshold, setThreshold] = useState(90);

  const [sortField, setSortField] = useState("total_qty_sold");
  const [sortDir, setSortDir] = useState("desc");
  const [deadSortField, setDeadSortField] = useState("capital_tied_up");
  const [deadSortDir, setDeadSortDir] = useState("desc");

  const sitesQuery = useQuery({
    queryKey: ["inv-movement-sites"],
    queryFn: () => apiFetch("/api/inventory-movement/sites"),
    staleTime: 300_000,
  });
  const hubMode = sitesQuery.data?.hub === true;

  const [selectedItem, setSelectedItem] = useState(null);
  const [selectedSiteId, setSelectedSiteId] = useState(null);

  const handleSort = useCallback((field) => {
    if (sortField === field) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("desc"); }
  }, [sortField]);

  const handleDeadSort = useCallback((field) => {
    if (deadSortField === field) setDeadSortDir(d => d === "asc" ? "desc" : "asc");
    else { setDeadSortField(field); setDeadSortDir("desc"); }
  }, [deadSortField]);

  const syncMeta = useQuery({
    queryKey: ["inv-movement-meta"],
    queryFn: () => apiFetch("/api/inventory-movement/sync-meta"),
  });

  const commodities = useQuery({
    queryKey: ["inv-movement-commodities"],
    queryFn: () => apiFetch("/api/inventory-movement/commodities"),
    staleTime: 300_000,
  });

  const topMovers = useQuery({
    queryKey: ["inv-movement-top", from, to, commodity, siteFilter],
    queryFn: () => {
      const params = new URLSearchParams({ from, to, limit: "200" });
      if (commodity !== "all") params.set("commodity", commodity);
      if (siteFilter !== "all") params.set("site_id", siteFilter);
      return apiFetch(`/api/inventory-movement/top-movers?${params}`);
    },
    enabled: tab === "topMovers",
    staleTime: 60_000,
  });

  const deadStock = useQuery({
    queryKey: ["inv-movement-dead", threshold, commodity, siteFilter],
    queryFn: () => {
      const params = new URLSearchParams({ threshold: String(threshold), limit: "500" });
      if (commodity !== "all") params.set("commodity", commodity);
      if (siteFilter !== "all") params.set("site_id", siteFilter);
      return apiFetch(`/api/inventory-movement/dead-stock?${params}`);
    },
    enabled: tab === "deadStock",
    staleTime: 60_000,
  });

  const itemTrend = useQuery({
    queryKey: ["inv-movement-trend", selectedItem, from, to, selectedSiteId || siteFilter],
    queryFn: () => {
      const params = new URLSearchParams({ item: selectedItem, from, to });
      const effectiveSite = selectedSiteId || (siteFilter !== "all" ? siteFilter : null);
      if (effectiveSite) params.set("site_id", effectiveSite);
      return apiFetch(`/api/inventory-movement/item-trend?${params}`);
    },
    enabled: !!selectedItem && tab === "trend",
    staleTime: 60_000,
  });

  const syncMutation = useMutation({
    mutationFn: () => fetch("/api/inventory-movement/sync", { method: "POST", credentials: "include" }).then(async r => {
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      return d;
    }),
    onSuccess: (data) => {
      toast.success("Sales data synced", { description: `${data.synced} item-month rows synced from Sage` });
      queryClient.invalidateQueries({ queryKey: ["inv-movement-top"] });
      queryClient.invalidateQueries({ queryKey: ["inv-movement-dead"] });
      queryClient.invalidateQueries({ queryKey: ["inv-movement-meta"] });
      queryClient.invalidateQueries({ queryKey: ["inv-movement-trend"] });
    },
    onError: (err) => toast.error("Sync failed", { description: err.message }),
  });

  const sortedTopMovers = useMemo(() => {
    const rows = topMovers.data?.rows || [];
    const q = search.toLowerCase();
    const filtered = q
      ? rows.filter(r => (r.item_number || "").toLowerCase().includes(q) || (r.item_description || "").toLowerCase().includes(q))
      : rows;
    return [...filtered].sort((a, b) => {
      const av = a[sortField];
      const bv = b[sortField];
      if (typeof av === "string" || typeof bv === "string") {
        const sa = String(av ?? "");
        const sb = String(bv ?? "");
        return sortDir === "asc" ? sa.localeCompare(sb) : sb.localeCompare(sa);
      }
      return sortDir === "asc" ? (av ?? 0) - (bv ?? 0) : (bv ?? 0) - (av ?? 0);
    });
  }, [topMovers.data, search, sortField, sortDir]);

  const sortedDeadStock = useMemo(() => {
    const rows = deadStock.data?.rows || [];
    const q = search.toLowerCase();
    const filtered = q
      ? rows.filter(r => (r.item_number || "").toLowerCase().includes(q) || (r.item_description || "").toLowerCase().includes(q))
      : rows;
    return [...filtered].sort((a, b) => {
      const av = a[deadSortField];
      const bv = b[deadSortField];
      if (typeof av === "string" || typeof bv === "string") {
        const sa = String(av ?? "");
        const sb = String(bv ?? "");
        return deadSortDir === "asc" ? sa.localeCompare(sb) : sb.localeCompare(sa);
      }
      return deadSortDir === "asc" ? (av ?? 0) - (bv ?? 0) : (bv ?? 0) - (av ?? 0);
    });
  }, [deadStock.data, search, deadSortField, deadSortDir]);

  const totalDeadCapital = useMemo(
    () => sortedDeadStock.reduce((s, r) => s + (r.capital_tied_up || 0), 0),
    [sortedDeadStock],
  );

  // Forecast state
  const [forecastSort, setForecastSort] = useState("days_of_stock");
  const [forecastDir, setForecastDir] = useState("asc");
  const [abcFilter, setAbcFilter] = useState("all");

  const forecast = useQuery({
    queryKey: ["inv-movement-forecast", forecastSort, forecastDir, abcFilter, commodity],
    queryFn: () => {
      const params = new URLSearchParams({ sort: forecastSort, dir: forecastDir, limit: "300" });
      if (abcFilter !== "all") params.set("abc", abcFilter);
      if (commodity !== "all") params.set("commodity", commodity);
      return apiFetch(`/api/inventory-movement/forecast?${params}`);
    },
    enabled: tab === "forecast" && !hubMode,
    staleTime: 60_000,
  });

  const recomputeMutation = useMutation({
    mutationFn: () => fetch("/api/inventory-movement/recompute-forecast", { method: "POST", credentials: "include" }).then(async r => {
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      return d;
    }),
    onSuccess: (data) => {
      toast.success("Forecast recomputed", { description: `${data.computed} items` });
      queryClient.invalidateQueries({ queryKey: ["inv-movement-forecast"] });
    },
    onError: (err) => toast.error("Recompute failed", { description: err.message }),
  });

  const handleForecastSort = useCallback((field) => {
    if (forecastSort === field) setForecastDir(d => d === "asc" ? "desc" : "asc");
    else { setForecastSort(field); setForecastDir(field === "days_of_stock" ? "asc" : "desc"); }
  }, [forecastSort]);

  const forecastRows = useMemo(() => {
    const rows = forecast.data?.rows || [];
    if (!search) return rows;
    const q = search.toLowerCase();
    return rows.filter(r => (r.item_number || "").toLowerCase().includes(q) || (r.item_description || "").toLowerCase().includes(q));
  }, [forecast.data, search]);

  const tabs = [
    { id: "topMovers", label: "Top Movers", icon: TrendingUp },
    { id: "deadStock", label: "Dead Stock", icon: AlertTriangle },
    ...(!hubMode ? [{ id: "forecast", label: "Forecast", icon: ShoppingCart }] : []),
  ];

  return (
    <div className="inv-movement-page min-h-screen bg-background text-foreground px-6 pt-4 pb-6">
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .inv-movement-page, .inv-movement-page * { visibility: visible; }
          .inv-movement-page { position: absolute; left: 0; top: 0; width: 100%; }
          nav, header, aside, [data-sidebar], .no-print { display: none !important; }
          .inv-print-header { display: block !important; }
          .print-table-wrap { overflow: visible !important; height: auto !important; max-height: none !important; }
          @page { size: landscape; margin: 10mm; }
        }
      `}</style>
      {/* Print-only header */}
      <div className="inv-print-header hidden border-b border-border mb-3 pb-2">
        <h1 className="text-lg font-bold">Inventory Movement — Demand Forecast</h1>
        <p className="text-xs text-gray-600">
          Printed: {new Date().toLocaleString("en-ZA")} · {forecastRows.length} items
          {abcFilter !== "all" ? ` · ABC: ${abcFilter}` : ""}
        </p>
      </div>
      {/* Header */}
      <div className="border-b border-border pb-5 mb-5 no-print">
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">§ Inventory Movement</div>
        <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
          What <em className="text-phosphor">moves</em>, what doesn't.
        </h1>
        <p className="text-sm text-muted-foreground mt-3">
          Sales velocity and dead stock analysis from Sage shipment history. Used for forecasting and stock management.
        </p>
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-4 mb-6">
        <div className="flex items-center gap-4 flex-wrap">
          {/* Tabs */}
          <div className="flex gap-1 rounded-xl border border-border p-1 bg-card">
            {tabs.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  onClick={() => { setTab(t.id); setSelectedItem(null); setSelectedSiteId(null); }}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                    tab === t.id ? "bg-amber-500/15 text-amber-400 border border-amber-500/30" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t.label}
                </button>
              );
            })}
          </div>

          {hubMode && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground">Site</label>
              <select
                value={siteFilter}
                onChange={(e) => setSiteFilter(e.target.value)}
                className="h-8 rounded-lg border border-border bg-card px-2 text-xs text-foreground"
              >
                <option value="all">All Sites (Combined)</option>
                {(sitesQuery.data?.sites || []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground">Commodity</label>
            <select
              value={commodity}
              onChange={(e) => setCommodity(e.target.value)}
              className="h-8 rounded-lg border border-border bg-card px-2 text-xs text-foreground"
            >
              <option value="all">All</option>
              {(commodities.data?.commodities || []).map((c) => (
                <option key={c} value={c}>{COMMODITY_LABELS[c] || c}</option>
              ))}
            </select>
          </div>

          {/* Search */}
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search item number or description…"
              className="w-full h-8 pl-8 pr-3 rounded-lg border border-border bg-card text-xs text-foreground placeholder:text-muted-foreground"
            />
          </div>

          {/* Sync button — site-mode only (hub pulls from sites via ETL) */}
          {!hubMode && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${syncMutation.isPending ? "animate-spin" : ""}`} />
                Sync from Sage
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {syncMeta.data?.last_synced_at
                ? `Last synced: ${new Date(syncMeta.data.last_synced_at).toLocaleString("en-ZA")} · ${syncMeta.data.rows_synced} rows`
                : "Never synced — click to pull sales data from Sage"}
            </TooltipContent>
          </Tooltip>
          )}
        </div>

        {/* Period selector for top movers */}
        {(tab === "topMovers" || tab === "trend") && (
          <PeriodSelector from={from} to={to} onChange={({ from: f, to: t }) => { setFrom(f); setTo(t); }} />
        )}

        {/* Threshold for dead stock */}
        {tab === "deadStock" && (
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground">No sales in the last</label>
            {THRESHOLD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setThreshold(opt.value)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  threshold === opt.value
                    ? "border-red-500 bg-red-500/15 text-red-400"
                    : "border-border bg-card text-muted-foreground hover:text-foreground"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Trend detail view */}
      {tab === "trend" && selectedItem && (
        <div className="mb-6 space-y-4">
          <div className="flex items-center gap-3">
            <button onClick={() => { setTab("topMovers"); setSelectedItem(null); setSelectedSiteId(null); }} className="text-muted-foreground hover:text-foreground transition-colors">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <div>
              <h2 className="text-lg font-semibold text-foreground">{selectedItem}</h2>
              <p className="text-xs text-muted-foreground">
                Monthly sales trend{selectedSiteId && (() => {
                  const site = sitesQuery.data?.sites?.find(s => s.id === selectedSiteId);
                  return site ? ` — ${site.name}` : ` — ${selectedSiteId}`;
                })()}
              </p>
            </div>
          </div>

          {itemTrend.isLoading && <div className="text-sm text-muted-foreground">Loading trend…</div>}
          {!itemTrend.isLoading && itemTrend.isError && (
            <QueryError error={itemTrend.error} label="item trend" />
          )}
          {!itemTrend.isLoading && !itemTrend.isError && itemTrend.data?.rows?.length === 0 && (
            <div className="text-sm text-muted-foreground">No sales data for this item in the selected period.</div>
          )}

          {itemTrend.data?.rows?.length > 0 && (
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <table className="w-full text-xs">
                <thead className="border-b border-border bg-card">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase">Month</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase">Qty Sold</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase">Revenue</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase">Orders</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase">Avg Qty/Order</th>
                  </tr>
                </thead>
                <tbody>
                  {itemTrend.data.rows.map((r) => (
                    <tr key={r.period} className="border-b border-border last:border-0 hover:bg-muted/20">
                      <td className="px-3 py-2 font-mono">{r.period}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold">{formatNum(r.qty_sold)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(r.revenue)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{r.order_count}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {r.order_count > 0 ? (r.qty_sold / r.order_count).toFixed(1) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Top Movers Table */}
      {tab === "topMovers" && (
        <>
          {topMovers.isLoading && (
            <div className="flex items-center justify-center py-20 text-muted-foreground">
              <RefreshCw className="h-5 w-5 animate-spin mr-2" /> Loading…
            </div>
          )}
          {!topMovers.isLoading && topMovers.isError && (
            <QueryError error={topMovers.error} label="top movers" />
          )}
          {!topMovers.isLoading && !topMovers.isError && sortedTopMovers.length === 0 && (
            <div className="rounded-xl border border-border bg-card p-12 text-center text-sm text-muted-foreground">
              <Package className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
              {syncMeta.data?.last_synced_at
                ? "No sales data found for the selected period and filters."
                : hubMode
                  ? "No movement data synced from sites yet. Data arrives during the next hub sync cycle."
                  : 'No sales data yet. Click "Sync from Sage" to pull shipment history.'}
            </div>
          )}
          {sortedTopMovers.length > 0 && (
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="text-xs text-muted-foreground px-3 py-2 border-b border-border">
                {sortedTopMovers.length} items · {from} to {to}
              </div>
              <div className="overflow-x-auto max-h-[calc(100vh-320px)] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-10 bg-card border-b border-border">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase w-8">#</th>
                      <SortHeader label="Item" field="item_number" current={sortField} dir={sortDir} onSort={handleSort} className="text-left" />
                      <SortHeader label="Description" field="item_description" current={sortField} dir={sortDir} onSort={handleSort} className="text-left" />
                      {hubMode && siteFilter === "all" && <SortHeader label="Site" field="site_name" current={sortField} dir={sortDir} onSort={handleSort} className="text-left" />}
                      <SortHeader label="Qty Sold" field="total_qty_sold" current={sortField} dir={sortDir} onSort={handleSort} className="text-right" />
                      <SortHeader label="Revenue" field="total_revenue" current={sortField} dir={sortDir} onSort={handleSort} className="text-right" />
                      <SortHeader label="Orders" field="total_orders" current={sortField} dir={sortDir} onSort={handleSort} className="text-right" />
                      <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase">Avg/Order</th>
                      <SortHeader label="On Hand" field="qty_on_hand" current={sortField} dir={sortDir} onSort={handleSort} className="text-right" />
                      <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase">Last Sale</th>
                      <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground uppercase"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedTopMovers.map((r, idx) => (
                      <tr key={`${r.site_id || 'local'}-${r.item_number}`} className="border-b border-border last:border-0 hover:bg-muted/20">
                        <td className="px-3 py-2 text-muted-foreground tabular-nums">{idx + 1}</td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap">{r.item_number}</td>
                        <td className="px-3 py-2 max-w-[200px] truncate" title={r.item_description}>{r.item_description || "—"}</td>
                        {hubMode && siteFilter === "all" && <td className="px-3 py-2 text-xs text-muted-foreground">{r.site_name || "—"}</td>}
                        <td className="px-3 py-2 text-right tabular-nums font-semibold text-foreground">{formatNum(r.total_qty_sold)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(r.total_revenue)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.total_orders}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.total_orders > 0 ? (r.total_qty_sold / r.total_orders).toFixed(1) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatNum(r.qty_on_hand)}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap text-muted-foreground">{r.last_sale_date || "—"}</td>
                        <td className="px-3 py-2 text-center">
                          <button
                            onClick={() => { setSelectedItem(r.item_number); setSelectedSiteId(r.site_id && r.site_id !== "all" ? r.site_id : null); setTab("trend"); }}
                            className="text-muted-foreground hover:text-foreground transition-colors"
                            title="View trend"
                          >
                            <BarChart3 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Dead Stock Table */}
      {tab === "deadStock" && (
        <>
          {deadStock.isLoading && (
            <div className="flex items-center justify-center py-20 text-muted-foreground">
              <RefreshCw className="h-5 w-5 animate-spin mr-2" /> Loading…
            </div>
          )}
          {!deadStock.isLoading && deadStock.isError && (
            <QueryError error={deadStock.error} label="dead stock" />
          )}
          {!deadStock.isLoading && !deadStock.isError && sortedDeadStock.length === 0 && (
            <div className="rounded-xl border border-border bg-card p-12 text-center text-sm text-muted-foreground">
              <Package className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
              No dead stock found for the selected threshold.
            </div>
          )}
          {sortedDeadStock.length > 0 && (
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="text-xs text-muted-foreground px-3 py-2 border-b border-border flex items-center gap-4">
                <span>{sortedDeadStock.length} items with no sales in {threshold}+ days</span>
                <span className="text-red-400 font-semibold">Capital tied up: {formatCurrency(totalDeadCapital)}</span>
              </div>
              <div className="overflow-x-auto max-h-[calc(100vh-320px)] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-10 bg-card border-b border-border">
                    <tr>
                      <SortHeader label="Item" field="item_number" current={deadSortField} dir={deadSortDir} onSort={handleDeadSort} className="text-left" />
                      <SortHeader label="Description" field="item_description" current={deadSortField} dir={deadSortDir} onSort={handleDeadSort} className="text-left" />
                      {hubMode && siteFilter === "all" && <SortHeader label="Site" field="site_name" current={deadSortField} dir={deadSortDir} onSort={handleDeadSort} className="text-left" />}
                      <SortHeader label="On Hand" field="qty_on_hand" current={deadSortField} dir={deadSortDir} onSort={handleDeadSort} className="text-right" />
                      <SortHeader label="Last Cost" field="last_cost" current={deadSortField} dir={deadSortDir} onSort={handleDeadSort} className="text-right" />
                      <SortHeader label="Capital Tied Up" field="capital_tied_up" current={deadSortField} dir={deadSortDir} onSort={handleDeadSort} className="text-right" />
                      <SortHeader label="Days Since Sale" field="days_since_sale" current={deadSortField} dir={deadSortDir} onSort={handleDeadSort} className="text-right" />
                      <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase">Last Sale</th>
                      <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground uppercase">Age</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedDeadStock.map((r) => (
                      <tr key={`${r.site_id || 'local'}-${r.item_number}`} className="border-b border-border last:border-0 hover:bg-muted/20">
                        <td className="px-3 py-2 font-mono whitespace-nowrap">{r.item_number}</td>
                        <td className="px-3 py-2 max-w-[200px] truncate" title={r.item_description}>{r.item_description || "—"}</td>
                        {hubMode && siteFilter === "all" && <td className="px-3 py-2 text-xs text-muted-foreground">{r.site_name || "—"}</td>}
                        <td className="px-3 py-2 text-right tabular-nums">{formatNum(r.qty_on_hand)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatCurrency(r.last_cost)}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold text-red-400">{formatCurrency(r.capital_tied_up)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.days_since_sale === 999999 ? "—" : r.days_since_sale}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap text-muted-foreground">{r.last_sale_date === "never" ? "—" : r.last_sale_date}</td>
                        <td className="px-3 py-2 text-center"><AgeBadge days={r.days_since_sale} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Forecast Tab */}
      {tab === "forecast" && !hubMode && (
        <>
          <div className="flex items-center gap-3 flex-wrap mb-4">
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground">ABC Class</label>
              {["all", "A", "B", "C"].map((v) => (
                <button
                  key={v}
                  onClick={() => setAbcFilter(v)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    abcFilter === v
                      ? "border-amber-500 bg-amber-500/15 text-amber-400"
                      : "border-border bg-card text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {v === "all" ? "All" : v}
                </button>
              ))}
            </div>
            <button
              onClick={() => recomputeMutation.mutate()}
              disabled={recomputeMutation.isPending}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${recomputeMutation.isPending ? "animate-spin" : ""}`} />
              Recompute
            </button>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Printer className="h-3.5 w-3.5" />
                  Print
                </button>
              </TooltipTrigger>
              <TooltipContent>Print forecast table as PDF</TooltipContent>
            </Tooltip>
          </div>

          {forecast.isLoading && (
            <div className="flex items-center justify-center py-20 text-muted-foreground">
              <RefreshCw className="h-5 w-5 animate-spin mr-2" /> Loading forecast…
            </div>
          )}
          {!forecast.isLoading && forecast.isError && (
            <QueryError error={forecast.error} label="forecast" />
          )}
          {!forecast.isLoading && !forecast.isError && forecastRows.length === 0 && (
            <div className="rounded-xl border border-border bg-card p-12 text-center text-sm text-muted-foreground">
              <Package className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
              No forecast data. Click "Recompute" after syncing sales data.
            </div>
          )}
          {forecastRows.length > 0 && (
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="text-xs text-muted-foreground px-3 py-2 border-b border-border">
                {forecastRows.length} items · sorted by {forecastSort.replace(/_/g, " ")} {forecastDir}
              </div>
              <div className="overflow-x-auto max-h-[calc(100vh-380px)] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-10 bg-card border-b border-border">
                    <tr>
                      <SortHeader label="Item" field="item_number" current={forecastSort} dir={forecastDir} onSort={handleForecastSort} className="text-left" />
                      <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase">Description</th>
                      <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground uppercase">ABC</th>
                      <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase">On Hand</th>
                      <SortHeader label="Daily Demand" field="avg_daily_demand" current={forecastSort} dir={forecastDir} onSort={handleForecastSort} className="text-right" />
                      <SortHeader label="Adj Demand/Mo" field="adjusted_demand" current={forecastSort} dir={forecastDir} onSort={handleForecastSort} className="text-right" />
                      <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase">Season</th>
                      <SortHeader label="Reorder Pt" field="reorder_point" current={forecastSort} dir={forecastDir} onSort={handleForecastSort} className="text-right" />
                      <SortHeader label="Days of Stock" field="days_of_stock" current={forecastSort} dir={forecastDir} onSort={handleForecastSort} className="text-right" />
                      <SortHeader label="Order Qty" field="suggested_order_qty" current={forecastSort} dir={forecastDir} onSort={handleForecastSort} className="text-right" />
                    </tr>
                  </thead>
                  <tbody>
                    {forecastRows.map((r) => {
                      const dos = r.days_of_stock;
                      const urgency = dos == null ? "none"
                        : dos < 7 ? "critical"
                        : dos < 14 ? "warning"
                        : dos < 30 ? "low"
                        : "ok";
                      const urgencyCls = {
                        critical: "bg-red-500/10 text-red-400 border-red-500/30",
                        warning: "bg-amber-500/10 text-amber-400 border-amber-500/30",
                        low: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30",
                        ok: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
                        none: "bg-slate-500/10 text-slate-400 border-slate-500/30",
                      }[urgency];
                      const abcCls = {
                        A: "bg-amber-500/15 text-amber-400 border-amber-500/30",
                        B: "bg-blue-500/15 text-blue-400 border-blue-500/30",
                        C: "bg-slate-500/15 text-slate-400 border-slate-500/30",
                      }[r.abc_class] || "";
                      return (
                        <tr key={r.item_number} className={`border-b border-border last:border-0 ${urgency === "critical" ? "bg-red-500/5" : urgency === "warning" ? "bg-amber-500/5" : "hover:bg-muted/20"}`}>
                          <td className="px-3 py-2 font-mono whitespace-nowrap">{r.item_number}</td>
                          <td className="px-3 py-2 max-w-[180px] truncate" title={r.item_description}>{r.item_description || "—"}</td>
                          <td className="px-3 py-2 text-center">
                            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${abcCls}`}>
                              {r.abc_class}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatNum(r.qty_on_hand)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{r.avg_daily_demand?.toFixed(1) ?? "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums font-semibold">{formatNum(r.adjusted_demand)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{r.seasonality_index?.toFixed(2) ?? "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{formatNum(r.reorder_point)}</td>
                          <td className="px-3 py-2 text-right">
                            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold tabular-nums ${urgencyCls}`}>
                              {dos != null ? `${Math.round(dos)}d` : "—"}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-semibold">
                            {r.suggested_order_qty > 0 ? formatNum(r.suggested_order_qty) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
