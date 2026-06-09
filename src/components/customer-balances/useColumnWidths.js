import { useState, useEffect, useRef, useCallback } from "react";

// ── Resizable columns ────────────────────────────────────────────────────
export const CB_COLUMN_DEFAULTS = {
  idx: 40, name: 412, custId: 105, site: 54, rep: 83, location: 74, terms: 74,
  lastInv: 107, lastRec: 104, outstanding: 132, credit: 90,
};
// v4: switched table from absolute-pixel widths + JS auto-fit to a CSS
// width:100% + percentage <col> layout. Existing v3 saves are scaled
// pixel values left over from the broken auto-fit and would render with
// the same off-balance proportions; bumping the key gives operators a
// clean default that fills the container.
export const CB_COLUMN_WIDTHS_KEY = "customerBalances.columnWidths.v4";

export function useColumnWidths(containerRef) {
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
  const writeTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  useEffect(() => {
    widthsRef.current = widths;
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(() => {
      try { localStorage.setItem(CB_COLUMN_WIDTHS_KEY, JSON.stringify(widths)); } catch {} // eslint-disable-line no-empty -- hot path on every column drag; localStorage quota errors are non-fatal
      writeTimerRef.current = null;
    }, 200);
    return () => {
      if (writeTimerRef.current) {
        clearTimeout(writeTimerRef.current);
        writeTimerRef.current = null;
        try { localStorage.setItem(CB_COLUMN_WIDTHS_KEY, JSON.stringify(widths)); } catch {} // eslint-disable-line no-empty -- hot path teardown; localStorage quota errors are non-fatal
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
