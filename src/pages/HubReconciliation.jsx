import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { SummaryTile, fmtR, fmtRSigned, fmtCount, REPORT_COLORS } from '@/components/reports/lib';
import { CheckCircle, AlertTriangle, CloudOff, Clock, ExternalLink, RefreshCw } from 'lucide-react';
import { currentIsoWeek } from '@/lib/isoWeek';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

// Hoisted to module scope so callers don't allocate a new Intl formatter on
// every invocation (this function runs once per site on each render).
const SAST_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit',
});

// Working-days-since-sync — counts only Mon-Fri elapsed strictly after
// the last-sync date through "now", with both dates evaluated in the
// business timezone (SAST / Africa/Johannesburg). Examples (now = Mon):
//   sync Mon AM SAST → 0  (same business day)
//   sync Fri PM SAST → 1  (Sat/Sun skipped, today Mon counts)
//   sync Thu         → 2  (Fri + Mon)
//   sync prev-Thu    → 6
//
// Why a fixed TZ: setHours(0,0,0,0) anchors to the VIEWER's local
// timezone. A hub admin in London and one in Joburg watching the same
// Mon-AM Hub page can see different "days elapsed" — Joburg already
// sees Mon, London might still see late-Sun. Same data, different
// stale badges. Pinning to SAST (which has no DST) makes the verdict
// deterministic regardless of where the operator's browser is.
function workingDaysSinceSync(syncedAt, now = new Date()) {
  if (!syncedAt) return null;
  // Guard against malformed inputs BEFORE touching Intl. A site that
  // returns a garbled synced_at string (or a non-ISO variant the
  // browser can't parse) would otherwise make fmt.format() throw
  // RangeError("Invalid time value") and crash the whole Hub page
  // — the whole stale-site UX wedging on one bad row. Treat invalid
  // dates the same as missing: null = "no stale verdict for this site"
  // (caller's badge code falls back to the normal Matched/Mismatch
  // pathway).
  const startDate = new Date(syncedAt);
  const endDate = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null;

  // YYYY-MM-DD in SAST via Intl. en-CA gives ISO-style output which
  // compares lexicographically.
  const startStr = SAST_DATE_FMT.format(startDate);
  const endStr   = SAST_DATE_FMT.format(endDate);
  if (endStr <= startStr) return 0;

  // Iterate by calendar day. Anchoring at noon UTC keeps each
  // increment exactly +24h and getUTCDay() stable regardless of
  // viewer TZ — noon UTC sits mid-day in every TZ globally, so the
  // weekday returned matches what an operator would call that date.
  // SAST has no DST so the math stays clean.
  const dateAtNoonUtc = (s) => new Date(`${s}T12:00:00Z`);
  let cur = dateAtNoonUtc(startStr);
  const end = dateAtNoonUtc(endStr);
  let count = 0;
  while (cur < end) {
    cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
    const dow = cur.getUTCDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

// Threshold: synced strictly more than 1 working day ago = stale.
// Friday sync seen on Monday morning is 1 working day → NOT stale.
// Friday sync seen on Tuesday morning is 2 → stale.
const STALE_WORKING_DAYS = 1;

function isSiteStale(site) {
  // Don't double-count: if the site is in an active error state OR has
  // never returned data, those badges take precedence over "stale".
  if (site.last_error) return false;
  if (!site.has_data) return false;
  const days = workingDaysSinceSync(site.synced_at);
  return days != null && days > STALE_WORKING_DAYS;
}

// Plain-English explainers for every labelled metric on the per-site
// recon card. Defining these centrally (one object per source-of-truth)
// keeps the tooltip text in one place rather than scattered through the
// JSX, and makes copy edits a one-line change. Each entry is intentionally
// operator-focused: WHAT the number is + WHY it matters + WHAT to do
// when it looks wrong. Avoid jargon; assume the reader knows BAT/Sage
// terminology but not the implementation details (ISO weeks, sage_total
// columns, etc.).
const TIPS = {
  bat: 'Total of supplier deliveries (delivery + discount + pricing) from every BAT spreadsheet uploaded for this site this year. This is what the supplier says they invoiced.',
  creditNotes: 'Total of every BAT credit note Sage has posted against this site this year. This is what your accounting says was actually paid back.',
  variance: 'BAT minus Credit Notes. Should be ≈ R0 when every week is matched. Positive: supplier billed more than Sage paid (you owe less than you thought, or Sage is behind on processing). Negative: Sage paid more than supplier billed (overpayment or duplicate credit notes). Anything ≥ R0.01 in absolute value flags as a mismatch.',
  lastBatWeek: 'The most recent week the operator uploaded a BAT supplier spreadsheet on this site. If this falls behind "Last paid (Sage)", the site is behind on data entry — Sage already paid for weeks the operator hasn\'t reconciled yet.',
  lastPaidSage: 'The most recent week with Sage credit notes posted, capped at the current ISO week so phantom future-dated entries don\'t surface here. If this falls behind "Last BAT week", Sage is behind on processing the credit notes the operator already uploaded.',
  mismatchHeader: 'Weeks where BOTH a BAT spreadsheet AND Sage credit notes exist for that week, but the totals don\'t balance (variance ≥ R0.01). Investigate each listed week — usually a missing line item, an amount captured wrong, or a credit note posted to the wrong week.',
  missingCreditNotesHeader: 'Weeks where the BAT spreadsheet was uploaded but Sage hasn\'t posted any credit notes against it yet. Chase accounts to confirm the credit notes are processed; until they are, the site can\'t close the week.',
  weeksCount: 'Total number of weeks with any BAT spreadsheet uploaded this year. The denominator for "X of Y weeks matched".',
  mismatchCount: 'Count of weeks listed in the Mismatch section above — weeks where both BAT and Sage are present but the totals don\'t balance.',
  missingBat: 'Number of ISO weeks between the last BAT spreadsheet uploaded and the current week. Example: if the last upload was W13 and we are now in W20, this shows 7 — meaning the site is 7 weeks behind on uploads. Crosses year boundaries correctly via ISO-week arithmetic.',
  synced: 'When the hub last successfully pulled this site\'s BAT summary. Hub pulls run every 5 minutes; click the refresh button at the top of the page to force one now.',
};

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
              {(() => {
                // Headline tile reflects errors first, then staleness (sites
                // that haven't synced in more than 1 working day) — the
                // operator wants "ALL HEALTHY" to mean exactly that, not
                // "no errors but some sites are days behind".
                const staleCount = sites.filter(isSiteStale).length;
                let sub, accent;
                if (summary.sites_with_errors > 0) {
                  sub = `${summary.sites_with_errors} error${summary.sites_with_errors === 1 ? '' : 's'}`;
                  accent = REPORT_COLORS.danger;
                } else if (staleCount > 0) {
                  sub = `${staleCount} stale (>1 working day)`;
                  accent = REPORT_COLORS.warning;
                } else {
                  sub = 'all healthy';
                  accent = REPORT_COLORS.info;
                }
                return (
                  <SummaryTile
                    label="Sites reporting"
                    value={`${summary.sites_with_data}/${summary.site_count}`}
                    sub={sub}
                    accent={accent}
                  />
                );
              })()}
              <SummaryTile label="Total BAT" value={<><span className="text-muted-subtle mr-1">R</span>{fmtR(summary.total_supplier)}</>} accent={REPORT_COLORS.primary} />
              <SummaryTile label="Total Credit Notes" value={<><span className="text-muted-subtle mr-1">R</span>{fmtR(summary.total_sage)}</>} accent={REPORT_COLORS.secondary} />
              <SummaryTile
                label="Total Variance"
                value={<><span className="text-muted-subtle mr-1">R</span>{fmtRSigned(summary.total_variance)}</>}
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
                    value={<><span className="text-muted-subtle mr-1">W</span>{currentWeek}</>}
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
  const stale = isSiteStale(site);
  const daysSinceSync = workingDaysSinceSync(site.synced_at);
  let badge;
  if (hasError) {
    badge = { color: 'hsl(var(--destructive))', glow: 'hsla(0, 72%, 50%, 0.4)', Icon: AlertTriangle, label: 'Sync error' };
  } else if (noData) {
    badge = { color: 'hsl(280 70% 65%)', glow: 'hsla(280, 70%, 55%, 0.4)', Icon: CloudOff, label: 'Awaiting data' };
  } else if (stale) {
    // Stale takes precedence over Matched/Mismatch — the data MIGHT be
    // matched but it's days old; operator needs to know the freshness
    // problem before they trust the variance numbers.
    badge = { color: REPORT_COLORS.warning, glow: 'hsla(50, 90%, 55%, 0.4)', Icon: Clock, label: `Stale · ${daysSinceSync}d` };
  } else if (matched) {
    badge = { color: 'hsl(145 55% 45%)', glow: 'hsla(145, 55%, 45%, 0.4)', Icon: CheckCircle, label: 'Matched' };
  } else {
    badge = { color: 'var(--phosphor)', glow: 'hsla(33, 95%, 55%, 0.4)', Icon: AlertTriangle, label: 'Mismatch' };
  }
  const { color, glow, Icon, label } = badge;
  const syncedAt = site.synced_at ? new Date(site.synced_at).toLocaleString('en-ZA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

  // Card border highlights when the site is in any attention-worthy
  // state — sync error (red), or stale (yellow). Mismatch/matched/no-data
  // use the default border + the left phosphor stripe to signal status.
  const borderColor = hasError
    ? 'hsl(var(--destructive))'
    : stale
      ? REPORT_COLORS.warning
      : 'hsl(var(--border))';

  return (
    <div className="relative overflow-hidden bg-card p-4" style={{ border: `1px solid ${borderColor}`, borderRadius: '12px' }}>
      <div className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: color, boxShadow: `0 0 10px ${glow}` }} />
      <div className="pl-2 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted-foreground">{site.site_slug}</div>
            <div className="font-display text-xl leading-tight text-foreground truncate" title={site.site_name}>
              {site.site_name || site.site_slug}
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <Icon className="h-3 w-3" style={{ color }} strokeWidth={1.5} />
            <span className="font-mono text-[11px] uppercase tracking-[0.2em]" style={{ color }}>{label}</span>
          </div>
        </div>

        {hasError ? (
          <p className="font-mono text-xs text-destructive break-all">{site.last_error}</p>
        ) : noData ? (
          <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground">No BAT summary returned yet — site may not have any reconciliations uploaded.</p>
        ) : (
          <>
            {/* Year-scoped totals (current ISO year — matches what the site
                shows in its own Reconciliation page when no other year is
                selected). The summary_year label tells the operator
                explicitly which year's data is in the card. */}
            {site.summary_year && (
              <div className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted-subtle">
                Year {site.summary_year}
              </div>
            )}
            <div className="space-y-1">
              <DataRow label="BAT" value={fmtR(site.total_supplier)} tooltip={TIPS.bat} />
              <DataRow label="Credit Notes" value={fmtR(site.total_sage)} muted tooltip={TIPS.creditNotes} />
              <DataRow label="Variance" value={fmtRSigned(site.total_variance)} variance={site.total_variance} tooltip={TIPS.variance} />
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
                  tooltip={TIPS.lastBatWeek}
                  value={site.last_bat_week != null
                    ? `W${String(site.last_bat_week).padStart(2, '0')}/${site.last_bat_year ?? site.summary_year ?? ''}`
                    : '—'}
                />
                <Stat
                  label="Last paid (Sage)"
                  tooltip={TIPS.lastPaidSage}
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
                <LabelWithTip
                  tooltip={TIPS.mismatchHeader}
                  className="font-mono text-[11px] uppercase tracking-[0.15em] text-destructive mb-1 block"
                >
                  ⚠ Mismatch · {site.mismatch_weeks.length} week{site.mismatch_weeks.length !== 1 ? 's' : ''}
                </LabelWithTip>
                <div className="font-mono text-xs tabular-nums text-muted-foreground">
                  {site.mismatch_weeks.map(w => `W${String(w).padStart(2, '0')}`).join(', ')}
                </div>
              </div>
            )}

            {site.missing_credit_notes_weeks?.length > 0 && (
              <div className="pt-2 border-t border-border">
                <LabelWithTip
                  tooltip={TIPS.missingCreditNotesHeader}
                  className="font-mono text-[11px] uppercase tracking-[0.15em] mb-1 block"
                >
                  <span style={{ color: 'var(--phosphor)' }}>
                    ⚠ Missing credit notes · {site.missing_credit_notes_weeks.length} week{site.missing_credit_notes_weeks.length !== 1 ? 's' : ''}
                  </span>
                </LabelWithTip>
                <div className="font-mono text-xs tabular-nums text-muted-foreground">
                  {site.missing_credit_notes_weeks.map(w => `W${String(w).padStart(2, '0')}`).join(', ')}
                </div>
              </div>
            )}

            <div className="pt-2 border-t border-border grid grid-cols-3 gap-2">
              <Stat label="Weeks" value={fmtCount(site.weeks_count)} tooltip={TIPS.weeksCount} />
              <Stat label="Mismatch" value={fmtCount(site.mismatch_count)} tooltip={TIPS.mismatchCount} color={site.mismatch_count > 0 ? 'hsl(var(--destructive))' : undefined} />
              {/* Weeks where Sage has posted credit notes but no BAT recon
                  has been uploaded yet — i.e. the site is behind on data
                  entry. Highlighted in phosphor when > 0 so an operator
                  scanning the network can spot stragglers immediately. */}
              <Stat
                label="Missing BAT"
                tooltip={TIPS.missingBat}
                value={fmtCount(site.missing_weeks_count)}
                color={site.missing_weeks_count > 0 ? 'var(--phosphor)' : undefined}
              />
            </div>
          </>
        )}

        <div className="pt-2 border-t border-border flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.15em] text-muted-subtle">
          <LabelWithTip tooltip={TIPS.synced} className="font-mono text-[11px] uppercase tracking-[0.15em] text-muted-subtle">
            Synced {syncedAt}
          </LabelWithTip>
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

