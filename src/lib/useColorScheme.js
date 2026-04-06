import { useState, useEffect } from 'react';

/**
 * Reactively returns 'dark' | 'light' based on the <html> class,
 * so native <select>/<option> dropdowns render correctly in both themes.
 * Usage: style={{ colorScheme }} on each <select>
 */
export function useColorScheme() {
  const [scheme, setScheme] = useState(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  );
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setScheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    });
    obs.observe(document.documentElement, { attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return scheme;
}
