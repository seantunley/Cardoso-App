import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Search, ExternalLink, Save, RotateCcw, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { humanizeApiError } from '@/lib/humanizeApiError';
import ReconResetModal from './ReconResetModal';

const COLUMN_TIPS = {
  idx: 'Row number within this filter/tab',
  order: 'Order number from the BAT supplier spreadsheet',
  store: 'Branch name (delivery destination)',
  custNo: 'Cardoso customer code (Branch Code from the BAT sheet)',
  cust: 'Customer / store name',
  week: 'BAT delivery week number',
  orderDay: 'Day the order was placed',
  deliveryDay: 'Day the order was delivered',
  leadTime: 'Days between order and delivery',
  delivery: 'Delivery date from the supplier sheet',
  podUploaded: 'Date the proof-of-delivery PDF was uploaded',
  target: 'BAT performance target — typical lead time in days',
  exception: 'Reason this invoice was flagged as a BAT exception',
  ocr: 'Status of automated invoice-number extraction from the POD PDF: Found, Not found, Failed, or Pending',
  invoice: 'Cardoso invoice number — extracted by OCR or entered manually. Edit the field to override.',
  amount: 'Order amount from the BAT supplier sheet',
};

// Defaults are sized to fit the HEADER label at 10pt mono uppercase
// tracking-[0.15em] without truncation. Earlier values were sized to data
// only (e.g. store=52 fit "JHB" but clipped the "STORE" header to "STO…").
// The auto-fit useEffect below scales these proportionally to match the
// actual container width, so the absolute numbers below are seed values —
// it's the proportions that matter.
const COLUMN_DEFAULTS = {
  idx: 44, order: 185, store: 78, custNo: 125, cust: 240,
  week: 60, orderDay: 84, deliveryDay: 100, leadTime: 60,
  delivery: 95, podUploaded: 110, target: 80, exception: 180,
  ocr: 56, invoice: 218, amount: 95,
};
// Bumped to v5 because the auto-fit useEffect saves SCALED widths to
// localStorage on every change — once v4 had scaled values cached, any
// subsequent default-tweak in the source was silently overridden by the
// saved values. Bumping the key invalidates the cache so existing users
// pick up the new custNo width (was 99 → header "CUSTOMER NO." truncated;
// now 125 fits comfortably).
const COLUMN_WIDTHS_KEY = 'bat.invoiceMatching.columnWidths.v5';

function useColumnWidths(containerRef) {
  const [widths, setWidths] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLUMN_WIDTHS_KEY) || '{}');
      return { ...COLUMN_DEFAULTS, ...saved };
    } catch {
      return COLUMN_DEFAULTS;
    }
  });
  const widthsRef = useRef(widths);
  // Debounce-flushed localStorage write. setWidths fires at 60Hz during
  // a column drag — sync JSON.stringify + localStorage.setItem on every
  // mousemove was wasted work; persist 200ms after the last change.
  // On unmount/dep-change flush whatever's pending so persistence
  // survives navigate-away.
  const writeTimerRef = useRef(null);
  useEffect(() => {
    widthsRef.current = widths;
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(() => {
      try { localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(widths)); } catch {} // eslint-disable-line no-empty -- hot path on every column drag; localStorage quota errors are non-fatal
      writeTimerRef.current = null;
    }, 200);
    return () => {
      if (writeTimerRef.current) {
        clearTimeout(writeTimerRef.current);
        writeTimerRef.current = null;
        try { localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(widths)); } catch {} // eslint-disable-line no-empty -- hot path teardown; localStorage quota errors are non-fatal
      }
    };
  }, [widths]);

  const MIN_COL = 40;

  const startResize = useCallback((id) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = widthsRef.current[id] ?? COLUMN_DEFAULTS[id] ?? 100;
    // Snapshot of every other column at drag start — fixed for the duration.
    const sumOthers = Object.entries(widthsRef.current)
      .filter(([k]) => k !== id)
      .reduce((s, [, v]) => s + v, 0);

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
  }, [containerRef]);

  const resetColumn = useCallback((id) => {
    setWidths((w) => ({ ...w, [id]: COLUMN_DEFAULTS[id] ?? 100 }));
  }, []);

  return { widths, setWidths, startResize, resetColumn };
}