// Wraps a label in a Radix tooltip when `tooltip` text is provided. The
// dotted underline is the affordance — operators learn that any dotted
// label is hoverable for an explainer. asChild lets the tooltip trigger
// off the existing span without injecting an extra button into the DOM
// (which would break the flex layout and tab order).
function LabelWithTip({ tooltip, className, children }) {
  if (!tooltip) {
    return <span className={className}>{children}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`${className} cursor-help underline decoration-dotted decoration-muted-foreground/40 underline-offset-[3px]`}
          tabIndex={0}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[22rem]">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

function DataRow({ label, value, muted, variance, tooltip }) {
  let color;
  if (variance != null) {
    color = Math.abs(variance) < 0.01 ? 'hsl(145 55% 45%)' : (variance > 0 ? 'hsl(var(--destructive))' : 'hsl(33 95% 55%)');
  }
  return (
    <div className="flex items-baseline justify-between gap-2">
      <LabelWithTip tooltip={tooltip} className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </LabelWithTip>
      <span className={`font-mono text-sm tabular-nums ${muted ? 'text-muted-foreground' : 'text-foreground'}`} style={color ? { color } : undefined}>
        <span className="text-muted-subtle mr-1">R</span>{value}
      </span>
    </div>
  );
}

function Stat({ label, value, color, tooltip }) {
  return (
    <div>
      <LabelWithTip tooltip={tooltip} className="font-mono text-[11px] uppercase tracking-[0.15em] text-muted-foreground block">
        {label}
      </LabelWithTip>
      <div className="font-mono text-sm tabular-nums" style={color ? { color } : undefined}>{value}</div>
    </div>
  );
}
