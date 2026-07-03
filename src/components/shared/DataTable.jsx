// Shared data table — one implementation of the table plumbing every list page
// hand-rolls today: resizable columns persisted to localStorage, sticky header,
// sortable headers (keyboard-operable, not click-only), right-aligned numeric
// cells, and windowed rows via @tanstack/react-virtual so a 5,000-row vendor
// list scrolls smoothly (PERF-4's "unvirtualized vendor table").
//
// Column model matches the codebase's existing COLUMNS convention:
//   { key, label, align?: "left"|"right", format?: (value, row) => node,
//     mono?: boolean,
//     sortValue?: (row) => any,   // custom sort key (uncontrolled mode only)
//     csv?: (value, row) => any } // export value when format renders JSX
//
// Two usage modes:
//   CONTROLLED (original) — rows arrive already sorted/filtered; header
//     clicks call onSortChange; the page owns all data logic. Unchanged.
//   UNCONTROLLED — omit onSortChange and the table sorts internally
//     (numbers numerically, strings case-insensitively, null/undefined last),
//     seeded by defaultSortKey/defaultSortDir and persisted per storageKey.
//
// `toolbar` (opt-in) adds the operator chrome shared by list screens: a global
// text filter across visible columns, a column show/hide menu (persisted), CSV
// export of exactly the current view (filtered + sorted + visible columns),
// and a row count. Off by default so trivial embeds stay chrome-free.
//
// `virtualize={false}` renders all rows — for print flows and jsdom tests
// (jsdom has no layout, so the virtualizer would window everything to zero).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Columns3, Download, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuCheckboxItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

const MIN_COL = 60;

