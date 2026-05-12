// JTI Sales Export — replaces the old Crystal-report-plus-Excel-macro
// workflow. Operator picks a date range, the address fields pre-fill
// from saved defaults (editable inline), they hit Generate, the
// browser downloads a .xlsx that matches the macro output exactly.
//
// Page structure:
//   1. Header
//   2. Defaults panel — TownCity / Region / Country / Site label.
//      Pre-fills the form below; Save persists for next time.
//   3. Export panel — date range (preset chips + custom from/to) +
//      the per-export address fields (pre-populated from defaults,
//      editable for one-off overrides). Generate downloads the file.
//   4. Status / error display

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Download, Save, FileSpreadsheet, AlertTriangle, ChevronDown, ChevronRight, RotateCcw, Database, Archive, Cloud, CloudOff, Check, X } from "lucide-react";
import { useAuth } from "@/lib/AuthContext";

// Preset date-range buttons. Computes the [from, to] pair from "now"
// at click time. Order matches operator workflow: most-likely first.
function presetRange(name) {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  switch (name) {
    case 'today': {
      const today = new Date(Date.UTC(y, m, d));
      return { from: today, to: today };
    }
    case 'thisWeek': {
      // ISO week — Monday to today.
      const day = (now.getUTCDay() + 6) % 7;            // Mon=0 .. Sun=6
      const monday = new Date(Date.UTC(y, m, d - day));
      return { from: monday, to: new Date(Date.UTC(y, m, d)) };
    }
    case 'lastWeek': {
      const day = (now.getUTCDay() + 6) % 7;
      const thisMonday = new Date(Date.UTC(y, m, d - day));
      const lastMonday = new Date(thisMonday); lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);
      const lastSunday = new Date(thisMonday); lastSunday.setUTCDate(lastSunday.getUTCDate() - 1);
      return { from: lastMonday, to: lastSunday };
    }
    case 'thisMonth': {
      const start = new Date(Date.UTC(y, m, 1));
      return { from: start, to: new Date(Date.UTC(y, m, d)) };
    }
    case 'lastMonth': {
      const start = new Date(Date.UTC(y, m - 1, 1));
      const end = new Date(Date.UTC(y, m, 0));    // 0th of this month = last of prev
      return { from: start, to: end };
    }
    default: {
      return { from: new Date(Date.UTC(y, m, 1)), to: new Date(Date.UTC(y, m, d)) };
    }
  }
}