const ocrMeta = (status) => {
  if (status === 'found')     return { label: 'Found',     color: 'hsl(145 55% 45%)' };
  if (status === 'not_found') return { label: 'Not found', color: 'var(--phosphor)' };
  if (status === 'failed')    return { label: 'Failed',    color: 'hsl(var(--destructive))' };
  return                             { label: 'Pending',   color: 'hsl(var(--muted-foreground))' };
};

const fmt = (v) => {
  if (v == null) return '—';
  // Round to 2dp first so values like -0.001 don't display as "-0,00"
  const rounded = Math.round(Number(v) * 100) / 100;
  return rounded.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

function needsAttention(extraction) {
  if (extraction.extraction_status === 'not_found' || extraction.extraction_status === 'failed') return true;
  const inv = extraction.extracted_invoice;
  // Accept any IN-prefix shape that the OCR pipeline can produce: 6 digits
  // (legacy short — e.g. IN580437), or 6 digits with up to 3 leading zeros
  // (8-digit IN00xxxxxx and 9-digit IN000xxxxxx — different sites use
  // different padding lengths; the per-site `invoice_in_digit_length`
  // setting decides which one OCR returns).
  if (inv && !/^IN0{0,3}\d{6}$/i.test(inv.trim())) return true;
  return false;
}

function OcrBadge({ status }) {
  const m = ocrMeta(status);
  return (
    <span
      className="font-mono text-[10px] uppercase tracking-[0.15em]"
      style={{ color: m.color }}
    >
      {m.label}
    </span>
  );
}

function ManualInvoiceInput({ extraction, onSaved }) {
  const [value, setValue] = useState(extraction.extracted_invoice || '');
  const [saving, setSaving] = useState(false);
  const attention = needsAttention(extraction);

  const handleSave = async () => {
    const inv = value.trim();
    if (!inv) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/bat/extraction/${extraction.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceNumber: inv }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Server-side errors come back as { error: "..." } — surface that
        // verbatim if present (it's already a readable string for known
        // codes), otherwise fall back to a humanised HTTP description.
        const detail = data.error || data.detail;
        toast.error(detail
          ? `Couldn't save invoice ${inv} — ${detail}`
          : humanizeApiError(new Error(`HTTP ${res.status}`), `save invoice ${inv}`));
        return;
      }
      toast.success(`Saved ${inv}`);
      onSaved(data.reconciliation);
    } catch (err) {
      toast.error(humanizeApiError(err, `save invoice ${inv}`));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <a
            href={extraction.preview_path || extraction.pdf_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-shrink-0 p-1 text-muted-foreground hover:text-accent transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </TooltipTrigger>
        <TooltipContent>{extraction.preview_path ? 'Open preview (JPEG)' : 'Open PDF'}</TooltipContent>
      </Tooltip>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value.toUpperCase())}
        onKeyDown={(e) => e.key === 'Enter' && handleSave()}
        placeholder="IN…"
        className="w-24 bg-transparent border-b px-1 py-0.5 font-mono text-xs tabular-nums outline-none transition-colors"
        style={{
          borderColor: attention ? 'hsl(var(--destructive))' : 'hsl(var(--border))',
          color: 'hsl(var(--foreground))',
        }}
        onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--phosphor)')}
        onBlur={(e) => (e.currentTarget.style.borderColor = attention ? 'hsl(var(--destructive))' : 'hsl(var(--border))')}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleSave}
            disabled={saving || !value.trim()}
            className="flex-shrink-0 p-1 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ color: 'hsl(145 55% 45%)' }}
          >
            <Save className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Save invoice number</TooltipContent>
      </Tooltip>
    </div>
  );
}

