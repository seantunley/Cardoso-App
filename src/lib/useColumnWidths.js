// Reusable column-resize hook for HTML tables.
//
// Originally inline in src/components/reconciliation/InvoiceMatching.jsx
// (where it's been load-bearing for months). Lifted out so other tables
// — Operations → Job Runs, future Reports tables — can opt in without
// duplicating ~80 lines of resize/persist plumbing.
//
// Usage:
//   const containerRef = useRef(null);
//   const { widths, startResize, resetColumn } = useColumnWidths(
//     { name: 200, status: 120, error: 400 },
//     'cardoso.jobRuns.columnWidths.v1',
//     containerRef,
//   );
//
//   // Inside the table:
//   <colgroup>
//     {COLUMN_ORDER.map(id => <col key={id} style={{ width: `${widths[id]}px` }} />)}
//   </colgroup>
//
//   // On each <th>, attach a drag handle:
//   <th onMouseDown={startResize('name')} ...>
//
// The hook saves widths to localStorage on every change and restores them
// on mount. Bump the storageKey suffix (e.g. v1 → v2) to invalidate cached
// widths when the column SET changes (renaming a key alone is enough; keeping
// the same key with new defaults will preserve old saved values for users
// who have customised them).

import { useState, useRef, useEffect, useCallback } from 'react';

const MIN_COL = 40;

/** @typedef {Record<string, number>} ColumnWidths */
/** @typedef {(id: string) => (event: import("react").MouseEvent) => void} StartResize */
/** @typedef {{ widths: ColumnWidths, setWidths: import("react").Dispatch<import("react").SetStateAction<ColumnWidths>>, startResize: StartResize, resetColumn: (id: string) => void, resetAll: () => void }} UseColumnWidthsResult */

/**
 * @param {ColumnWidths} defaults
 * @param {string} storageKey
 * @param {import("react").RefObject<HTMLElement | null>} containerRef
 * @returns {UseColumnWidthsResult}
 */
export function useColumnWidths(defaults, storageKey, containerRef) {
  const [widths, setWidths] = useState(
    /** @returns {ColumnWidths} */
    () => {
      try {
        const saved = /** @type {Partial<ColumnWidths>} */ (JSON.parse(localStorage.getItem(storageKey) || '{}'));
        // Merge defaults under saved so a NEW column added in code shows up
        // with its default width even when the user has cached widths from
        // an older version of the table.
        return /** @type {ColumnWidths} */ ({ ...defaults, ...saved });
      } catch {
        return { ...defaults };
      }
    }
  );

  // useRef so resize handlers always read the current widths without
  // reattaching listeners every render.
  const widthsRef = useRef(widths);
  useEffect(() => {
    widthsRef.current = widths;
    try { localStorage.setItem(storageKey, JSON.stringify(widths)); } catch {}
  }, [widths, storageKey]);

  /** @type {StartResize} */
  const startResize = useCallback((id) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = widthsRef.current[id] ?? defaults[id] ?? 100;
    // Snapshot of every other column at drag start — fixed for the duration.
    const sumOthers = Object.entries(widthsRef.current)
      .filter(([k]) => k !== id)
      .reduce((s, [, v]) => s + v, 0);

    /** @param {MouseEvent} ev */
    const onMove = (ev) => {
      // Hard cap so the table never exceeds the container's inner width
      // (1px hairline reserved for the right border).
      const containerInner = containerRef?.current?.clientWidth ?? Infinity;
      const maxThisCol = Math.max(MIN_COL, (containerInner - 1) - sumOthers);
      const proposed = startWidth + (ev.clientX - startX);
      const next = Math.max(MIN_COL, Math.min(maxThisCol, proposed));
      setWidths((w) => ({ ...w, [id]: next }));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [containerRef, defaults]);

  /** @type {(id: string) => void} */
  const resetColumn = useCallback((id) => {
    setWidths((w) => ({ ...w, [id]: defaults[id] ?? 100 }));
  }, [defaults]);

  const resetAll = useCallback(() => {
    setWidths({ ...defaults });
  }, [defaults]);

  return { widths, setWidths, startResize, resetColumn, resetAll };
}
