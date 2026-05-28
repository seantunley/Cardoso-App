import { useState, useMemo, useEffect, useRef, useCallback, memo } from "react";
import { useColorScheme } from "@/lib/useColorScheme";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Filter, Scale, X } from "lucide-react";
import SummaryTile from "@/components/shared/SummaryTile";
import CollapsibleFilterBar from "@/components/shared/CollapsibleFilterBar";
import { analyseInvoiceCredit, CREDIT_BADGE_META } from "@/lib/creditAnalysis";
import { DEFAULT_CREDIT_LOGIC_CONFIG } from "@/lib/creditLogic";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// ── Resizable columns ────────────────────────────────────────────────────
const CB_COLUMN_DEFAULTS = {
  idx: 40, name: 476, custId: 105, site: 54, rep: 83,
  lastInv: 107, lastRec: 104, outstanding: 132, credit: 90,
};
// v4: switched table from absolute-pixel widths + JS auto-fit to a CSS
// width:100% + percentage <col> layout. Existing v3 saves are scaled
// pixel values left over from the broken auto-fit and would render with
// the same off-balance proportions; bumping the key gives operators a
// clean default that fills the container.
const CB_COLUMN_WIDTHS_KEY = "customerBalances.columnWidths.v4";

function useColumnWidths(containerRef) {
  const [widths, setWidths] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(CB_COLUMN_WIDTHS_KEY) || "{}");
      return { ...CB_COLUMN_DEFAULTS, ...saved };
    } catch {
      return CB_COLUMN_DEFAULTS;
    }
  });
  const widthsRef = useRef(widths);
  // Debounce-flushed localStorage write — see comment in
  // src/lib/useColumnWidths.js. Avoids JSON.stringify + sync
  // localStorage.setItem at 60Hz during a column drag.
  const writeTimerRef = useRef(null);
  useEffect(() => {
    widthsRef.current = widths;
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(() => {
      try { localStorage.setItem(CB_COLUMN_WIDTHS_KEY, JSON.stringify(widths)); } catch {}
      writeTimerRef.current = null;
    }, 200);
    return () => {
      if (writeTimerRef.current) {
        clearTimeout(writeTimerRef.current);
        writeTimerRef.current = null;
        try { localStorage.setItem(CB_COLUMN_WIDTHS_KEY, JSON.stringify(widths)); } catch {}
      }
    };
  }, [widths]);

  const MIN_COL = 40;

  const startResize = useCallback((id) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = widthsRef.current[id] ?? CB_COLUMN_DEFAULTS[id] ?? 100;

    // Sum of every other column at drag start — fixed for the duration.
    const sumOthers = Object.entries(widthsRef.current)
      .filter(([k]) => k !== id)
      .reduce((s, [, v]) => s + v, 0);

    const onMove = (ev) => {
      // Clamp `next` so the *table* never exceeds the container's inner width
      // (subtract a 1px hairline so the rightmost border stays visible). This
      // is what stops a runaway drag from pushing the table out of its frame.
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
    setWidths((w) => ({ ...w, [id]: CB_COLUMN_DEFAULTS[id] ?? 100 }));
  }, []);

  return { widths, setWidths, startResize, resetColumn };
}

function ResizeHandle({ id, startResize, resetColumn }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          onMouseDown={startResize(id)}
          onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); resetColumn(id); }}
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-accent/50 active:bg-accent z-30"
          style={{ touchAction: "none" }}
        />
      </TooltipTrigger>
      <TooltipContent side="right">Drag to resize · double-click to reset</TooltipContent>
    </Tooltip>
  );
}

