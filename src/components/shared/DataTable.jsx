// Shared data table — one implementation of the table plumbing every list page
// hand-rolls today: resizable columns persisted to localStorage, sticky header,
// sortable headers (keyboard-operable, not click-only), right-aligned numeric
// cells, and windowed rows via @tanstack/react-virtual so a 5,000-row vendor
// list scrolls smoothly (PERF-4's "unvirtualized vendor table").
//
// Deliberately presentational: rows arrive ALREADY sorted/filtered (pages own
// their data logic); header clicks just call onSortChange. Column model matches
// the codebase's existing COLUMNS convention:
//   { key, label, align?: "left"|"right", format?: (value, row) => node, mono?: boolean }
//
// `virtualize={false}` renders all rows — for print flows and jsdom tests
// (jsdom has no layout, so the virtualizer would window everything to zero).
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";

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
  className = "",
}) {
  const { widths, startResize, resetCol } = useStoredColWidths(storageKey, defaultWidths);
  const scrollRef = useRef(null);

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
    count: rows.length,
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
    ? virtualItems.map((vi) => ({ row: rows[vi.index], index: vi.index, measureRef: virtualizer.measureElement, viIndex: vi.index }))
    : rows.map((row, index) => ({ row, index }));

  const headerKeyDown = (key) => (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSortChange?.(key); }
  };
  const rowKeyDown = (row) => (e) => {
    if (onRowClick && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onRowClick(row); }
  };

  return (
    <div className={`rounded-xl border border-border bg-card overflow-hidden ${className}`}>
      <div
        ref={scrollRef}
        className="overflow-auto"
        style={{ maxHeight }}
        onMouseLeave={hoverCard ? () => setHoverRow(null) : undefined}
      >
        <table className="text-sm" style={{ tableLayout: "fixed", width: "max-content", minWidth: "100%" }}>
          <colgroup>
            {columns.map((c) => (
              <col key={c.key} style={{ width: `${widths[c.key] ?? defaultWidths[c.key] ?? 120}px` }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 bg-card z-10">
            <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={`px-3 py-2 select-none relative ${c.align === "right" ? "text-right" : "text-left"} ${onSortChange ? "cursor-pointer hover:text-foreground" : ""}`}
                  onClick={onSortChange ? () => onSortChange(c.key) : undefined}
                  onKeyDown={onSortChange ? headerKeyDown(c.key) : undefined}
                  tabIndex={onSortChange ? 0 : undefined}
                  aria-sort={sortKey === c.key ? (sortDir === "asc" ? "ascending" : "descending") : undefined}
                  title={onSortChange ? `Sort by ${c.label}` : undefined}
                >
                  <span className="truncate inline-block max-w-full align-middle">
                    {c.label}{sortKey === c.key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
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
              <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: paddingTop, padding: 0, border: 0 }} /></tr>
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
                {columns.map((c) => (
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
              <tr aria-hidden="true"><td colSpan={columns.length} style={{ height: paddingBottom, padding: 0, border: 0 }} /></tr>
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
