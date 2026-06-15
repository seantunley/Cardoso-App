import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { humanizeApiError } from '@/lib/humanizeApiError';
import { reportClientError } from '@/lib/clientLog';
import { RefreshCw, FileText, ChevronLeft, ChevronDown, ChevronRight, AlertTriangle, Upload, Calendar as CalendarIcon } from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import FileUpload from '@/components/reconciliation/FileUpload';
import { isoYear } from '@/lib/isoWeek';
import WeekSelector from '@/components/reconciliation/WeekSelector';
import FeeComparison from '@/components/reconciliation/FeeComparison';
import InvoiceMatching from '@/components/reconciliation/InvoiceMatching';
import ReconciliationSummary from '@/components/reconciliation/ReconciliationSummary';
import ExtractionProgress from '@/components/reconciliation/ExtractionProgress';
import DashboardOverview from '@/components/reconciliation/DashboardOverview';
import { useColorScheme } from '@/lib/useColorScheme';

// ── Sage status pill ──────────────────────────────────────────────────
//
// Surfaces the live Sage MSSQL connectivity state on the recon page so
// an operator can spot "the credit-note refresh button is going to
// fail" without having to click it first. Polls /api/bat/sage-health
// every 60s — same cadence the admin layout's banner already uses,
// so the request is effectively free (browser HTTP cache + server-side
// state).
//
// States (from getSageHealth in src/services/batReconciliation.js):
//   ok === true                    → green   "Sage OK"
//   attention === true (≥5 fails)  → red     "Sage down Xm"
//   ok === false (1-4 fails)       → amber   "Sage degraded"
//   ok === null (no probe yet)     → grey    "Sage —"
function SageStatusPill() {
  const [health, setHealth] = useState(null);
  // fetchFailed flips true when /api/bat/sage-health is unreachable
  // OR returns non-OK. The pill still renders in that case (as unknown
  // with a distinct tooltip) instead of disappearing — operators
  // shouldn't have to guess "is the feature broken or just unset?".
  const [fetchFailed, setFetchFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchHealth = async () => {
      try {
        const r = await fetch('/api/bat/sage-health', { credentials: 'include' });
        if (!r.ok) {
          // CRITICAL: clear `health` alongside flipping fetchFailed.
          // If we only flipped the flag, a previously-fetched
          // `{ ok: true }` would keep rendering the green "Sage OK"
          // pill while the probe endpoint is currently unreachable —
          // operator sees a healthy badge but the data is stale and
          // we have no current ground truth. Reset to null so the
          // render priority falls through to the unknown branch
          // (which will use the fetchFailed tooltip).
          if (!cancelled) {
            setHealth(null);
            setFetchFailed(true);
          }
          return;
        }
        const data = await r.json();
        if (!cancelled) {
          setHealth(data);
          setFetchFailed(false);
        }
      } catch {
        // Network error (server down, offline, etc.) — same shape:
        // clear stale health AND flip fetchFailed. The pill renders
        // the unknown branch with the probe-endpoint-specific
        // tooltip rather than continuing to display whatever the
        // last successful poll returned.
        if (!cancelled) {
          setHealth(null);
          setFetchFailed(true);
        }
      }
    };
    fetchHealth();
    const t = setInterval(fetchHealth, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // Pill ALWAYS renders — three "unknown" sub-cases:
  //   - initial load before the first fetch resolves (health === null,
  //     fetchFailed === false) → "Sage —" + "loading" tooltip
  //   - probe endpoint unreachable / non-OK (fetchFailed === true) →
  //     "Sage —" + "probe endpoint unreachable" tooltip (distinct from
  //     "Sage backend down" which would be ok === false from a
  //     successful response)
  //   - server returned but probe never ran (health.ok === null) →
  //     documented unknown state
  // Earlier the component returned null on !health, so the pill
  // disappeared during initial load and on any non-OK response —
  // which an operator would naturally read as "the feature isn't
  // there" rather than "I can't tell". Caught in PR review.
  let label, tone, tooltip;
  if (!health) {
    label = 'Sage —';
    tone = 'bg-slate-500/15 text-slate-400 border-slate-500/30';
    tooltip = fetchFailed
      ? 'Could not reach /api/bat/sage-health. The probe endpoint is unreachable; this is separate from Sage MSSQL connectivity.'
      : 'Loading Sage health…';
  } else if (health.attention) {
    label = `Sage down ${health.downForMinutes ?? '?'}m`;
    tone = 'bg-red-500/15 text-red-400 border-red-500/30';
    tooltip = `${health.consecutiveFailures} consecutive probe failures. Last error: ${health.lastError || 'unknown'}. Last OK: ${health.lastOkAt || 'never'}.`;
  } else if (health.ok === true) {
    label = 'Sage OK';
    tone = 'bg-green-500/15 text-green-400 border-green-500/30';
    tooltip = `Last probe OK at ${health.lastOkAt ? new Date(health.lastOkAt).toLocaleTimeString() : 'unknown'}`;
  } else if (health.ok === false) {
    label = 'Sage degraded';
    tone = 'bg-amber-500/15 text-amber-400 border-amber-500/30';
    tooltip = `${health.consecutiveFailures} probe failure(s). Last OK: ${health.lastOkAt || 'never'}. ${health.lastError || ''}`;
  } else {
    // health.ok === null — server reachable but no probe yet.
    label = 'Sage —';
    tone = 'bg-slate-500/15 text-slate-400 border-slate-500/30';
    tooltip = 'Sage health not yet probed.';
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${tone}`}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

// Dashboard-wide integrity panel. Fetches /api/bat/integrity-report on
// mount (the endpoint runs every per-recon invariant in services/bat/
// integrity.js across every reconciliation) and renders an at-a-glance
// summary plus a collapsible table of failing recons. Operator uses
// this to spot drift across the whole BAT pipeline without drilling
// into each week — when negotiating with BAT, this is the page they
// can point at.
function IntegrityOverviewPanel({ onSelectRecon }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await fetch('/api/bat/integrity-report', { credentials: 'include' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!cancelled) { setReport(data); setErr(null); }
      } catch (e) {
        if (!cancelled) setErr(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="border border-border bg-card px-5 py-3 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground" style={{ borderRadius: '12px' }}>
        Loading integrity report…
      </div>
    );
  }
  if (err) {
    return (
      <div className="border border-destructive bg-card px-5 py-3 font-mono text-xs text-destructive" style={{ borderRadius: '12px' }}>
        Integrity report failed: {err}
      </div>
    );
  }
  if (!report) return null;

  const { summary, recons } = report;
  const failing = recons.filter(r => !r.passed);
  const needsReupload = recons.filter(r => !r.marked_zero && r.overview_orders_stored === 0);
  const allPassing = summary.failing === 0;

  // Color theme follows status: green when all reconcile, red when any
  // fail. The amber "needs re-upload" call-out is a secondary signal
  // because pre-v72 recons skip Overview-dependent checks rather than
  // fail them.
  const accent = allPassing ? 'hsl(145 55% 45%)' : 'hsl(var(--destructive))';
  const accentGlow = allPassing ? 'hsla(145, 55%, 45%, 0.25)' : 'hsla(0, 72%, 50%, 0.25)';

  return (
    <div
      className="relative overflow-hidden border bg-card"
      style={{
        borderRadius: '12px',
        borderColor: allPassing ? 'hsl(var(--border))' : accent,
        boxShadow: allPassing ? 'none' : `0 0 16px ${accentGlow}`,
      }}
    >
      <div className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: accent, boxShadow: `0 0 10px ${accentGlow}` }} />
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-5 py-3 hover:bg-muted/20 transition-colors text-left"
      >
        <div className="pl-2 flex items-center gap-3 flex-wrap">
          <span className="font-mono text-[10px] uppercase tracking-[0.25em]" style={{ color: accent }}>
            {allPassing ? '● Integrity OK' : '▲ Integrity drift'}
          </span>
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {summary.passing}/{summary.total - summary.marked_zero} reconcile
            {summary.marked_zero > 0 && <span className="ml-2">· {summary.marked_zero} zero</span>}
            {summary.failing > 0 && <span className="ml-2 text-destructive">· {summary.failing} failing</span>}
            {needsReupload.length > 0 && <span className="ml-2" style={{ color: 'hsl(33 70% 60%)' }}>· {needsReupload.length} need re-upload</span>}
          </span>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground pr-1">
          {expanded ? <ChevronDown className="h-3 w-3 inline" /> : <ChevronRight className="h-3 w-3 inline" />}
          <span className="ml-1">{expanded ? 'Hide' : 'Details'}</span>
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border px-5 py-4 space-y-3">
          {failing.length === 0 && needsReupload.length === 0 && (
            <p className="font-mono text-xs text-muted-foreground">
              Every reconciliation passes every invariant. PAID + NON-COMPLIANT balances to BAT TOTAL claim; EXCEPTIONS balances to BAT exception pivot; no orphan extractions; no duplicate order_numbers.
            </p>
          )}

          {failing.length > 0 && (
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-destructive mb-2">
                {failing.length} recon{failing.length === 1 ? '' : 's'} with integrity drift
              </div>
              <ul className="space-y-1.5">
                {failing.map(r => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => onSelectRecon(r.id)}
                      className="w-full flex items-baseline justify-between gap-3 px-3 py-2 hover:bg-muted/30 transition-colors text-left"
                      style={{ borderRadius: '8px', border: '1px solid hsla(0, 72%, 50%, 0.3)', background: 'hsla(0, 72%, 50%, 0.04)' }}
                    >
                      <span className="font-mono text-xs tabular-nums text-foreground">
                        W{String(r.week_number).padStart(2, '0')}/{r.year}
                      </span>
                      <span className="font-mono text-[10px] text-destructive truncate">
                        {r.failed_check_ids.join(' · ')}
                      </span>
                      <span className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted-foreground">
                        open →
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {needsReupload.length > 0 && (
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] mb-2" style={{ color: 'hsl(33 70% 60%)' }}>
                {needsReupload.length} recon{needsReupload.length === 1 ? '' : 's'} need re-upload to enable full integrity checks
              </div>
              <p className="font-mono text-[10px] text-muted-foreground mb-2">
                Recons created before migration v72 have no stored Overview ODR list. Their Missing-PODs / Overview-sum invariants can't be verified until the supplier spreadsheet is re-uploaded.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {needsReupload.map(r => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => onSelectRecon(r.id)}
                    className="font-mono text-[10px] tabular-nums px-2 py-1 hover:bg-muted/30 transition-colors"
                    style={{ borderRadius: '6px', border: '1px solid hsla(33, 70%, 60%, 0.35)', color: 'hsl(33 70% 60%)' }}
                  >
                    W{String(r.week_number).padStart(2, '0')}/{r.year}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Reconciliation() {
  const colorScheme = useColorScheme();
  const [view, setView] = useState('dashboard'); // dashboard | detail
  const [dashTab, setDashTab] = useState('archive'); // archive | upload
  const [reconciliations, setReconciliations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [dashboardData, setDashboardData] = useState(null);
  const [extractionPolling, setExtractionPolling] = useState(null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState(null);
  const [weekStatus, setWeekStatus] = useState(null);
  const [cardosoMatch, setCardosoMatch] = useState(null);
  const [cardosoUploading, setCardosoUploading] = useState(false);
  const [cardosoError, setCardosoError] = useState(null);
  const [cardosoStats, setCardosoStats] = useState(null);
  const [pendingCardosoFile, setPendingCardosoFile] = useState(null);
  const [showDupePrompt, setShowDupePrompt] = useState(false);
  const [crossrefYear, setCrossrefYear] = useState('all');
  const [crossrefWeek, setCrossrefWeek] = useState('all');
  const [crossrefInvoice, setCrossrefInvoice] = useState('');
  // Mark-week-zero dialog. `markZeroTarget` is { week_number, year } when
  // open, null otherwise. `markZeroNote` and `markZeroBusy` are local
  // form state. Closing resets everything.
  const [markZeroTarget, setMarkZeroTarget] = useState(null);
  const [markZeroNote, setMarkZeroNote] = useState('');
  const [markZeroBusy, setMarkZeroBusy] = useState(false);
  // Unmark-zero confirmation dialog. `unmarkZeroTarget` is the recon row
  // (carrying id/recon_id, week_number, year, marked_zero_by, etc) when
  // open, null otherwise.
  const [unmarkZeroTarget, setUnmarkZeroTarget] = useState(null);
  const [unmarkZeroBusy, setUnmarkZeroBusy] = useState(false);
  // Orphan-extraction prune picker. `orphanReview` is { rows: [...] } when the
  // dialog is open, null otherwise; `orphanSelected` is the Set of ticked ids.
  const [orphanReview, setOrphanReview] = useState(null);
  const [orphanSelected, setOrphanSelected] = useState(() => new Set());
  const [orphanBusy, setOrphanBusy] = useState(false);
  // Page-level viewing year — drives which reconciliations show up in the
  // archive list, the per-week comparison, and (eventually) the dashboard
  // summary tiles. Persisted in localStorage so a page reload doesn't reset
  // back to the current calendar year mid-session.
  const [viewingYear, setViewingYear] = useState(() => {
    try {
      const saved = window.localStorage.getItem('bat.viewingYear');
      if (saved) return saved;
    } catch {} // eslint-disable-line no-empty -- localStorage read with documented fallback to ISO year
    // ISO year — disagrees with calendar year on Dec 29-31 of years
    // where Jan 1 is Mon/Tue/Wed. Without this the page would default
    // to viewing the previous year's recons in early Jan / late Dec.
    return String(isoYear(new Date()));
  });
  useEffect(() => {
    try { window.localStorage.setItem('bat.viewingYear', viewingYear); } catch (e) { console.warn('[reconciliation.persist_viewing_year]', { viewingYear }, e.message); }
  }, [viewingYear]);
  // Legacy aliases — kept so existing JSX bindings still work. Both feed off
  // the same viewingYear so the user only sees one selector.
  const weekCompYear = viewingYear;
  const setWeekCompYear = setViewingYear;
  const archiveYear = viewingYear;
  const setArchiveYear = setViewingYear;
  const [uploadOpen, setUploadOpen] = useState(false);
  const [cardosoOpen, setCardosoOpen] = useState(false);
  const [expandedWeeks, setExpandedWeeks] = useState(() => new Set());
  const [hideBalanced, setHideBalanced] = useState(true);
  // Default off — operator feedback: "very annoying to have the recons
  // hidden all the time." Show everything by default; the toggle stays
  // available for narrowing the view when the matched count gets noisy.
  const [hideMatched, setHideMatched] = useState(false);
  const [genFromDate, setGenFromDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 14); return d.toISOString().slice(0, 10);
  });
  const [genToDate, setGenToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [generating, setGenerating] = useState(false);
  const [tg1Rate, setTg1Rate] = useState('0.0009');
  const [tg2Rate, setTg2Rate] = useState('0.0001');
  // Company-wide VAT %, used by the H1/H2 weekly comparison "Missing VAT"
  // detector. Editable by an admin in Settings → Accounting; default 15.
  const [vatPercent, setVatPercent] = useState(15);
  const [ocrPaused, setOcrPausedState] = useState(false);
  // Reflect the global OCR pause switch in the Extract button. Re-checked
  // whenever a reconciliation is opened so toggling pause in Settings is
  // picked up without a hard reload.
  useEffect(() => {
    if (view !== 'detail') return;
    // GET /api/bat/ocr-status reads the pause flag (the matching /ocr-pause
    // endpoint is POST-only).
    fetch('/api/bat/ocr-status', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setOcrPausedState(!!d.paused); })
      .catch(() => {});
  }, [view, selected?.id]);
  // Load saved TG rates from bat_settings on mount so the inputs show the
  // last-used per-site values instead of the macro defaults.
  useEffect(() => {
    fetch('/api/bat/settings', { credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(s => {
        if (s?.tg1_rate) setTg1Rate(String(s.tg1_rate));
        if (s?.tg2_rate) setTg2Rate(String(s.tg2_rate));
        if (s?.vat_percent !== undefined && s?.vat_percent !== null && s?.vat_percent !== '') {
          const v = Number(s.vat_percent);
          if (Number.isFinite(v)) setVatPercent(v);
        }
      })
      // Fail loudly: these rates feed Cardoso invoice generation. If the saved
      // values can't load, the inputs silently keep their defaults — the operator
      // must know so they verify before generating (no-silent-failures).
      .catch((err) => {
        toast.error(`Could not load saved BAT TG/VAT rates — the inputs show defaults. Verify them before generating invoices. (${err.message})`);
      });
  }, []);
  const cardosoFileRef = useRef();
  // Active EventSource + polling timer for the in-flight extraction stream.
  // We keep these on a ref so they survive across re-renders and so the
  // *next* handleStartExtraction call can force-close any still-open
  // stream from a previous run before opening a new one. Without this,
  // every Extract click during a stuck run leaked an EventSource — and
  // after Chrome's 6-per-origin connection limit was reached, every HTTP
  // request from the tab blocked, requiring a full browser restart to
  // recover.
  const extractionStreamRef = useRef({ es: null, timer: null, stopped: false });
  const closeExtractionStream = useCallback(() => {
    const s = extractionStreamRef.current;
    s.stopped = true;
    if (s.es) { try { s.es.close(); } catch (e) { console.warn('[reconciliation.extraction_stream.close]', e.message); } s.es = null; }
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  }, []);
  // Belt-and-suspenders cleanup: if this page unmounts or the user
  // navigates away, kill any open EventSource so it can't leak even
  // if extraction is still running on the backend.
  useEffect(() => closeExtractionStream, [closeExtractionStream]);

  const loadDashboard = useCallback(async () => {
    // Per-fetch handling — a single failed endpoint must not blank the entire
    // dashboard. Each fetch reports its own error via toast + reportClientError.
    const safeFetch = async (label, url, onSuccess) => {
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status}`);
          toast.error(humanizeApiError(err, `load ${label}`));
          reportClientError(`reconciliation.loadDashboard.${label}`, err, { url, status: res.status });
          return;
        }
        const data = await res.json();
        onSuccess(data);
      } catch (err) {
        toast.error(humanizeApiError(err, `load ${label}`));
        reportClientError(`reconciliation.loadDashboard.${label}`, err, { url });
      }
    };

    // cardoso-match is heavy (cross-table fuzzy match across every extraction)
    // and only consumed by the cross-reference tab, so it's fetched lazily on
    // demand rather than blocking the initial dashboard render.
    const yearParam = viewingYear && viewingYear !== 'all' ? `?year=${encodeURIComponent(viewingYear)}` : '';
    await Promise.all([
      safeFetch('dashboard', `/api/bat/dashboard${yearParam}`, (data) => setDashboardData(data)),
      safeFetch('reconciliations', '/api/bat/reconciliations', (data) => setReconciliations(data.reconciliations || [])),
      safeFetch('week-status', '/api/bat/week-status', (data) => setWeekStatus(data)),
    ]);
  }, [viewingYear]);

  // Lazy-load the heavy cross-reference match only when the user opens that tab.
  useEffect(() => {
    if (dashTab !== 'crossref' || cardosoMatch !== null) return;
    let cancelled = false;
    fetch('/api/bat/cardoso-match', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (cancelled || !data) return;
        if (data.cardosoCount > 0) setCardosoMatch(data.matching);
      })
      .catch(err => {
        toast.error(humanizeApiError(err, "load cross-reference"));
        reportClientError('reconciliation.lazyLoadCardosoMatch', err);
      });
    return () => { cancelled = true; };
  }, [dashTab, cardosoMatch]);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  // Auto-refresh detail view while extractions are pending
  const selectedIdRef = useRef(null);
  useEffect(() => { selectedIdRef.current = selected?.id; }, [selected?.id]);

  // Cross-recon stale-state cleanup. When the operator navigates from one
  // recon to another, force-close any leftover extraction stream and reset
  // `extracting` to false. Without this, if the previous recon's run
  // wedged before its handleProgress saw `running: false` (e.g. SSE stream
  // silently dropped, or the final emit was missed), the `extracting`
  // gate stayed stuck true at the page level — clicking Extract on the
  // new recon was silently swallowed by `if (extracting) return;` and the
  // operator had to close+reopen the browser tab to recover.
  useEffect(() => {
    closeExtractionStream();
    setExtracting(false);
    setExtractionPolling(null);
  }, [selected?.id, closeExtractionStream]);

  // De-dupe toasted errors per reconciliation so polling doesn't spam
  const shownErrorsRef = useRef(new Set());
  useEffect(() => {
    shownErrorsRef.current = new Set();
  }, [selected?.id]);

  // Toast any new backend errors surfaced on the reconciliation
  useEffect(() => {
    if (!selected) return;
    const seen = shownErrorsRef.current;
    const fire = (key, message, opts = {}) => {
      if (!message || seen.has(key)) return;
      seen.add(key);
      toast.error(message, { duration: 5000, ...opts });
    };
    // Recon-level errors get a Dismiss button — clears last_error on the
    // server so the toast doesn't reappear on next page load. The original
    // error stays in System Log forever; this just acknowledges it.
    fire(
      `recon:${selected.last_error}`,
      selected.last_error && `OCR: ${selected.last_error}`,
      {
        action: {
          label: 'Dismiss',
          onClick: async () => {
            try {
              await fetch(`/api/bat/reconciliation/${selected.id}/dismiss-error`, {
                method: 'POST', credentials: 'include',
              });
              loadReconciliation(selected.id);
            } catch { /* no-op — toast disappears anyway */ }
          },
        },
      },
    );
    fire(`sage:${selected.sage_error}`, selected.sage_error && `Sage: ${selected.sage_error}`);
    for (const ext of selected.extractions || []) {
      if (ext.extraction_error) {
        fire(`ext:${ext.id}:${ext.extraction_error}`, `OCR id ${ext.id}: ${ext.extraction_error}`);
      }
    }
  }, [selected]);

  useEffect(() => {
    if (view !== 'detail') return;
    // Adaptive polling: start at 5s, bump to 15s after 12 stable polls
    // (1 minute of "no change"), hard-cap at 30 minutes total.
    let pollInterval = 5000;
    let stablePolls = 0;          // consecutive polls where stillPending hasn't flipped
    let lastStillPending = null;
    const startedAt = Date.now();
    const HARD_CAP_MS = 30 * 60 * 1000;
    let timer = null;
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      if (Date.now() - startedAt > HARD_CAP_MS) {
        stopped = true;
        return;
      }
      const id = selectedIdRef.current;
      if (!id) {
        timer = setTimeout(tick, pollInterval);
        return;
      }
      try {
        const r = await fetch(`/api/bat/reconciliation/${id}`, { credentials: 'include' });
        // Stale guard: the user may have clicked a different recon while
        // the poll's fetch was in flight. Writing the old recon's data into
        // setSelected here would flicker the UI back to the wrong recon.
        if (selectedIdRef.current !== id) {
          timer = setTimeout(tick, pollInterval);
          return;
        }
        if (r.ok) {
          const data = await r.json();
          const stillPending = data.extractions?.some(e => e.extraction_status === 'pending');
          setSelected(data);
          if (!stillPending) {
            stopped = true;
            return;
          }
          if (lastStillPending === stillPending) {
            stablePolls += 1;
          } else {
            stablePolls = 0;
            pollInterval = 5000;
          }
          lastStillPending = stillPending;
          if (stablePolls >= 12 && pollInterval < 15000) {
            pollInterval = 15000;
          }
        }
      } catch (e) { console.warn('[reconciliation.poll_pending_tick]', e.message); }
      if (!stopped) timer = setTimeout(tick, pollInterval);
    };

    timer = setTimeout(tick, pollInterval);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [view]);

  // Holds the AbortController for the in-flight loadReconciliation fetches.
  // Replaced on every new call so a rapid second click cancels the first
  // pair of requests immediately. Without this, six rapid clicks pinned all
  // six of Chrome's per-origin connection slots on dead-on-arrival GETs
  // (the data was about to be replaced) and every subsequent request — JPEG
  // previews, polls, navigations — stalled until something completed,
  // which felt like the entire UI was hung.
  const loadReconRef = useRef({ ctrl: null, latestId: null });
  const loadReconciliation = async (id) => {
    const slot = loadReconRef.current;
    if (slot.ctrl) { try { slot.ctrl.abort(); } catch (e) { console.warn('[reconciliation.load_recon.abort_prev]', e.message); } }
    const ctrl = new AbortController();
    slot.ctrl = ctrl;
    slot.latestId = id;
    setView('detail');

    // Fire both fetches in parallel, but DO NOT block the page render on
    // cardoso-match. That endpoint runs a heavy fuzzy match across every
    // extraction in the recon (116+ rows × the Cardoso invoice table) and
    // can hang or take many seconds on a busy site. The previous
    // Promise.allSettled([recon, match]) waited for BOTH to settle, so a
    // hung cardoso-match left setSelected unfired and the page blank with
    // no error in console — the recon body had returned 200 and parsed
    // fine, but the React function was still awaiting allSettled.
    //
    // Now: recon body is the only thing the page render needs. Block on
    // it, set state as soon as it lands. cardoso-match fires concurrently
    // but its result populates the cross-reference panel whenever it
    // returns (or never, if it errors / hangs — page is usable either way).

    // Cardoso match — fire-and-forget. Errors are logged but don't block
    // the page. The stale-id guard inside ensures a slow response from a
    // previous click can't overwrite state for the current selection.
    (async () => {
      try {
        const mr = await fetch(`/api/bat/cardoso-match/${id}`, { credentials: 'include', signal: ctrl.signal });
        if (slot.latestId !== id || ctrl.signal.aborted) return;
        if (mr.ok) {
          const md = await mr.json();
          if (slot.latestId !== id) return;
          setCardosoMatch(md.cardosoCount > 0 ? md.matching : null);
        }
      } catch (err) {
        if (err?.name !== 'AbortError') {
          console.warn('[loadReconciliation] cardoso-match failed (non-blocking):', err?.message || err);
        }
      }
    })();

    // Recon body — required for the page to render. Block on this only.
    try {
      const r = await fetch(`/api/bat/reconciliation/${id}`, { credentials: 'include', signal: ctrl.signal });
      // Stale-response guard: a slower earlier click resolving after a
      // faster later one would otherwise overwrite `selected` with the
      // wrong recon.
      if (slot.latestId !== id || ctrl.signal.aborted) return;
      if (r.ok) {
        const data = await r.json();
        if (slot.latestId !== id) return;
        setSelected(data);
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.error('[loadReconciliation] recon fetch failed:', err?.message || err);
      }
    }
  };

  const doCardosoUpload = async (file, mode = 'skip') => {
    setCardosoUploading(true);
    setCardosoError(null);
    setCardosoStats(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('duplicateMode', mode);
      const r = await fetch('/api/bat/cardoso-upload', {
        method: 'POST', credentials: 'include', body: form,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Upload failed');
      setCardosoMatch(data.matching);
      setCardosoStats({ inserted: data.inserted, updated: data.updated, skipped: data.skipped, duplicatesFound: data.duplicatesFound });
      setPendingCardosoFile(null);
      setShowDupePrompt(false);
    } catch (err) {
      setCardosoError(err.message);
    } finally {
      setCardosoUploading(false);
    }
  };

  const handleCardosoUpload = async (file) => {
    if (!file) return;
    // First upload with skip mode to see if there are duplicates
    setPendingCardosoFile(file);
    setCardosoUploading(true);
    setCardosoError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('duplicateMode', 'skip');
      const r = await fetch('/api/bat/cardoso-upload', {
        method: 'POST', credentials: 'include', body: form,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Upload failed');
      setCardosoMatch(data.matching);
      setCardosoStats({ inserted: data.inserted, updated: data.updated, skipped: data.skipped, duplicatesFound: data.duplicatesFound });
      if (data.duplicatesFound > 0) {
        setShowDupePrompt(true);
      } else {
        setPendingCardosoFile(null);
      }
    } catch (err) {
      setCardosoError(err.message);
      setPendingCardosoFile(null);
    } finally {
      setCardosoUploading(false);
    }
  };

  const [backfillMsg, setBackfillMsg] = useState(null);

  const handleUploadComplete = (recon, backfilled) => {
    setSelected(recon);
    setView('detail');
    loadDashboard();
    if (backfilled > 0) {
      setBackfillMsg(`Backfilled ${backfilled} amount${backfilled !== 1 ? 's' : ''} from previous weeks`);
      setTimeout(() => setBackfillMsg(null), 8000);
    }
  };

  // Mark-zero handlers. Both reuse loadDashboard() so the missing-weeks
  // count + week-comparison list refresh in one beat.
  const submitMarkZero = async () => {
    if (!markZeroTarget || markZeroBusy) return;
    setMarkZeroBusy(true);
    try {
      const r = await fetch('/api/bat/reconciliations/mark-zero', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          year: markZeroTarget.year,
          week_number: markZeroTarget.week_number,
          note: markZeroNote.trim() || null,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      toast.success(`Week ${markZeroTarget.week_number}/${markZeroTarget.year} marked as zero`);
      setMarkZeroTarget(null); setMarkZeroNote('');
      loadDashboard();
    } catch (err) {
      toast.error(humanizeApiError(err, 'mark week as zero'));
    } finally {
      setMarkZeroBusy(false);
    }
  };

  // Open the styled in-app confirm dialog. The actual API call lives in
  // submitUnmarkZero (called from the dialog's confirm button). We keep
  // these split so the dialog can manage its own busy state and the row
  // is closure-captured at open-time, not called-time.
  const handleUnmarkZero = (row) => {
    if (!row) return;
    if (!(row.recon_id ?? row.id)) return;
    setUnmarkZeroTarget(row);
  };

  const submitUnmarkZero = async () => {
    if (!unmarkZeroTarget || unmarkZeroBusy) return;
    const row = unmarkZeroTarget;
    const id = row.recon_id ?? row.id;
    setUnmarkZeroBusy(true);
    try {
      const r = await fetch(`/api/bat/reconciliations/${id}/unmark-zero`, {
        method: 'POST', credentials: 'include',
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      toast.success(`Week ${row.week_number}/${row.year} unmarked`);
      setUnmarkZeroTarget(null);
      loadDashboard();
    } catch (err) {
      toast.error(humanizeApiError(err, 'unmark zero week'));
    } finally {
      setUnmarkZeroBusy(false);
    }
  };

  const handleRefreshSage = async () => {
    if (!selected) return;
    try {
      const r = await fetch(`/api/bat/reconciliation/${selected.id}/refresh-sage`, {
        method: 'POST', credentials: 'include',
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setSelected(data.reconciliation);
    } catch (e) {
      toast.error(`Failed to refresh from Sage: ${e.message}`);
    }
  };

  // Open the orphan-extraction prune picker: fetch the orphan rows (order_number
  // not in BAT's Overview pivot) so the admin can tick exactly which to delete.
  // We DON'T auto-classify — a retained row from another branch's upload can be in
  // any OCR status, so the operator decides. Admin-only on the server (403 toast).
  const handlePruneOrphans = async () => {
    if (!selected) return;
    try {
      const r = await fetch(`/api/bat/reconciliation/${selected.id}/orphan-extractions`, { credentials: 'include' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      if (!d.orphans || d.orphans.length === 0) {
        toast.message('No orphan extraction rows to review.');
        return;
      }
      setOrphanSelected(new Set());
      setOrphanReview({ rows: d.orphans });
    } catch (e) {
      toast.error(`Could not load orphan rows: ${e.message}`);
    }
  };

  const toggleOrphan = (rowId) => {
    setOrphanSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId); else next.add(rowId);
      return next;
    });
  };

  const closeOrphanReview = () => { setOrphanReview(null); setOrphanSelected(new Set()); };

  const confirmPruneOrphans = async () => {
    if (!selected || orphanSelected.size === 0 || orphanBusy) return;
    setOrphanBusy(true);
    try {
      const r = await fetch(`/api/bat/reconciliation/${selected.id}/prune-orphan-extractions`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(orphanSelected) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      toast.success(`Deleted ${d.pruned} orphan extraction row${d.pruned === 1 ? '' : 's'}.`
        + (d.refused?.length ? ` (${d.refused.length} no longer orphaned, skipped.)` : ''));
      closeOrphanReview();
      loadReconciliation(selected.id);
    } catch (e) {
      toast.error(`Failed to delete orphan rows: ${e.message}`);
    } finally {
      setOrphanBusy(false);
    }
  };

  const handleStartExtraction = async () => {
    if (!selected || extracting) return;
    setExtracting(true);
    setExtractError(null);
    try {
      const r = await fetch('/api/bat/extract-invoices', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reconciliationId: selected.id }),
      });
      const data = await r.json();
      if (!r.ok) {
        setExtractError(data.error || 'Extraction failed');
        setExtracting(false);
        return;
      }
      if (data.processed === 0 && data.message === 'No pending extractions') {
        setExtractError('No pending invoices to extract. Upload a spreadsheet with POD URLs first.');
        setExtracting(false);
        return;
      }
      // Prefer Server-Sent Events (push) — instant updates, no polling.
      // Fall back to adaptive polling if EventSource is unsupported or errors.
      const startedAt = Date.now();
      const HARD_CAP_MS = 2 * 60 * 60 * 1000;

      // Force-close any leftover stream from a previous Extract click before
      // opening a new one. Without this, repeatedly clicking Extract during
      // a stuck run leaks an EventSource per click; after ~6 leaks Chrome's
      // per-origin connection limit blocks every fetch from the tab and
      // only a full browser restart recovers.
      closeExtractionStream();
      extractionStreamRef.current.stopped = false;

      const stop = () => closeExtractionStream();

      const handleProgress = (progress) => {
        setExtractionPolling(progress);
        if (!progress.running) {
          stop();
          setExtractionPolling(null);
          setExtracting(false);
          loadReconciliation(selected.id);
          loadDashboard();
        }
      };

      // ── SSE first ──
      try {
        const es = new EventSource(`/api/bat/extraction-status-stream/${selected.id}`, { withCredentials: true });
        extractionStreamRef.current.es = es;
        es.onmessage = (ev) => {
          try { handleProgress(JSON.parse(ev.data)); } catch (e) { console.warn('[reconciliation.sse.parse_progress]', e.message); }
        };
        es.onerror = () => {
          // Connection dropped — close SSE and fall back to polling
          try { es.close(); } catch (e) { console.warn('[reconciliation.sse.close_on_error]', e.message); }
          if (extractionStreamRef.current.es === es) extractionStreamRef.current.es = null;
          if (!extractionStreamRef.current.stopped) startPolling();
        };
      } catch {
        startPolling();
      }

      // ── Polling fallback ──
      function startPolling() {
        let pollDelay = 2000;
        let lastProcessed = null;
        let stableCount = 0;
        const tick = async () => {
          if (extractionStreamRef.current.stopped) return;
          if (Date.now() - startedAt > HARD_CAP_MS) {
            stop(); setExtracting(false); setExtractionPolling(null); return;
          }
          try {
            const pr = await fetch(`/api/bat/extraction-status/${selected.id}`, { credentials: 'include' });
            if (pr.ok) {
              const progress = await pr.json();
              handleProgress(progress);
              if (extractionStreamRef.current.stopped) return;
              const proc = progress.processed ?? 0;
              if (lastProcessed !== null && proc === lastProcessed) {
                stableCount += 1;
                if (stableCount >= 3) { pollDelay = Math.min(pollDelay * 2, 30000); stableCount = 0; }
              } else { stableCount = 0; pollDelay = 2000; }
              lastProcessed = proc;
            }
          } catch {
            stop(); setExtracting(false); setExtractionPolling(null); return;
          }
          if (!extractionStreamRef.current.stopped) {
            extractionStreamRef.current.timer = setTimeout(tick, pollDelay);
          }
        };
        extractionStreamRef.current.timer = setTimeout(tick, pollDelay);
      }
    } catch (err) {
      setExtractError('Network error: ' + err.message);
      setExtracting(false);
    }
  };

  // Derived rows for the BAT-vs-Sage weekly comparison. Previously this
  // ran inside an IIFE in the JSX, recomputing on every render of the
  // dashboard regardless of whether any of its inputs had changed.
  const weekComparisonDerived = useMemo(() => {
    const rows = weekStatus?.weekComparison;
    if (!rows?.length) return null;
    const isBalanced = (r) => {
      const worst = Math.max(
        Math.abs((r.supplier_delivery || 0) - (r.sage_delivery || 0)),
        Math.abs((r.supplier_discount || 0) - (r.sage_discount || 0)),
        Math.abs((r.supplier_pricing  || 0) - (r.sage_pricing  || 0)),
      );
      return worst < 0.01;
    };
    const allYears = Array.from(new Set(rows.map(r => r.year))).sort((a, b) => b - a);
    const yearScoped = weekCompYear === 'all'
      ? rows
      : rows.filter(r => String(r.year) === String(weekCompYear));
    const balancedCount = yearScoped.filter(isBalanced).length;
    const filteredRows = hideBalanced ? yearScoped.filter((r) => !isBalanced(r)) : yearScoped;
    return { allYears, yearScoped, balancedCount, filteredRows, isBalanced };
  }, [weekStatus?.weekComparison, weekCompYear, hideBalanced]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1600px] mx-auto px-8 py-10 space-y-10">
        {/* Page header — pinned in both views so the year picker / upload
            actions (dashboard) and the back button + week title (detail)
            stay visible while the operator scrolls the long tables below. */}
        <div className="flex items-end justify-between gap-6 border-b border-border pb-5 sticky top-0 z-30 bg-background pt-5 -mt-5 shadow-[0_8px_16px_-12px_hsla(0,0%,0%,0.6)]">
          <div>
            <div className="font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground mb-3 flex items-center gap-3">
              {view === 'detail' && (
                <button
                  onClick={() => { setView('dashboard'); setSelected(null); loadDashboard(); }}
                  className="inline-flex items-center gap-1.5 hover:text-accent transition-colors"
                >
                  <ChevronLeft className="h-3.5 w-3.5" /> All Weeks
                </button>
              )}
              {view === 'detail' && <span className="text-border">·</span>}
              <SageStatusPill />
            </div>
            <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
              {view === 'detail' && selected ? (
                <>
                  <em className="text-muted-foreground">Week</em>{' '}
                  <span className="tabular-nums">{selected.week_number}</span>
                  <span className="text-muted-foreground mx-3">/</span>
                  <span className="tabular-nums text-phosphor">{selected.year}</span>
                </>
              ) : (
                <>The <em className="text-phosphor">BAT</em> ledger.</>
              )}
            </h1>
          </div>
          {view === 'dashboard' && (
            <div className="flex items-center gap-2 flex-wrap">
              {(() => {
                const currentYear = isoYear(new Date());
                const knownYears = Array.from(new Set(reconciliations.map(r => r.year).filter(Boolean)));
                // Always offer current year + an "all" option so a fresh install
                // can still flip the selector even before the first upload.
                const years = Array.from(new Set([...knownYears, currentYear])).sort((a, b) => b - a);
                return (
                  <div
                    className="flex items-center gap-2.5 px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.22em] font-medium mr-4"
                    style={{
                      color: 'var(--phosphor)',
                      background: 'hsla(33, 95%, 55%, 0.08)',
                      border: '1px solid hsla(33, 95%, 55%, 0.5)',
                      borderRadius: '12px',
                      boxShadow: '0 0 0 1px transparent, 0 0 12px hsla(33,95%,55%,0.18)',
                    }}
                    title="Filter the BAT dashboard, archive and week comparison to one calendar year. Saved between sessions."
                  >
                    <CalendarIcon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                    <span className="leading-none">Year</span>
                    <select
                      value={viewingYear}
                      onChange={(e) => setViewingYear(e.target.value)}
                      className="font-mono text-[11px] uppercase tracking-[0.22em] focus:outline-none cursor-pointer leading-none"
                      style={{
                        colorScheme,
                        color: 'var(--phosphor)',
                        background: 'transparent',
                        border: 0,
                        margin: 0,
                        padding: 0,
                        appearance: 'none',
                        WebkitAppearance: 'none',
                        MozAppearance: 'none',
                        backgroundImage: 'none',
                      }}
                    >
                      <option value="all">All</option>
                      {years.map(y => <option key={y} value={String(y)}>{y}</option>)}
                    </select>
                    <ChevronDown className="h-3 w-3 shrink-0 opacity-70 -ml-1" strokeWidth={2} />
                  </div>
                );
              })()}
              <PhosphorButton
                onClick={() => setUploadOpen(true)}
                icon={Upload}
                label="Upload BAT Week"
                tip="Upload a BAT supplier spreadsheet (.xlsx) for a given week. The app extracts fee totals, queues OCR on the POD invoices, and creates a new reconciliation."
              />
              <PhosphorButton
                onClick={() => setCardosoOpen(true)}
                icon={FileText}
                label="Download Cardoso Invoices"
                tip="Generate a fresh set of Cardoso invoices from Sage 300 for the chosen date range, used to match against BAT POD extractions."
              />
            </div>
          )}
        </div>

        {view === 'dashboard' && (
          <>
            {/* Top summary — totals across all reconciliations */}
            {dashboardData && (
              <section>
                <DashboardOverview data={dashboardData} />
              </section>
            )}

            {/* Integrity overview — runs all invariants across every
                recon. Failing recons surface here so the operator can
                see the dashboard-wide picture before drilling into a
                week. Per-recon banner inside the detail view shows the
                specifics. */}
            <IntegrityOverviewPanel onSelectRecon={(id) => loadReconciliation(id)} />


            {/* Week status block */}
            {weekStatus && (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 stagger-in">
                <div className="relative bg-card border border-border p-5 overflow-hidden" style={{ borderRadius: '14px', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }}>
                  <div
                    className="absolute left-0 right-0 bottom-0 h-[2px]"
                    style={{ background: 'var(--phosphor)', boxShadow: '0 0 12px hsla(33,95%,55%,0.35)' }}
                  />
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-2">
                      Current Week
                    </div>
                    <div className="font-display text-5xl leading-none text-foreground tabular-nums">
                      {weekStatus.currentWeek}
                    </div>
                  </div>
                </div>
                {/* Latest uploaded reconciliation — how current the supplier
                    file is. Excludes synthetic marked-zero entries; this
                    is "the most recent week we actually have a file for". */}
                <div className="relative bg-card border border-border p-5 overflow-hidden" style={{ borderRadius: '14px', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }}>
                  <div
                    className="absolute left-0 right-0 bottom-0 h-[2px]"
                    style={{
                      background: weekStatus.latestReconWeek != null ? 'hsl(210 80% 55%)' : 'hsl(var(--muted-foreground))',
                      boxShadow: weekStatus.latestReconWeek != null ? '0 0 12px hsla(210,80%,55%,0.3)' : 'none',
                    }}
                  />
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-2">
                      Latest Recon Uploaded
                    </div>
                    <div className="font-display text-5xl leading-none tabular-nums" style={{ color: weekStatus.latestReconWeek != null ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))' }}>
                      {weekStatus.latestReconWeek != null
                        ? `W${weekStatus.latestReconWeek}/${weekStatus.latestReconYear}`
                        : '—'}
                    </div>
                  </div>
                </div>
                <div className="relative bg-card border border-border p-5 overflow-hidden" style={{ borderRadius: '14px', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }}>
                  <div
                    className="absolute left-0 right-0 bottom-0 h-[2px]"
                    style={{
                      background: weekStatus.lastWeekPaid ? 'hsl(145 55% 45%)' : 'hsl(var(--muted-foreground))',
                      boxShadow: weekStatus.lastWeekPaid ? '0 0 12px hsla(145,55%,45%,0.3)' : 'none',
                    }}
                  />
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-2">
                      Last Week Paid (Sage)
                    </div>
                    <div className="font-display text-5xl leading-none tabular-nums" style={{ color: weekStatus.lastWeekPaid ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))' }}>
                      {weekStatus.sageError ? '—' : weekStatus.lastWeekPaid != null
                        ? `W${weekStatus.lastWeekPaid}/${weekStatus.lastWeekPaidYear}`
                        : '—'}
                    </div>
                    {weekStatus.sageError && (
                      <div className="font-mono text-[10px] text-muted-foreground mt-2">Sage not connected</div>
                    )}
                  </div>
                </div>
                <div className="relative bg-card border border-border p-5 overflow-hidden" style={{ borderRadius: '14px', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }}>
                  <div
                    className="absolute left-0 right-0 bottom-0 h-[2px]"
                    style={{
                      background: weekStatus.missingWeeks?.length > 0 ? 'hsl(var(--destructive))' : 'hsl(145 55% 45%)',
                      boxShadow: weekStatus.missingWeeks?.length > 0 ? '0 0 12px hsla(0,72%,50%,0.3)' : '0 0 12px hsla(145,55%,45%,0.3)',
                    }}
                  />
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-2">
                      Missing Credit Notes
                    </div>
                    {weekStatus.sageError ? (
                      <div className="font-display text-2xl leading-none text-muted-foreground">—</div>
                    ) : weekStatus.missingWeeks?.length > 0 ? (
                      <>
                        <div className="flex items-center gap-2 mb-2">
                          <AlertTriangle className="h-4 w-4 text-destructive" strokeWidth={1.5} />
                          <span className="font-display text-2xl leading-none text-destructive tabular-nums">
                            {weekStatus.missingWeeks.length} week{weekStatus.missingWeeks.length !== 1 ? 's' : ''}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {weekStatus.missingWeeks.map(w => (
                            <button
                              key={w}
                              type="button"
                              onClick={() => { setMarkZeroTarget({ week_number: w, year: isoYear(new Date()) }); setMarkZeroNote(''); }}
                              title={`Mark W${String(w).padStart(2, '0')} as a zero week`}
                              className="font-mono text-[10px] tabular-nums px-2 py-0.5 rounded border border-destructive/40 text-destructive hover:bg-destructive/10 transition-colors cursor-pointer"
                            >
                              W{String(w).padStart(2, '0')}
                            </button>
                          ))}
                        </div>
                      </>
                    ) : (
                      <div className="font-display text-2xl leading-none" style={{ color: 'hsl(145 55% 45%)' }}>
                        All paid
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Per-year/week Supplier vs Sage comparison — 3 fee rows per week.
                Show even when Sage errors so supplier values stay visible. */}
            {weekComparisonDerived && (() => {
              const { allYears, balancedCount, filteredRows, isBalanced } = weekComparisonDerived;
              const fmt = (v) => Math.abs(v || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              const ragColor = (sup, sage) => {
                const signed = (sup || 0) - (sage || 0);
                const d = Math.abs(signed);
                if (d < 0.01) return 'hsl(145 55% 45%)';
                // Credit notes exceeding BAT is not a shortfall — show green.
                if (signed < 0) return 'hsl(145 55% 45%)';
                if (d < 100) return 'var(--phosphor)';
                return 'hsl(var(--destructive))';
              };
              const cells = [
                { key: 'delivery', label: 'Delivery Fee', sup: 'supplier_delivery', sage: 'sage_delivery' },
                { key: 'discount', label: 'Discount',     sup: 'supplier_discount', sage: 'sage_discount' },
                { key: 'pricing',  label: 'Price Adj',    sup: 'supplier_pricing',  sage: 'sage_pricing'  },
              ];
              return (
                <div
                  className="border border-border bg-card overflow-hidden"
                  style={{ borderRadius: '12px' }}
                >
                  <div className="flex items-center justify-between p-5 border-b border-border gap-4 flex-wrap">
                    <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                      BAT vs Sage by week
                      {weekStatus.cacheRefreshedAt && (
                        <span className="ml-3 normal-case tracking-normal text-muted-subtle">
                          · Sage cache refreshed {new Date(weekStatus.cacheRefreshedAt).toLocaleString('en-ZA', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}
                        </span>
                      )}
                      {weekStatus.sageError && (
                        <span className="ml-3 normal-case tracking-normal text-destructive">
                          · Sage refresh failed ({weekStatus.sageError.slice(0, 60)})
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={async () => {
                          try {
                            const r = await fetch('/api/bat/refresh-sage-cache', { method: 'POST', credentials: 'include' });
                            const d = await r.json();
                            if (d.ok) {
                              toast.success(`Sage cache refreshed · ${d.total} weeks (added ${d.added}, changed ${d.changed}, removed ${d.removed})`);
                              loadDashboard();
                            } else {
                              toast.error(`Couldn't refresh Sage cache — ${d.error || d.status || 'unknown reason'}`);
                            }
                          } catch (e) { toast.error(humanizeApiError(e, "refresh Sage cache")); }
                        }}
                        className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent hover:text-foreground transition-colors border border-border bg-card px-3 py-1.5"
                        style={{ borderRadius: '12px' }}
                      >
                        Refresh Sage cache
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between p-5 border-b border-border gap-4 flex-wrap">
                    <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
                      Filters
                    </div>
                    <div className="flex items-center gap-3 flex-wrap">
                      {/* Year selector lives in the page header now — controls
                          this section via viewingYear (see weekCompYear alias). */}
                      <button
                        type="button"
                        onClick={() => setHideBalanced((v) => !v)}
                        className="group flex items-center gap-2 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors"
                        style={{
                          color: hideBalanced ? 'hsl(145 55% 45%)' : 'hsl(var(--muted-foreground))',
                          background: hideBalanced ? 'hsla(145, 55%, 45%, 0.08)' : 'transparent',
                          border: hideBalanced ? '1px solid hsla(145, 55%, 45%, 0.5)' : '1px solid hsl(var(--border))',
                          borderRadius: '12px',
                        }}
                      >
                        <span
                          className="inline-block w-3 h-3 flex-shrink-0 flex items-center justify-center"
                          style={{
                            border: hideBalanced ? '1px solid hsl(145 55% 45%)' : '1px solid hsl(var(--border))',
                            background: hideBalanced ? 'hsl(145 55% 45%)' : 'transparent',
                            borderRadius: '12px',
                          }}
                        >
                          {hideBalanced && (
                            <svg className="w-2.5 h-2.5" viewBox="0 0 12 12" fill="none">
                              <path d="M2 6 L5 9 L10 3" stroke="hsl(var(--background))" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </span>
                        <span>Hide balanced</span>
                        {hideBalanced && balancedCount > 0 && (
                          <span className="tabular-nums opacity-80">· {balancedCount}</span>
                        )}
                      </button>
                      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground tabular-nums">
                        {filteredRows.length} of {weekStatus.weekComparison.length} week{weekStatus.weekComparison.length !== 1 ? 's' : ''}
                      </div>
                    </div>
                  </div>
                  {(() => {
                    // Split into H1 (weeks 1-26) and H2 (weeks 27-53) so we can render
                    // two side-by-side mini-tables. Same data, easier to scan.
                    const h1Rows = filteredRows.filter(r => r.week_number <= 26);
                    const h2Rows = filteredRows.filter(r => r.week_number >= 27);

                    const renderRowGroup = (row) => {
                          const key = `${row.year}/${row.week_number}`;
                          const isOpen = expandedWeeks.has(key);
                          // Per-fee diffs + aggregates
                          const feeDiffs = cells.map((c) => (row[c.sup] || 0) - (row[c.sage] || 0));
                          const supTotal = cells.reduce((s, c) => s + (row[c.sup] || 0), 0);
                          const sageTotal = cells.reduce((s, c) => s + (row[c.sage] || 0), 0);
                          const totalDiff = supTotal - sageTotal;
                          const worst = Math.max(...feeDiffs.map(Math.abs));
                          // Credit notes covering or exceeding BAT is not a shortfall.
                          const creditCoversBat = totalDiff <= 0.01;
                          const headerColor = worst < 0.01 || creditCoversBat
                            ? 'hsl(145 55% 45%)'
                            : worst < 100
                              ? 'var(--phosphor)'
                              : 'hsl(var(--destructive))';
                          const headerGlyph = worst < 0.01 || creditCoversBat ? '●' : worst < 100 ? '◐' : '▲';
                          // VAT-shaped variance detector. BAT is excl. VAT;
                          // if the absolute weekly variance equals VAT % of
                          // BAT (within R0.50 to absorb rounding), the most
                          // likely cause is one side having included VAT
                          // and the other not. Surfaced as "Missing VAT"
                          // under the All Fees cell so an operator can see
                          // why a week looks "out by exactly the VAT".
                          const vatExpected = supTotal * (Number(vatPercent) / 100);
                          const missingVat = supTotal > 0 &&
                            vatExpected > 0.01 &&
                            Math.abs(Math.abs(totalDiff) - vatExpected) < 0.5;
                          const toggle = () => setExpandedWeeks((prev) => {
                            const next = new Set(prev);
                            if (next.has(key)) next.delete(key); else next.add(key);
                            return next;
                          });
                          return (
                            <React.Fragment key={key}>
                              {/* Collapsible header row — week summary */}
                              <tr
                                onClick={toggle}
                                className="border-t hover:bg-muted/30 transition-colors cursor-pointer"
                                style={{ borderColor: 'hsl(var(--border))', background: isOpen ? 'hsl(24 8% 11%)' : 'transparent' }}
                              >
                                <td className="px-3 py-2 text-center text-muted-foreground">
                                  {isOpen ? <ChevronDown className="h-3 w-3 inline" /> : <ChevronRight className="h-3 w-3 inline" />}
                                </td>
                                <td className="px-3 py-2 font-mono tabular-nums text-foreground">
                                  <div className="flex items-center gap-2">
                                    <span>W{String(row.week_number).padStart(2, '0')}/{row.year}</span>
                                    {row.marked_zero && (
                                      <span
                                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] uppercase tracking-[0.15em] cursor-default"
                                        style={{ color: 'hsl(145 55% 45%)', border: '1px solid hsla(145, 55%, 45%, 0.4)', background: 'hsla(145, 55%, 45%, 0.08)' }}
                                        title={`Marked zero by ${row.marked_zero_by || 'unknown'} on ${row.marked_zero_at ? new Date(row.marked_zero_at).toLocaleString('en-ZA') : 'unknown date'}${row.marked_zero_note ? ` — ${row.marked_zero_note}` : ''}`}
                                      >
                                        ZERO
                                      </span>
                                    )}
                                  </div>
                                  <div className="font-mono text-[9px] uppercase tracking-[0.15em] mt-0.5" style={{ color: row.sage_present ? 'hsl(145 55% 45%)' : 'hsl(var(--muted-foreground))' }}>
                                    {row.sage_present ? `${row.batch_count} batch${row.batch_count !== 1 ? 'es' : ''}` : 'no sage'}
                                  </div>
                                  {row.marked_zero && (
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); handleUnmarkZero(row); }}
                                      className="mt-1 font-mono text-[9px] uppercase tracking-[0.15em] text-muted-foreground hover:text-destructive transition-colors underline-offset-2 hover:underline"
                                      title="Reverse the mark-zero on this week"
                                    >
                                      Unmark
                                    </button>
                                  )}
                                </td>
                                <td className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.15em]">
                                  <div className="text-muted-subtle">All fees</div>
                                  {missingVat && (
                                    <div
                                      className="mt-0.5 inline-block px-1.5 py-0.5 rounded-sm"
                                      style={{
                                        color: 'var(--phosphor)',
                                        background: 'hsla(33, 95%, 55%, 0.12)',
                                        border: '1px solid hsla(33, 95%, 55%, 0.4)',
                                      }}
                                      title={`Variance R${fmt(Math.abs(totalDiff))} ≈ ${vatPercent}% of BAT (R${fmt(vatExpected)}) — likely VAT mismatch`}
                                    >
                                      missing VAT
                                    </div>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">
                                  {supTotal ? <><span className="text-muted-subtle mr-0.5">R</span>{fmt(supTotal)}</> : '—'}
                                </td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums text-foreground">
                                  {sageTotal ? <><span className="text-muted-subtle mr-0.5">R</span>{fmt(sageTotal)}</> : '—'}
                                </td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums" style={{ color: headerColor }}>
                                  {(supTotal || sageTotal) ? <><span className="opacity-60 mr-0.5">R</span>{fmt(totalDiff)}</> : '—'}
                                </td>
                                <td className="px-3 py-2 text-center">
                                  <span className="font-mono text-[11px]" style={{ color: headerColor }}>{headerGlyph}</span>
                                </td>
                              </tr>
                              {/* Per-fee detail rows — only when expanded */}
                              {isOpen && cells.map((c) => {
                                const sup = row[c.sup] || 0;
                                const sage = row[c.sage] || 0;
                                const diff = sup - sage;
                                const color = ragColor(sup, sage);
                                return (
                                  <tr
                                    key={`${key}-${c.key}`}
                                    className="border-t hover:bg-muted/20 transition-colors"
                                    style={{ borderColor: 'hsl(var(--border))', background: 'hsla(0,0%,0%,0.15)' }}
                                  >
                                    <td></td>
                                    <td></td>
                                    <td className="px-3 py-1.5 text-muted-foreground pl-6">{c.label}</td>
                                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-foreground">
                                      {sup ? <><span className="text-muted-subtle mr-0.5">R</span>{fmt(sup)}</> : '—'}
                                    </td>
                                    <td className="px-3 py-1.5 text-right font-mono tabular-nums text-foreground">
                                      {sage ? <><span className="text-muted-subtle mr-0.5">R</span>{fmt(sage)}</> : '—'}
                                    </td>
                                    <td className="px-3 py-1.5 text-right font-mono tabular-nums" style={{ color }}>
                                      {(sup || sage) ? <><span className="opacity-60 mr-0.5">R</span>{fmt(diff)}</> : '—'}
                                    </td>
                                    <td className="px-3 py-1.5 text-center">
                                      {(sup || sage) ? (
                                        <span className="font-mono text-[10px]" style={{ color }}>
                                          {Math.abs(diff) < 0.01 ? '●' : Math.abs(diff) < 100 ? '◐' : '▲'}
                                        </span>
                                      ) : <span className="text-muted-subtle">—</span>}
                                    </td>
                                  </tr>
                                );
                              })}
                            </React.Fragment>
                          );
                        };

                    const renderHalf = (rows, label) => (
                      <div className="overflow-auto max-h-[28rem] border border-border" style={{ borderRadius: '12px' }}>
                        <table className="w-full text-sm">
                          <thead className="sticky top-0 z-10" style={{ background: 'hsl(24 8% 11%)' }}>
                            <tr style={{ borderBottom: '1px solid hsl(var(--border))' }}>
                              <th colSpan={7} className="px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground border-b border-border">{label}</th>
                            </tr>
                            <tr style={{ borderBottom: '1px solid hsl(var(--border))' }}>
                              <th className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground" style={{ width: '24px' }}></th>
                              <th className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Wk</th>
                              <th className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Fee</th>
                              <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">BAT</th>
                              <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Credit Notes</th>
                              <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Diff</th>
                              <th className="px-2 py-2 text-center font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground" style={{ width: '32px' }}></th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.length === 0 ? (
                              <tr><td colSpan={7} className="px-3 py-6 text-center text-muted-subtle font-mono text-[10px] uppercase tracking-[0.2em]">No data</td></tr>
                            ) : rows.map(renderRowGroup)}
                          </tbody>
                        </table>
                      </div>
                    );

                    return (
                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 p-3">
                        {renderHalf(h1Rows, 'H1 · Weeks 1–26')}
                        {renderHalf(h2Rows, 'H2 · Weeks 27–53')}
                      </div>
                    );
                  })()}
                </div>
              );
            })()}

            {/* Dashboard tabs */}
            <div className="flex gap-px overflow-hidden bg-border border border-border" style={{ borderRadius: '12px' }}>
              {[
                { id: 'archive', label: 'Reconciliations', count: reconciliations.length },
                { id: 'crossref', label: 'Cross-Reference' },
              ].map((t) => (
                <button
                  key={t.id}
                  onClick={() => setDashTab(t.id)}
                  className="relative flex-1 px-4 py-3 text-left transition-colors"
                  style={{ background: dashTab === t.id ? 'hsl(var(--card))' : 'transparent' }}
                >
                  {dashTab === t.id && (
                    <span
                      className="absolute left-0 top-0 bottom-0 w-[2px]"
                      style={{ background: 'var(--phosphor)', boxShadow: '0 0 12px hsla(33,95%,55%,0.35)' }}
                    />
                  )}
                  <div className="pl-2 flex items-center gap-3">
                    <span
                      className="font-mono text-[10px] uppercase tracking-[0.2em]"
                      style={{ color: dashTab === t.id ? 'var(--phosphor)' : 'hsl(var(--muted-foreground))' }}
                    >
                      {t.label}
                    </span>
                    {t.count != null && (
                      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{t.count}</span>
                    )}
                  </div>
                </button>
              ))}
            </div>

            {dashTab === 'archive' && (() => {
              const archiveYears = Array.from(new Set(reconciliations.map(r => r.year).filter(Boolean))).sort((a, b) => b - a);
              const yearFiltered = archiveYear === 'all'
                ? reconciliations
                : reconciliations.filter(r => String(r.year) === String(archiveYear));
              const isWeekMatched = (r) => {
                const sageHasData = !!r.sage_present;
                if (!sageHasData) return false;
                // Use the same per-fee baseline the WeekSelector card,
                // the dashboard variance tile, and the per-week table
                // all use (PR #354). Reading r.supplier_total /
                // r.sage_total here would re-introduce the cached-vs-
                // per-fee drift that the rest of the page was already
                // fixed to avoid — manifests as cards labeled "Matched"
                // that aren't hidden by "Hide matched" (or vice versa).
                const claim = (r.claim_per_fee != null)
                  ? r.claim_per_fee
                  : (r.supplier_delivery || 0) + (r.supplier_discount || 0) + (r.supplier_pricing || 0);
                const sagePerFee = (r.sage_delivery || 0) + (r.sage_discount || 0) + (r.sage_pricing || 0);
                return Math.abs(claim - sagePerFee) < 0.01;
              };
              const matchedCount = yearFiltered.filter(isWeekMatched).length;
              const filtered = hideMatched ? yearFiltered.filter(r => !isWeekMatched(r)) : yearFiltered;
              const excAmount = dashboardData?.summary?.totalExceptionsAmount || 0;
              const excCount = dashboardData?.summary?.totalExceptionsCount || 0;
              const excByReason = dashboardData?.summary?.exceptionsByReason || [];
              const fmtR = (v) => Math.abs(v).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
              return (
                <section className="space-y-4">
                  <div
                    className="relative overflow-hidden bg-card px-6 py-4"
                    style={{ border: '1px solid hsl(var(--border))', borderRadius: '12px' }}
                  >
                    <div
                      className="absolute left-0 top-0 bottom-0 w-[2px]"
                      style={{ background: 'var(--phosphor)', boxShadow: '0 0 12px hsla(33, 95%, 55%, 0.4)' }}
                    />
                    <div className="pl-2 flex items-center justify-between gap-6">
                      <div>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground cursor-help inline-block">
                              Exceptions · all weeks
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side="top">Sum of every invoice across every uploaded week that BAT flagged as an exception (any non-blank "Cardoso Exceptions Reasons" cell). Reasons are normalized — case and word-order variants are merged.</TooltipContent>
                        </Tooltip>
                        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-subtle tabular-nums mt-1">
                          {excCount} flagged invoice{excCount === 1 ? '' : 's'}
                        </div>
                      </div>
                      <div className="font-display text-3xl leading-none tabular-nums" style={{ color: 'var(--phosphor)' }}>
                        <span className="text-muted-subtle text-2xl mr-1.5">R</span>{fmtR(excAmount)}
                      </div>
                    </div>
                    {excByReason.length > 0 && (
                      <div className="pl-2 mt-4 pt-3 border-t border-border space-y-1.5">
                        {excByReason.map((r) => {
                          const pct = excAmount > 0 ? (r.amount / excAmount) * 100 : 0;
                          return (
                            <div key={r.reason} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 font-mono text-[11px]">
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="truncate text-foreground cursor-help">{r.reason}</span>
                                </TooltipTrigger>
                                <TooltipContent side="top">{r.reason}</TooltipContent>
                              </Tooltip>
                              <span className="tabular-nums text-muted-subtle text-[10px]">
                                {r.count}× · {pct.toFixed(0)}%
                              </span>
                              <span className="tabular-nums text-foreground min-w-[120px] text-right">
                                <span className="text-muted-subtle mr-1">R</span>{fmtR(r.amount)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    {/* Year now lives in the page header — drives this list via
                        the archiveYear alias on viewingYear. */}
                    <button
                      onClick={() => setHideMatched(!hideMatched)}
                      className="inline-flex items-center gap-2 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors"
                      style={{
                        color: hideMatched ? 'hsl(145 55% 45%)' : 'hsl(var(--muted-foreground))',
                        background: hideMatched ? 'hsla(145, 55%, 45%, 0.08)' : 'transparent',
                        border: hideMatched ? '1px solid hsla(145, 55%, 45%, 0.5)' : '1px solid hsl(var(--border))',
                        borderRadius: '12px',
                      }}
                    >
                      <span
                        className="inline-block w-3 h-3 flex-shrink-0"
                        style={{
                          border: hideMatched ? '1px solid hsl(145 55% 45%)' : '1px solid hsl(var(--border))',
                          background: hideMatched ? 'hsl(145 55% 45%)' : 'transparent',
                          borderRadius: '1px',
                          position: 'relative',
                        }}
                      >
                        {hideMatched && (
                          <span style={{ position: 'absolute', top: '-1px', left: '2px', color: 'hsl(var(--background))', fontSize: '10px', lineHeight: 1 }}>✓</span>
                        )}
                      </span>
                      Hide matched
                      {hideMatched && matchedCount > 0 && (
                        <span className="tabular-nums opacity-70">· {matchedCount}</span>
                      )}
                    </button>
                    <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground tabular-nums">
                      {filtered.length} of {yearFiltered.length} week{yearFiltered.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <WeekSelector reconciliations={filtered} onSelect={loadReconciliation} onUnmarkZero={handleUnmarkZero} />
                </section>
              );
            })()}

            {dashTab === 'crossref' && (
              <section className="space-y-5">
                <h2 className="font-display text-3xl leading-tight tracking-tight text-foreground">
                  Cross-<em className="text-phosphor">reference</em>.
                </h2>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                  Use <span className="text-accent">Download Cardoso Invoices</span> at the top to pull or upload data
                </p>

                {cardosoError && (
                  <div className="relative overflow-hidden border border-border bg-card px-4 py-3" style={{ borderRadius: '12px' }}>
                    <div className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: 'hsl(var(--destructive))' }} />
                    <p className="font-mono text-xs text-destructive pl-2">{cardosoError}</p>
                  </div>
                )}

                {/* Duplicate prompt */}
                {showDupePrompt && pendingCardosoFile && (
                  <div className="relative overflow-hidden border border-border bg-card px-5 py-4" style={{ borderRadius: '12px' }}>
                    <div className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: 'var(--phosphor)', boxShadow: '0 0 12px hsla(33,95%,55%,0.35)' }} />
                    <div className="pl-2 space-y-3">
                      <div>
                        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent">Duplicates found</span>
                        <p className="text-sm text-foreground mt-1">
                          {cardosoStats?.skipped} invoice{cardosoStats?.skipped !== 1 ? 's' : ''} already exist. {cardosoStats?.inserted} new added.
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => doCardosoUpload(pendingCardosoFile, 'overwrite')}
                          disabled={cardosoUploading}
                          className="px-4 py-2 border border-foreground bg-transparent text-foreground font-mono text-[10px] uppercase tracking-[0.2em] hover:bg-[hsla(33,95%,55%,0.18)] hover:shadow-[0_0_12px_hsla(33,95%,55%,0.35)] transition-colors disabled:opacity-50"
                          style={{ borderRadius: '12px' }}
                        >
                          Overwrite duplicates
                        </button>
                        <button
                          onClick={() => { setShowDupePrompt(false); setPendingCardosoFile(null); }}
                          className="px-4 py-2 border border-border bg-card text-muted-foreground font-mono text-[10px] uppercase tracking-[0.2em] hover:text-foreground hover:border-[var(--phosphor)] transition-colors"
                          style={{ borderRadius: '12px' }}
                        >
                          Keep existing
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Upload stats */}
                {cardosoStats && !showDupePrompt && (
                  <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    {cardosoStats.inserted > 0 && <span className="text-accent">{cardosoStats.inserted} new</span>}
                    {cardosoStats.updated > 0 && <><span className="text-border mx-2">·</span><span>{cardosoStats.updated} updated</span></>}
                    {cardosoStats.skipped > 0 && <><span className="text-border mx-2">·</span><span>{cardosoStats.skipped} unchanged</span></>}
                  </div>
                )}

                {cardosoMatch && (() => {
                  const allRows = cardosoMatch.results || [];
                  // Count occurrences of each invoice number across the whole result
                  // set so we can flag duplicates inline (same number on multiple PODs).
                  const invCounts = new Map();
                  for (const r of allRows) {
                    if (r.extraction_id && r.invoice_number) {
                      const k = String(r.invoice_number).toUpperCase();
                      invCounts.set(k, (invCounts.get(k) || 0) + 1);
                    }
                  }
                  const availableYears = Array.from(new Set(allRows.map(r => r.year).filter(Boolean))).sort((a, b) => b - a);
                  const yearScope = crossrefYear === 'all' ? allRows : allRows.filter(r => String(r.year) === String(crossrefYear));
                  const availableWeeks = Array.from(new Set(yearScope.map(r => r.week_number).filter(v => v != null))).sort((a, b) => a - b);
                  const invSearch = crossrefInvoice.trim().toUpperCase();
                  const filteredRows = yearScope.filter(r =>
                    (crossrefWeek === 'all' || String(r.week_number) === String(crossrefWeek)) &&
                    (!invSearch || String(r.invoice_number || '').toUpperCase().includes(invSearch))
                  );
                  const filterActive = crossrefYear !== 'all' || crossrefWeek !== 'all' || invSearch !== '';
                  return (
                  <>
                    <div className="grid gap-3 sm:grid-cols-5 stagger-in">
                      <MatchTile label="Matched" value={cardosoMatch.stats.matched} color="hsl(145 55% 45%)" />
                      <MatchTile label="Auto-Corrected" value={cardosoMatch.stats.autoCorrections || 0} color="hsl(200 80% 55%)" />
                      <MatchTile label="Amount Mismatches" value={cardosoMatch.stats.mismatches} color="var(--phosphor)" />
                      <MatchTile label="BAT Only" value={cardosoMatch.stats.unmatchedSupplier} color="hsl(var(--muted-foreground))" />
                      <MatchTile label="Cardoso Only" value={cardosoMatch.stats.unmatchedCardoso} color="hsl(var(--destructive))" />
                    </div>

                    <div className="flex flex-wrap items-center gap-3">
                      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Filter</span>
                      <select
                        value={crossrefYear}
                        onChange={(e) => { setCrossrefYear(e.target.value); setCrossrefWeek('all'); }}
                        className="bg-card border border-border text-foreground px-2 py-1.5 font-mono text-xs tabular-nums focus:border-accent outline-none"
                        style={{ borderRadius: '12px' }}
                      >
                        <option value="all">All years</option>
                        {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
                      </select>
                      <select
                        value={crossrefWeek}
                        onChange={(e) => setCrossrefWeek(e.target.value)}
                        className="bg-card border border-border text-foreground px-2 py-1.5 font-mono text-xs tabular-nums focus:border-accent outline-none"
                        style={{ borderRadius: '12px' }}
                      >
                        <option value="all">All weeks</option>
                        {availableWeeks.map(w => <option key={w} value={w}>Week {w}</option>)}
                      </select>
                      <input
                        type="text"
                        placeholder="Invoice #"
                        value={crossrefInvoice}
                        onChange={(e) => setCrossrefInvoice(e.target.value)}
                        className="bg-card border border-border text-foreground px-2 py-1.5 font-mono text-xs tabular-nums focus:border-accent outline-none w-32"
                        style={{ borderRadius: '12px' }}
                      />
                      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground tabular-nums">
                        {filteredRows.length} of {allRows.length} row{allRows.length !== 1 ? 's' : ''}
                      </span>
                      {filterActive && (
                        <button
                          onClick={() => { setCrossrefYear('all'); setCrossrefWeek('all'); setCrossrefInvoice(''); }}
                          className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent hover:text-foreground transition-colors"
                        >
                          Clear
                        </button>
                      )}
                    </div>

                    <div className="border overflow-auto max-h-[32rem]" style={{ borderColor: 'hsl(var(--border))', borderRadius: '12px' }}>
                      <table className="min-w-full text-xs">
                        <thead className="sticky top-0 z-10" style={{ background: 'hsl(24 8% 11%)' }}>
                          <tr>
                            <th className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">Invoice</th>
                            <th className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">Week</th>
                            <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">BAT Total</th>
                            <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">S.Pricing</th>
                            <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">S.Discount</th>
                            <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">S.DelFee</th>
                            <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">Cardoso Total</th>
                            <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">C.PriceDiff</th>
                            <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">C.Discount</th>
                            <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">C.DelFee</th>
                            <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">Difference</th>
                            <th className="px-2 py-2 text-center font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredRows.map((r, i) => (
                            <tr
                              key={i}
                              className="border-t transition-colors hover:bg-muted/30"
                              style={{
                                borderColor: 'hsl(var(--border))',
                                background: r.amount_mismatch ? 'hsla(33, 95%, 55%, 0.04)' : 'hsl(var(--card))',
                              }}
                            >
                              <td className="px-2 py-1.5 font-mono tabular-nums text-foreground whitespace-nowrap">
                                {r.invoice_number}
                                {r.is_exception ? <span className="ml-1.5 font-mono text-[9px] uppercase tracking-[0.15em] px-1.5 py-0.5" style={{ color: 'hsl(280 70% 65%)', background: 'hsla(280,70%,55%,0.1)' }}>Exception</span> : null}
                                {r.auto_corrected && <span className="ml-1.5 font-mono text-[9px] uppercase tracking-[0.15em] px-1 py-0.5" style={{ color: 'hsl(200 80% 55%)', background: 'hsla(200,80%,55%,0.1)' }}>fixed</span>}
                                {(() => {
                                  const dc = r.invoice_number ? (invCounts.get(String(r.invoice_number).toUpperCase()) || 0) : 0;
                                  return dc > 1 ? (
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span className="ml-1.5 font-mono text-[9px] uppercase tracking-[0.15em] px-1 py-0.5 cursor-help" style={{ color: 'hsl(var(--destructive))', background: 'hsla(0, 72%, 50%, 0.12)', border: '1px solid hsla(0, 72%, 50%, 0.4)', borderRadius: '12px' }}>×{dc} dup</span>
                                      </TooltipTrigger>
                                      <TooltipContent>This invoice number appears on {dc} different POD extractions — at least {dc - 1} are wrong.</TooltipContent>
                                    </Tooltip>
                                  ) : null;
                                })()}
                              </td>
                              <td className="px-2 py-1.5 font-mono tabular-nums text-muted-foreground whitespace-nowrap">
                                <span className="inline-flex items-center gap-1.5">
                                  <span>{r.week_number ? `W${r.week_number}/${r.year}` : '—'}</span>
                                  {r.delivery_date && parseInt(r.delivery_date) < new Date().getFullYear() && (
                                    <span className="font-mono text-[9px] uppercase tracking-[0.15em] px-1.5 py-0.5" style={{ color: 'hsl(0 72% 65%)', background: 'hsla(0,72%,50%,0.1)' }}>Delivered last year</span>
                                  )}
                                </span>
                              </td>
                              <td className="px-2 py-1.5 text-right font-mono tabular-nums text-foreground">
                                {r.supplier_amount != null ? `R ${r.supplier_amount.toFixed(2)}` : '—'}
                              </td>
                              <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                                {r.supplier_pricing != null ? `R ${r.supplier_pricing.toFixed(2)}` : '—'}
                              </td>
                              <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                                {r.supplier_discount != null ? `R ${r.supplier_discount.toFixed(2)}` : '—'}
                              </td>
                              <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                                {r.supplier_del_fee != null ? `R ${r.supplier_del_fee.toFixed(2)}` : '—'}
                              </td>
                              <td className="px-2 py-1.5 text-right font-mono tabular-nums text-foreground">
                                {r.cardoso_amount != null ? `R ${r.cardoso_amount.toFixed(2)}` : '—'}
                              </td>
                              <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                                {r.cardoso_price_diff != null ? `R ${r.cardoso_price_diff.toFixed(2)}` : '—'}
                              </td>
                              <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                                {r.cardoso_discount != null ? `R ${r.cardoso_discount.toFixed(2)}` : '—'}
                              </td>
                              <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">
                                {r.cardoso_del_fee != null ? `R ${r.cardoso_del_fee.toFixed(2)}` : '—'}
                              </td>
                              <td className="px-2 py-1.5 text-right font-mono tabular-nums" style={{
                                color: r.difference == null ? 'hsl(var(--muted-foreground))' : Math.abs(r.difference) < 0.01 ? 'hsl(145 55% 45%)' : 'hsl(var(--destructive))',
                              }}>
                                {r.difference != null ? `R ${r.difference.toFixed(2)}` : '—'}
                              </td>
                              <td className="px-2 py-1.5 text-center">
                                {r.matched ? (
                                  r.amount_mismatch ? (
                                    <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-accent">◐ Mismatch</span>
                                  ) : (
                                    <span className="font-mono text-[10px] uppercase tracking-[0.15em]" style={{ color: 'hsl(145 55% 45%)' }}>● Match</span>
                                  )
                                ) : r.extraction_id ? (
                                  <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">○ BAT only</span>
                                ) : (
                                  <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-destructive">▲ Cardoso only</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                  );
                })()}
              </section>
            )}

          </>
        )}

        {view === 'detail' && selected && (
          <>
            {backfillMsg && (
              <div className="relative overflow-hidden border border-border bg-card px-4 py-3" style={{ borderRadius: '12px' }}>
                <div className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: 'var(--phosphor)', boxShadow: '0 0 12px hsla(33,95%,55%,0.35)' }} />
                <p className="font-mono text-xs text-accent pl-2">{backfillMsg}</p>
              </div>
            )}
            {selected.integrity && selected.integrity.passed === false && (() => {
              // Red blocking banner. Integrity invariants come from
              // src/services/bat/integrity.js — getReconciliation runs them
              // on every load. Banner lists every failed check so the
              // operator can see exactly what doesn't reconcile and
              // (importantly) is not given a dismiss button, per the
              // operator-requested "blocking dismiss until investigated"
              // treatment: trust in the numbers was eroded enough during
              // PR #354 work that a quiet chip wasn't strong enough.
              const failed = selected.integrity.checks.filter(c => !c.passed && !c.skipped);
              if (failed.length === 0) return null;
              return (
                <div
                  className="relative overflow-hidden border-2 px-5 py-4"
                  style={{
                    borderColor: 'hsl(var(--destructive))',
                    background: 'hsla(0, 72%, 50%, 0.08)',
                    borderRadius: '12px',
                    boxShadow: '0 0 18px hsla(0, 72%, 50%, 0.2)',
                  }}
                >
                  <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-destructive font-semibold mb-2">
                    ▲ Integrity drift — numbers on this recon do not reconcile to source-of-truth
                  </div>
                  <div className="text-xs text-foreground/90 mb-3">
                    {failed.length} invariant{failed.length === 1 ? '' : 's'} failing. Investigate before trusting any total on this page — the displayed PAID / NON-COMPLIANT / EXCEPTIONS / Missing PODs may be wrong.
                  </div>
                  <ul className="space-y-2">
                    {failed.map((c) => (
                      <li key={c.id} className="font-mono text-[11px] leading-relaxed pl-3" style={{ borderLeft: '2px solid hsl(var(--destructive))' }}>
                        <div className="text-foreground font-semibold">{c.name}</div>
                        {c.expected != null && c.actual != null && (
                          <div className="text-muted-foreground mt-0.5">
                            Expected <span className="text-foreground tabular-nums">{c.expected}</span>
                            <span className="text-muted-subtle mx-1.5">→</span>
                            Actual <span className="text-destructive tabular-nums">{c.actual}</span>
                            {Number.isFinite(c.drift) && Math.abs(c.drift) >= 0.01 && (
                              <span className="text-muted-subtle ml-2">drift {c.drift > 0 ? '+' : ''}{c.drift.toFixed(2)}</span>
                            )}
                          </div>
                        )}
                        {c.detail && <div className="text-foreground/80 mt-1">{c.detail}</div>}
                      </li>
                    ))}
                  </ul>
                  {failed.some((c) => c.id === 'no_orphan_extractions') && (
                    <button
                      onClick={handlePruneOrphans}
                      className="mt-3 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] border transition-colors hover:bg-destructive/10"
                      style={{ borderColor: 'hsl(var(--destructive))', color: 'hsl(var(--destructive))', borderRadius: '8px' }}
                      title="Review the extraction rows whose order_number isn't in BAT's Overview pivot, and pick which to delete (admin only)"
                    >
                      Review &amp; prune orphan rows
                    </button>
                  )}
                  <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground mt-3">
                    Logged to System Log as <span className="text-foreground">bat.integrity.drift</span> for this recon.
                  </div>
                </div>
              );
            })()}
            <ReconciliationSummary recon={selected} />

            <div className="flex flex-wrap gap-3 items-center pb-4 border-b border-border">
              <button
                onClick={handleRefreshSage}
                className="flex items-center gap-2 border border-border bg-card px-4 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground hover:border-[var(--phosphor)] transition-colors"
                style={{ borderRadius: '12px' }}
              >
                <RefreshCw className="h-3 w-3" /> Refresh Sage
              </button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className={ocrPaused ? 'cursor-not-allowed' : ''}>
                    <button
                      onClick={handleStartExtraction}
                      disabled={extracting || ocrPaused}
                      className="flex items-center gap-2 border border-foreground bg-transparent text-foreground px-4 py-2 font-mono text-[10px] uppercase tracking-[0.2em] hover:bg-[hsla(33,95%,55%,0.18)] hover:shadow-[0_0_12px_hsla(33,95%,55%,0.35)] transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:shadow-none disabled:pointer-events-none"
                      style={{ borderRadius: '12px' }}
                    >
                      <FileText className="h-3 w-3" /> {ocrPaused ? 'Extract Invoices (OCR off)' : (extracting ? 'Extracting…' : 'Extract Invoices (OCR)')}
                    </button>
                  </span>
                </TooltipTrigger>
                {ocrPaused && (
                  <TooltipContent side="top">
                    OCR is paused in Settings → Reconciliation. Resume it there to enable extraction.
                  </TooltipContent>
                )}
              </Tooltip>
            </div>

            {extractError && (
              <div className="relative overflow-hidden border border-border bg-card px-4 py-3" style={{ borderRadius: '12px' }}>
                <div
                  className="absolute left-0 top-0 bottom-0 w-[2px]"
                  style={{ background: 'hsl(var(--destructive))', boxShadow: '0 0 10px hsla(0,72%,50%,0.3)' }}
                />
                <p className="font-mono text-xs text-destructive pl-2">{extractError}</p>
              </div>
            )}

            {extractionPolling && <ExtractionProgress progress={extractionPolling} />}
            {!extractionPolling && selected.extractions?.some(e => e.extraction_status === 'pending') && (() => {
              const total = selected.extractions.length;
              const processed = selected.extractions.filter(e => e.extraction_status !== 'pending').length;
              return <ExtractionProgress progress={{ running: true, total, processed, pending: total - processed }} />;
            })()}

            <FeeComparison comparison={selected.feeComparison} creditNotes={selected.creditNotes} />

            <InvoiceMatching
              extractions={selected.extractions}
              stats={selected.extractionStats}
              reconciliationId={selected.id}
              reconLabel={`Week ${selected.week_number}/${selected.year}`}
              weekNumber={selected.week_number}
              year={selected.year}
              missingPods={selected.missingPods || []}
              overviewOrdersStored={selected.overviewOrdersStored || 0}
              onReconciliationUpdate={(recon) => setSelected(recon)}
            />
          </>
        )}
      </div>

      {/* Upload Supplier Week dialog (triggered from the page-header button) */}
      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-display text-2xl text-foreground">
              Register a <em className="text-phosphor not-italic">new week</em>
            </DialogTitle>
            <DialogDescription className="font-mono text-[10px] uppercase tracking-[0.2em]">
              Upload the BAT supplier reconciliation spreadsheet for the week
            </DialogDescription>
          </DialogHeader>
          <div className="pt-2">
            <FileUpload
              onComplete={(recon, backfilled) => {
                setUploadOpen(false);
                handleUploadComplete(recon, backfilled);
              }}
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* Orphan-extraction prune picker — admin ticks exactly which orphan rows to
          delete. No auto-classification: a retained row from another branch's
          upload can be in any OCR status, so the operator decides. */}
      <Dialog open={!!orphanReview} onOpenChange={(v) => { if (!v) closeOrphanReview(); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Review &amp; prune orphan extraction rows</DialogTitle>
            <DialogDescription>
              These extraction rows have an order number that isn’t in BAT’s Overview pivot for this
              recon. Tick the <strong>stale</strong> rows (typically a prior upload, no longer claimed)
              to delete them. <strong>Leave</strong> any row that’s a valid POD from another branch’s
              upload in the same week — those can still be pending/awaiting OCR. The POD PDFs are not affected.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] overflow-auto border border-border rounded-md">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  <th className="px-2 py-1.5 w-8"></th>
                  <th className="px-2 py-1.5 text-left">Order #</th>
                  <th className="px-2 py-1.5 text-left">OCR status</th>
                  <th className="px-2 py-1.5 text-right">Amount</th>
                  <th className="px-2 py-1.5 text-left">POD</th>
                </tr>
              </thead>
              <tbody>
                {orphanReview?.rows.map((o) => (
                  <tr
                    key={o.id}
                    className="border-t border-border hover:bg-muted/40 cursor-pointer"
                    onClick={() => toggleOrphan(o.id)}
                  >
                    <td className="px-2 py-1.5 text-center">
                      <input
                        type="checkbox"
                        checked={orphanSelected.has(o.id)}
                        onChange={() => toggleOrphan(o.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td className="px-2 py-1.5 font-mono">{o.order_number}</td>
                    <td className="px-2 py-1.5">{o.extraction_status || '—'}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">R {(Number(o.order_amount) || 0).toFixed(2)}</td>
                    <td className="px-2 py-1.5">
                      {o.pdf_url
                        ? <a href={o.pdf_url} target="_blank" rel="noreferrer" className="text-primary underline" onClick={(e) => e.stopPropagation()}>view</a>
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between mt-3">
            <span className="text-xs text-muted-foreground">
              {orphanSelected.size} of {orphanReview?.rows.length || 0} selected
            </span>
            <div className="flex gap-2">
              <button
                onClick={closeOrphanReview}
                className="px-3 py-1.5 text-xs border border-border rounded-md hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmPruneOrphans}
                disabled={orphanSelected.size === 0 || orphanBusy}
                className="px-3 py-1.5 text-xs rounded-md bg-destructive text-destructive-foreground disabled:opacity-50 transition-opacity"
              >
                {orphanBusy ? 'Deleting…' : `Delete selected (${orphanSelected.size})`}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Download Cardoso Invoices dialog — Generate from Sage OR upload spreadsheet */}
      <Dialog open={cardosoOpen} onOpenChange={setCardosoOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-display text-2xl text-foreground">
              Download <em className="text-phosphor not-italic">Cardoso</em> invoices
            </DialogTitle>
            <DialogDescription className="font-mono text-[10px] uppercase tracking-[0.2em]">
              Pull straight from Sage, or upload a generated spreadsheet
            </DialogDescription>
          </DialogHeader>

          {/* Generate from Sage */}
          <div className="border border-border bg-card p-4 mt-2" style={{ borderRadius: '12px' }}>
            <div className="mb-3">
              <p className="font-display text-base text-foreground">Generate from Sage</p>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground mt-0.5">
                OEINVH × OEINVD × ICPRICP · BF/OC price lists
              </p>
            </div>
            <div className="flex items-end gap-3 flex-wrap">
              <DatePickerField label="From" value={genFromDate} onChange={setGenFromDate} />
              <DatePickerField label="To"   value={genToDate}   onChange={setGenToDate}   />
              <div className="flex flex-col gap-1">
                <label className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">TG1 rate</label>
                <input
                  type="number" step="0.00001" min="0"
                  value={tg1Rate}
                  onChange={(e) => setTg1Rate(e.target.value)}
                  className="bg-background border border-border text-foreground px-2 py-1.5 font-mono text-xs tabular-nums focus:border-accent outline-none w-20"
                  style={{ borderRadius: '12px' }}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">TG2 rate</label>
                <input
                  type="number" step="0.00001" min="0"
                  value={tg2Rate}
                  onChange={(e) => setTg2Rate(e.target.value)}
                  className="bg-background border border-border text-foreground px-2 py-1.5 font-mono text-xs tabular-nums focus:border-accent outline-none w-20"
                  style={{ borderRadius: '12px' }}
                />
              </div>
              <button
                disabled={generating}
                onClick={async () => {
                  setGenerating(true);
                  const callGenerate = async () => {
                    const r = await fetch('/api/bat/cardoso-invoices/generate', {
                      method: 'POST',
                      credentials: 'include',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ fromDate: genFromDate, toDate: genToDate, mode: 'overwrite', tg1Rate: parseFloat(tg1Rate), tg2Rate: parseFloat(tg2Rate) }),
                    });
                    return { res: r, body: await r.json() };
                  };
                  try {
                    let { res, body: d } = await callGenerate();
                    if (!res.ok && /already in progress/i.test(d?.error || '')) {
                      await fetch('/api/bat/cardoso-invoices/cancel-generate', { method: 'POST', credentials: 'include' });
                      ({ res, body: d } = await callGenerate());
                    }
                    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
                    if (d.status === 'cancelled') {
                      toast.info('Generation cancelled');
                    } else {
                      toast.success(`Generated ${d.invoices} invoices from ${d.sageLines} Sage line items (${d.inserted} new, ${d.updated} updated)`);
                      if (d.matching) setCardosoMatch({ ...cardosoMatch, stats: d.matching });
                      setCardosoOpen(false);
                      loadDashboard();
                    }
                  } catch (err) {
                    toast.error(humanizeApiError(err, `generate Cardoso invoices for ${genFromDate} → ${genToDate}`));
                  } finally {
                    setGenerating(false);
                  }
                }}
                className="px-4 py-2 border border-foreground bg-transparent text-foreground font-mono text-[10px] uppercase tracking-[0.2em] hover:bg-[hsla(33,95%,55%,0.18)] hover:shadow-[0_0_12px_hsla(33,95%,55%,0.35)] transition-colors disabled:opacity-50 flex items-center gap-2"
                style={{ borderRadius: '12px' }}
              >
                {generating && <RefreshCw className="h-3 w-3 animate-spin" />}
                {generating ? 'Generating…' : 'Generate'}
              </button>
              {generating && (
                <button
                  onClick={async () => {
                    try {
                      await fetch('/api/bat/cardoso-invoices/cancel-generate', { method: 'POST', credentials: 'include' });
                      toast.info('Cancellation requested…');
                    } catch (e) { toast.error(humanizeApiError(e, "cancel generation")); }
                  }}
                  className="px-4 py-2 border border-destructive bg-transparent text-destructive font-mono text-[10px] uppercase tracking-[0.2em] hover:bg-[hsla(0,72%,50%,0.18)] hover:shadow-[0_0_12px_hsla(0,72%,50%,0.35)] transition-colors"
                  style={{ borderRadius: '12px' }}
                >
                  Cancel
                </button>
              )}
            </div>
          </div>

          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-subtle text-center my-1">— or —</div>

          <div
            className="border border-dashed py-5 px-6 text-center transition-colors cursor-pointer"
            style={{ borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))', borderRadius: '12px' }}
            onClick={() => cardosoFileRef.current?.click()}
          >
            <input
              ref={cardosoFileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => { handleCardosoUpload(e.target.files[0]); e.target.value = ''; }}
            />
            {cardosoUploading ? (
              <div className="flex items-center justify-center gap-2">
                <RefreshCw className="h-4 w-4 animate-spin text-accent" />
                <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Processing…</span>
              </div>
            ) : (
              <div className="flex items-center justify-center gap-3">
                <Upload className="h-5 w-5 text-muted-foreground" strokeWidth={1} />
                <div className="text-left">
                  <p className="font-display text-base text-foreground">Upload Cardoso invoice spreadsheet</p>
                  <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground mt-0.5">
                    Excel/CSV · Invoice Number + Amount columns
                  </p>
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Mark week zero — opens when an operator clicks a missing-week
          badge. Records a synthetic recon row with all zero totals so
          the week stops showing as missing. Reversible from the week-
          comparison list. */}
      <Dialog open={!!markZeroTarget} onOpenChange={(v) => { if (!v) { setMarkZeroTarget(null); setMarkZeroNote(''); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-2xl text-foreground">
              Mark week as zero
            </DialogTitle>
            <DialogDescription className="font-mono text-[10px] uppercase tracking-[0.2em]">
              {markZeroTarget && `W${String(markZeroTarget.week_number).padStart(2, '0')} of ${markZeroTarget.year}`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Confirms there were <strong>no deliveries, fees or charges</strong> for this week. The
              week is recorded as a zero recon and removed from missing credit notes. Reversible.
            </p>
            <div className="space-y-2">
              <label htmlFor="mark-zero-note" className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                Note (optional)
              </label>
              <textarea
                id="mark-zero-note"
                value={markZeroNote}
                onChange={(e) => setMarkZeroNote(e.target.value.slice(0, 500))}
                placeholder="e.g. Sky City closed for refurb; no orders placed"
                rows={3}
                className="w-full px-3 py-2 text-sm border border-border rounded bg-background text-foreground focus:outline-none focus:border-accent"
              />
              <div className="font-mono text-[9px] text-muted-foreground text-right">
                {markZeroNote.length}/500
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => { setMarkZeroTarget(null); setMarkZeroNote(''); }}
                className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitMarkZero}
                disabled={markZeroBusy}
                className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent hover:text-foreground transition-colors border border-accent bg-accent/10 px-3 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ borderRadius: '8px' }}
              >
                {markZeroBusy ? 'Marking…' : 'Mark as zero'}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Unmark week zero — confirmation dialog (replaces window.confirm). */}
      <Dialog open={!!unmarkZeroTarget} onOpenChange={(v) => { if (!v && !unmarkZeroBusy) setUnmarkZeroTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-2xl text-foreground">
              Unmark week
            </DialogTitle>
            <DialogDescription className="font-mono text-[10px] uppercase tracking-[0.2em]">
              {unmarkZeroTarget && `W${String(unmarkZeroTarget.week_number).padStart(2, '0')} of ${unmarkZeroTarget.year}`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This week will be removed from the recon list and{' '}
              <strong>reappear in the missing credit notes list</strong>. Use this if the
              week was marked zero by mistake or if charges later turned up.
            </p>
            {unmarkZeroTarget && (unmarkZeroTarget.marked_zero_by || unmarkZeroTarget.marked_zero_at || unmarkZeroTarget.marked_zero_note) && (
              <div className="border border-border rounded-md p-3 bg-muted/20 space-y-1.5">
                <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">Marked zero</div>
                {unmarkZeroTarget.marked_zero_by && (
                  <div className="text-sm"><span className="text-muted-foreground">By:</span> <strong>{unmarkZeroTarget.marked_zero_by}</strong></div>
                )}
                {unmarkZeroTarget.marked_zero_at && (
                  <div className="text-sm"><span className="text-muted-foreground">When:</span> {new Date(unmarkZeroTarget.marked_zero_at).toLocaleString('en-ZA')}</div>
                )}
                {unmarkZeroTarget.marked_zero_note && (
                  <div className="text-sm"><span className="text-muted-foreground">Note:</span> <em>{unmarkZeroTarget.marked_zero_note}</em></div>
                )}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setUnmarkZeroTarget(null)}
                disabled={unmarkZeroBusy}
                className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitUnmarkZero}
                disabled={unmarkZeroBusy}
                className="font-mono text-[10px] uppercase tracking-[0.2em] text-destructive hover:text-foreground transition-colors border border-destructive bg-destructive/10 px-3 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ borderRadius: '8px' }}
              >
                {unmarkZeroBusy ? 'Unmarking…' : 'Unmark'}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PhosphorButton({ onClick, icon: Icon, label, tip }) {
  const btn = (
    <button
      onClick={onClick}
      className="group flex items-center gap-2.5 px-5 py-2.5 font-mono text-[11px] uppercase tracking-[0.22em] font-medium transition-all"
      style={{
        color: 'var(--phosphor)',
        background: 'hsla(33, 95%, 55%, 0.08)',
        border: '1px solid hsla(33, 95%, 55%, 0.5)',
        borderRadius: '12px',
        boxShadow: '0 0 0 1px transparent, 0 0 12px hsla(33,95%,55%,0.18)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'hsla(33, 95%, 55%, 0.18)';
        e.currentTarget.style.borderColor = 'var(--phosphor)';
        e.currentTarget.style.boxShadow = '0 0 0 1px hsla(33,95%,55%,0.4), 0 0 20px hsla(33,95%,55%,0.35)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'hsla(33, 95%, 55%, 0.08)';
        e.currentTarget.style.borderColor = 'hsla(33, 95%, 55%, 0.5)';
        e.currentTarget.style.boxShadow = '0 0 0 1px transparent, 0 0 12px hsla(33,95%,55%,0.18)';
      }}
    >
      {Icon && <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />}
      <span>{label}</span>
      <span className="opacity-60 transition-transform group-hover:translate-x-0.5">→</span>
    </button>
  );
  if (!tip) return btn;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent side="bottom">{tip}</TooltipContent>
    </Tooltip>
  );
}

function DatePickerField({ label, value, onChange }) {
  const [open, setOpen] = useState(false);
  const dateValue = value ? new Date(value + 'T00:00:00') : undefined;
  const display = dateValue
    ? dateValue.toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: '2-digit' })
    : 'Pick a date';
  return (
    <div className="flex flex-col gap-1">
      <label className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{label}</label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="bg-background border border-border text-foreground px-3 py-1.5 font-mono text-xs tabular-nums hover:border-accent transition-colors flex items-center gap-2 w-[180px] justify-start"
            style={{ borderRadius: '12px' }}
          >
            <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            <span className="truncate">{display}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-auto p-0"
          align="start"
          side="bottom"
          sideOffset={6}
          collisionPadding={16}
        >
          <Calendar
            mode="single"
            selected={dateValue}
            defaultMonth={dateValue}
            onSelect={(d) => {
              if (d) {
                const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                onChange(iso);
                setOpen(false);
              }
            }}
            initialFocus
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

function MatchTile({ label, value, color }) {
  return (
    <div
      className="relative bg-card border border-border p-4 overflow-hidden"
      style={{ borderRadius: '14px', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }}
    >
      <div
        className="absolute left-0 right-0 bottom-0 h-[2px]"
        style={{ background: color, boxShadow: `0 0 10px ${color}40` }}
      />
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-1.5">{label}</div>
        <div className="font-display text-3xl leading-none tabular-nums" style={{ color }}>{value}</div>
      </div>
    </div>
  );
}
