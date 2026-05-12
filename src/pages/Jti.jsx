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
import { Loader2, Download, Save, FileSpreadsheet, AlertTriangle } from "lucide-react";

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
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  // Saved defaults (the ones the GET /api/jti/settings returned).
  // Used to detect "dirty" state on the defaults form so the Save
  // button can be disabled when nothing changed.
  const [savedDefaults, setSavedDefaults] = useState({
    townCity: '', region: '', country: '', siteLabel: '',
  });
  // The defaults panel's editable copy (what the user is about to save).
  const [defaultsForm, setDefaultsForm] = useState({
    townCity: '', region: '', country: '', siteLabel: '',
  });

  // Export form: date range + per-export overrides for the address
  // fields (initialised from the saved defaults).
  const [from, setFrom] = useState(() => dateInputValue(presetRange('thisMonth').from));
  const [to,   setTo  ] = useState(() => dateInputValue(presetRange('thisMonth').to));
  const [exportForm, setExportForm] = useState({
    townCity: '', region: '', country: '',
  });

  // Load saved defaults on mount + propagate them into both the
  // defaults form and the export form's address fields.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/jti/settings', { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data => {
        if (cancelled) return;
        const s = data.settings || {};
        setSavedDefaults(s);
        setDefaultsForm(s);
        setExportForm({ townCity: s.townCity, region: s.region, country: s.country });
      })
      .catch(err => { if (!cancelled) setError(`Couldn't load saved defaults: ${err.message}`); })
      .finally(() => { if (!cancelled) setLoadingSettings(false); });
    return () => { cancelled = true; };
  }, []);

  const defaultsDirty =
    defaultsForm.townCity  !== savedDefaults.townCity  ||
    defaultsForm.region    !== savedDefaults.region    ||
    defaultsForm.country   !== savedDefaults.country   ||
    defaultsForm.siteLabel !== savedDefaults.siteLabel;

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
      const blob = await r.blob();
      const filename = parseFilename(r.headers.get('content-disposition')) || 'JTI_export.xlsx';
      triggerDownload(blob, filename);
      toast.success(`Downloaded ${filename}`);
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