function useStoredColWidths(storageKey, defaults) {
  const [widths, setWidths] = useState(() => {
    try {
      const saved = storageKey ? JSON.parse(localStorage.getItem(storageKey) || "{}") : {};
      return { ...defaults, ...saved };
    } catch {
      return { ...defaults };
    }
  });
  const widthsRef = useRef(widths);
  const writeRef = useRef(null);
  useEffect(() => {
    widthsRef.current = widths;
    if (!storageKey) return undefined;
    if (writeRef.current) clearTimeout(writeRef.current);
    writeRef.current = setTimeout(() => {
      try { localStorage.setItem(storageKey, JSON.stringify(widths)); } catch {} // eslint-disable-line no-empty -- localStorage quota errors are non-fatal
    }, 200);
    return () => { if (writeRef.current) clearTimeout(writeRef.current); };
  }, [widths, storageKey]);

  const startResize = useCallback((id) => (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = widthsRef.current[id] ?? defaults[id] ?? 100;
    const onMove = (ev) => {
      const next = Math.max(MIN_COL, startW + (ev.clientX - startX));
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
  }, [defaults]);

  const resetCol = useCallback((id) => {
    setWidths((w) => ({ ...w, [id]: defaults[id] ?? 100 }));
  }, [defaults]);

  return { widths, startResize, resetCol };
}

// Tiny persisted-JSON state hook for the toolbar prefs (hidden columns,
// uncontrolled sort). Separate keys from the widths map so the existing
// flat widths format never needs migrating.
function usePersistedState(key, initial) {
  const [value, setValue] = useState(() => {
    if (!key) return initial;
    try {
      const raw = localStorage.getItem(key);
      return raw != null ? JSON.parse(raw) : initial;
    } catch { return initial; }
  });
  const set = useCallback((next) => {
    setValue((old) => {
      const v = typeof next === "function" ? next(old) : next;
      if (key) {
        try { localStorage.setItem(key, JSON.stringify(v)); } catch {} // eslint-disable-line no-empty -- quota errors are non-fatal
      }
      return v;
    });
  }, [key]);
  return [value, set];
}

// Natural comparator for uncontrolled sorting: numbers numerically, strings
// case-insensitively, null/undefined always last regardless of direction.
function compareValues(a, b) {
  const aNull = a == null || a === "";
  const bNull = b == null || b === "";
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

// CSV-escape one cell: quote when the value contains a delimiter/quote/newline.
function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function DataTable({
  columns,
  rows,
  rowKey,
  sortKey,
  sortDir,
  onSortChange,
  storageKey,
  defaultWidths = {},
  maxHeight = "70vh",
  estimateRowHeight = 33,
  virtualize = true,
  onRowClick,
  rowClassName,
  rowTitle,
  // Optional cursor-following hover card (same pattern as Customer Balances):
  // hoverCard(row) returns JSX (or null) shown in a prominent popup that
  // tracks the pointer, rendered via a portal so the table's scroll can't clip
  // it, click-through so it never blocks onRowClick. When omitted there's zero
  // overhead — no handlers, no portal.
  hoverCard,
  // Toolbar chrome (filter / columns / CSV / count) — opt-in.
  toolbar = false,
  filterPlaceholder = "Filter rows…",
  exportName,
  // Uncontrolled-sort seed, used only when onSortChange is not supplied.
  defaultSortKey = null,
  defaultSortDir = "desc",
  className = "",
}) {
  const { widths, startResize, resetCol } = useStoredColWidths(storageKey, defaultWidths);
  const scrollRef = useRef(null);

  // ── Toolbar + uncontrolled-sort state ─────────────────────────────────
  const [hiddenCols, setHiddenCols] = usePersistedState(
    storageKey ? `${storageKey}.hidden` : null, []);
  const [internalSort, setInternalSort] = usePersistedState(
    storageKey ? `${storageKey}.sort` : null,
    { key: defaultSortKey, dir: defaultSortDir });
  const [query, setQuery] = useState("");

  const controlled = typeof onSortChange === "function";
  const effectiveSortKey = controlled ? sortKey : internalSort.key;
  const effectiveSortDir = controlled ? sortDir : internalSort.dir;
  const handleSort = controlled
    ? onSortChange
    : (key) => setInternalSort((s) =>
        s.key === key
          ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
          : { key, dir: "desc" });

  const visibleColumns = useMemo(
    () => columns.filter((c) => !hiddenCols.includes(c.key)),
    [columns, hiddenCols]);

  // Filter (toolbar) then sort (uncontrolled only). Controlled callers keep
  // full ownership of order; the filter still applies to what they passed.
  const processedRows = useMemo(() => {
    let out = rows;
    if (toolbar && query.trim()) {
      const q = query.trim().toLowerCase();
      out = out.filter((row) =>
        visibleColumns.some((c) => String(row[c.key] ?? "").toLowerCase().includes(q)));
    }
    if (!controlled && effectiveSortKey) {
      const col = columns.find((c) => c.key === effectiveSortKey);
      const val = col?.sortValue ? col.sortValue : (row) => row[effectiveSortKey];
      const mul = effectiveSortDir === "asc" ? 1 : -1;
      out = [...out].sort((a, b) => mul * compareValues(val(a), val(b)));
    }
    return out;
  }, [rows, toolbar, query, visibleColumns, controlled, effectiveSortKey, effectiveSortDir, columns]);

  // Export exactly the operator's current view: filtered + sorted rows,
  // visible columns, display order. col.csv unwraps JSX-rendering columns.
  const exportCsv = () => {
    const header = visibleColumns.map((c) => csvCell(c.label)).join(",");
    const lines = processedRows.map((row) =>
      visibleColumns.map((c) => csvCell(c.csv ? c.csv(row[c.key], row) : row[c.key])).join(","));
    const blob = new Blob(["﻿" + [header, ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${exportName || storageKey || "export"}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Hover-card state: the row sets which card to show (one state change per row
  // entered, none per move); position is written straight to the node on
  // mousemove so the virtualised rows don't re-render as the pointer moves.
  const [hoverRow, setHoverRow] = useState(null);
  const tipRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const posRef = useRef({ x: 0, y: 0 });
  const positionTip = useCallback(() => {
    const el = tipRef.current;
    if (!el) return;
    const pad = 16;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = posRef.current.x + pad;
    let top = posRef.current.y + pad;
    if (left + w > window.innerWidth - 8) left = posRef.current.x - pad - w;
    if (left < 8) left = 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, posRef.current.y - pad - h);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, []);
  const onRowEnter = useCallback((row) => (e) => {
    posRef.current = { x: e.clientX, y: e.clientY };
    setHoverRow(row);
  }, []);
  const onRowMove = useCallback((e) => {
    posRef.current = { x: e.clientX, y: e.clientY };
    positionTip();
  }, [positionTip]);
  const hoverContent = hoverCard && hoverRow ? hoverCard(hoverRow) : null;

  const virtualizer = useVirtualizer({
    count: processedRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateRowHeight,
    overscan: 12,
    enabled: virtualize,
  });

  const virtualItems = virtualize ? virtualizer.getVirtualItems() : null;
  const paddingTop = virtualItems?.length ? virtualItems[0].start : 0;
  const paddingBottom = virtualItems?.length
    ? virtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end
    : 0;
  const visibleRows = virtualItems
    ? virtualItems.map((vi) => ({ row: processedRows[vi.index], index: vi.index, measureRef: virtualizer.measureElement, viIndex: vi.index }))
    : processedRows.map((row, index) => ({ row, index }));

  const headerKeyDown = (key) => (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSort?.(key); }
  };
  const rowKeyDown = (row) => (e) => {
    if (onRowClick && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onRowClick(row); }
  };

  return (
    <div className={`rounded-xl border border-border bg-card overflow-hidden ${className}`}>
      {toolbar && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-muted/20">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={filterPlaceholder}
              className="w-full h-8 pl-8 pr-7 bg-background border border-border text-sm text-foreground placeholder:text-muted-subtle focus:outline-none focus:border-accent"
              style={{ borderRadius: "6px" }}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground hover:text-foreground"
                aria-label="Clear filter"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-subtle pr-1 whitespace-nowrap">
              {processedRows.length}{query ? ` / ${rows.length}` : ""} rows
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 gap-1.5 border-border text-muted-foreground hover:text-foreground">
                  <Columns3 className="h-3.5 w-3.5" />
                  Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-[0.18em]">Show columns</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {columns.map((c) => (
                  <DropdownMenuCheckboxItem
                    key={c.key}
                    checked={!hiddenCols.includes(c.key)}
                    // Never allow hiding the last visible column — an all-hidden
                    // table has no affordance to get columns back.
                    disabled={!hiddenCols.includes(c.key) && visibleColumns.length === 1}
                    onCheckedChange={(v) => setHiddenCols((h) =>
                      v ? h.filter((k) => k !== c.key) : [...h, c.key])}
                  >
                    {c.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline" size="sm"
              onClick={exportCsv}
              disabled={processedRows.length === 0}
              className="h-8 gap-1.5 border-border text-muted-foreground hover:text-foreground"
              title="Export the current view (filtered, sorted, visible columns) as CSV"
            >
              <Download className="h-3.5 w-3.5" />
              CSV
            </Button>
          </div>
        </div>
      )}
      <div
        ref={scrollRef}
        className="overflow-auto"
        style={{ maxHeight }}
        onMouseLeave={hoverCard ? () => setHoverRow(null) : undefined}
      >
        <table className="text-sm" style={{ tableLayout: "fixed", width: "max-content", minWidth: "100%" }}>
          <colgroup>
            {visibleColumns.map((c) => (
              <col key={c.key} style={{ width: `${widths[c.key] ?? defaultWidths[c.key] ?? 120}px` }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 bg-card z-10">
            <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
              {visibleColumns.map((c) => (
                <th
                  key={c.key}
                  className={`px-3 py-2 select-none relative ${c.align === "right" ? "text-right" : "text-left"} ${handleSort ? "cursor-pointer hover:text-foreground" : ""}`}
                  onClick={handleSort ? () => handleSort(c.key) : undefined}
                  onKeyDown={handleSort ? headerKeyDown(c.key) : undefined}
                  tabIndex={handleSort ? 0 : undefined}
                  aria-sort={effectiveSortKey === c.key ? (effectiveSortDir === "asc" ? "ascending" : "descending") : undefined}
                  title={handleSort ? `Sort by ${c.label}` : undefined}
                >
                  <span className="truncate inline-block max-w-full align-middle">
                    {c.label}{effectiveSortKey === c.key ? (effectiveSortDir === "asc" ? " ↑" : " ↓") : ""}
                  </span>
                  <span
                    onMouseDown={startResize(c.key)}
                    onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); resetCol(c.key); }}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-accent/50 active:bg-accent z-20"
                    title="Drag to resize · double-click to reset"
                    style={{ touchAction: "none" }}
                    aria-hidden="true"
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paddingTop > 0 && (
              <tr aria-hidden="true"><td colSpan={visibleColumns.length} style={{ height: paddingTop, padding: 0, border: 0 }} /></tr>
            )}
            {visibleRows.map(({ row, index, measureRef, viIndex }) => (
              <tr
                key={rowKey ? rowKey(row) : index}
                ref={measureRef}
                data-index={viIndex}
                className={`border-b border-border last:border-0 hover:bg-muted/30 ${onRowClick ? "cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" : ""} ${rowClassName ? rowClassName(row) : ""}`}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? rowKeyDown(row) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                title={rowTitle ? rowTitle(row) : undefined}
                onMouseEnter={hoverCard ? onRowEnter(row) : undefined}
                onMouseMove={hoverCard ? onRowMove : undefined}
              >
                {visibleColumns.map((c) => (
                  <td
                    key={c.key}
                    className={`px-3 py-1.5 tabular-nums truncate ${c.align === "right" ? "text-right" : "text-left"} ${c.mono ? "font-mono text-xs" : ""}`}
                    title={hoverCard ? undefined : String(row[c.key] ?? "")}
                  >
                    {c.format ? c.format(row[c.key], row) : row[c.key]}
                  </td>
                ))}
              </tr>
            ))}
            {paddingBottom > 0 && (
              <tr aria-hidden="true"><td colSpan={visibleColumns.length} style={{ height: paddingBottom, padding: 0, border: 0 }} /></tr>
            )}
          </tbody>
        </table>
      </div>
      {hoverContent && createPortal(
        <div
          ref={(el) => { tipRef.current = el; if (el) positionTip(); }}
          style={{ position: "fixed", left: posRef.current.x + 16, top: posRef.current.y + 16, zIndex: 70, pointerEvents: "none" }}
        >
          {hoverContent}
        </div>,
        document.body,
      )}
    </div>
  );
}
