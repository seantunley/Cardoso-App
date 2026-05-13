// HubJti — hub-mode dashboard for received JTI archives.
// Lists hub_jti_archive rows across all sites, with per-site filter,
// download, and source/received-via badges. Mirrors the per-site
// archive panel on the site-mode JTI page (src/pages/Jti.jsx).

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Loader2, Download, Archive, AlertTriangle, Server, Cloud,
} from "lucide-react";

export default function HubJti() {
  const [archives, setArchives] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloadingId, setDownloadingId] = useState(null);
  const [siteFilter, setSiteFilter] = useState('');
  // Master site list — derived ONCE from the unfiltered fetch and
  // kept stable across filter changes. Without this, selecting a
  // site would shrink the response to 1 site_id, the chips would
  // hide, and there would be no in-page way back to "All sites".
  // Filter chips render from this; the table renders from `archives`.
  //
  // Stored as { id, label } pairs so the chips and table cells can
  // show the human-readable site name (joined from hub_sites on the
  // server) while the filter still keys off the canonical site_id.
  // Falls back to the site_id when the row's hub_sites name is
  // missing (orphan archive whose registry entry was removed).
  const [allSites, setAllSites] = useState([]);
  const siteLabel = (id) => allSites.find(s => s.id === id)?.label || id;

  useEffect(() => {
    let cancelled = false;
    refresh({ cancelledRef: () => cancelled });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteFilter]);

  async function refresh({ cancelledRef = () => false } = {}) {
    setLoading(true);
    try {
      const url = siteFilter
        ? `/api/hub/jti/archives?site_id=${encodeURIComponent(siteFilter)}`
        : `/api/hub/jti/archives`;
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (cancelledRef()) return;
      const fetched = Array.isArray(data.archives) ? data.archives : [];
      setArchives(fetched);
      // Only refresh the master site list when we're fetching the
      // UNFILTERED set — a filtered fetch would shrink it to one
      // site_id and dead-end the UI. Union with the prior list (so a
      // new site appearing in a later unfiltered fetch is captured)
      // and only replace, never narrow.
      if (!siteFilter) {
        // First-seen-wins for the label (site_name), so an orphan
        // archive without a join match doesn't overwrite a real
        // name we already learned for the same id.
        const labelById = new Map();
        for (const a of fetched) {
          const label = (a.site_name || '').trim() || a.site_id;
          if (!labelById.has(a.site_id)) labelById.set(a.site_id, label);
        }
        setAllSites(prev => {
          const merged = new Map(prev.map(s => [s.id, s.label]));
          for (const [id, label] of labelById) {
            if (!merged.has(id) || merged.get(id) === id) merged.set(id, label);
          }
          return Array.from(merged, ([id, label]) => ({ id, label }))
            .sort((a, b) => a.label.localeCompare(b.label));
        });
      }
      setError('');
    } catch (err) {
      if (!cancelledRef()) {
        setError(`Couldn't load archives: ${err.message}`);
        toast.error(`Couldn't load JTI archives: ${err.message}`);
      }
    } finally {
      if (!cancelledRef()) setLoading(false);
    }
  }

  const handleDownload = async (id, filename) => {
    setDownloadingId(id);
    try {
      const r = await fetch(`/api/hub/jti/archives/${id}/download`, { credentials: 'include' });
      if (!r.ok) {
        let message = `HTTP ${r.status}`;
        try { message = (await r.json()).error || message; } catch {}
        throw new Error(message);
      }
      const blob = await r.blob();
      triggerDownload(blob, filename || `JTI_hub_archive_${id}.xlsx`);
      toast.success(`Downloaded ${filename}`);
    } catch (err) {
      toast.error(`Archive download failed: ${err.message}`);
    } finally {
      setDownloadingId(null);
    }
  };

  // Filter chips use the stable master list (allSites), NOT the
  // currently-filtered archives — otherwise selecting a single site
  // would shrink the chip list to just that site and leave no way
  // back to "All sites" without a page reload.
  const sites = allSites;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1200px] mx-auto px-8 py-10 space-y-8">
        <div className="border-b border-border pb-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">
            § JTI · Hub archives
          </div>
          <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
            JTI Sales <em className="text-phosphor not-italic">archives</em>.
          </h1>
          <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground mt-3">
            Pushed by sites · pulled nightly as fallback · dedup by sha256
          </p>
        </div>

        {error && (
          <div
            className="relative overflow-hidden border border-border bg-card px-4 py-2.5"
            style={{ borderRadius: '12px' }}
          >
            <div
              className="absolute left-0 top-0 bottom-0 w-[2px]"
              style={{ background: 'hsl(var(--destructive))', boxShadow: '0 0 10px hsla(0,72%,50%,0.3)' }}
            />
            <p className="font-mono text-xs text-destructive pl-2 flex items-start gap-2">
              <AlertTriangle className="h-3.5 w-3.5 mt-px flex-shrink-0" strokeWidth={1.75} />
              {error}
            </p>
          </div>
        )}

        <section className="bg-card border border-border p-6" style={{ borderRadius: '12px' }}>
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-1">
                All sites · all months
              </div>
              <h2 className="font-display text-xl text-foreground mb-1 flex items-center gap-2">
                <Archive className="h-5 w-5 text-muted-foreground" strokeWidth={1.75} />
                Received archives
              </h2>
              <p className="text-sm text-muted-foreground">
                Each row is one archive on hub disk. Push = site sent it; Pull = hub fetched it overnight.
              </p>
            </div>
          </div>

          {/* Site filter chips */}
          {sites.length > 1 && (
            <div className="flex flex-wrap gap-2 mb-4">
              <button
                onClick={() => setSiteFilter('')}
                className="px-3 py-1.5 border font-mono text-[10px] uppercase tracking-[0.2em] transition-colors"
                style={{
                  borderRadius: '8px',
                  borderColor: siteFilter === '' ? 'var(--phosphor)' : 'hsl(var(--border))',
                  color: siteFilter === '' ? 'var(--phosphor)' : 'hsl(var(--muted-foreground))',
                  background: siteFilter === '' ? 'hsla(33,95%,55%,0.08)' : 'transparent',
                }}
              >
                All sites
              </button>
              {sites.map(({ id, label }) => (
                <button
                  key={id}
                  onClick={() => setSiteFilter(id)}
                  title={id}
                  className="px-3 py-1.5 border font-mono text-[10px] uppercase tracking-[0.2em] transition-colors"
                  style={{
                    borderRadius: '8px',
                    borderColor: siteFilter === id ? 'var(--phosphor)' : 'hsl(var(--border))',
                    color: siteFilter === id ? 'var(--phosphor)' : 'hsl(var(--muted-foreground))',
                    background: siteFilter === id ? 'hsla(33,95%,55%,0.08)' : 'transparent',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {loading ? (
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading archives…
            </div>
          ) : archives.length === 0 ? (
            <div className="border border-dashed border-border px-4 py-6 text-center" style={{ borderRadius: '8px' }}>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                No archives yet
              </p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                {siteFilter
                  ? `No archives received from "${siteLabel(siteFilter)}".`
                  : 'No site has pushed an archive yet, and the nightly pull-fallback hasn\'t run.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    <th className="py-2 pr-4">Site</th>
                    <th className="py-2 pr-4">Period</th>
                    <th className="py-2 pr-4">Received</th>
                    <th className="py-2 pr-4">Source</th>
                    <th className="py-2 pr-4">Via</th>
                    <th className="py-2 pr-4 text-right">Rows</th>
                    <th className="py-2 pr-4 text-right">Size</th>
                    <th className="py-2 pr-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {archives.map(a => (
                    <tr key={a.id} className="border-b border-border/40 last:border-b-0">
                      <td className="py-2.5 pr-4 font-mono text-xs text-foreground" title={a.site_id}>
                        {(a.site_name || '').trim() || siteLabel(a.site_id)}
                      </td>
                      <td className="py-2.5 pr-4 font-mono text-xs text-foreground">
                        {a.period_year}-{String(a.period_month).padStart(2, '0')}
                      </td>
                      <td className="py-2.5 pr-4 text-xs text-muted-foreground">
                        {formatTs(a.received_at)}
                      </td>
                      <td className="py-2.5 pr-4">
                        <SourcePill source={a.source} />
                      </td>
                      <td className="py-2.5 pr-4">
                        <ViaPill via={a.received_via} />
                      </td>
                      <td className="py-2.5 pr-4 text-right font-mono text-xs text-muted-foreground">
                        {a.row_count.toLocaleString()}
                      </td>
                      <td className="py-2.5 pr-4 text-right font-mono text-xs text-muted-foreground">
                        {formatBytes(a.byte_size)}
                      </td>
                      <td className="py-2.5 pr-4 text-right">
                        <button
                          onClick={() => handleDownload(a.id, a.filename)}
                          disabled={downloadingId === a.id}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 border border-border font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground hover:border-foreground transition-colors disabled:opacity-50"
                          style={{ borderRadius: '6px' }}
                          title={a.filename}
                        >
                          {downloadingId === a.id
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : <Download className="h-3 w-3" strokeWidth={1.75} />}
                          Download
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function SourcePill({ source }) {
  const config = source === 'scheduled'
    ? { color: 'var(--phosphor)', bg: 'hsla(33,95%,55%,0.12)' }
    : { color: 'hsl(var(--muted-foreground))', bg: 'hsla(0,0%,100%,0.06)' };
  return (
    <span
      className="inline-block px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em]"
      style={{ borderRadius: '4px', background: config.bg, color: config.color }}
    >
      {source}
    </span>
  );
}

function ViaPill({ via }) {
  const Icon = via === 'push' ? Server : Cloud;
  const config = via === 'push'
    ? { color: 'var(--phosphor)', bg: 'hsla(33,95%,55%,0.12)' }
    : { color: 'hsl(var(--muted-foreground))', bg: 'hsla(0,0%,100%,0.06)' };
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em]"
      style={{ borderRadius: '4px', background: config.bg, color: config.color }}
    >
      <Icon className="h-2.5 w-2.5" strokeWidth={2} />
      {via}
    </span>
  );
}

function formatTs(s) {
  if (!s) return '—';
  const d = new Date(s.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}
function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
