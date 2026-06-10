import { useEffect, useState } from 'react';

// Returns `value` delayed by `delay` ms — it only updates once the input has
// stopped changing for that long. Used to drive search queries off a debounced
// value so a fast typist fires one request per pause instead of one per
// keystroke (the input itself stays bound to the immediate state for snappiness).
export function useDebouncedValue(value, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