export default function InvoiceMatching({ extractions, stats, reconciliationId, onReconciliationUpdate, reconLabel, missingPods = [], overviewOrdersStored = 0 }) {
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [retrying, setRetrying] = useState(false);
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const tableContainerRef = useRef(null);
  // Holds the "Retry Not Found" status-poll interval so we can kill it on
  // unmount or when the user navigates to a different recon. Without this,
  // the interval was leaked into a local closure inside handleRetry — every
  // retry click that didn't reach pending=0 before unmount kept ticking
  // forever, polling /api/bat/extraction-status every 3s in the background.
  // After a week of OCR sessions the operator had accumulated enough zombie
  // pollers that the only fix was closing+reopening the browser tab.
  const retryPollRef = useRef(null);
  const clearRetryPoll = useCallback(() => {
    if (retryPollRef.current) {
      clearInterval(retryPollRef.current);
      retryPollRef.current = null;
    }
  }, []);
  // Kill the poll on unmount AND whenever the recon changes — a stale poll
  // from recon A would otherwise keep firing while the user is on recon B.
  useEffect(() => clearRetryPoll, [reconciliationId, clearRetryPoll]);
  const { widths, startResize, resetColumn } = useColumnWidths(tableContainerRef);

  // No more auto-fit useEffect — we now use percentage widths on
  // <col> elements and width:100% on the table itself, so the
  // browser fills the container natively. The pixel values in
  // `widths` state are only used as ratios for proportional
  // distribution. See the table render below.
  //
  // The previous setWidths-based auto-fit was fragile: it relied
  // on ResizeObserver firing reliably on mount, on closures
  // capturing fresh state, and on Math.round not introducing
  // drift across saves to localStorage. Easier to let CSS do it.

  const handleRetry = async () => {
    if (!reconciliationId) return;
    // A retry click while a previous poll is still running would leak the
    // old interval. Clear first.
    clearRetryPoll();
    setRetrying(true);
    try {
      const res = await fetch('/api/bat/retry-extraction', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reconciliationId }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.requeued > 0) {
          // Hard cap so a wedged worker (status.running stays true forever)
          // can't leak the poll past 30 minutes even if the user stays on
          // the page — the cleanup useEffect handles the navigate-away case.
          const startedAt = Date.now();
          const HARD_CAP_MS = 30 * 60 * 1000;
          retryPollRef.current = setInterval(async () => {
            if (Date.now() - startedAt > HARD_CAP_MS) {
              clearRetryPoll();
              setRetrying(false);
              return;
            }
            try {
              const statusRes = await fetch(`/api/bat/extraction-status/${reconciliationId}`, { credentials: 'include' });
              const status = await statusRes.json();
              if (!status.running && status.pending === 0) {
                clearRetryPoll();
                const reconRes = await fetch(`/api/bat/reconciliation/${reconciliationId}`, { credentials: 'include' });
                if (reconRes.ok) onReconciliationUpdate(await reconRes.json());
                setRetrying(false);
              }
            } catch { clearRetryPoll(); setRetrying(false); }
          }, 3000);
        } else {
          setRetrying(false);
        }
      } else {
        setRetrying(false);
      }
    } catch { setRetrying(false); }
  };

  const [activeTab, setActiveTab] = useState('paid');

  // Synthesise table-shaped rows for missing PODs (orders BAT itemised
  // in the Overview pivot but didn't ship a POD for in the same upload).
  // is_missing_pod=1 tells the render to mark the row visually and skip
  // any field that depends on a real extraction (OCR status, store name,
  // dates, etc.). Negative synthetic ids keep React keys unique and
  // collision-free with real extraction.id values.
  const missingPodRows = useMemo(() => (missingPods || []).map((m, idx) => ({
    id: -1 * (idx + 1),
    is_missing_pod: 1,
    is_exception: m.is_exception ? 1 : 0,
    order_number: m.order_number,
    order_amount: m.order_amount,
    extraction_status: null,
    branch_name: null,
    store_name: null,
    extracted_invoice: null,
    duplicate_count: 0,
    exception_reason: m.is_exception ? '(POD missing from upload)' : null,
  })), [missingPods]);

  // Split into categories — memoized so we only re-bucket when extractions
  // or missingPods change. EXCEPTIONS tab includes both the extracted
  // exception rows AND the missing exception PODs so its total balances
  // to BAT's exception pivot total. The new "Missing PODs" tab shows
  // every missing POD (normal + exception) as an informational view.
  // All hooks must run before any early return (Rules of Hooks).
  const { paid, exceptions, nonCompliant } = useMemo(() => {
    const paid = [];
    const exceptions = [];
    const nonCompliant = [];
    for (const e of (extractions || [])) {
      if (e.is_exception) {
        exceptions.push(e);
      } else if (e.compliance_status && e.compliance_status !== 'Compliant') {
        nonCompliant.push(e);
      } else {
        paid.push(e);
      }
    }
    // Categorisation rule, per Sean (operator), 2026-05-18:
    //   - Compliance is normally derived from POD lead-time vs target.
    //   - For ODRs with NO POD: mark non-compliant, reason = "POD does
    //     not exist" (the OCR-column "No POD" badge carries that signal
    //     in the row).
    //   - Missing exception PODs go to EXCEPTIONS (same as their
    //     extracted siblings), so the tab balances to BAT's exception
    //     pivot total.
    //   - Missing normal PODs go to NON-COMPLIANT, so PAID + NC
    //     balances to the BAT TOTAL normal-pivot claim summary — the
    //     two values the operator points at when negotiating with BAT.
    // The Missing PODs tab still shows every missing POD (both flavours)
    // as a single informational view, no double counting (it reads from
    // missingPodRows, separate from the bucketing above).
    for (const m of missingPodRows) {
      if (m.is_exception) exceptions.push(m);
      else nonCompliant.push(m);
    }
    return { paid, exceptions, nonCompliant };
  }, [extractions, missingPodRows]);

  const tabData = useMemo(() => {
    if (activeTab === 'exceptions') return exceptions;
    if (activeTab === 'nonCompliant') return nonCompliant;
    if (activeTab === 'missingPods') return missingPodRows;
    return paid;
  }, [activeTab, paid, exceptions, nonCompliant, missingPodRows]);

  const filtered = useMemo(() => {
    return tabData.filter((e) => {
      // The extraction_status filter (not_found / pending) only makes
      // sense for real OCR rows. Missing-POD synthetic rows have
      // extraction_status=null because there's no extraction to have
      // a status. Bypass the filter ONLY on the Missing PODs tab so
      // the operator can always see the tab's real population there.
      // On other tabs (NON-COMPLIANT, EXCEPTIONS) missing-POD rows
      // are mixed with real extractions for balance — if the operator
      // selects "OCR failed" or "Pending" on those tabs they're
      // legitimately asking for status-bearing rows only, so the
      // synthetic missing-POD rows fall out naturally (their null
      // status doesn't match any status value).
      if (filterStatus !== 'all') {
        const bypassForMissingTab = activeTab === 'missingPods' && e.is_missing_pod;
        if (!bypassForMissingTab) {
          if (filterStatus === 'not_found' && e.extraction_status !== 'not_found') return false;
          if (filterStatus === 'pending' && e.extraction_status !== 'pending') return false;
        }
      }
      if (search) {
        const q = search.toLowerCase();
        return (
          (e.extracted_invoice || '').toLowerCase().includes(q) ||
          (e.order_number || '').toLowerCase().includes(q) ||
          (e.store_name || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [tabData, filterStatus, search, activeTab]);

  // Don't bail just because there are zero extraction rows — a recon
  // can legitimately have N missing-POD rows and zero extractions (BAT
  // shipped Overview ODRs but no Delivery POD PDFs). Bailing here
  // would hide the entire invoice register for exactly the scenario
  // the Missing PODs tab is meant to surface.
  if (!extractions?.length && !missingPodRows.length) return null;

  const tabTotal = (rows) => rows.reduce((s, e) => s + (e.order_amount || 0), 0);
  const fmtR = (v) => `R ${Math.abs(v).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const tabs = [
    { id: 'paid', label: 'Paid Invoices', count: paid.length, total: tabTotal(paid), color: 'hsl(145 55% 45%)' },
    { id: 'nonCompliant', label: 'Non-Compliant', count: nonCompliant.length, total: tabTotal(nonCompliant), color: 'hsl(var(--destructive))' },
    { id: 'exceptions', label: 'Exceptions', count: exceptions.length, total: tabTotal(exceptions), color: 'var(--phosphor)' },
    { id: 'missingPods', label: 'Missing PODs', count: missingPodRows.length, total: tabTotal(missingPodRows), color: 'hsl(33 70% 60%)' },
  ];

  return (
    <section className="space-y-4">
      {/* Header */}
      <div className="flex items-baseline justify-between flex-wrap gap-4 pt-2">
        <div>

          <h3 className="font-display text-3xl leading-tight text-foreground">
            Per-invoice <em className="text-muted-foreground">audit trail</em>.
          </h3>
        </div>
        <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.15em]">
          <span className="text-accent">◐ {stats?.notFound || 0} OCR failed</span>
          {(stats?.notFound > 0 || stats?.failed > 0) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleRetry}
                  disabled={retrying}
                  className="ml-2 inline-flex items-center gap-1.5 border px-2.5 py-1 transition-colors disabled:opacity-50"
                  style={{
                    borderColor: 'hsl(var(--border))',
                    color: 'hsl(var(--muted-foreground))',
                    borderRadius: '12px',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = 'var(--phosphor)';
                    e.currentTarget.style.color = 'var(--phosphor)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'hsl(var(--border))';
                    e.currentTarget.style.color = 'hsl(var(--muted-foreground))';
                  }}
                >
                  <RotateCcw className={`h-3 w-3 ${retrying ? 'animate-spin' : ''}`} />
                  {retrying ? 'Retrying…' : 'Retry'}
                </button>
              </TooltipTrigger>
              <TooltipContent>Re-run OCR on every invoice that wasn't found, using Google Vision as a fallback engine.</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setResetModalOpen(true)}
                className="inline-flex items-center gap-1.5 border px-2.5 py-1 transition-colors"
                style={{
                  borderColor: 'hsl(var(--border))',
                  color: 'hsl(var(--muted-foreground))',
                  borderRadius: '12px',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--phosphor)';
                  e.currentTarget.style.color = 'var(--phosphor)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'hsl(var(--border))';
                  e.currentTarget.style.color = 'hsl(var(--muted-foreground))';
                }}
              >
                <RefreshCw className="h-3 w-3" />
                Reset…
              </button>
            </TooltipTrigger>
            <TooltipContent>Reset extractions back to pending — choose ALL, only failed/not_found, or only duplicates.</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <ReconResetModal
        open={resetModalOpen}
        onOpenChange={setResetModalOpen}
        reconciliationId={reconciliationId}
        reconLabel={reconLabel}
        onResetComplete={async () => {
          // Refresh the recon row counts after reset so the operator sees
          // the new pending counts immediately. Same fetch the retry path
          // uses on completion.
          try {
            const reconRes = await fetch(`/api/bat/reconciliation/${reconciliationId}`, { credentials: 'include' });
            if (reconRes.ok) onReconciliationUpdate(await reconRes.json());
          } catch (e) { console.warn('[invoiceMatching.refresh_after_reset]', { reconciliationId }, e.message); }
        }}
      />

      {/* Category Tabs */}
      <div className="flex gap-px overflow-hidden bg-border border border-border" style={{ borderRadius: '12px' }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className="relative flex-1 px-4 py-3 text-left transition-colors"
            style={{
              background: activeTab === t.id ? 'hsl(var(--card))' : 'transparent',
            }}
          >
            {activeTab === t.id && (
              <span
                className="absolute left-0 top-0 bottom-0 w-[2px]"
                style={{ background: t.color, boxShadow: `0 0 12px ${t.color}40` }}
              />
            )}
            <div className="pl-2">
              <div className="flex items-center justify-between">
                <span
                  className="font-mono text-[10px] uppercase tracking-[0.2em]"
                  style={{ color: activeTab === t.id ? t.color : 'hsl(var(--muted-foreground))' }}
                >
                  {t.label}
                </span>
                <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                  {t.count}
                </span>
              </div>
              <div
                className="font-display text-2xl leading-none tabular-nums mt-1"
                style={{ color: activeTab === t.id ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))' }}
              >
                {fmtR(t.total)}
              </div>
            </div>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none"
            strokeWidth={1.5}
          />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search invoices, orders, customers…"
            className="w-full border bg-card pl-9 pr-3 py-2 text-xs outline-none transition-colors"
            style={{
              borderColor: 'hsl(var(--border))',
              color: 'hsl(var(--foreground))',
              borderRadius: '12px',
            }}
            onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--phosphor)')}
            onBlur={(e) => (e.currentTarget.style.borderColor = 'hsl(var(--border))')}
          />
        </div>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="border bg-card px-3 py-2 font-mono text-[11px] uppercase tracking-wider outline-none text-foreground"
          style={{ borderColor: 'hsl(var(--border))', borderRadius: '12px' }}
        >
          <option value="all">All</option>
          <option value="not_found">OCR failed</option>
          <option value="pending">Pending</option>
        </select>
      </div>

      {/* Table */}
      <div
        ref={tableContainerRef}
        className="border overflow-y-auto overflow-x-hidden max-h-[28rem]"
        style={{ borderColor: 'hsl(var(--border))', borderRadius: '12px' }}
      >
        {(() => {
          const colOrder = [
            'idx', 'order', 'store', 'custNo', 'cust', 'week', 'orderDay', 'deliveryDay',
            'leadTime', 'delivery', 'podUploaded', 'target',
            ...(activeTab === 'exceptions' ? ['exception'] : []),
            'ocr', 'invoice', 'amount',
          ];
          const totalWidth = colOrder.reduce((s, id) => s + (widths[id] || 100), 0);
          return (
        // Table is 100% of container; column percentages are
        // computed from the pixel ratios in `widths` state. The
        // browser handles "fill the container" — no JS-side
        // auto-fit logic to get wrong. Resize handlers still
        // operate in pixels (relative to current container width)
        // and persist to localStorage, but on render we always
        // re-derive percentages so the proportions are honoured
        // regardless of container size.
        <table className="text-xs w-full" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            {colOrder.map((id) => (
              <col key={id} style={{ width: `${((widths[id] || 100) / totalWidth) * 100}%` }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10" style={{ background: 'hsl(24 8% 11%)' }}>
            <tr>
              <Th id="idx" startResize={startResize} resetColumn={resetColumn}>#</Th>
              <Th id="order" startResize={startResize} resetColumn={resetColumn}>Order</Th>
              <Th id="store" startResize={startResize} resetColumn={resetColumn}>Store</Th>
              <Th id="custNo" startResize={startResize} resetColumn={resetColumn}>Customer No.</Th>
              <Th id="cust" startResize={startResize} resetColumn={resetColumn}>Customer</Th>
              <Th id="week" startResize={startResize} resetColumn={resetColumn}>Week</Th>
              <Th id="orderDay" startResize={startResize} resetColumn={resetColumn}>Order</Th>
              <Th id="deliveryDay" startResize={startResize} resetColumn={resetColumn}>Delivery</Th>
              <Th id="leadTime" align="center" startResize={startResize} resetColumn={resetColumn}>Time</Th>
              <Th id="delivery" startResize={startResize} resetColumn={resetColumn}>Delivery</Th>
              <Th id="podUploaded" startResize={startResize} resetColumn={resetColumn}>POD Upload</Th>
              <Th id="target" align="center" startResize={startResize} resetColumn={resetColumn}>Target</Th>
              {activeTab === 'exceptions' && (
                <Th id="exception" startResize={startResize} resetColumn={resetColumn}>Exception Reason</Th>
              )}
              <Th id="ocr" startResize={startResize} resetColumn={resetColumn}>OCR</Th>
              <Th id="invoice" startResize={startResize} resetColumn={resetColumn}>Invoice</Th>
              <Th id="amount" align="right" startResize={startResize} resetColumn={resetColumn}>Amount</Th>
            </tr>
          </thead>
          <tbody>
            {/* Empty-state when the Missing PODs tab is the active tab and
                the recon predates v72 (no Overview ODR list persisted). The
                operator can recover the data by re-uploading the same
                spreadsheet — the upload path now writes bat_overview_orders
                automatically. */}
            {activeTab === 'missingPods' && missingPodRows.length === 0 && overviewOrdersStored === 0 && (
              <tr>
                <td colSpan={colOrder.length} className="px-4 py-6 text-center text-muted-foreground text-xs">
                  Overview ODR list not stored for this reconciliation. Re-upload the same supplier spreadsheet to populate this view — the upload path now records every ODR from BAT's Overview pivot for Missing-POD detection.
                </td>
              </tr>
            )}
            {activeTab === 'missingPods' && missingPodRows.length === 0 && overviewOrdersStored > 0 && (
              <tr>
                <td colSpan={colOrder.length} className="px-4 py-6 text-center text-muted-foreground text-xs">
                  No missing PODs — every ODR in BAT's Overview pivot has a matching POD in the Delivery POD sheet.
                </td>
              </tr>
            )}
            {filtered.map((e, i) => (
              <tr
                key={e.id}
                className="border-t transition-colors hover:bg-muted/30 relative"
                style={{
                  borderColor: 'hsl(var(--border))',
                  background: e.is_missing_pod
                    ? 'hsla(33, 70%, 60%, 0.06)'
                    : e.is_exception ? 'hsla(33, 95%, 55%, 0.04)' : 'hsl(var(--card))',
                  opacity: e.is_missing_pod ? 0.85 : 1,
                }}
              >
                <Td muted mono>{i + 1}</Td>
                <td className="px-2 py-1.5 font-mono tabular-nums text-foreground whitespace-nowrap text-xs">{e.order_number || '—'}</td>
                <Td truncate>{e.branch_name || '—'}</Td>
                <Td mono muted>{e.validate || '—'}</Td>
                <Td truncate>{e.store_name || '—'}</Td>
                <Td muted>{e.week || '—'}</Td>
                <Td muted>{e.order_day || '—'}</Td>
                <Td muted>{e.delivery_day || '—'}</Td>
                <Td muted mono align="center">{e.lead_time ?? '—'}</Td>
                <Td muted mono>{e.delivery_date || '—'}</Td>
                <Td muted mono>{e.pod_uploaded_date || '—'}</Td>
                <Td mono muted align="center">{e.target_days ?? '—'}</Td>
                {activeTab === 'exceptions' && <Td muted truncate>{e.exception_reason || '—'}</Td>}
                <Td>
                  {e.is_missing_pod ? (
                    <span
                      className="font-mono text-[10px] uppercase tracking-[0.15em]"
                      style={{ color: 'hsl(33 70% 60%)' }}
                      title="This order appears in BAT's Overview pivot but no matching POD PDF was included in the Delivery POD sheet of the upload. No extraction row exists for it."
                    >
                      No POD
                    </span>
                  ) : (
                    <OcrBadge status={e.extraction_status} />
                  )}
                </Td>
                <Td mono>
                  <span className="inline-flex items-center gap-1.5">
                    {e.is_missing_pod ? (
                      <span className="font-mono text-[10px] text-muted-foreground italic">— no POD —</span>
                    ) : (
                      <>
                    {/* Always editable — even matched rows can be wrong. The
                        save button still pulses in and the row re-runs the
                        match query downstream, so the user always has an
                        override path. */}
                    <ManualInvoiceInput extraction={e} onSaved={onReconciliationUpdate} />
                    {e.duplicate_count > 1 && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className="font-mono text-[9px] uppercase tracking-[0.15em] px-1 py-0.5 cursor-help"
                            style={{ color: 'hsl(var(--destructive))', background: 'hsla(0, 72%, 50%, 0.12)', border: '1px solid hsla(0, 72%, 50%, 0.4)', borderRadius: '12px' }}
                          >
                            ×{e.duplicate_count} dup
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          {(() => {
                            const others = Array.isArray(e.duplicate_other_recons) ? e.duplicate_other_recons : [];
                            // Distinct (week, year) pairs from the other occurrences,
                            // ordered most-recent-first so the operator's eye lands
                            // on the relevant week.
                            const seen = new Set();
                            const uniqueWeeks = [];
                            for (const o of others) {
                              if (!o.week || !o.year) continue;
                              const key = `${o.year}-${o.week}`;
                              if (seen.has(key)) continue;
                              seen.add(key);
                              uniqueWeeks.push({ week: o.week, year: o.year });
                            }
                            uniqueWeeks.sort((a, b) => (b.year - a.year) || (b.week - a.week));
                            const weekList = uniqueWeeks.map(w => `W${w.week}/${w.year}`).join(', ');
                            if (uniqueWeeks.length === 0) {
                              // Cross-recon dupes only within the same week — fall back to the
                              // original wording so the operator isn't told "no other weeks" when
                              // the duplicates are actually right here in front of them.
                              return `This invoice number appears on ${e.duplicate_count} different POD rows in this week — at least one is wrong.`;
                            }
                            return `Invoice number appears on ${e.duplicate_count} POD rows across all reconciliations — also in ${weekList}. At least one is wrong (OCR misread or manual typo).`;
                          })()}
                        </TooltipContent>
                      </Tooltip>
                    )}
                      </>
                    )}
                  </span>
                </Td>
                <Td mono align="right">
                  {e.is_exception ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="font-mono text-[9px] uppercase tracking-[0.15em] px-1 py-0.5" style={{ color: 'var(--phosphor)', background: 'hsla(33, 95%, 55%, 0.1)' }}>Exc</span>
                      <span style={{ color: 'var(--phosphor)' }}>
                        {e.order_amount != null && <span className="opacity-60 mr-0.5">R</span>}
                        {fmt(e.order_amount)}
                      </span>
                    </span>
                  ) : (
                    <>
                      {e.order_amount != null && <span className="text-muted-foreground/60 mr-1">R</span>}
                      {fmt(e.order_amount)}
                    </>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
          );
        })()}
      </div>
      <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        Showing <span className="text-foreground tabular-nums">{filtered.length}</span> of{' '}
        <span className="text-foreground tabular-nums">{tabData.length}</span> in tab ·{' '}
        <span className="text-foreground tabular-nums">{extractions.length}</span> total
      </p>
    </section>
  );
}

function Th({ id, children, align = 'left', startResize, resetColumn }) {
  const handleDoubleClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (id && resetColumn) resetColumn(id);
  };
  const tip = COLUMN_TIPS[id];
  const labelEl = <span className="block truncate cursor-help">{children}</span>;
  return (
    <th
      className={`relative px-2 py-2 text-${align} font-mono text-[10px] uppercase tracking-[0.15em] font-medium text-muted-foreground whitespace-nowrap select-none`}
    >
      {tip ? (
        <Tooltip>
          <TooltipTrigger asChild>{labelEl}</TooltipTrigger>
          <TooltipContent side="top">{tip}</TooltipContent>
        </Tooltip>
      ) : labelEl}
      {id && startResize && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              onMouseDown={startResize(id)}
              onDoubleClick={handleDoubleClick}
              className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-accent/50 active:bg-accent z-20"
              style={{ touchAction: 'none' }}
            />
          </TooltipTrigger>
          <TooltipContent side="right">Drag to resize · double-click to reset</TooltipContent>
        </Tooltip>
      )}
    </th>
  );
}

function Td({ children, muted, mono, truncate, align = 'left' }) {
  const cls = [
    'px-2 py-1.5 text-xs overflow-hidden',
    align === 'right'  ? 'text-right'  : '',
    align === 'center' ? 'text-center' : '',
    mono     ? 'font-mono tabular-nums' : '',
    truncate ? 'truncate' : 'whitespace-nowrap text-ellipsis',
    muted    ? 'text-muted-foreground'  : 'text-foreground',
  ].filter(Boolean).join(' ');
  return <td className={cls}>{children}</td>;
}
