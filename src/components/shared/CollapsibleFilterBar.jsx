// Reusable collapsible filter bar used on Customer Balances, Inventory,
// and (after the next pass) Stock Receipt Expiry / Price List.
//
// API shape on purpose: the consumer owns its filter state and the
// active-chip definitions; this component only handles:
//   - the wrapper border, padding, and collapse animation
//   - the summary row that lists active filters as removable chips
//   - the prominent "Clear all filters" button (count + click)
//   - the chevron and React-controlled open/closed state
//
// Filter content (pill rows, dropdowns, toggles) goes into `children`
// so it renders inside the disclosed body unchanged.
//
// Usage:
//   <CollapsibleFilterBar
//     open={filtersOpen}
//     onOpenChange={setFiltersOpen}
//     chips={[
//       commodity !== "all" && { key: "c", label: "Sweets", onClear: () => setCommodity("all") },
//       hideZeroQty && { key: "z", label: "Hide zero qty", onClear: () => setHideZeroQty(false) },
//     ].filter(Boolean)}
//     onClearAll={clearAll}
//   >
//     <FilterRow label="Commodity">...pills...</FilterRow>
//     <FilterRow label="Price list">...pills...</FilterRow>
//   </CollapsibleFilterBar>

import { Filter, X } from "lucide-react";

export default function CollapsibleFilterBar({
  open,
  onOpenChange,
  chips = [],
  onClearAll,
  className = "",
  children,
}) {
  const activeCount = chips.length;
  return (
    <details
      open={open}
      onToggle={(e) => onOpenChange?.(e.currentTarget.open)}
      className={`rounded-2xl border border-border bg-card/80 group ${className}`}
    >
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 list-none [&::-webkit-details-marker]:hidden">
        <div className="flex items-center gap-2 flex-wrap text-sm font-medium text-foreground">
          <Filter className="h-4 w-4 text-amber-400 shrink-0" />
          <span>Filters</span>
          {activeCount === 0 && (
            <span className="text-xs font-normal text-muted-foreground">none active</span>
          )}
          {chips.map((chip) => (
            <span
              key={chip.key}
              role="button"
              title="Remove this filter"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                chip.onClear?.();
              }}
              className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 text-amber-400 text-[11px] font-medium px-2 py-0.5 hover:bg-amber-500/25 cursor-pointer"
            >
              {chip.label}
              <span aria-hidden="true" className="opacity-60">×</span>
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {activeCount > 0 && onClearAll && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onClearAll();
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-500/20 hover:text-red-300 transition-colors"
            >
              <X className="h-3.5 w-3.5" />
              Clear all filters
              <span className="rounded-full bg-red-500/25 px-1.5 py-0.5 text-[10px] font-bold text-red-100">
                {activeCount}
              </span>
            </button>
          )}
          <svg
            className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </div>
      </summary>
      <div className="border-t border-border px-3 py-3 space-y-3">{children}</div>
    </details>
  );
}
