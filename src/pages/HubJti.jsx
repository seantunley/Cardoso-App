// HubJti — hub-mode dashboard for received JTI archives.
//
// Groups archives by (period_year, period_month) so an operator can see
// at a glance "do I have all N sites for April yet?" and download the
// whole month as a single ZIP when complete. Per-site individual
// download stays inside each group for ad-hoc access (e.g. need just
// one site's file).
//
// Backed by GET /api/hub/jti/archive-groups, which returns:
//   - expected_sites: [{id, name}]                  from HUB_SITES env
//   - groups: [{
//       period_year, period_month, expected_count,
//       received_count, complete, missing_site_ids,
//       orphan_site_ids, received: [archive...]
//     }]

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Loader2, Download, Archive, AlertTriangle, CheckCircle2, Package,
  Server, Cloud, ChevronDown, ChevronRight,
} from "lucide-react";

export default function HubJti() {
  const [groups, setGroups] = useState([]);
  const [expectedSites, setExpectedSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloadingId, setDownloadingId] = useState(null);
  const [downloadingBundle, setDownloadingBundle] = useState(null); // "YYYY-MM" while a bundle download is in flight
  // Track which group is expanded — default: latest period open,
  // older ones collapsed so the page reads as a digest, not a wall.
  const [expanded, setExpanded] = useState(() => new Set());

  useEffect(() => {
    let cancelled = false;
    refresh({ cancelledRef: () => cancelled });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh({ cancelledRef = () => false } = {}) {
    setLoading(true);
    try {
      const r = await fetch(`/api/hub/jti/archive-groups`, { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (cancelledRef()) return;
      const fetched = Array.isArray(data.groups) ? data.groups : [];
      setGroups(fetched);
      setExpectedSites(Array.isArray(data.expected_sites) ? data.expected_sites : []);
      // Auto-expand the latest period on first load so the operator
      // sees the most relevant data without an extra click.
      if (fetched.length > 0) {
        setExpanded((prev) => {
          if (prev.size > 0) return prev; // honour operator's manual choices on refresh
          const key = `${fetched[0].period_year}-${String(fetched[0].period_month).padStart(2, '0')}`;
          return new Set([key]);
        });
      }
      setError('');
    } catch (err) {
      if (!cancelledRef()) {
        setError(`Couldn't load archives: ${err.message}`);
        toast.error(`Couldn't load JTI archive groups: ${err.message}`);
      }
    } finally {
      if (!cancelledRef()) setLoading(false);
    }
  }

  const handleDownloadOne = async (id, filename) => {
    setDownloadingId(id);
    try {
      const r = await fetch(`/api/hub/jti/archives/${id}/download`, { credentials: 'include' });
      if (!r.ok) {
        let message = `HTTP ${r.status}`;
        try { message = (await r.json()).error || message; } catch {} // eslint-disable-line no-empty -- error-body parse fallback; default HTTP message is the documented contract
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

  const handleDownloadBundle = async (year, month) => {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    setDownloadingBundle(key);
    try {
      const r = await fetch(
        `/api/hub/jti/archive-groups/${year}/${month}/download`,
        { credentials: 'include' }
      );
      if (!r.ok) {
        // Structured-error fall-back. The server returns 409 with
        // missing_site_ids when the bundle isn't ready; surface that
        // directly so the operator knows who hasn't pushed.
        let message = `HTTP ${r.status}`;
        try {
          const data = await r.json();
          if (data?.error) message = data.error;
          if (Array.isArray(data?.missing_site_ids) && data.missing_site_ids.length > 0) {
            message += ` (Missing: ${data.missing_site_ids.join(', ')})`;
          }
        } catch { /* not JSON — leave generic */ }
        throw new Error(message);
      }
      const blob = await r.blob();
      triggerDownload(blob, `JTI_Bundle_${key}.zip`);
      toast.success(`Bundle downloaded — ${key}`);
    } catch (err) {
      toast.error(`Bundle download failed: ${err.message}`);
    } finally {
      setDownloadingBundle(null);
    }
  };

  const toggleExpanded = (key) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1200px] mx-auto px-8 py-10 space-y-8">
        <div className="border-b border-border pb-5">

          <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
            JTI Sales <em className="text-phosphor not-italic">archives</em>.
          </h1>
          <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground mt-3">
            {expectedSites.length} sites expected · grouped by month · bundle ready when all sites have reported
          </p>
        </div>

        {error && (
          <div
            className="relative overflow-hidden border border-border bg-card px-4 py-2.5"
            style={{ borderRadius: '12px' }}
          >
            <div
              className="absolute left-0 top-0 bottom-0 w-[2px]"
              style={{ background: 'hsl(var(--destructive))', boxShadow: '0 0 10px hsl(var(--status-critical) / 0.3)' }}
            />
            <p className="font-mono text-xs text-destructive pl-2 flex items-start gap-2">
              <AlertTriangle className="h-3.5 w-3.5 mt-px flex-shrink-0" strokeWidth={1.75} />
              {error}
            </p>
          </div>
        )}

        <section className="bg-card border border-border p-6 space-y-3" style={{ borderRadius: '12px' }}>
          <div className="flex items-start justify-between gap-4 mb-2">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-1">
                Monthly archive bundles
              </div>
              <h2 className="font-display text-xl text-foreground mb-1 flex items-center gap-2">
                <Archive className="h-5 w-5 text-muted-foreground" strokeWidth={1.75} />
                Received by period
              </h2>
              <p className="text-sm text-muted-foreground">
                Each month is a bundle of all {expectedSites.length} sites' archives. A bundle is downloadable as one ZIP only when every site has reported.
              </p>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading archives…
            </div>
          ) : groups.length === 0 ? (
            <div className="border border-dashed border-border px-4 py-6 text-center" style={{ borderRadius: '8px' }}>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                No archives yet
              </p>
              <p className="text-xs text-muted-subtle mt-1">
                No site has pushed an archive yet, and the nightly pull-fallback hasn't run.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {groups.map((g, idx) => {
                const key = `${g.period_year}-${String(g.period_month).padStart(2, '0')}`;
                const isOpen = expanded.has(key);
                const bundleDownloading = downloadingBundle === key;
                return (
                  <GroupRow
                    key={key}
                    group={g}
                    periodKey={key}
                    expectedSites={expectedSites}
                    isOpen={isOpen}
                    isLatest={idx === 0}
                    onToggle={() => toggleExpanded(key)}
                    onDownloadBundle={() => handleDownloadBundle(g.period_year, g.period_month)}
                    onDownloadOne={handleDownloadOne}
                    downloadingId={downloadingId}
                    bundleDownloading={bundleDownloading}
                  />
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function GroupRow({
  group, periodKey, expectedSites, isOpen, isLatest, onToggle,
  onDownloadBundle, onDownloadOne, downloadingId, bundleDownloading,
}) {
  const expectedById = new Map(expectedSites.map((s) => [s.id, s.name || s.id]));
  const missingNames = group.missing_site_ids.map((id) => expectedById.get(id) || id);

  return (
    <div className="border border-border" style={{ borderRadius: '8px' }}>
      {/* Header — always visible. Click to expand. */}
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/20 transition-colors"
      >
        <div className="flex items-center gap-3">
          {isOpen
            ? <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            : <ChevronRight className="h-4 w-4 text-muted-foreground flex-shrink-0" />}
          <div className="text-left">
            <div className="font-mono text-sm text-foreground">
              {group.period_year}-{String(group.period_month).padStart(2, '0')}
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {group.complete
                ? `Bundle ready · all ${group.expected_count} sites reported`
                : `${group.received_count}/${group.expected_count} sites · missing ${missingNames.join(', ')}`}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {isLatest && (
            <span
              className="inline-flex items-center px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] cursor-default"
              style={{
                borderRadius: '6px',
                border: '1px solid var(--phosphor)',
                color: 'var(--phosphor)',
                background: 'hsla(33, 95%, 55%, 0.08)',
              }}
              title="Most recent period the Hub has archives for"
            >
              Latest
            </span>
          )}
          <CompletenessPill complete={group.complete} received={group.received_count} expected={group.expected_count} />
          {group.complete && (
            <div
              onClick={(e) => { e.stopPropagation(); onDownloadBundle(); }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDownloadBundle(); } }}
              aria-disabled={bundleDownloading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 border font-mono text-[10px] uppercase tracking-[0.2em] transition-colors cursor-pointer"
              style={{
                borderRadius: '6px',
                borderColor: 'var(--phosphor)',
                color: 'var(--phosphor)',
                background: 'hsla(33, 95%, 55%, 0.08)',
                opacity: bundleDownloading ? 0.5 : 1,
                pointerEvents: bundleDownloading ? 'none' : 'auto',
              }}
            >
              {bundleDownloading
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <Package className="h-3 w-3" strokeWidth={1.75} />}
              {bundleDownloading ? 'Bundling…' : 'Download bundle'}
            </div>
          )}
        </div>
      </button>

      {/* Expanded body — per-site rows. */}
      {isOpen && (
        <div className="border-t border-border/40 px-4 py-3">
          {/* Missing sites callout (when incomplete) */}
          {!group.complete && (
            <div className="mb-3 px-3 py-2 border border-amber-500/40 bg-amber-500/5" style={{ borderRadius: '6px' }}>
              <div className="flex items-start gap-2 text-xs text-amber-300/90">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber-300 mb-0.5">
                    Bundle locked
                  </div>
                  <div>
                    Waiting on {missingNames.length} site{missingNames.length === 1 ? '' : 's'}:
                    {' '}<span className="font-mono">{missingNames.join(', ')}</span>.
                    Bundle download unlocks automatically when every site has pushed for this period.
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Orphan callout — archives from sites that aren't in HUB_SITES anymore. */}
          {group.orphan_site_ids?.length > 0 && (
            <div className="mb-3 px-3 py-2 border border-border/40 bg-muted/20" style={{ borderRadius: '6px' }}>
              <div className="text-[11px] text-muted-foreground">
                <span className="font-mono">{group.orphan_site_ids.join(', ')}</span> sent archives but {group.orphan_site_ids.length === 1 ? 'is' : 'are'} no longer in HUB_SITES — still individually downloadable below, excluded from the bundle.
              </div>
            </div>
          )}

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                <th className="py-2 pr-4">Site</th>
                <th className="py-2 pr-4">Source</th>
                <th className="py-2 pr-4">Via</th>
                <th className="py-2 pr-4">Received</th>
                <th className="py-2 pr-4 text-right">Rows</th>
                <th className="py-2 pr-4 text-right">Size</th>
                <th className="py-2 pr-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {expectedSites.map((s) => {
                const archive = group.received.find((a) => a.site_id === s.id);
                if (!archive) {
                  // Missing row — render a placeholder so the operator
                  // can see WHICH expected site hasn't reported.
                  return (
                    <tr key={`missing-${s.id}`} className="border-b border-border/40 last:border-b-0 opacity-60">
                      <td className="py-2.5 pr-4 font-mono text-xs text-foreground">{s.name || s.id}</td>
                      <td className="py-2.5 pr-4 text-xs text-muted-foreground" colSpan={5}>— not received yet —</td>
                      <td className="py-2.5 pr-4 text-right">
                        <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-amber-400">
                          Missing
                        </span>
                      </td>
                    </tr>
                  );
                }
                return (
                  <SiteRow
                    key={archive.id}
                    site={s}
                    archive={archive}
                    isOrphan={false}
                    onDownload={onDownloadOne}
                    downloadingId={downloadingId}
                  />
                );
              })}
              {/* Orphan rows (sites that sent archives but aren't in HUB_SITES).
                  Prefer the LEFT-JOIN'd site_name on the archive row over the
                  raw UUID — hub_sites still has a row for the site even after
                  it drops out of HUB_SITES (in_env=0), so the join keeps
                  yielding a friendly name for as long as the registry row
                  survives. Reviewer-flagged: the merge that landed PR #312
                  on top of PR #319 dropped this fallback at line 354 and
                  left orphans rendering with their UUID. */}
              {group.received.filter((a) => !expectedById.has(a.site_id)).map((a) => (
                <SiteRow
                  key={a.id}
                  site={{ id: a.site_id, name: a.site_name || a.site_id }}
                  archive={a}
                  isOrphan={true}
                  onDownload={onDownloadOne}
                  downloadingId={downloadingId}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SiteRow({ site, archive, isOrphan, onDownload, downloadingId }) {
  return (
    <tr className="border-b border-border/40 last:border-b-0">
      <td className="py-2.5 pr-4 font-mono text-xs text-foreground">
        {site.name || site.id}
        {isOrphan && (
          <span className="ml-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-muted-subtle">
            orphan
          </span>
        )}
      </td>
      <td className="py-2.5 pr-4">
        <SourcePill source={archive.source} />
      </td>
      <td className="py-2.5 pr-4">
        <ViaPill via={archive.received_via} />
      </td>
      <td className="py-2.5 pr-4 text-xs text-muted-foreground">
        {formatTs(archive.received_at)}
      </td>
      <td className="py-2.5 pr-4 text-right font-mono text-xs text-muted-foreground">
        {archive.row_count.toLocaleString()}
      </td>
      <td className="py-2.5 pr-4 text-right font-mono text-xs text-muted-foreground">
        {formatBytes(archive.byte_size)}
      </td>
      <td className="py-2.5 pr-4 text-right">
        <button
          onClick={() => onDownload(archive.id, archive.filename)}
          disabled={downloadingId === archive.id}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 border border-border font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground hover:border-foreground transition-colors disabled:opacity-50"
          style={{ borderRadius: '6px' }}
          title={archive.filename}
        >
          {downloadingId === archive.id
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : <Download className="h-3 w-3" strokeWidth={1.75} />}
          Download
        </button>
      </td>
    </tr>
  );
}

function CompletenessPill({ complete, received, expected }) {
  if (complete) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em]"
        style={{
          borderRadius: '4px',
          background: 'hsla(33,95%,55%,0.12)',
          color: 'var(--phosphor)',
        }}
      >
        <CheckCircle2 className="h-3 w-3" strokeWidth={2} />
        {received}/{expected}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em]"
      style={{
        borderRadius: '4px',
        background: 'hsla(0,0%,100%,0.06)',
        color: 'hsl(var(--muted-foreground))',
      }}
    >
      {received}/{expected}
    </span>
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
