import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  TrendingUp, Package, RefreshCw, Search, ArrowUpDown,
  BarChart3, AlertTriangle, ChevronLeft, ChevronRight, ShoppingCart, Printer,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import ItemDetailModal from "@/components/inventory/ItemDetailModal";
import ForecastSettingsModal from "@/components/inventory/ForecastSettingsModal";
import ReorderPlanView from "@/components/inventory/ReorderPlanView";
import MovementHistoryView from "@/components/inventory/MovementHistoryView";
import EmptyState from "@/components/EmptyState";
import { Settings } from "lucide-react";
import { useUrlTab } from "@/lib/useUrlTab";
import { INVENTORY_MOVEMENT_TABS } from "@/lib/tabIds";

// Print-only header shown above the table when the page is printed. One
// component for every tab (kept in sync with the on-screen table) so a print
// is never mislabelled or — for tabs without a dedicated block — headerless.
function InvPrintHeader({ subtitle, details }) {
  return (
    <div className="inv-print-header hidden border-b border-border mb-3 pb-2">
      <h1 className="text-lg font-bold">Inventory Movement — {subtitle}</h1>
      <p className="text-xs text-gray-600">{details}</p>
    </div>
  );
}

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
  const isoDay = (d) => d.toISOString().slice(0, 10);
  const presets = [
    { label: "Last 7 days", days: 7 },
    { label: "Last 30 days", days: 30 },
    { label: "Last 90 days", days: 90 },
    { label: "YTD", ytd: true },
    { label: "Last 12 months", months: 12 },
  ];
  const getRange = (p) => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (p.ytd) {
      return { from: isoDay(new Date(now.getFullYear(), 0, 1)), to: isoDay(today) };
    }
    if (p.months) {
      const d = new Date(now.getFullYear(), now.getMonth() - p.months, now.getDate());
      return { from: isoDay(d), to: isoDay(today) };
    }
    // "Last N days" = the N days ending yesterday (today excluded — partial day skews totals)
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const fromD = new Date(yesterday); fromD.setDate(yesterday.getDate() - (p.days - 1));
    return { from: isoDay(fromD), to: isoDay(yesterday) };
  };
  const anyPresetActive = presets.some((p) => {
    const r = getRange(p);
    return r.from === from && r.to === to;
  });
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {presets.map((p) => {
        const range = getRange(p);
        const active = from === range.from && to === range.to;
        return (
          <button
            key={p.label}
            onClick={() => onChange(range)}
            title={`Set the date range to ${range.from} → ${range.to} (the ${p.label.toLowerCase()} window). Drives the OESHDT shipment query.`}
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
      <div className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${
        !anyPresetActive
          ? "border-amber-500 bg-amber-500/15 text-amber-400"
          : "border-border bg-card text-muted-foreground"
      }`}>
        <span className="opacity-70">Custom</span>
        <input
          type="date"
          value={from}
          max={to}
          onChange={(e) => e.target.value && onChange({ from: e.target.value, to })}
          className="bg-transparent border-none outline-none text-xs tabular-nums cursor-pointer [color-scheme:dark]"
          aria-label="From date"
          title="Start of the analysis window (inclusive). Drives the OESHDT shipment query for Top Movers and trend."
        />
        <span className="opacity-50">–</span>
        <input
          type="date"
          value={to}
          min={from}
          onChange={(e) => e.target.value && onChange({ from, to: e.target.value })}
          className="bg-transparent border-none outline-none text-xs tabular-nums cursor-pointer [color-scheme:dark]"
          aria-label="To date"
          title="End of the analysis window (inclusive). Drives the OESHDT shipment query for Top Movers and trend."
        />
      </div>
    </div>
  );
}

function SortHeader({ label, field, current, dir, onSort, className = "", tooltip }) {
  const active = current === field;
  const labelNode = tooltip ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dotted decoration-muted-foreground/40 underline-offset-2">{label}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs leading-relaxed">{tooltip}</TooltipContent>
    </Tooltip>
  ) : label;
  return (
    <th
      onClick={() => onSort(field)}
      className={`px-3 py-2 text-xs font-medium uppercase tracking-wide cursor-pointer select-none hover:text-foreground transition-colors ${className} ${active ? "text-foreground" : "text-muted-foreground"}`}
    >
      <span className="inline-flex items-center gap-1">
        {labelNode}
        {active ? (dir === "asc" ? " ↑" : " ↓") : <ArrowUpDown className="h-3 w-3 opacity-30" />}
      </span>
    </th>
  );
}

function HeaderWithTip({ label, tooltip, className = "" }) {
  return (
    <th className={`px-3 py-2 text-xs font-medium text-muted-foreground uppercase ${className}`}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help underline decoration-dotted decoration-muted-foreground/40 underline-offset-2">{label}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs leading-relaxed">{tooltip}</TooltipContent>
      </Tooltip>
    </th>
  );
}

export default function InventoryMovement() {
  const queryClient = useQueryClient();
  // Deep-link support: ?tab=topMovers|deadStock|forecast lets Insights cards
  // (e.g. a dead-stock alert) open straight onto the relevant tab.
  const [tab, setTab] = useUrlTab("tab", Object.values(INVENTORY_MOVEMENT_TABS), INVENTORY_MOVEMENT_TABS.TOP_MOVERS);
  const [search, setSearch] = useState("");
  const [siteFilter, setSiteFilter] = useState("all");

  const now = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const defaultFrom = iso(new Date(now.getFullYear(), 0, 1));
  const defaultTo = iso(now);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [commodity, setCommodity] = useState("all");
  const [supplier, setSupplier] = useState("all");
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

  const suppliers = useQuery({
    queryKey: ["inv-movement-suppliers"],
    queryFn: () => apiFetch("/api/inventory-movement/suppliers"),
    staleTime: 300_000,
  });

  const topMovers = useQuery({
    queryKey: ["inv-movement-top", from, to, commodity, supplier, siteFilter],
    queryFn: () => {
      const params = new URLSearchParams({ from, to, limit: "200" });
      if (commodity !== "all") params.set("commodity", commodity);
      if (supplier !== "all") params.set("supplier", supplier);
      if (siteFilter !== "all") params.set("site_id", siteFilter);
      return apiFetch(`/api/inventory-movement/top-movers?${params}`);
    },
    enabled: tab === "topMovers",
    staleTime: 60_000,
  });

  const deadStock = useQuery({
    queryKey: ["inv-movement-dead", threshold, commodity, supplier, siteFilter],
    queryFn: () => {
      const params = new URLSearchParams({ threshold: String(threshold), limit: "500" });
      if (commodity !== "all") params.set("commodity", commodity);
      if (supplier !== "all") params.set("supplier", supplier);
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
  const [forecastMode, setForecastMode] = useState("forecast"); // "forecast" | "reorder"
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [detailItem, setDetailItem] = useState(null);

  // Admin gate for the forecast-settings button (the PUT is admin-only too).
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => apiFetch("/api/auth/me"),
    staleTime: 300_000,
  });
  const isAdmin = me.data?.role === "admin";
  const [abcFilter, setAbcFilter] = useState("all");

  const forecast = useQuery({
    queryKey: ["inv-movement-forecast", forecastSort, forecastDir, abcFilter, commodity, supplier],
    queryFn: () => {
      const params = new URLSearchParams({ sort: forecastSort, dir: forecastDir, limit: "300" });
      if (abcFilter !== "all") params.set("abc", abcFilter);
      if (commodity !== "all") params.set("commodity", commodity);
      if (supplier !== "all") params.set("supplier", supplier);
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
    // Movement history (stock card) is per-branch — site only for now.
    ...(!hubMode ? [{ id: "movementHistory", label: "Movement History", icon: ArrowUpDown }] : []),
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
      {/* Print-only header. Title + row count switch by active tab (including
          the item-trend detail view) so a print is correctly labelled and
          never headerless. The timestamp is computed once for the print. */}
      {(() => {
        const printedAt = new Date().toLocaleString("en-ZA");
        const commodityMeta = commodity !== "all" ? ` · Commodity: ${commodity}` : "";
        const headers = {
          forecast: {
            subtitle: "Demand Forecast",
            details: `Printed: ${printedAt} · ${forecastRows.length} items${abcFilter !== "all" ? ` · ABC: ${abcFilter}` : ""}`,
          },
          topMovers: {
            subtitle: "Top Movers",
            details: `Printed: ${printedAt} · ${sortedTopMovers.length} items · ${from} to ${to}${commodityMeta}`,
          },
          deadStock: {
            subtitle: "Dead Stock",
            details: `Printed: ${printedAt} · ${sortedDeadStock.length} items · no sales in ${threshold}+ days · Capital tied up: ${formatCurrency(totalDeadCapital)}${commodityMeta}`,
          },
          trend: {
            subtitle: selectedItem ? `Item Trend — ${selectedItem}` : "Item Trend",
            details: `Printed: ${printedAt} · ${from} to ${to}`,
          },
        };
        const h = headers[tab] || headers.topMovers;
        return <InvPrintHeader subtitle={h.subtitle} details={h.details} />;
      })()}
      {/* Header */}
      <div className="border-b border-border pb-5 mb-5 no-print">

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
              const tipMap = {
                topMovers: "Rank items by shipped qty over the selected date range. Sourced from OESHDT shipment history via the sales cache.",
                deadStock: "Show on-hand items with no sales activity within the cutoff window. Capital tied up = qty_on_hand × ICITEM.LAST_COST.",
                forecast: "Reorder-point and demand projections per item, computed from the rolling sales cache. Site-only — hubs receive precomputed rows.",
                movementHistory: "Per-item stock card: every movement (sales, receipts, credits, adjustments, write-offs) with a running balance that reconciles to current on-hand. Sourced from Sage I/C transaction history (ICHIST).",
              };
              return (
                <button
                  key={t.id}
                  onClick={() => { setTab(t.id); setSelectedItem(null); setSelectedSiteId(null); }}
                  title={tipMap[t.id]}
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
                title="Restrict the report to one site. 'All Sites' aggregates movement_sales_cache rows across every depot."
                className="h-8 rounded-full border border-border bg-card px-3 text-xs text-foreground cursor-help"
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
              title="Filter by ICITEM.COMMODIM classification (1=Sweets, 2=Cigarettes, 3=Tobacco, 4=Mixed)."
              className="h-8 rounded-full border border-border bg-card px-3 text-xs text-foreground cursor-help"
            >
              <option value="all">All</option>
              {(commodities.data?.commodities || []).map((c) => (
                <option key={c} value={c}>{COMMODITY_LABELS[c] || c}</option>
              ))}
            </select>
          </div>

          {/* Supplier — sourced from latest Sage PO receipt per item.
              Items never received via PO sync will not appear under any
              supplier (use the All option to see them). Hidden when there
              are no suppliers yet (e.g. before the first Stock Receipt sync). */}
          {(suppliers.data?.suppliers || []).length > 0 && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground">Supplier</label>
              <select
                value={supplier}
                onChange={(e) => setSupplier(e.target.value)}
                title="Filter by primary vendor — derived from the most recent stock_receipt PO per item. Items never received via PO sync are excluded from any specific supplier filter."
                className="h-8 rounded-full border border-border bg-card px-3 text-xs text-foreground min-w-[260px] cursor-help"
              >
                <option value="all">All</option>
                {(suppliers.data?.suppliers || []).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          )}

          {/* Search */}
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search item number or description…"
              title="Client-side filter on item number or description — applied after the Sage query, doesn't affect ranking."
              className="w-full h-8 pl-8 pr-3 rounded-full border border-border bg-card text-xs text-foreground placeholder:text-muted-foreground"
            />
          </div>

          {/* Sync button — site-mode only (hub pulls from sites via ETL) */}
          {!hubMode && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
                className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
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

          {/* Print — always visible top-level on Top Movers and Dead
              Stock so the operator can hit it regardless of data
              state. (Forecast has its own Print button down in the
              forecast toolbar next to Recompute / Settings.) */}
          {(tab === "topMovers" || tab === "deadStock") && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => window.print()}
                  className="no-print flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Printer className="h-3.5 w-3.5" />
                  Print
                </button>
              </TooltipTrigger>
              <TooltipContent>
                Print the {tab === "topMovers" ? "Top Movers" : "Dead Stock"} table as PDF
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
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-muted-foreground">No sales in the last</label>
            {THRESHOLD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setThreshold(opt.value)}
                title={`Show items with no shipments in the last ${opt.label}. Cutoff is calculated from today.`}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  threshold === opt.value
                    ? "border-red-500 bg-red-500/15 text-red-400"
                    : "border-border bg-card text-muted-foreground hover:text-foreground"
                }`}
              >
                {opt.label}
              </button>
            ))}
            {(() => {
              const isCustom = !THRESHOLD_OPTIONS.some(o => o.value === threshold);
              const cutoffISO = new Date(Date.now() - threshold * 86400000).toISOString().slice(0, 10);
              const todayISO = new Date().toISOString().slice(0, 10);
              return (
                <div className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${
                  isCustom
                    ? "border-red-500 bg-red-500/15 text-red-400"
                    : "border-border bg-card text-muted-foreground"
                }`}>
                  <span className="opacity-70">Since</span>
                  <input
                    type="date"
                    value={cutoffISO}
                    max={todayISO}
                    onChange={(e) => {
                      if (!e.target.value) return;
                      const days = Math.max(1, Math.round((Date.now() - new Date(e.target.value).getTime()) / 86400000));
                      setThreshold(days);
                    }}
                    className="bg-transparent border-none outline-none text-xs tabular-nums cursor-pointer [color-scheme:dark]"
                    aria-label="Cutoff date — items with no sales since this date"
                  />
                  {isCustom && <span className="opacity-60">({threshold}d)</span>}
                </div>
              );
            })()}
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
                    <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase cursor-help" title="Calendar month bucket (YYYY-MM)">Month</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase cursor-help" title="Total quantity shipped in the month (movement_sales_cache.qty_sold)">Qty Sold</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase cursor-help" title="Total revenue for the month in ZAR (movement_sales_cache.revenue)">Revenue</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase cursor-help" title="Number of distinct sales orders containing this item (movement_sales_cache.order_count)">Orders</th>
                    <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase cursor-help" title="Mean order size = Qty Sold ÷ Orders (rounded)">Avg Qty/Order</th>
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
                        {r.order_count > 0 ? Math.round(r.qty_sold / r.order_count) : "—"}
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
              <div className="print-table-wrap overflow-x-auto max-h-[calc(100vh-320px)] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-10 bg-card border-b border-border">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase w-8 cursor-help" title="Rank in the current sort order">#</th>
                      <SortHeader label="Item" field="item_number" current={sortField} dir={sortDir} onSort={handleSort} className="text-left" tooltip="Sage item number (ICITEM.ITEMNO). Click to sort." />
                      <SortHeader label="Description" field="item_description" current={sortField} dir={sortDir} onSort={handleSort} className="text-left" tooltip="Item description (ICITEM.DESC). Click to sort." />
                      {hubMode && siteFilter === "all" && <SortHeader label="Site" field="site_name" current={sortField} dir={sortDir} onSort={handleSort} className="text-left" tooltip="Owning depot for the row. Hub-only column when All Sites is selected." />}
                      <SortHeader label="Qty Sold" field="total_qty_sold" current={sortField} dir={sortDir} onSort={handleSort} className="text-right" tooltip="Sum of qty shipped in the selected window (movement_sales_cache.qty_sold)" />
                      <SortHeader label="Revenue" field="total_revenue" current={sortField} dir={sortDir} onSort={handleSort} className="text-right" tooltip="Sum of revenue in ZAR in the selected window (movement_sales_cache.revenue)" />
                      <SortHeader label="Orders" field="total_orders" current={sortField} dir={sortDir} onSort={handleSort} className="text-right" tooltip="Distinct order count across the window (movement_sales_cache.order_count)" />
                      <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase cursor-help" title="Mean order size = Qty Sold ÷ Orders (rounded)">Avg/Order</th>
                      <SortHeader label="On Hand" field="qty_on_hand" current={sortField} dir={sortDir} onSort={handleSort} className="text-right" tooltip="Current qty on hand from Sage inventoryrecord" />
                      <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase cursor-help" title="Date of the most recent OESHDT shipment for this item (movement_sales_cache.last_sale_date)">Last Sale</th>
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
                          {r.total_orders > 0 ? Math.round(r.total_qty_sold / r.total_orders) : "—"}
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
              <div className="print-table-wrap overflow-x-auto max-h-[calc(100vh-320px)] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-10 bg-card border-b border-border">
                    <tr>
                      <SortHeader label="Item" field="item_number" current={deadSortField} dir={deadSortDir} onSort={handleDeadSort} className="text-left" tooltip="Sage item number (ICITEM.ITEMNO). Click to sort." />
                      <SortHeader label="Description" field="item_description" current={deadSortField} dir={deadSortDir} onSort={handleDeadSort} className="text-left" tooltip="Item description (ICITEM.DESC). Click to sort." />
                      {hubMode && siteFilter === "all" && <SortHeader label="Site" field="site_name" current={deadSortField} dir={deadSortDir} onSort={handleDeadSort} className="text-left" tooltip="Owning depot for the row. Hub-only column when All Sites is selected." />}
                      <SortHeader label="On Hand" field="qty_on_hand" current={deadSortField} dir={deadSortDir} onSort={handleDeadSort} className="text-right" tooltip="Current qty on hand from Sage inventoryrecord — the money still sitting on shelves" />
                      <SortHeader label="Last Cost" field="last_cost" current={deadSortField} dir={deadSortDir} onSort={handleDeadSort} className="text-right" tooltip="Last cost in ZAR per unit (ICITEM.LAST_COST)" />
                      <SortHeader label="Capital Tied Up" field="capital_tied_up" current={deadSortField} dir={deadSortDir} onSort={handleDeadSort} className="text-right" tooltip="qty_on_hand × ICITEM.LAST_COST — value at cost of the unsold stock" />
                      <SortHeader label="Days Since Sale" field="days_since_sale" current={deadSortField} dir={deadSortDir} onSort={handleDeadSort} className="text-right" tooltip="Days between today and the most recent OESHDT shipment date. 999999 = never sold." />
                      <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase cursor-help" title="Date of the most recent shipment (movement_sales_cache.last_sale_date) — 'never' if absent">Last Sale</th>
                      <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground uppercase cursor-help" title="Bucketed age — green ≤30d, amber ≤90d, red >90d, 'Never sold' for no history">Age</th>
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
            {/* Forecast vs Reorder-plan view toggle */}
            <label className="text-xs text-muted-foreground">View</label>
            <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-0.5">
              {[
                { id: "forecast", label: "Forecast", title: "Per-item demand forecast, reorder points and days of stock" },
                { id: "reorder", label: "Reorder Plan", title: "Items at or below reorder point, grouped by supplier and ready to order" },
              ].map((m) => (
                <button
                  key={m.id}
                  onClick={() => setForecastMode(m.id)}
                  title={m.title}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    forecastMode === m.id ? "bg-amber-500/15 text-amber-400" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {forecastMode === "forecast" && (
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
            )}
            <button
              onClick={() => recomputeMutation.mutate()}
              disabled={recomputeMutation.isPending}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${recomputeMutation.isPending ? "animate-spin" : ""}`} />
              Recompute
            </button>
            {isAdmin && (
              <button
                onClick={() => setSettingsOpen(true)}
                title="Adjust forecast parameters — lead time, order cycle, service level and minimum order qty"
                className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <Settings className="h-3.5 w-3.5" />
                Settings
              </button>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Printer className="h-3.5 w-3.5" />
                  Print
                </button>
              </TooltipTrigger>
              <TooltipContent>Print forecast table as PDF</TooltipContent>
            </Tooltip>
          </div>

          {forecastMode === "reorder" && (
            <ReorderPlanView commodity={commodity} supplier={supplier} onRowClick={setDetailItem} />
          )}

          {forecastMode === "forecast" && forecast.isLoading && (
            <div className="flex items-center justify-center py-20 text-muted-foreground">
              <RefreshCw className="h-5 w-5 animate-spin mr-2" /> Loading forecast…
            </div>
          )}
          {forecastMode === "forecast" && !forecast.isLoading && forecast.isError && (
            <QueryError error={forecast.error} label="forecast" />
          )}
          {forecastMode === "forecast" && !forecast.isLoading && !forecast.isError && forecastRows.length === 0 && (
            <EmptyState
              icon={Package}
              title="No forecast data"
              message='Click "Recompute" after syncing sales data to generate the forecast.'
            />
          )}
          {forecastMode === "forecast" && forecastRows.length > 0 && (
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="text-xs text-muted-foreground px-3 py-2 border-b border-border">
                {forecastRows.length} items · sorted by {forecastSort.replace(/_/g, " ")} {forecastDir}
              </div>
              <div className="overflow-x-auto max-h-[calc(100vh-380px)] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-10 bg-card border-b border-border">
                    <tr>
                      <SortHeader label="Item" field="item_number" current={forecastSort} dir={forecastDir} onSort={handleForecastSort} className="text-left"
                        tooltip="Sage item number. Trimmed of trailing spaces to match the sales cache." />
                      <HeaderWithTip label="Description" className="text-left"
                        tooltip="Item description from Sage inventoryrecord (most recent variant per item)." />
                      <HeaderWithTip label="ABC" className="text-center"
                        tooltip="Pareto class by revenue over all months on file. A = items covering the top 80% of revenue, B = next 15%, C = remaining 5%. Used for prioritising stock attention." />
                      <HeaderWithTip label="On Hand" className="text-right"
                        tooltip="Current qty on hand from Sage inventoryrecord. Where an item has multiple location rows, the highest qty wins." />
                      <SortHeader label="Daily Demand" field="avg_daily_demand" current={forecastSort} dir={forecastDir} onSort={handleForecastSort} className="text-right"
                        tooltip="Historical reference: total qty ÷ (months × 30). Plain average across the whole window, not used to drive the order calc. Compare against Adj Demand/Mo to spot trend changes." />
                      <SortHeader label="Adj Demand/Mo" field="adjusted_demand" current={forecastSort} dir={forecastDir} onSort={handleForecastSort} className="text-right"
                        tooltip="What the model expects you to sell THIS month. = WMA3 × Seasonality. WMA3 is a weighted average of the last 3 complete months (weights 3-2-1, most recent first). The current partial month is excluded." />
                      <HeaderWithTip label="Season" className="text-right"
                        tooltip="Seasonality index for the current calendar month. = avg(qty for this month-of-year across history) ÷ avg(all months). 1.00 = no seasonal effect; >1 = busier than average; <1 = quieter. Defaults to 1.00 if there's less than 12 months of history. Clamped to [0.10, 5.00]." />
                      <SortHeader label="Reorder Pt" field="reorder_point" current={forecastSort} dir={forecastDir} onSort={handleForecastSort} className="text-right"
                        tooltip="When On Hand drops to this number, place an order today. = (daily demand × lead time days) + safety stock. Lead time and service level come from Forecast Settings." />
                      <SortHeader label="Days of Stock" field="days_of_stock" current={forecastSort} dir={forecastDir} onSort={handleForecastSort} className="text-right"
                        tooltip="Runway at the current sell rate. = On Hand ÷ daily demand. Colour coding: red <7d, amber <14d, yellow <30d, green ≥30d. Anything below your lead time is a stockout risk." />
                      <SortHeader label="Order Qty" field="suggested_order_qty" current={forecastSort} dir={forecastDir} onSort={handleForecastSort} className="text-right"
                        tooltip="Suggested order size to cover one order cycle plus variability. = (daily demand × order cycle days) + safety stock − On Hand. Bumped up to the per-item minimum order qty if set. Order cycle days comes from Forecast Settings." />
                      <th className="w-8 px-2 py-2" aria-hidden="true" />
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
                        <tr key={r.item_number} onClick={() => setDetailItem(r)} className={`cursor-pointer border-b border-border last:border-0 ${urgency === "critical" ? "bg-red-500/5" : urgency === "warning" ? "bg-amber-500/5" : "hover:bg-muted/20"}`}>
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
                            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold tabular-nums ${urgencyCls}`}>
                              {(urgency === "critical" || urgency === "warning") && <AlertTriangle className="h-3 w-3" aria-hidden="true" />}
                              {dos != null ? `${Math.round(dos)}d` : "—"}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-semibold">
                            {r.suggested_order_qty > 0 ? formatNum(r.suggested_order_qty) : "—"}
                          </td>
                          <td className="px-2 py-2 text-right">
                            <button
                              type="button"
                              aria-label={`View details for ${r.item_number}`}
                              title="View this item's sales trend and seasonality"
                              onClick={(e) => { e.stopPropagation(); setDetailItem(r); }}
                              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500"
                            >
                              <ChevronRight className="h-4 w-4" />
                            </button>
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

      {tab === "movementHistory" && !hubMode && <MovementHistoryView />}

      {detailItem && <ItemDetailModal item={detailItem} onClose={() => setDetailItem(null)} />}
      <ForecastSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => recomputeMutation.mutate()}
      />
    </div>
  );
}