function dateInputValue(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export default function Jti() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [loadingSettings, setLoadingSettings] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingQuery, setSavingQuery] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  // Saved defaults (the ones the GET /api/jti/settings returned).
  // Used to detect "dirty" state on the defaults form so the Save
  // button can be disabled when nothing changed.
  const [savedDefaults, setSavedDefaults] = useState({
    townCity: '', region: '', country: '', siteLabel: '', queryOverride: '',
  });
  // The defaults panel's editable copy (what the user is about to save).
  const [defaultsForm, setDefaultsForm] = useState({
    townCity: '', region: '', country: '', siteLabel: '',
  });

  // SQL editor state. defaultSql is the version-controlled SQL the
  // server ships with; effectiveSql is what's currently being run
  // (override OR default); queryDraft is the operator's editable
  // copy. The editor panel is collapsed by default — most operators
  // shouldn't ever look at it.
  const [defaultSql, setDefaultSql] = useState('');
  const [savedQueryOverride, setSavedQueryOverride] = useState('');
  const [queryDraft, setQueryDraft] = useState('');
  const [queryEditorOpen, setQueryEditorOpen] = useState(false);
  const [queryWarnings, setQueryWarnings] = useState([]);
  const [queryIssues, setQueryIssues] = useState([]);

  // Pool status — when configured=false, JTI hasn't been routed in
  // Settings → Connections and the export will fail. Show a banner.
  const [poolStatus, setPoolStatus] = useState({ configured: true, source: null });

  // Export form: date range + per-export overrides for the address
  // fields (initialised from the saved defaults).
  const [from, setFrom] = useState(() => dateInputValue(presetRange('thisMonth').from));
  const [to,   setTo  ] = useState(() => dateInputValue(presetRange('thisMonth').to));
  const [exportForm, setExportForm] = useState({
    townCity: '', region: '', country: '',
  });

  // Past archives — populated from GET /api/jti/archive on page load
  // and refreshed after every successful Generate that triggers an
  // archive write (i.e. when the range is a full calendar month).
  const [archives, setArchives] = useState([]);
  const [loadingArchives, setLoadingArchives] = useState(true);
  const [downloadingArchiveId, setDownloadingArchiveId] = useState(null);

  // Load everything the page needs in one fetch. The settings
  // endpoint returns: saved defaults, the effective SQL, the default
  // SQL (so the editor can show "reset to default"), and the pool
  // configuration status.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/jti/settings', { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => {
        if (cancelled) return;
        const s = data.settings || {};
        setSavedDefaults(s);
        // Address-defaults form (excludes queryOverride which has its
        // own editor below).
        setDefaultsForm({
          townCity: s.townCity || '',
          region: s.region || '',
          country: s.country || '',
          siteLabel: s.siteLabel || '',
        });
        setExportForm({ townCity: s.townCity || '', region: s.region || '', country: s.country || '' });
        setDefaultSql(data.defaultSql || '');
        setSavedQueryOverride(s.queryOverride || '');
        setQueryDraft(s.queryOverride || data.defaultSql || '');
        setPoolStatus(data.poolStatus || { configured: false, source: null });
      })
      .catch(err => { if (!cancelled) setError(`Couldn't load JTI settings: ${err.message}`); })
      .finally(() => { if (!cancelled) setLoadingSettings(false); });
    return () => { cancelled = true; };
  }, []);

  // Fetch the archive list separately — the settings call is the
  // gate (loads first), this populates the "Past months" panel.
  useEffect(() => {
    let cancelled = false;
    refreshArchives({ cancelledRef: () => cancelled });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshArchives({ cancelledRef = () => false } = {}) {
    try {
      const r = await fetch('/api/jti/archive', { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (cancelledRef()) return;
      setArchives(Array.isArray(data.archives) ? data.archives : []);
    } catch (err) {
      if (!cancelledRef()) {
        // Don't bury this — the user should know if the archive list
        // failed to load (the panel will still render but be empty).
        console.error('[jti] failed to load archives', err);
        toast.error(`Couldn't load JTI archive list: ${err.message}`);
      }
    } finally {
      if (!cancelledRef()) setLoadingArchives(false);
    }
  }

  const handleDownloadArchive = async (id, filename) => {
    setDownloadingArchiveId(id);
    try {
      const r = await fetch(`/api/jti/archive/${id}/download`, {
        credentials: 'include',
      });
      if (!r.ok) {
        let message = `HTTP ${r.status}`;
        try { const data = await r.json(); message = data.error || message; }
        catch { /* not JSON */ }
        throw new Error(message);
      }
      const blob = await r.blob();
      triggerDownload(blob, filename || `JTI_archive_${id}.xlsx`);
      toast.success(`Downloaded ${filename}`);
    } catch (err) {
      toast.error(`Archive download failed: ${err.message}`);
    } finally {
      setDownloadingArchiveId(null);
    }
  };

  const defaultsDirty =
    defaultsForm.townCity  !== savedDefaults.townCity  ||
    defaultsForm.region    !== savedDefaults.region    ||
    defaultsForm.country   !== savedDefaults.country   ||
    defaultsForm.siteLabel !== savedDefaults.siteLabel;

  // Effective SQL: what's currently being run by the export. Override
  // takes precedence; default falls through. The dirty flag drives
  // the Save button.
  const effectiveQuery = (savedQueryOverride && savedQueryOverride.length > 0)
    ? savedQueryOverride
    : defaultSql;
  const queryDirty = queryDraft.trim() !== effectiveQuery.trim();
  const queryUsingOverride = Boolean(savedQueryOverride && savedQueryOverride.length > 0);

  const applyPreset = (name) => {
    const range = presetRange(name);
    setFrom(dateInputValue(range.from));
    setTo(dateInputValue(range.to));
  };

  const handleSaveDefaults = async () => {
    setSavingSettings(true);
    setError('');
    try {
      const r = await fetch('/api/jti/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(defaultsForm),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setSavedDefaults(data.settings);
      // Re-seed export-form addresses from the new defaults so the
      // operator immediately sees the updated values down below.
      setExportForm({
        townCity: data.settings.townCity,
        region: data.settings.region,
        country: data.settings.country,
      });
      toast.success('Defaults saved');
    } catch (err) {
      setError(`Save failed: ${err.message}`);
      toast.error(`Save failed: ${err.message}`);
    } finally {
      setSavingSettings(false);
    }
  };

  const handleSaveQuery = async () => {
    if (!isAdmin) {
      setError('Only admin users can change the JTI query');
      return;
    }
    setSavingQuery(true);
    setError('');
    setQueryIssues([]);
    setQueryWarnings([]);
    try {
      // If the draft equals the default, send empty string — that's
      // the "use default" signal the server understands.
      const overrideToSend = queryDraft.trim() === defaultSql.trim() ? '' : queryDraft;
      const r = await fetch('/api/jti/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queryOverride: overrideToSend }),
      });
      const data = await r.json();
      if (!r.ok) {
        // Validation failures come back as { error, issues, warnings }
        if (Array.isArray(data.issues) && data.issues.length > 0) {
          setQueryIssues(data.issues);
          setQueryWarnings(data.warnings || []);
          toast.error(`SQL validation failed (${data.issues.length} issue${data.issues.length === 1 ? '' : 's'})`);
          return;
        }
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      setSavedQueryOverride(data.settings.queryOverride || '');
      setSavedDefaults(data.settings);
      setQueryWarnings(data.warnings || []);
      toast.success(
        overrideToSend ? 'JTI query saved' : 'Reset to default JTI query'
      );
    } catch (err) {
      setError(`Save query failed: ${err.message}`);
      toast.error(`Save query failed: ${err.message}`);
    } finally {
      setSavingQuery(false);
    }
  };

  const handleResetQuery = () => {
    setQueryDraft(defaultSql);
    setQueryIssues([]);
    setQueryWarnings([]);
  };

  const handleExport = async () => {
    setError('');
    if (!from || !to) {
      setError('Pick a date range first');
      return;
    }
    setExporting(true);
    try {
      const r = await fetch('/api/jti/export', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to,
          townCity: exportForm.townCity,
          region: exportForm.region,
          country: exportForm.country,
        }),
      });
      if (!r.ok) {
        // Try to read JSON error; fall back to status text.
        let message = `HTTP ${r.status}`;
        try {
          const data = await r.json();
          message = data.error || message;
        } catch { /* response wasn't JSON */ }
        throw new Error(message);
      }
      // Download the binary response.
      const archiveId = r.headers.get('x-jti-archive-id');
      const blob = await r.blob();
      const filename = parseFilename(r.headers.get('content-disposition')) || 'JTI_export.xlsx';
      triggerDownload(blob, filename);
      toast.success(
        archiveId
          ? `Downloaded ${filename} (archived as #${archiveId})`
          : `Downloaded ${filename}`
      );
      // If this export hit the archive path, the new row needs to
      // appear in the panel immediately.
      if (archiveId) refreshArchives();
    } catch (err) {
      setError(`Export failed: ${err.message}`);
      toast.error(`Export failed: ${err.message}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1200px] mx-auto px-8 py-10 space-y-8">
        <div className="border-b border-border pb-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">
            § JTI · Sales export
          </div>
          <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
            JTI Sales <em className="text-phosphor not-italic">export</em>.
          </h1>
          <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground mt-3">
            Live Accpac query · vendor-scoped · matches the existing macro output
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

        {/* Pool-not-configured warning. Shows when the operator hasn't
            assigned a connection to the jti_export role in Settings →
            Connections → Module routing. JTI doesn't fall back to BAT,
            so without this assignment the export endpoint will 503. */}
        {!loadingSettings && !poolStatus.configured && (
          <div
            className="relative overflow-hidden border border-border bg-card px-4 py-3"
            style={{ borderRadius: '12px' }}
          >
            <div
              className="absolute left-0 top-0 bottom-0 w-[2px]"
              style={{ background: 'var(--phosphor)', boxShadow: '0 0 10px hsla(33,95%,55%,0.3)' }}
            />
            <div className="pl-2">
              <div className="flex items-center gap-2 mb-1">
                <Database className="h-4 w-4" strokeWidth={1.75} style={{ color: 'var(--phosphor)' }} />
                <p className="font-mono text-xs uppercase tracking-[0.2em]" style={{ color: 'var(--phosphor)' }}>
                  JTI not yet routable
                </p>
              </div>
              <p className="text-sm text-muted-foreground">
                JTI export needs its own database connection (it does not fall back to BAT).
                Open <span className="font-mono text-foreground">Connections → Module routing</span>,
                find the <span className="font-mono text-foreground">JTI export</span> dropdown, pick the right Sage company.
              </p>
            </div>
          </div>
        )}

        {/* Defaults panel ─────────────────────────────────────────── */}
        <section className="bg-card border border-border p-6" style={{ borderRadius: '12px' }}>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-1">
            Install defaults
          </div>
          <h2 className="font-display text-xl text-foreground mb-1">Pre-fill values</h2>
          <p className="text-sm text-muted-foreground mb-5">
            These pre-populate the export form below. Set them once per install — change is audit-logged.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <LabeledInput
              label="TownCity"
              value={defaultsForm.townCity}
              onChange={(v) => setDefaultsForm(s => ({ ...s, townCity: v }))}
              disabled={loadingSettings || savingSettings}
              placeholder="ERMELO"
            />
            <LabeledInput
              label="Region"
              value={defaultsForm.region}
              onChange={(v) => setDefaultsForm(s => ({ ...s, region: v }))}
              disabled={loadingSettings || savingSettings}
              placeholder="MPUMALANGA"
            />
            <LabeledInput
              label="Country"
              value={defaultsForm.country}
              onChange={(v) => setDefaultsForm(s => ({ ...s, country: v }))}
              disabled={loadingSettings || savingSettings}
              placeholder="SOUTH AFRICA"
            />
            <LabeledInput
              label="Site label (filename)"
              value={defaultsForm.siteLabel}
              onChange={(v) => setDefaultsForm(s => ({ ...s, siteLabel: v }))}
              disabled={loadingSettings || savingSettings}
              placeholder="Ermelo"
              hint="Used in JTI_Cardoso_Sales_<SITE>_YYYYMMDD.xlsx"
            />
          </div>

          <div className="mt-5 flex items-center justify-end gap-3">
            <button
              onClick={handleSaveDefaults}
              disabled={!defaultsDirty || savingSettings || loadingSettings}
              className="inline-flex items-center gap-2 px-4 py-2 border font-mono text-[10px] uppercase tracking-[0.2em] transition-colors disabled:opacity-50"
              style={{
                borderRadius: '12px',
                borderColor: 'var(--phosphor)',
                color: 'var(--phosphor)',
                background: 'hsla(33, 95%, 55%, 0.08)',
              }}
            >
              {savingSettings ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" strokeWidth={1.75} />}
              {savingSettings ? 'Saving…' : 'Save defaults'}
            </button>
          </div>
        </section>

        {/* Query (advanced) panel ─────────────────────────────────────
            Collapsed by default. The default SQL is shipped in code;
            an operator can override it per-install. Editing requires
            admin role; viewing is open to anyone with can_access_jti.
            Validation runs server-side: missing @from / @to / required
            columns / mutating keywords are rejected before save. */}
        <section className="bg-card border border-border" style={{ borderRadius: '12px' }}>
          <button
            onClick={() => setQueryEditorOpen(o => !o)}
            className="w-full flex items-center justify-between gap-3 p-6 text-left"
          >
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-1">
                Query (advanced)
              </div>
              <h2 className="font-display text-xl text-foreground mb-1">SQL the export runs against Sage</h2>
              <p className="text-sm text-muted-foreground">
                {queryUsingOverride
                  ? 'Currently using a custom override. Click to view or edit.'
                  : 'Currently using the default. Click to view or override.'}
                {' '}
                {!isAdmin && (
                  <span className="text-muted-foreground/60">(Admin-only to change.)</span>
                )}
              </p>
            </div>
            {queryEditorOpen
              ? <ChevronDown className="h-5 w-5 text-muted-foreground flex-shrink-0" />
              : <ChevronRight className="h-5 w-5 text-muted-foreground flex-shrink-0" />}
          </button>

          {queryEditorOpen && (
            <div className="px-6 pb-6 border-t border-border pt-5">
              {/* Param hint */}
              <div className="mb-3 flex flex-wrap gap-3 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                <span>Required:</span>
                <span className="text-foreground">@from</span>
                <span className="text-foreground">@to</span>
                <span className="text-muted-foreground/70">(optional)</span>
                <span className="text-foreground">@vendor</span>
              </div>
              <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                <span>Required output cols:</span>
                <span className="text-foreground">TRANNUM</span>
                <span className="text-foreground">TRANDATE</span>
                <span className="text-foreground">ITEM</span>
                <span className="text-foreground">DESC</span>
                <span className="text-foreground">CUSTOMER</span>
                <span className="text-foreground">NAMECUST</span>
                <span className="text-foreground">QTYSOLD</span>
              </div>

              <textarea
                value={queryDraft}
                onChange={(e) => setQueryDraft(e.target.value)}
                disabled={!isAdmin || savingQuery}
                rows={18}
                className="w-full px-3 py-2 border border-border bg-background text-foreground font-mono text-xs disabled:opacity-60"
                style={{ borderRadius: '8px', tabSize: 2 }}
                spellCheck={false}
              />

              {/* Validation feedback from the most recent save attempt */}
              {queryIssues.length > 0 && (
                <div className="mt-3 border border-destructive bg-card px-3 py-2" style={{ borderRadius: '8px' }}>
                  <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-destructive mb-1.5">
                    {queryIssues.length} issue{queryIssues.length === 1 ? '' : 's'} — fix before saving
                  </p>
                  <ul className="space-y-1 text-xs text-destructive">
                    {queryIssues.map((msg, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="font-mono text-[10px] mt-0.5">▲</span>
                        <span>{msg}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {queryWarnings.length > 0 && (
                <div className="mt-3 border border-border bg-card px-3 py-2" style={{ borderRadius: '8px' }}>
                  <p className="font-mono text-[10px] uppercase tracking-[0.2em] mb-1.5" style={{ color: 'var(--phosphor)' }}>
                    {queryWarnings.length} warning{queryWarnings.length === 1 ? '' : 's'}
                  </p>
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {queryWarnings.map((msg, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="font-mono text-[10px] mt-0.5" style={{ color: 'var(--phosphor)' }}>!</span>
                        <span>{msg}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="mt-4 flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {queryUsingOverride
                    ? <>Override is active. <span className="font-mono">Reset</span> reverts to the version-controlled default.</>
                    : <>Default SQL is in use. Edit the textarea above to override per-install.</>}
                </p>
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleResetQuery}
                    disabled={savingQuery || queryDraft.trim() === defaultSql.trim()}
                    className="inline-flex items-center gap-2 px-3 py-1.5 border border-border font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                    style={{ borderRadius: '8px' }}
                    title="Replace the textarea with the version-controlled default"
                  >
                    <RotateCcw className="h-3 w-3" strokeWidth={1.75} />
                    Reset to default
                  </button>
                  <button
                    onClick={handleSaveQuery}
                    disabled={!isAdmin || !queryDirty || savingQuery}
                    className="inline-flex items-center gap-2 px-4 py-2 border font-mono text-[10px] uppercase tracking-[0.2em] transition-colors disabled:opacity-50"
                    style={{
                      borderRadius: '12px',
                      borderColor: 'var(--phosphor)',
                      color: 'var(--phosphor)',
                      background: 'hsla(33, 95%, 55%, 0.08)',
                    }}
                  >
                    {savingQuery ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" strokeWidth={1.75} />}
                    {savingQuery ? 'Saving…' : (queryDraft.trim() === defaultSql.trim() ? 'Reset to default' : 'Save query')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Export panel ───────────────────────────────────────────── */}
        <section className="bg-card border border-border p-6" style={{ borderRadius: '12px' }}>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-1">
            Generate export
          </div>
          <h2 className="font-display text-xl text-foreground mb-1">Date range + address fields</h2>
          <p className="text-sm text-muted-foreground mb-5">
            Address fields are pre-filled from the defaults above. Override them per-export if needed; saved defaults aren't changed.
          </p>

          {/* Preset chips */}
          <div className="flex flex-wrap gap-2 mb-4">
            {[
              { key: 'today',     label: 'Today' },
              { key: 'thisWeek',  label: 'This week' },
              { key: 'lastWeek',  label: 'Last week' },
              { key: 'thisMonth', label: 'This month' },
              { key: 'lastMonth', label: 'Last month' },
            ].map(p => (
              <button
                key={p.key}
                onClick={() => applyPreset(p.key)}
                disabled={exporting}
                className="px-3 py-1.5 border border-border font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground hover:border-foreground transition-colors disabled:opacity-50"
                style={{ borderRadius: '8px' }}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Date pickers */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <LabeledInput
              label="From"
              type="date"
              value={from}
              onChange={setFrom}
              disabled={exporting}
            />
            <LabeledInput
              label="To"
              type="date"
              value={to}
              onChange={setTo}
              disabled={exporting}
            />
          </div>

          {/* Address fields (per-export overrides) */}
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <LabeledInput
              label="TownCity"
              value={exportForm.townCity}
              onChange={(v) => setExportForm(s => ({ ...s, townCity: v }))}
              disabled={exporting}
              placeholder="ERMELO"
            />
            <LabeledInput
              label="Region"
              value={exportForm.region}
              onChange={(v) => setExportForm(s => ({ ...s, region: v }))}
              disabled={exporting}
              placeholder="MPUMALANGA"
            />
            <LabeledInput
              label="Country"
              value={exportForm.country}
              onChange={(v) => setExportForm(s => ({ ...s, country: v }))}
              disabled={exporting}
              placeholder="SOUTH AFRICA"
            />
          </div>

          <div className="mt-6 flex items-center justify-end gap-3">
            <button
              onClick={handleExport}
              disabled={exporting || loadingSettings || !from || !to}
              className="inline-flex items-center gap-2 px-5 py-2.5 border font-mono text-[11px] uppercase tracking-[0.2em] transition-colors disabled:opacity-50"
              style={{
                borderRadius: '12px',
                borderColor: 'var(--phosphor)',
                color: 'var(--phosphor)',
                background: 'hsla(33, 95%, 55%, 0.12)',
              }}
            >
              {exporting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Querying Accpac…
                </>
              ) : (
                <>
                  <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
                  Generate JTI export
                </>
              )}
            </button>
          </div>
        </section>

        {/* Archive panel ──────────────────────────────────────────── */}
        <section className="bg-card border border-border p-6" style={{ borderRadius: '12px' }}>
          <div className="flex items-start justify-between gap-4 mb-1">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-1">
                Past months
              </div>
              <h2 className="font-display text-xl text-foreground mb-1 flex items-center gap-2">
                <Archive className="h-5 w-5 text-muted-foreground" strokeWidth={1.75} />
                Archived exports
              </h2>
              <p className="text-sm text-muted-foreground">
                Generated automatically on the 1st of every month for the previous month, plus any manual full-month exports.
                Files are kept on disk and pushed to the hub.
              </p>
            </div>
          </div>

          {loadingArchives ? (
            <div className="mt-4 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading archives…
            </div>
          ) : archives.length === 0 ? (
            <div className="mt-4 border border-dashed border-border px-4 py-6 text-center" style={{ borderRadius: '8px' }}>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                No archives yet
              </p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                Run a full-month export, or wait for the 1st-of-month scheduler to fire.
              </p>
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                    <th className="py-2 pr-4">Period</th>
                    <th className="py-2 pr-4">Generated</th>
                    <th className="py-2 pr-4">Source</th>
                    <th className="py-2 pr-4 text-right">Rows</th>
                    <th className="py-2 pr-4 text-right">Size</th>
                    <th className="py-2 pr-4">Hub</th>
                    <th className="py-2 pr-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {archives.map(a => (
                    <tr key={a.id} className="border-b border-border/40 last:border-b-0">
                      <td className="py-2.5 pr-4 font-mono text-xs text-foreground">
                        {a.period_year}-{String(a.period_month).padStart(2, '0')}
                      </td>
                      <td className="py-2.5 pr-4 text-muted-foreground text-xs">
                        {formatGeneratedAt(a.generated_at)}
                      </td>
                      <td className="py-2.5 pr-4">
                        <span
                          className="inline-block px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em]"
                          style={{
                            borderRadius: '4px',
                            background: a.source === 'scheduled' ? 'hsla(33,95%,55%,0.12)' : 'hsla(0,0%,100%,0.06)',
                            color: a.source === 'scheduled' ? 'var(--phosphor)' : 'hsl(var(--muted-foreground))',
                          }}
                        >
                          {a.source}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 text-right font-mono text-xs text-muted-foreground">
                        {a.row_count.toLocaleString()}
                      </td>
                      <td className="py-2.5 pr-4 text-right font-mono text-xs text-muted-foreground">
                        {formatBytes(a.byte_size)}
                      </td>
                      <td className="py-2.5 pr-4">
                        <HubPushPill status={a.hub_push_status} attempts={a.hub_push_attempts} error={a.hub_push_error} />
                      </td>
                      <td className="py-2.5 pr-4 text-right">
                        <button
                          onClick={() => handleDownloadArchive(a.id, a.filename)}
                          disabled={downloadingArchiveId === a.id}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 border border-border font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground hover:border-foreground transition-colors disabled:opacity-50"
                          style={{ borderRadius: '6px' }}
                          title={a.filename}
                        >
                          {downloadingArchiveId === a.id
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

        <div className="text-center pt-4 pb-8">
          <FileSpreadsheet className="h-4 w-4 inline-block text-muted-foreground/50 mr-2" strokeWidth={1.5} />
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground/50">
            Output: JTI_Cardoso_Sales_&lt;Site&gt;_YYYYMMDD.xlsx
          </span>
        </div>
      </div>
    </div>
  );
}

function LabeledInput({ label, value, onChange, disabled, placeholder, type = 'text', hint }) {
  return (
    <div>
      <label className="block font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-1.5">
        {label}
      </label>
      <input
        type={type}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-border bg-background text-foreground font-mono text-sm focus:outline-none focus:border-foreground disabled:opacity-60"
        style={{ borderRadius: '8px' }}
      />
      {hint && (
        <p className="font-mono text-[9px] text-muted-foreground/60 mt-1">{hint}</p>
      )}
    </div>
  );
}

// Pulls the filename out of a Content-Disposition header, e.g.
// 'attachment; filename="JTI_Cardoso_Sales_Ermelo_20260430.xlsx"'.
// Defensive against missing/unquoted forms.
function parseFilename(disposition) {
  if (!disposition) return null;
  const match = disposition.match(/filename\s*=\s*"?([^";]+)"?/i);
  return match ? match[1].trim() : null;
}

function formatGeneratedAt(s) {
  if (!s) return '—';
  // Server stores as 'YYYY-MM-DD HH:MM:SS' (UTC). Render as local
  // short form so the operator sees "their" time.
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

function HubPushPill({ status, attempts, error }) {
  const config = {
    pushed:          { icon: Check,   label: 'Pushed',    color: 'var(--phosphor)',          bg: 'hsla(33,95%,55%,0.12)' },
    pending:         { icon: Cloud,   label: 'Pending',   color: 'hsl(var(--muted-foreground))', bg: 'hsla(0,0%,100%,0.05)' },
    failed:          { icon: X,       label: `Failed${attempts > 1 ? ` (${attempts}×)` : ''}`, color: 'hsl(var(--destructive))', bg: 'hsla(0,72%,50%,0.12)' },
    skipped_no_hub:  { icon: CloudOff, label: 'No hub',   color: 'hsl(var(--muted-foreground))', bg: 'hsla(0,0%,100%,0.05)' },
  }[status] || { icon: Cloud, label: status || 'unknown', color: 'hsl(var(--muted-foreground))', bg: 'hsla(0,0%,100%,0.05)' };

  const Icon = config.icon;
  return (
    <span
      title={status === 'failed' && error ? error : undefined}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em]"
      style={{ borderRadius: '4px', background: config.bg, color: config.color }}
    >
      <Icon className="h-2.5 w-2.5" strokeWidth={2} />
      {config.label}
    </span>
  );
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
    // Wait a tick before revoking so the browser actually starts the
    // download. Without this some browsers cancel the click mid-flight.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
