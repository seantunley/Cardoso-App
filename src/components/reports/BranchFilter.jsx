import { useSearchParams } from 'react-router-dom';

// Hub-only branch (site) selector, shared across the hub reports. Reads/writes
// the `site` URL param (so the view is shareable + reload-safe) and renders
// nothing in site mode. Options come from the report's data.filters.sites; the
// default "All branches" leaves the report consolidated across every branch.
export default function BranchFilter({ hubMode, sites }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const site = searchParams.get('site') || 'all';
  const setSite = (v) =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (!v || v === 'all') next.delete('site');
      else next.set('site', v);
      return next;
    }, { replace: true });

  if (!hubMode) return null;

  return (
    <div title="Show all branches consolidated, or narrow this report to a single branch. Hub mode only.">
      <label className="block font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-1" style={{ cursor: 'help' }}>Branch</label>
      <select
        value={site}
        onChange={(e) => setSite(e.target.value)}
        className="w-full bg-background border border-border text-foreground px-2 py-1.5 text-xs outline-none focus:border-accent"
        style={{ borderRadius: '12px' }}
      >
        <option value="all">All branches</option>
        {(sites || []).map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    </div>
  );
}