// ── Credit analysis (shared with CustomerLookup) ─────────────────────────
function CreditBadge({ row, creditLogicConfig }) {
  // Prefer the server-computed verdict on row.credit_verdict (added by the
  // /api/top-balances route) — saves running analyseInvoiceCredit per row
  // on every parent re-render. Falls back to local compute for rows that
  // pre-date the server addition (e.g. hub-mode, older caches).
  const result = useMemo(() => {
    if (row?.credit_verdict) return { verdict: row.credit_verdict, score: row.credit_score };
    return analyseInvoiceCredit([row], [], creditLogicConfig || DEFAULT_CREDIT_LOGIC_CONFIG);
  }, [row, creditLogicConfig]);
  const meta = CREDIT_BADGE_META[result.verdict] || CREDIT_BADGE_META.caution;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold cursor-default ${meta.className}`}>
          {meta.label}
        </span>
      </TooltipTrigger>
      <TooltipContent>Score: {result.score ?? "—"}/100 — {meta.label}</TooltipContent>
    </Tooltip>
  );
}

// React.memo'd row — virtualisation already trims DOM count, but each
// visible row was still re-rendering on every parent state change
// (filters, sort, hover). With stable props from React Query, memo
// skips the row body's reconciliation when only unrelated state moves.
//
// Rows have variable height (invoice/receipt cells render 1-3 lines), so
// we accept a measureRef from the virtualizer for accurate spacer math.
const CustomerBalancesRow = memo(function CustomerBalancesRow({
  row, idx, globalIdx, isTop, creditLogicConfig, assignment, measureRef,
}) {
  const amount = parseAmount(row.outstanding_balance);
  return (
    <tr
      ref={measureRef}
      data-index={idx}
      className={`border-b border-border last:border-0 transition-colors hover:bg-muted/30 ${isTop ? "bg-amber-500/5" : ""}`}
    >
      <td className="px-2 py-1 text-xs text-muted-foreground">{globalIdx + 1}</td>
      <td className="px-2 py-1 pr-3">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 w-[88px] shrink-0">
            <FlagDot color={row.flag_color} reason={row.flag_reason} />
            {getVisibleAccountType(row.account_type) && (
              <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium ${getAccountTypePillClasses(row.account_type)}`}>
                {getVisibleAccountType(row.account_type)}
              </span>
            )}
          </div>
          <span className={`font-medium truncate ${isTop ? "text-amber-400" : "text-foreground"}`}>
            {row.customer_name || "—"}
          </span>
          {assignment && (
            <span
              className="ml-auto shrink-0 inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/15 text-amber-300 px-1.5 py-0.5 text-[10px] font-medium"
              title={`On "${assignment.worklist_name}" — assigned to ${assignment.owner_name || "unassigned"}`}
            >
              Assigned: {assignment.owner_name || "—"}
            </span>
          )}
        </div>
      </td>
      <td className="px-2 py-1 text-xs text-muted-foreground font-mono">{row.customer_number || "—"}</td>
      <td className="px-2 py-1 text-xs text-muted-foreground">{row.site_name || "—"}</td>
      <td className="px-2 py-1 text-xs text-muted-foreground">{row.sales_rep || "—"}</td>
      <td className="px-2 py-1 text-xs">
        <div className="font-mono text-foreground leading-tight">{row.last_unpaid_invoice_1 || "—"}</div>
        {row.last_unpaid_invoice_1_amount && <div className="tabular-nums text-amber-400 leading-tight">R {formatAmount(row.last_unpaid_invoice_1_amount)}</div>}
        {row.last_unpaid_invoice_1_date && <div className="text-muted-foreground/60 leading-tight">{row.last_unpaid_invoice_1_date}</div>}
      </td>
      <td className="px-2 py-1 text-xs">
        <div className="font-mono text-foreground leading-tight">{row.last_receipt_1 || "—"}</div>
        {row.last_receipt_1_amount && <div className="tabular-nums text-amber-400 leading-tight">R {formatAmount(row.last_receipt_1_amount)}</div>}
        {row.last_receipt_1_date && <div className="text-muted-foreground/60 leading-tight">{row.last_receipt_1_date}</div>}
      </td>
      <td className="px-2 py-1 text-right">
        <span className={`font-semibold tabular-nums ${amount > 10000 ? "text-red-400" : amount > 0 ? "text-orange-400" : "text-muted-foreground"}`}>
          R {formatAmount(amount)}
        </span>
      </td>
      <td className="px-2 py-1 text-center">
        <CreditBadge row={row} creditLogicConfig={creditLogicConfig} />
      </td>
    </tr>
  );
});

// One-shot fetch — Customer Balances has at most a few thousand rows
// (one per customer with a balance), well within what an HTML table
// renders comfortably without virtualisation. The page scrolls inside
// the table container so the operator sees every customer in a single
// continuous list.
const PAGE_SIZE = 5000;

function getVisibleAccountType(accountType) {
  const value = String(accountType || "").trim().toUpperCase();
  if (!value || value === "SUB_ACCOUNT") return null;
  return value;
}

function getAccountTypePillClasses(accountType) {
  const value = getVisibleAccountType(accountType);
  if (!value) return "";
  if (value.includes("STANDARD")) {
    return "border-emerald-500/40 bg-emerald-500/12 text-emerald-700 dark:border-emerald-500/50 dark:bg-emerald-500/15 dark:text-emerald-300";
  }
  if (value.includes("NATIONAL")) {
    return "border-sky-500/40 bg-sky-500/12 text-sky-700 dark:border-sky-500/50 dark:bg-sky-500/15 dark:text-sky-300";
  }
  return "border-slate-400 bg-slate-500/10 text-slate-700 dark:border-slate-500 dark:bg-slate-500/10 dark:text-slate-300";
}

const AGE_BUCKETS = [
  { value: "all",   label: "All" },
  { value: "7-13",  label: "7–13 days" },
  { value: "14-20", label: "14–20 days" },
  { value: "21+",   label: "21+ days" },
];

/* ── print styles (injected once) ── */
const PRINT_STYLE = `
@page {
  size: auto;
  margin: 8mm;
}

@media print {
  html, body {
    margin: 0 !important;
    padding: 0 !important;
    background: #fff !important;
  }

  body { visibility: hidden; background: #fff; }
  #customer-balances-printable {
    visibility: visible;
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    margin: 0;
    padding: 0;
    box-sizing: border-box;
    background: #fff;
    color: #000;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 11px;
  }
  #customer-balances-printable * { visibility: visible; }

  .cb-print-header { margin-bottom: 5mm; border-bottom: 2px solid #000; padding-bottom: 3mm; }
  .cb-print-header h1 { font-size: 16px; font-weight: 700; margin: 0 0 2px 0; }
  .cb-print-header p  { font-size: 11px; color: #555; margin: 0; }

  .cb-print-summary {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 4mm;
    font-size: 12px;
  }
  .cb-print-summary strong { font-size: 14px; }

  table { width: 100%; border-collapse: collapse; font-size: 10px; page-break-inside: auto; }
  thead tr { background: #f0f0f0; }
  th { text-align: left; padding: 3px 5px; border-bottom: 1.5px solid #888; font-weight: 600; font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; }
  td { padding: 2px 5px; border-bottom: 1px solid #ddd; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .td-right { text-align: right; }
  .td-mono  { font-family: 'Courier New', monospace; }
  .td-muted { color: #666; }
  .td-top   { background: #fffbeb; }
  .td-amount-high { color: #c00; font-weight: 700; }
  .td-amount-mid  { color: #b45309; font-weight: 600; }
  .flag-dot {
    display: inline-block;
    width: 7px; height: 7px;
    border-radius: 50%;
    margin-right: 4px;
    vertical-align: middle;
  }
  .flag-red    { background: #ef4444; }
  .flag-orange { background: #f97316; }
  .flag-yellow { background: #eab308; }
  .flag-green  { background: #22c55e; }
  .flag-blue   { background: #3b82f6; }
  .flag-purple { background: #a855f7; }
  .flag-pink   { background: #ec4899; }
  .flag-gray   { background: #9ca3af; }
  tr { page-break-inside: avoid; }
  .cb-no-print { display: none !important; }
}
`;

