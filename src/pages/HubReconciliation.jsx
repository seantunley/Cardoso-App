import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SummaryTile, fmtR, fmtRSigned, fmtCount, REPORT_COLORS } from '@/components/reports/lib';
import { CheckCircle, AlertTriangle, CloudOff, ExternalLink, RefreshCw } from 'lucide-react';
import { currentIsoWeek } from '@/lib/isoWeek';

function fetchBatSummary() {
  return fetch('/api/hub/bat-summary', { credentials: 'include' })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

function refreshAll() {
  return fetch('/api/hub/bat-summary/refresh', { method: 'POST', credentials: 'include' })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

export default function HubReconciliation() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['hub-bat-summary'],
    queryFn: fetchBatSummary,
    staleTime: 60_000,
  });

  const refreshMutation = useMutation({
    mutationFn: refreshAll,
    onSuccess: () => {
      toast.success('Hub refresh started — pulling from every site');
      queryClient.invalidateQueries({ queryKey: ['hub-bat-summary'] });
    },
    onError: (err) => toast.error(`Refresh failed: ${err.message}`),
  });

  const sites = data?.sites || [];
  const summary = data?.summary;


  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1600px] mx-auto px-8 py-10">
        <div className="border-b border-border pb-5 mb-6">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">§ Hub · Reconciliation</div>
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div>
              <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
                Sites at a <em className="text-phosphor">glance</em>.
              </h1>
              <p className="text-sm text-muted-foreground mt-3">
                BAT reconciliation summary across every connected site. Synced once a day; click the refresh button to pull now.
              </p>
            </div>
            <button
              onClick={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending}
              className="inline-flex items-center gap-2 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.2em] transition-colors disabled:opacity-50"
              style={{
                borderRadius: '12px',
                border: '1px solid var(--phosphor)',
                color: 'var(--phosphor)',
                background: 'hsla(33, 95%, 55%, 0.08)',
              }}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshMutation.isPending ? 'animate-spin' : ''}`} strokeWidth={1.75} />
              {refreshMutation.isPending ? 'Refreshing…' : 'Refresh now'}
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-card px-4 py-3 mb-5" style={{ border: '1px solid hsl(var(--destructive))', borderRadius: '12px' }}>
            <p className="text-sm text-destructive font-mono">{error.message}</p>
          </div>
        )}

        {isLoading && (
          <div className="flex items-center justify-center py-12 text-muted-foreground gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.2em]">Loading…</span>
          </div>
        )}

        {data && summary && (
          <div className="space-y-6">
            {/* Network-wide summary tiles */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <SummaryTile label="Sites reporting" value={`${summary.sites_with_data}/${summary.site_count}`} sub={summary.sites_with_errors > 0 ? `${summary.sites_with_errors} errors` : 'all healthy'} accent={REPORT_COLORS.info} />
              <SummaryTile label="Total BAT" value={<><span className="text-muted-foreground/60 mr-1">R</span>{fmtR(summary.total_supplier)}</>} accent={REPORT_COLORS.primary} />
              <SummaryTile label="Total Credit Notes" value={<><span className="text-muted-foreground/60 mr-1">R</span>{fmtR(summary.total_sage)}</>} accent={REPORT_COLORS.secondary} />
              <SummaryTile
                label="Total Variance"
                value={<><span className="text-muted-foreground/60 mr-1">R</span>{fmtRSigned(summary.total_variance)}</>}
                sub={`${summary.total_matched} matched · ${summary.total_mismatch} mismatch · ${summary.total_awaiting} awaiting`}
                accent={Math.abs(summary.total_variance) < 1 ? REPORT_COLORS.secondary : REPORT_COLORS.danger}
                big
              />
              {(() => {
                // Routed through the canonical helper in src/lib/isoWeek.js
                // (which has dedicated boundary tests) so this tile and the
                // server's /api/bat/week-status agree on every ISO-year
                // straddling week. Replaces the previous inline algorithm.
                const { year: isoYear, week: currentWeek } = currentIsoWeek();
                return (
                  <SummaryTile
                    label="Current Week"
                    value={<><span className="text-muted-foreground/60 mr-1">W</span>{currentWeek}</>}
                    sub={`${isoYear}`}
                    accent={REPORT_COLORS.info}
                  />
                );
              })()}
            </div>

            {/* Per-site card grid */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {sites.map(s => <SiteCard key={s.site_id} site={s} />)}
              {sites.length === 0 && (
                <div className="col-span-full bg-card border border-border p-12 text-center text-muted-foreground" style={{ borderRadius: '12px' }}>
                  <p className="font-mono text-[11px] uppercase tracking-[0.2em]">
                    No sites registered. Configure HUB_SITES env var with at least one site URL + token.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SiteCard({ site }) {
  const matched = Math.abs(site.total_variance) < 0.01 && site.total_supplier > 0;
  const hasError = !!site.last_error;
  const noData = !site.has_data && !hasError;
  let badge;
  if (hasError) {
    badge = { color: 'hsl(var(--destructive))', glow: 'hsla(0, 72%, 50%, 0.4)', Icon: AlertTriangle, label: 'Sync error' };
  } else if (noData) {
    badge = { color: 'hsl(280 70% 65%)', glow: 'hsla(280, 70%, 55%, 0.4)', Icon: CloudOff, label: 'Awaiting data' };
  } else if (matched) {
    badge = { color: 'hsl(145 55% 45%)', glow: 'hsla(145, 55%, 45%, 0.4)', Icon: CheckCircle, label: 'Matched' };
  } else {
    badge = { color: 'var(--phosphor)', glow: 'hsla(33, 95%, 55%, 0.4)', Icon: AlertTriangle, label: 'Mismatch' };
  }
  const { color, glow, Icon, label } = badge;
  const syncedAt = site.synced_at ? new Date(site.synced_at).toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

  return (
    <div className="relative overflow-hidden bg-card p-4" style={{ border: `1px solid ${badge.color === 'hsl(var(--destructive))' ? 'hsl(var(--destructive))' : 'hsl(var(--border))'}`, borderRadius: '12px' }}>
      <div className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: color, boxShadow: `0 0 10px ${glow}` }} />
      <div className="pl-2 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">{site.site_slug}</div>
            <div className="font-display text-xl leading-tight text-foreground truncate" title={site.site_name}>
              {site.site_name || site.site_slug}
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <Icon className="h-3 w-3" style={{ color }} strokeWidth={1.5} />
            <span className="font-mono text-[9px] uppercase tracking-[0.2em]" style={{ color }}>{label}</span>
          </div>
        </div>

        {hasError ? (
          <p className="font-mono text-[10px] text-destructive break-all">{site.last_error}</p>
        ) : noData ? (
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">No BAT summary returned yet — site may not have any reconciliations uploaded.</p>
        ) : (
          <>
            {/* Year-scoped totals (current ISO year — matches what the site
                shows in its own Reconciliation page when no other year is
                selected). The summary_year label tells the operator
                explicitly which year's data is in the card. */}
            {site.summary_year && (
              <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground/70">
                Year {site.summary_year}
              </div>
            )}
            <div className="space-y-1">
              <DataRow label="BAT" value={fmtR(site.total_supplier)} />
              <DataRow label="Credit Notes" value={fmtR(site.total_sage)} muted />
              <DataRow label="Variance" value={fmtRSigned(site.total_variance)} variance={site.total_variance} />
            </div>

            {/* Per-week status row — replicates the most useful tiles from
                the site's own Reconciliation page so an operator scanning
                the hub knows which sites need chasing without drilling in.
                Only renders when the site has reported the new fields
                (older sites: last_bat_week / last_paid_week null). */}
            {(site.last_bat_week != null || site.last_paid_week != null) && (
              <div className="pt-2 border-t border-border grid grid-cols-2 gap-2">
                <Stat
                  label="Last BAT week"
                  value={site.last_bat_week != null
                    ? `W${String(site.last_bat_week).padStart(2, '0')}/${site.last_bat_year ?? site.summary_year ?? ''}`
                    : '—'}
                />
                <Stat
                  label="Last paid (Sage)"
                  value={site.last_paid_week != null
                    ? `W${String(site.last_paid_week).padStart(2, '0')}/${site.last_paid_year ?? site.summary_year ?? ''}`
                    : '—'}
                />
              </div>
            )}

            {/* Mismatch / missing-credit-note week numbers, listed
                explicitly so the operator can see which weeks to look at
                — not just a count. Phosphor for missing credit notes
                (chase accounts), red for mismatches (investigate). */}
            {site.mismatch_weeks?.length > 0 && (
              <div className="pt-2 border-t border-border">
                <div className="font-mono text-[9px] uppercase tracking-[0.15em] text-destructive mb-1">
                  ⚠ Mismatch · {site.mismatch_weeks.length} week{site.mismatch_weeks.length !== 1 ? 's' : ''}
                </div>
                <div className="font-mono text-[10px] tabular-nums text-muted-foreground">
                  {site.mismatch_weeks.map(w => `W${String(w).padStart(2, '0')}`).join(', ')}
                </div>
              </div>
            )}

            {site.missing_credit_notes_weeks?.length > 0 && (
              <div className="pt-2 border-t border-border">
                <div className="font-mono text-[9px] uppercase tracking-[0.15em] mb-1" style={{ color: 'var(--phosphor)' }}>
                  ⚠ Missing credit notes · {site.missing_credit_notes_weeks.length} week{site.missing_credit_notes_weeks.length !== 1 ? 's' : ''}
                </div>
                <div className="font-mono text-[10px] tabular-nums text-muted-foreground">
                  {site.missing_credit_notes_weeks.map(w => `W${String(w).padStart(2, '0')}`).join(', ')}
                </div>
              </div>
            )}

            <div className="pt-2 border-t border-border grid grid-cols-3 gap-2">
              <Stat label="Weeks" value={fmtCount(site.weeks_count)} />
              <Stat label="Mismatch" value={fmtCount(site.mismatch_count)} color={site.mismatch_count > 0 ? 'hsl(var(--destructive))' : undefined} />
              {/* Weeks where Sage has posted credit notes but no BAT recon
                  has been uploaded yet — i.e. the site is behind on data
                  entry. Highlighted in phosphor when > 0 so an operator
                  scanning the network can spot stragglers immediately. */}
              <Stat
                label="Missing BAT"
                value={fmtCount(site.missing_weeks_count)}
                color={site.missing_weeks_count > 0 ? 'var(--phosphor)' : undefined}
              />
            </div>
          </>
        )}

        <div className="pt-2 border-t border-border flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.15em] text-muted-foreground/70">
          <span>Synced {syncedAt}</span>
          {site.site_url && (
            <a
              href={site.site_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-accent transition-colors"
              title={`Open ${site.site_name || site.site_slug}`}
            >
              Open
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function DataRow({ label, value, muted, variance }) {
  let color;
  if (variance != null) {
    color = Math.abs(variance) < 0.01 ? 'hsl(145 55% 45%)' : (variance > 0 ? 'hsl(var(--destructive))' : 'hsl(33 95% 55%)');
  }
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={`font-mono text-sm tabular-nums ${muted ? 'text-muted-foreground' : 'text-foreground'}`} style={color ? { color } : undefined}>
        <span className="text-muted-foreground/60 mr-1">R</span>{value}
      </span>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted-foreground">{label}</div>
      <div className="font-mono text-sm tabular-nums" style={color ? { color } : undefined}>{value}</div>
    </div>
  );
}
