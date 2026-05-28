import { useState, useMemo, useEffect, useRef } from "react";
import { useColorScheme } from "@/lib/useColorScheme";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Scale } from "lucide-react";
import SummaryTile from "@/components/shared/SummaryTile";
import CustomerBalancesFilters from "@/components/customer-balances/CustomerBalancesFilters";
import { analyseInvoiceCredit } from "@/lib/creditAnalysis";
import { DEFAULT_CREDIT_LOGIC_CONFIG } from "@/lib/creditLogic";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useColumnWidths } from "@/components/customer-balances/useColumnWidths";
import ResizeHandle from "@/components/customer-balances/ResizeHandle";
import CustomerBalancesRow from "@/components/customer-balances/CustomerBalancesRow";
import { AGE_BUCKETS } from "@/components/customer-balances/AgeBucketPill";
import PrintableTable from "@/components/customer-balances/PrintableTable";
import CustomerBalancesHeader from "@/components/customer-balances/CustomerBalancesHeader";
import { PRINT_STYLE } from "@/components/customer-balances/printStyle";
import { fetchTopBalances, fetchAllTopBalances } from "@/components/customer-balances/api";
import { parseAmount, formatAmount } from "@/components/customer-balances/utils";

// One-shot fetch — Customer Balances has at most a few thousand rows
// (one per customer with a balance), well within what an HTML table
// renders comfortably without virtualisation. The page scrolls inside
// the table container so the operator sees every customer in a single
// continuous list.
const PAGE_SIZE = 5000;

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
      <PrintableTable
        printTitle={printTitle}
        printDate={printDate}
        totalRecords={totalRecords}
        siteFilter={siteFilter}
        ageBucket={ageBucket}
        activeAgeBucketLabel={activeAgeBucketLabel}
        filteredGrandTotal={filteredGrandTotal}
        printRows={printRows}
        printData={printData}
        sites={sites}
      />

      {/* ── Screen UI ── */}
      <div className="min-h-screen bg-background text-foreground px-6 pt-4 pb-6">
        <div>
          {/* Header */}
          <CustomerBalancesHeader
            subtitleParts={subtitleParts}
            rowsEmpty={rows.length === 0}
            onPrint={() => window.print()}
            onRefresh={() => refetch()}
          />

          {/* Filters — collapsible. The <details> element gives us a
              native toggle with no extra state plumbing; the summary
              row keeps a quick "active filters" indicator visible even
              when the panel is closed. */}
          {!isLoading && !isError && (
            <CustomerBalancesFilters
              filtersOpen={filtersOpen}
              setFiltersOpen={setFiltersOpen}
              ageBucket={ageBucket}
              setAgeBucket={setAgeBucket}
              lastPurchaseDays={lastPurchaseDays}
              setLastPurchaseDays={setLastPurchaseDays}
              dormantOnly={dormantOnly}
              setDormantOnly={setDormantOnly}
              siteFilter={siteFilter}
              setSiteFilter={setSiteFilter}
              salesRepFilter={salesRepFilter}
              setSalesRepFilter={setSalesRepFilter}
              hideInvoiceMatchesBalance={hideInvoiceMatchesBalance}
              setHideInvoiceMatchesBalance={setHideInvoiceMatchesBalance}
              activeAgeBucketLabel={activeAgeBucketLabel}
              sites={sites}
              salesReps={salesReps}
              colorScheme={colorScheme}
              setPage={setPage}
            />
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
