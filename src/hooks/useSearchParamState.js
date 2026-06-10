import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

// useState-shaped filter state backed by the URL query string, so filtered
// views are shareable/bookmarkable deep links ("send me the over-21-days view
// for Welkom") and survive a refresh. Default values are REMOVED from the URL
// (clean links), and updates use replace so filter clicks don't pollute
// browser history.
//
// Composition gotcha this hook exists to solve: react-router's functional
// setSearchParams does NOT queue like React state — each call reads the
// CURRENT location, so two setters fired in one click handler (the codebase's
// `setAgeBucket(v); setPage(1)` pattern) would clobber each other, keeping
// only the last write. Setters therefore accumulate into a shared per-tick
// URLSearchParams and flush ONCE on a microtask.
let pendingParams = null;
let flushScheduled = false;

export function useSearchParamState(key, defaultValue = "") {
  const [searchParams, setSearchParams] = useSearchParams();
  const value = searchParams.has(key) ? searchParams.get(key) : defaultValue;

  const setValue = useCallback(
    (next) => {
      if (pendingParams === null) pendingParams = new URLSearchParams(searchParams);
      const current = pendingParams.has(key) ? pendingParams.get(key) : defaultValue;
      const resolved = typeof next === "function" ? next(current) : next;
      if (resolved == null || resolved === "" || String(resolved) === String(defaultValue)) {
        pendingParams.delete(key);
      } else {
        pendingParams.set(key, String(resolved));
      }
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(() => {
          const finalParams = pendingParams;
          pendingParams = null;
          flushScheduled = false;
          setSearchParams(finalParams, { replace: true });
        });
      }
    },
    [key, defaultValue, searchParams, setSearchParams],
  );

  return [value, setValue];
}
