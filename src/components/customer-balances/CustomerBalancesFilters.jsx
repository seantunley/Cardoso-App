import CollapsibleFilterBar from "@/components/shared/CollapsibleFilterBar";
import AgeBucketPill, { AGE_BUCKETS } from "./AgeBucketPill";
import FilterToggle from "./FilterToggle";

// All the filter UI (pills + selects + toggles) for CustomerBalances.
// Wraps CollapsibleFilterBar with the chip + onClearAll wiring so the
// page render stays focused on data flow.
export default function CustomerBalancesFilters({
  filtersOpen, setFiltersOpen,
  ageBucket, setAgeBucket,
  lastPurchaseDays, setLastPurchaseDays,
  dormantOnly, setDormantOnly,
  accountTypeFilter, setAccountTypeFilter,
  siteFilter, setSiteFilter,
  salesRepFilter, setSalesRepFilter,
  hideInvoiceMatchesBalance, setHideInvoiceMatchesBalance,
  minBalance, setMinBalance,
  activeAgeBucketLabel,
  sites, salesReps,
  colorScheme,
  setPage,
}) {
  // Minimum balance options. "0" = show every positive balance (floor off);
  // "3" is the long-standing default that used to be hard-coded server-side.
  const MIN_BALANCE_OPTIONS = [
    { value: "0", label: "Off" },
    { value: "3", label: "R3+" },
    { value: "10", label: "R10+" },
    { value: "100", label: "R100+" },
    { value: "1000", label: "R1 000+" },
  ];
  const minBalanceLabel = (MIN_BALANCE_OPTIONS.find((o) => o.value === String(minBalance))?.label)
    || `R${minBalance}+`;
  return (
    <CollapsibleFilterBar
      open={filtersOpen}
      onOpenChange={setFiltersOpen}
      className="mb-4 cb-no-print"
      chips={[
        ageBucket !== "all" && { key: "age",   label: activeAgeBucketLabel,                onClear: () => setAgeBucket("all") },
        lastPurchaseDays !== "all" && { key: "last", label: `Last purchase ${lastPurchaseDays}+ days`, onClear: () => setLastPurchaseDays("all") },
        dormantOnly && { key: "dormant", label: "Dormant only", onClear: () => setDormantOnly(false) },
        accountTypeFilter !== "all" && { key: "acct", label: accountTypeFilter === "national" ? "National accounts" : "Standard accounts", onClear: () => setAccountTypeFilter("all") },
        siteFilter !== "all" && { key: "site", label: siteFilter, onClear: () => setSiteFilter("all") },
        salesRepFilter !== "all" && { key: "rep",  label: `Rep ${salesRepFilter}`, onClear: () => setSalesRepFilter("all") },
        hideInvoiceMatchesBalance && { key: "hide", label: "Hide invoice = balance", onClear: () => setHideInvoiceMatchesBalance(false) },
        String(minBalance) !== "3" && { key: "min", label: `Min ${minBalanceLabel}`, onClear: () => { setMinBalance("3"); setPage(1); } },
      ].filter(Boolean)}
      onClearAll={() => {
        setAgeBucket("all");
        setLastPurchaseDays("all");
        setDormantOnly(false);
        setAccountTypeFilter("all");
        setSiteFilter("all");
        setSalesRepFilter("all");
        setHideInvoiceMatchesBalance(false);
        setMinBalance("3");
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

        <div className="space-y-1.5">
          <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Minimum balance</div>
          <div className="flex flex-wrap gap-2">
            {MIN_BALANCE_OPTIONS.map((opt) => (
              <AgeBucketPill
                key={opt.value}
                value={opt.value}
                active={String(minBalance) === opt.value}
                onClick={() => { setMinBalance(opt.value); setPage(1); }}
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
            <select
              value={accountTypeFilter}
              onChange={(e) => { setAccountTypeFilter(e.target.value); setPage(1); }}
              className="rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground"
              title="Filter by account type (national accounts vs standard customers)"
            >
              <option value="all">All accounts</option>
              <option value="national">National accounts</option>
              <option value="standard">Standard accounts</option>
            </select>
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
  );
}