function parseAmount(val) {
  if (val === null || val === undefined || val === "") return 0;
  const cleaned = String(val).replace(/,/g, "").replace(/\s/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function formatAmount(val) {
  const num = parseAmount(val);
  return num.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const FLAG_DOT = {
  red: "bg-red-500", orange: "bg-orange-400", yellow: "bg-yellow-400",
  green: "bg-green-500", blue: "bg-blue-500", purple: "bg-purple-500",
  pink: "bg-pink-400", gray: "bg-gray-400",
};

function FlagDot({ color, reason }) {
  // Reserve the dot's slot even when there's no flag, so every row in
  // the table has the STANDARD/NATIONAL/etc. pill starting at the same
  // x-position. Without this placeholder the flex container collapses
  // and the pill shifts left into the dot's would-be slot, breaking
  // alignment across the column. (Operator-reported: badges visually
  // jumped between rows depending on whether the row had a flag.)
  if (!color || color === "none") {
    return <span className="inline-block h-2.5 w-2.5 flex-shrink-0" aria-hidden="true" />;
  }
  const cls = FLAG_DOT[color] || "bg-gray-400";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`inline-block h-2.5 w-2.5 rounded-full flex-shrink-0 cursor-default ${cls}`} />
      </TooltipTrigger>
      <TooltipContent>{reason ? `${color} flag: ${reason}` : `${color} flag`}</TooltipContent>
    </Tooltip>
  );
}

function FilterToggle({ active, onClick, children, tooltip }) {
  const btn = (
    <button
      onClick={onClick}
      className={`min-h-[42px] rounded-xl border px-3 py-2 text-xs font-medium transition-colors ${
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

const AGE_BUCKET_TOOLTIPS = {
  all:     "Show all customers with outstanding balances",
  "7-13":  "Customer has at least one unpaid invoice that's 7–13 days old",
  "14-20": "Customer has at least one unpaid invoice that's 14–20 days old",
  "21+":   "Customer has at least one unpaid invoice that's 21 or more days old",
};

function AgeBucketPill({ active, onClick, children, value }) {
  const btn = (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-[40px] rounded-full border px-3.5 py-2 text-xs font-semibold transition-all ${
        active
          ? "border-amber-500 bg-amber-500 text-black shadow-[0_0_0_1px_rgba(245,158,11,0.2)]"
          : "border-border bg-background text-muted-foreground hover:border-amber-500/40 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
  const tip = AGE_BUCKET_TOOLTIPS[value];
  if (!tip) return btn;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

async function fetchTopBalances({ page, limit, siteFilter, ageBucket, salesRepFilter, hideInvoiceMatchesBalance, lastPurchaseDays, dormantOnly }) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });
  if (siteFilter && siteFilter !== "all") params.set("site", siteFilter);
  if (ageBucket && ageBucket !== "all") params.set("ageBucket", ageBucket);
  if (salesRepFilter && salesRepFilter !== "all") params.set("salesRep", salesRepFilter);
  if (hideInvoiceMatchesBalance) params.set("hideInvoiceMatchesBalance", "1");
  if (lastPurchaseDays && lastPurchaseDays !== "all") params.set("lastPurchaseDays", String(lastPurchaseDays));
  if (dormantOnly) params.set("dormantOnly", "1");

  const res = await fetch(`/api/top-balances?${params.toString()}`, { credentials: "include" });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || "Failed to load balances");
  }
  const data = await res.json();
  // Handle both old servers (array) and new servers (paginated object)
  if (Array.isArray(data)) {
    const pageTotalOutstanding = data.reduce((sum, row) => sum + parseAmount(row.outstanding_balance), 0);
    return {
      records: data,
      total: data.length,
      page,
      totalPages: 1,
      filteredTotalOutstanding: pageTotalOutstanding,
      pageTotalOutstanding,
      sites: [...new Set(data.map((row) => row.site_name).filter(Boolean))].sort(),
      minBalanceThreshold: 0,
    };
  }
  return data;
}

async function fetchAllTopBalances({ siteFilter, ageBucket, salesRepFilter, hideInvoiceMatchesBalance, lastPurchaseDays, dormantOnly }) {
  const firstPage = await fetchTopBalances({
    page: 1,
    limit: 200,
    siteFilter,
    ageBucket,
    salesRepFilter,
    hideInvoiceMatchesBalance,
    lastPurchaseDays,
    dormantOnly,
  });

  if ((firstPage?.totalPages ?? 1) <= 1) return firstPage;

  const allRecords = [...(firstPage.records ?? [])];
  for (let nextPage = 2; nextPage <= firstPage.totalPages; nextPage += 1) {
    const pageData = await fetchTopBalances({
      page: nextPage,
      limit: 200,
      siteFilter,
      ageBucket,
      salesRepFilter,
      hideInvoiceMatchesBalance,
      lastPurchaseDays,
      dormantOnly,
    });
    allRecords.push(...(pageData.records ?? []));
  }

  return {
    ...firstPage,
    records: allRecords,
    page: 1,
    pageTotalOutstanding:
      firstPage.filteredTotalOutstanding ??
      allRecords.reduce((sum, row) => sum + parseAmount(row.outstanding_balance), 0),
  };
}

export default function CustomerBalances() {
  const colorScheme = useColorScheme();
  const { data: creditLogicState } = useQuery({
    queryKey: ["creditLogicCurrent"],
    queryFn: async () => {
      const response = await fetch("/api/credit-logic/current", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load credit logic");
      return response.json();
    },
    staleTime: 60_000,
    retry: false,
  });
  const creditLogicConfig = creditLogicState?.analysis?.config || DEFAULT_CREDIT_LOGIC_CONFIG;
  const [page, setPage] = useState(1);
  const [siteFilter, setSiteFilter] = useState("all");
  const [ageBucket, setAgeBucket] = useState("all");
  const [salesRepFilter, setSalesRepFilter] = useState("all");
  // Client-side page filters (applied to the current page only — server
  // pagination / totals remain authoritative). lastPurchaseDays: "all"
  // or a string number of days ("30", "60", "90", "180", "365").
  const [lastPurchaseDays, setLastPurchaseDays] = useState("all");
  const [dormantOnly, setDormantOnly] = useState(false);
  // Controlled <details> open state so the filter panel stays put
  // across React re-renders (refetches, sort clicks, etc.) — without
  // this, native <details> gets unmounted by conditional rendering and
  // snaps back to closed every time the data changes.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [hideInvoiceMatchesBalance, setHideInvoiceMatchesBalance] = useState(false);
  const tableContainerRef = useRef(null);
  const { widths: colWidths, setWidths: setColWidths, startResize, resetColumn } = useColumnWidths(tableContainerRef);

  // Container fill is now handled by CSS (table width: 100% + percentage
  // <col> widths below) instead of a JS auto-fit loop. The previous
  // ResizeObserver-based scaler captured colWidths in a closure with an
  // empty deps array, so setColWidths(scaled) wrote stale values back —
  // and the Math.max(40, ...) floor introduced drift on every save to
  // localStorage, eventually leaving an empty band to the right of the
  // table that operators couldn't recover from without clearing storage.
  const [sortField, setSortField] = useState("outstanding_balance");
  const [sortDir, setSortDir] = useState("desc");

  function handleSort(field) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "outstanding_balance" ? "desc" : "asc");
    }
  }

  useEffect(() => {
    const id = "cb-print-style";
    if (!document.getElementById(id)) {
      const el = document.createElement("style");
      el.id = id;
      el.textContent = PRINT_STYLE;
      document.head.appendChild(el);
    }
  }, []);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["top-balances", page, PAGE_SIZE, siteFilter, ageBucket, salesRepFilter, hideInvoiceMatchesBalance, lastPurchaseDays, dormantOnly],
    queryFn: () => fetchTopBalances({ page, limit: PAGE_SIZE, siteFilter, ageBucket, salesRepFilter, hideInvoiceMatchesBalance, lastPurchaseDays, dormantOnly }),
    staleTime: 60_000,
    keepPreviousData: true,
  });

  // Live map of customer_id → { worklist_name, owner_name } so rows
  // can show an "Assigned to X" chip when the customer is on someone's
  // Collections worklist. Cheap query (one small map), polled every
  // minute so chips update if Collections changes.
  const { data: collectionAssignments } = useQuery({
    queryKey: ["customer-assignments-map"],
    queryFn: async () => {
      const r = await fetch("/api/collections/customer-assignments", { credentials: "include" });
      if (!r.ok) return {};
      const d = await r.json().catch(() => ({}));
      return d.assignments || {};
    },
    staleTime: 60_000,
  });

  const totalRecords = data?.total ?? 0;

  const { data: printData } = useQuery({
    queryKey: ["top-balances-print", siteFilter, ageBucket, salesRepFilter, hideInvoiceMatchesBalance, lastPurchaseDays, dormantOnly],
    queryFn: () => fetchAllTopBalances({ siteFilter, ageBucket, salesRepFilter, hideInvoiceMatchesBalance, lastPurchaseDays, dormantOnly }),
    staleTime: 60_000,
    keepPreviousData: true,
    enabled: totalRecords > PAGE_SIZE,
  });

  function parseDDMMYYYY(str) {
    if (!str || str.length < 8) return 0;
    const clean = str.replace(/[^0-9]/g, '');
    if (clean.length !== 8) return 0;
    return parseInt(`${clean.slice(4, 8)}${clean.slice(2, 4)}${clean.slice(0, 2)}`, 10);
  }

  const VERDICT_ORDER = { approve: 4, caution: 3, dormant: 2, hold: 1 };

  // Cache credit scores so sorting doesn't re-run analyseInvoiceCredit per comparison
  const creditScores = useMemo(() => {
    const raw = data?.records ?? [];
    if (sortField !== "credit") return null;
    const map = new Map();
    for (const row of raw) {
      try { map.set(row, analyseInvoiceCredit([row], [], creditLogicConfig).score ?? 0); }
      catch { map.set(row, 0); }
    }
    return map;
  }, [data?.records, sortField, creditLogicConfig]);

  const sortRows = (raw) => {
    return [...raw].sort((a, b) => {
      let va, vb;
      if (sortField === "outstanding_balance") {
        va = parseAmount(a.outstanding_balance);
        vb = parseAmount(b.outstanding_balance);
      } else if (sortField === "customer_name") {
        va = (a.customer_name || "").toLowerCase();
        vb = (b.customer_name || "").toLowerCase();
        return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      } else if (sortField === "customer_number") {
        va = String(a.customer_number || "");
        vb = String(b.customer_number || "");
        return sortDir === "asc"
          ? va.localeCompare(vb, undefined, { numeric: true, sensitivity: "base" })
          : vb.localeCompare(va, undefined, { numeric: true, sensitivity: "base" });
      } else if (sortField === "last_invoice_date") {
        va = parseDDMMYYYY(a.last_unpaid_invoice_1_date);
        vb = parseDDMMYYYY(b.last_unpaid_invoice_1_date);
      } else if (sortField === "last_receipt_date") {
        va = parseDDMMYYYY(a.last_receipt_1_date);
        vb = parseDDMMYYYY(b.last_receipt_1_date);
      } else if (sortField === "credit") {
        va = creditScores?.get(a) ?? 0;
        vb = creditScores?.get(b) ?? 0;
      } else {
        return 0;
      }
      return sortDir === "asc" ? va - vb : vb - va;
    });
  };

  const rows = useMemo(() => {
    const raw = data?.records ?? [];
    return sortRows(raw);
  }, [data?.records, sortField, sortDir, creditScores]);

  // Row virtualization — rendering 5,000 <tr>s at once paints slow and
  // makes scroll janky. The virtualizer keeps only ~30 visible rows in the
  // DOM and uses two spacer <tr>s to preserve scroll height + sort stability.
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => 44,
    overscan: 10,
  });

  const printRows = useMemo(() => {
    const raw = printData?.records ?? data?.records ?? [];
    return sortRows(raw);
  }, [printData?.records, data?.records, sortField, sortDir, creditScores]);

  const totalPages = data?.totalPages ?? 1;
  const currentPage = data?.page ?? page;

  function SortArrow({ field }) {
    if (sortField !== field) return <span className="ml-0.5 opacity-30">⇅</span>;
    return <span className="ml-0.5 opacity-80">{sortDir === "asc" ? "↑" : "↓"}</span>;
  }
  const filteredGrandTotal = data?.filteredTotalOutstanding ?? 0;
  const currentPageTotal = data?.pageTotalOutstanding ?? 0;
  const minBalanceThreshold = data?.minBalanceThreshold ?? 0;

  const sites = useMemo(() => {
    return data?.sites ?? [];
  }, [data?.sites]);
  const salesReps = useMemo(() => {
    return data?.salesReps ?? [];
  }, [data?.salesReps]);

  useEffect(() => {
    if (data?.page && data.page !== page) setPage(data.page);
  }, [data?.page, page]);

  const printTitle = siteFilter !== "all" ? `Customer Balances — ${siteFilter}` : "Customer Balances — All Sites";
  const printDate  = new Date().toLocaleString("en-ZA", {
    year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const activeAgeBucketLabel = AGE_BUCKETS.find((bucket) => bucket.value === ageBucket)?.label || "All";

  /* ── filter subtitle ── */
  const subtitleParts = [];
  subtitleParts.push(`${totalRecords} customer${totalRecords !== 1 ? "s" : ""}`);
  if (siteFilter && siteFilter !== "all") subtitleParts.push(siteFilter);
  if (ageBucket !== "all") subtitleParts.push(activeAgeBucketLabel);
  if (hideInvoiceMatchesBalance) subtitleParts.push("Invoice ≠ Balance");
  if (minBalanceThreshold > 0) subtitleParts.push(`>${formatAmount(minBalanceThreshold)}`);

  return (
    <>
      {/* ── Print-only block (hidden on screen) ── */}
      <div id="customer-balances-printable" style={{ visibility: "hidden", position: "absolute" }}>
        <div className="cb-print-header">
          <h1>{printTitle}</h1>
          <p>Printed: {printDate} · {totalRecords} customer{totalRecords !== 1 ? "s" : ""}</p>
        </div>
        <div className="cb-print-summary">
          <div>
            <div>
              Total outstanding ({totalRecords} customers{siteFilter !== "all" ? ` · ${siteFilter}` : ""}
              {ageBucket !== "all" ? ` · ${activeAgeBucketLabel}` : ""})
            </div>
            <strong>R {formatAmount(filteredGrandTotal)}</strong>
          </div>
          <div className="td-right">
              <div>Printed rows ({printRows.length} customers)</div>
              <strong>R {formatAmount(printData?.filteredTotalOutstanding ?? filteredGrandTotal)}</strong>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Customer Name</th>
              <th>Customer ID</th>
              {sites.length > 1 && <th>Site</th>}
              <th>Last Invoice</th>
              <th>Last Receipt</th>
              <th className="td-right">Outstanding Balance</th>
            </tr>
          </thead>
          <tbody>
            {printRows.map((row, idx) => {
              const amount = parseAmount(row.outstanding_balance);
              const fc = row.flag_color && row.flag_color !== "none" ? row.flag_color : null;
              return (
                <tr key={`print-${idx}`} className={idx === 0 ? "td-top" : ""}>
                  <td className="td-muted">{idx + 1}</td>
                  <td>
                    {fc && <span className={`flag-dot flag-${fc}`} title={row.flag_reason || fc} />}
                    {getVisibleAccountType(row.account_type) && (
                      <span className={`mr-2 inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium ${getAccountTypePillClasses(row.account_type)}`}>
                        {getVisibleAccountType(row.account_type)}
                      </span>
                    )}
                    <strong>{row.customer_name || "—"}</strong>
                  </td>
                  <td className="td-mono td-muted">{row.customer_number || "—"}</td>
                  {sites.length > 1 && <td className="td-muted">{row.site_name || "—"}</td>}
                  <td>
                    <div className="td-mono">{row.last_unpaid_invoice_1 || "—"}</div>
                    {row.last_unpaid_invoice_1_amount && <div>R {formatAmount(row.last_unpaid_invoice_1_amount)}</div>}
                    {row.last_unpaid_invoice_1_date && <div className="td-muted">{row.last_unpaid_invoice_1_date}</div>}
                  </td>
                  <td>
                    <div className="td-mono">{row.last_receipt_1 || "—"}</div>
                    {row.last_receipt_1_amount && <div>R {formatAmount(row.last_receipt_1_amount)}</div>}
                    {row.last_receipt_1_date && <div className="td-muted">{row.last_receipt_1_date}</div>}
                  </td>
                  <td className={`td-right ${amount > 10000 ? "td-amount-high" : amount > 0 ? "td-amount-mid" : "td-muted"}`}>
                    R {formatAmount(amount)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Screen UI ── */}
      <div className="min-h-screen bg-background text-foreground px-6 pt-4 pb-6">
        <div>
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8 pb-5 border-b border-border">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">
                § Financial
              </div>
              <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
                Customer <em className="text-phosphor">balances</em>.
              </h1>
              <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground mt-3">{subtitleParts.join(" · ")}</p>
            </div>
            <div className="flex items-center gap-2 cb-no-print">
              <button
                onClick={() => window.print()}
                disabled={rows.length === 0}
                className="flex items-center gap-2 border px-4 py-2 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-h-[40px]"
                style={{
                  borderRadius: "12px",
                  borderColor: 'var(--phosphor)',
                  color: 'var(--phosphor)',
                  background: 'hsla(33, 95%, 55%, 0.08)',
                }}
                onMouseEnter={(e) => {
                  if (e.currentTarget.disabled) return;
                  e.currentTarget.style.background = 'hsla(33, 95%, 55%, 0.18)';
                  e.currentTarget.style.boxShadow = '0 0 12px hsla(33,95%,55%,0.35)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'hsla(33, 95%, 55%, 0.08)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
                title="Print or save as PDF"
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 6 2 18 2 18 9"/>
                  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
                  <rect x="6" y="14" width="12" height="8"/>
                </svg>
                Print / PDF
              </button>
              <button
                onClick={() => refetch()}
                className="flex items-center gap-2 border border-border bg-card px-4 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground transition-colors min-h-[40px]"
                style={{ borderRadius: "12px" }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--phosphor)';
                  e.currentTarget.style.color = 'var(--phosphor)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'hsl(var(--border))';
                  e.currentTarget.style.color = 'hsl(var(--muted-foreground))';
                }}
              >
                <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M23 4v6h-6M1 20v-6h6"/>
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
                </svg>
                Refresh
              </button>
            </div>
          </div>

          {/* Filters — collapsible. The <details> element gives us a
              native toggle with no extra state plumbing; the summary
              row keeps a quick "active filters" indicator visible even
              when the panel is closed. */}
          {!isLoading && !isError && (
            <CollapsibleFilterBar
              open={filtersOpen}
              onOpenChange={setFiltersOpen}
              className="mb-4 cb-no-print"
              chips={[
                ageBucket !== "all" && { key: "age",   label: activeAgeBucketLabel,                onClear: () => setAgeBucket("all") },
                lastPurchaseDays !== "all" && { key: "last", label: `Last purchase ${lastPurchaseDays}+ days`, onClear: () => setLastPurchaseDays("all") },
                dormantOnly && { key: "dormant", label: "Dormant only", onClear: () => setDormantOnly(false) },
                siteFilter !== "all" && { key: "site", label: siteFilter, onClear: () => setSiteFilter("all") },
                salesRepFilter !== "all" && { key: "rep",  label: `Rep ${salesRepFilter}`, onClear: () => setSalesRepFilter("all") },
                hideInvoiceMatchesBalance && { key: "hide", label: "Hide invoice = balance", onClear: () => setHideInvoiceMatchesBalance(false) },
              ].filter(Boolean)}
              onClearAll={() => {
                setAgeBucket("all");
                setLastPurchaseDays("all");
                setDormantOnly(false);
                setSiteFilter("all");
                setSalesRepFilter("all");
                setHideInvoiceMatchesBalance(false);
              }}
            >
              {/* All pill-style filters stack as labelled rows so the
                  layout reads top-to-bottom and nothing sits stranded
                  on the right edge. Dropdowns + toggles share a row at
                  the bottom. */}
                <div className="space-y-1.5">
                  <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Age buckets</div>
                  <div className="flex flex-wrap gap-2">
                    {AGE_BUCKETS.map((bucket) => (
                      <AgeBucketPill
                        key={bucket.value}
                        value={bucket.value}
                        active={ageBucket === bucket.value}
                        onClick={() => { setAgeBucket(bucket.value); setPage(1); }}
                      >
                        {bucket.label}
                      </AgeBucketPill>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Last purchase</div>
                  <div className="flex flex-wrap gap-2">
                    {[
                      { value: "all",  label: "All" },
                      { value: "30",   label: "30+ days" },
                      { value: "60",   label: "60+ days" },
                      { value: "90",   label: "90+ days" },
                      { value: "180",  label: "180+ days" },
                      { value: "365",  label: "1+ year" },
                    ].map((opt) => (
                      <AgeBucketPill
                        key={opt.value}
                        value={opt.value}
                        active={lastPurchaseDays === opt.value}
                        onClick={() => { setLastPurchaseDays(opt.value); setPage(1); }}
                      >
                        {opt.label}
                      </AgeBucketPill>
                    ))}
                  </div>
                </div>

                {/* Dropdowns + toggles share the last row. Wraps cleanly
                    on narrow screens. */}
                <div className="flex flex-wrap items-end gap-3 pt-1">
                  {sites.length > 1 && (
                    <div className="flex flex-col gap-1.5 min-w-[180px]">
                      <label className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Site</label>
                      <select
                        value={siteFilter}
                        onChange={(e) => { setSiteFilter(e.target.value); setPage(1); }}
                        style={{ colorScheme }}
                        className="h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      >
                        <option value="all">All sites</option>
                        {sites.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                  )}

                  {salesReps.length > 0 && (
                    <div className="flex flex-col gap-1.5 min-w-[180px]">
                      <label className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Sales rep</label>
                      <select
                        value={salesRepFilter}
                        onChange={(e) => { setSalesRepFilter(e.target.value); setPage(1); }}
                        style={{ colorScheme }}
                        className="h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      >
                        <option value="all">All reps</option>
                        {salesReps.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>
                  )}

                  <div className="flex items-center gap-2 ml-auto flex-wrap">
                    <FilterToggle
                      active={dormantOnly}
                      onClick={() => { setDormantOnly((v) => !v); setPage(1); }}
                      tooltip="Show only customers whose credit verdict is 'dormant' (no recent activity)"
                    >
                      {dormantOnly ? "⊘ " : ""}Dormant only
                    </FilterToggle>
                    <FilterToggle
                      active={hideInvoiceMatchesBalance}
                      onClick={() => { setHideInvoiceMatchesBalance((v) => !v); setPage(1); }}
                      tooltip="Hide customers where the latest invoice amount equals their outstanding balance"
                    >
                      {hideInvoiceMatchesBalance ? "⊘ " : ""}Hide invoice = balance
                    </FilterToggle>
                  </div>
                </div>
            </CollapsibleFilterBar>
          )}

          {/* Summary tile — uses shared SummaryTile so layout matches
              Inventory and Collections. Half-width grid for visual
              consistency across the inventory modules and customer pages. */}
          {rows.length > 0 && (
            <div className="mb-4 grid gap-4 md:grid-cols-2">
              <SummaryTile
                label={`Total outstanding (${totalRecords} customer${totalRecords !== 1 ? "s" : ""}${siteFilter !== "all" ? ` · ${siteFilter}` : ""}${ageBucket !== "all" ? ` · ${activeAgeBucketLabel}` : ""})`}
                value={`R ${formatAmount(filteredGrandTotal)}`}
              />
            </div>
          )}

          {isLoading && (
            <div className="flex items-center justify-center py-20">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-border border-t-foreground" />
            </div>
          )}
          {isError && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-center text-sm text-red-400">
              {error?.message || "Failed to load data"}
            </div>
          )}
          {!isLoading && !isError && rows.length === 0 && totalRecords === 0 && (
            <div className="flex flex-col items-center justify-center py-20 rounded-xl border border-border bg-card">
              <Scale className="w-12 h-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium text-foreground">No balance data yet</h3>
              <p className="text-sm text-muted-foreground mt-1">
                {siteFilter !== "all"
                  ? `No outstanding balances over R ${formatAmount(minBalanceThreshold)} for "${siteFilter}"${ageBucket !== "all" ? ` in ${activeAgeBucketLabel.toLowerCase()}` : ""}.`
                  : `No outstanding balances over R ${formatAmount(minBalanceThreshold)}${ageBucket !== "all" ? ` in ${activeAgeBucketLabel.toLowerCase()}` : ""} found.`}
              </p>
            </div>
          )}

          {/* Table */}
          {false && (
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
              <span>⚠️</span>
              <span>Showing top {PAGE_SIZE} customers only. There may be more records not shown.</span>
            </div>
          )}
          {!isLoading && !isError && rows.length > 0 && (
            <div
              ref={tableContainerRef}
              className="rounded-xl border border-border bg-card overflow-hidden"
              style={{ height: "min(900px, calc(100vh - 180px))", overflowY: "auto", overflowX: "hidden" }}
            >
              {(() => {
                const totalWidth = Object.values(colWidths).reduce((s, v) => s + v, 0) || 1;
                const pct = (id) => `${((colWidths[id] || 100) / totalWidth) * 100}%`;
                return (
              <table className="text-sm w-full" style={{ tableLayout: "fixed" }}>
                <colgroup>
                  <col style={{ width: pct("idx") }} />
                  <col style={{ width: pct("name") }} />
                  <col style={{ width: pct("custId") }} />
                  <col style={{ width: pct("site") }} />
                  <col style={{ width: pct("rep") }} />
                  <col style={{ width: pct("lastInv") }} />
                  <col style={{ width: pct("lastRec") }} />
                  <col style={{ width: pct("outstanding") }} />
                  <col style={{ width: pct("credit") }} />
                </colgroup>
                <thead className="sticky top-0 z-20">
                  <tr className="border-b border-border bg-card">
                    <th className="relative px-2 py-1.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">#<ResizeHandle id="idx" startResize={startResize} resetColumn={resetColumn} /></th>
                    <Tooltip><TooltipTrigger asChild><th onClick={() => handleSort("customer_name")} className="relative py-1.5 pr-3 pl-[98px] text-left text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none hover:text-foreground transition-colors"><span className="block truncate">Customer Name<SortArrow field="customer_name" /></span><ResizeHandle id="name" startResize={startResize} resetColumn={resetColumn} /></th></TooltipTrigger><TooltipContent>Customer trading name — click to sort</TooltipContent></Tooltip>
                    <Tooltip><TooltipTrigger asChild><th onClick={() => handleSort("customer_number")} className="relative px-2 py-1.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none hover:text-foreground transition-colors"><span className="block truncate">Customer ID<SortArrow field="customer_number" /></span><ResizeHandle id="custId" startResize={startResize} resetColumn={resetColumn} /></th></TooltipTrigger><TooltipContent>Customer account number — click to sort (numeric-aware)</TooltipContent></Tooltip>
                    <th className="relative px-2 py-1.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide"><span className="block truncate">Site</span><ResizeHandle id="site" startResize={startResize} resetColumn={resetColumn} /></th>
                    <th className="relative px-2 py-1.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide"><span className="block truncate">Sales Rep</span><ResizeHandle id="rep" startResize={startResize} resetColumn={resetColumn} /></th>
                    <Tooltip><TooltipTrigger asChild><th onClick={() => handleSort("last_invoice_date")} className="relative px-2 py-1.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none hover:text-foreground transition-colors"><span className="block truncate">Last Invoice<SortArrow field="last_invoice_date" /></span><ResizeHandle id="lastInv" startResize={startResize} resetColumn={resetColumn} /></th></TooltipTrigger><TooltipContent>Date of the most recent unpaid invoice — click to sort</TooltipContent></Tooltip>
                    <Tooltip><TooltipTrigger asChild><th onClick={() => handleSort("last_receipt_date")} className="relative px-2 py-1.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none hover:text-foreground transition-colors"><span className="block truncate">Last Receipt<SortArrow field="last_receipt_date" /></span><ResizeHandle id="lastRec" startResize={startResize} resetColumn={resetColumn} /></th></TooltipTrigger><TooltipContent>Date of the most recent payment received — click to sort</TooltipContent></Tooltip>
                    <Tooltip><TooltipTrigger asChild><th onClick={() => handleSort("outstanding_balance")} className="relative px-2 py-1.5 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none hover:text-foreground transition-colors"><span className="block truncate">Outstanding Balance<SortArrow field="outstanding_balance" /></span><ResizeHandle id="outstanding" startResize={startResize} resetColumn={resetColumn} /></th></TooltipTrigger><TooltipContent>Total amount currently owed — click to sort</TooltipContent></Tooltip>
                    <Tooltip><TooltipTrigger asChild><th onClick={() => handleSort("credit")} className="relative px-2 py-1.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-pointer select-none hover:text-foreground transition-colors"><span className="block truncate">Credit<SortArrow field="credit" /></span><ResizeHandle id="credit" startResize={startResize} resetColumn={resetColumn} /></th></TooltipTrigger><TooltipContent>Credit verdict based on payment history and outstanding balance — click to sort</TooltipContent></Tooltip>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const virtualItems = rowVirtualizer.getVirtualItems();
                    const totalHeight = rowVirtualizer.getTotalSize();
                    const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
                    const paddingBottom = virtualItems.length > 0
                      ? totalHeight - virtualItems[virtualItems.length - 1].end
                      : 0;
                    return (
                      <>
                        {paddingTop > 0 && <tr aria-hidden="true"><td colSpan={9} style={{ height: paddingTop, padding: 0, border: 0 }} /></tr>}
                        {virtualItems.map((v) => {
                          const idx = v.index;
                          const row = rows[idx];
                          if (!row) return null;
                          const globalIdx = (currentPage - 1) * PAGE_SIZE + idx;
                          const isTop  = globalIdx === 0;
                          const assignment = collectionAssignments?.[String(row.id ?? row.customer_id)];
                          return (
                            <CustomerBalancesRow
                              key={`${row.customer_number}-${row.site_name}-${idx}`}
                              row={row}
                              idx={idx}
                              globalIdx={globalIdx}
                              isTop={isTop}
                              creditLogicConfig={creditLogicConfig}
                              assignment={assignment}
                              measureRef={rowVirtualizer.measureElement}
                            />
                          );
                        })}
                        {paddingBottom > 0 && <tr aria-hidden="true"><td colSpan={9} style={{ height: paddingBottom, padding: 0, border: 0 }} /></tr>}
                      </>
                    );
                  })()}
                </tbody>
              </table>
                );
              })()}
            </div>
          )}

          {/* Pagination removed — the table now scrolls in place and
              renders the full result set (capped at PAGE_SIZE=5000). */}
        </div>
      </div>
    </>
  );
}
