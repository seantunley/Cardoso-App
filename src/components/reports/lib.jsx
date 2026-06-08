// Shared report-page utilities: number / currency formatting, themed Recharts
// defaults, and a single print stylesheet generator. Every report component
// imports from here so layout and chart polish stay consistent.

import React, { useEffect } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend,
} from 'recharts';
import { getReportSignature } from '@/lib/fun';

// ── Formatting ────────────────────────────────────────────────────────────
export const fmtR = (v) => {
  const n = Math.abs(Number(v) || 0);
  return n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const fmtRSigned = (v) => {
  const n = Number(v) || 0;
  const abs = Math.abs(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 && Math.abs(n) >= 0.005 ? `−${abs}` : abs;
};

// Compact axis ticks: 1234 → "R 1.2k", 1234567 → "R 1.2M"
export const fmtCompactR = (v) => {
  const n = Math.abs(Number(v) || 0);
  if (n >= 1_000_000) return `R ${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000)     return `R ${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `R ${n.toFixed(0)}`;
};

export const fmtPct = (v, digits = 1) => `${(Number(v) || 0).toFixed(digits)}%`;

export const fmtCount = (v) => Number(v || 0).toLocaleString('en-ZA');

// ── Themed colour palette for charts ──────────────────────────────────────
export const REPORT_COLORS = {
  primary:   'hsl(33 95% 55%)',       // phosphor amber
  secondary: 'hsl(145 55% 45%)',      // green
  danger:    'hsl(0 72% 50%)',
  warning:   'hsl(50 90% 55%)',
  info:      'hsl(200 80% 55%)',
  purple:    'hsl(280 70% 65%)',
  muted:     'hsl(220 8% 50%)',
};

// Cycle palette for grouped bars / multi-series
export const PALETTE = [
  'hsl(33 95% 55%)',
  'hsl(145 55% 45%)',
  'hsl(200 80% 55%)',
  'hsl(280 70% 65%)',
  'hsl(50 90% 55%)',
  'hsl(0 72% 50%)',
  'hsl(170 60% 45%)',
  'hsl(310 70% 60%)',
];

// ── Themed Recharts defaults (prop bundles, not wrappers) ────────────────
// Recharts identifies XAxis / YAxis / Legend / CartesianGrid / Tooltip
// children by static class metadata on the actual component, so wrapping them
// in a custom function loses axis rendering entirely. Export styling as
// prop bundles instead — callers spread these onto the raw Recharts elements
// (re-exported below) so the chart still recognises them.
export const AXIS_TICK = {
  fill: 'hsl(var(--muted-foreground))',
  fontSize: 11,
  fontFamily: 'monospace',
};

export const AXIS_LINE = { stroke: 'hsl(var(--border))' };

export const AXIS_LABEL = {
  fill: 'hsl(var(--muted-foreground))',
  fontSize: 10,
  fontFamily: 'monospace',
  letterSpacing: '0.15em',
  textTransform: 'uppercase',
};

export const TOOLTIP_CONTENT = {
  background: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  borderLeft: '2px solid var(--phosphor)',
  borderRadius: '12px',
  fontSize: 12,
  fontFamily: 'monospace',
  boxShadow: '0 8px 24px rgba(0,0,0,0.45), 0 0 14px hsla(33,95%,55%,0.12)',
  padding: '8px 12px',
};

export const TOOLTIP_LABEL = {
  color: 'hsl(var(--muted-foreground))',
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.15em',
  marginBottom: 4,
};

export const TOOLTIP_ITEM = {
  color: 'hsl(var(--foreground))',
  fontSize: 12,
};

export const TOOLTIP_CURSOR = { fill: 'hsla(33, 95%, 55%, 0.06)' };

export const LEGEND_WRAPPER = {
  fontSize: 11,
  fontFamily: 'monospace',
  paddingTop: 8,
};

// Aliases retained for any internal references below.
const AXIS_TICK_PROPS = AXIS_TICK;
const AXIS_LABEL_PROPS = AXIS_LABEL;
const TOOLTIP_STYLE = TOOLTIP_CONTENT;
const TOOLTIP_LABEL_STYLE = TOOLTIP_LABEL;
const TOOLTIP_ITEM_STYLE = TOOLTIP_ITEM;
const LEGEND_STYLE = LEGEND_WRAPPER;

// Common axis components — use them in every chart so styling is uniform.
export function ThemedXAxis({ label, ...props }) {
  return (
    <XAxis
      tick={AXIS_TICK_PROPS}
      tickLine={{ stroke: 'hsl(var(--border))' }}
      axisLine={{ stroke: 'hsl(var(--border))' }}
      label={label ? { value: label, position: 'insideBottom', offset: -5, style: AXIS_LABEL_PROPS } : undefined}
      {...props}
    />
  );
}

export function ThemedYAxis({ label, currency = false, percent = false, ...props }) {
  const tickFormatter = props.tickFormatter
    ?? (currency ? fmtCompactR : percent ? (v) => `${v}%` : (v) => fmtCount(v));
  return (
    <YAxis
      tick={AXIS_TICK_PROPS}
      tickLine={{ stroke: 'hsl(var(--border))' }}
      axisLine={{ stroke: 'hsl(var(--border))' }}
      tickFormatter={tickFormatter}
      label={label ? { value: label, angle: -90, position: 'insideLeft', offset: 10, style: AXIS_LABEL_PROPS } : undefined}
      width={70}
      {...props}
    />
  );
}

export function ThemedTooltip({ formatter, ...props }) {
  return (
    <RechartsTooltip
      contentStyle={TOOLTIP_STYLE}
      labelStyle={TOOLTIP_LABEL_STYLE}
      itemStyle={TOOLTIP_ITEM_STYLE}
      cursor={{ fill: 'hsla(33, 95%, 55%, 0.06)' }}
      formatter={formatter}
      {...props}
    />
  );
}

export function ThemedLegend(props) {
  return <Legend wrapperStyle={LEGEND_STYLE} iconType="square" {...props} />;
}

export function ThemedGrid() {
  return <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />;
}

// Re-export Recharts primitives so report files only import from here.
export {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, RechartsTooltip as Tooltip, Legend,
};

// ── Print stylesheet ──────────────────────────────────────────────────────
// Each report passes a unique `id` and chooses orientation. The hook installs
// the stylesheet on mount and removes it on unmount, so multiple reports never
// fight over the same #printable region.
export function usePrintStyles({ id, orientation = 'landscape' }) {
  useEffect(() => {
    const styleEl = document.createElement('style');
    styleEl.id = `${id}-print-style`;
    styleEl.textContent = buildPrintStyle(id, orientation);
    document.head.appendChild(styleEl);
    return () => { styleEl.remove(); };
  }, [id, orientation]);
}

function buildPrintStyle(id, orientation) {
  return `
@page { size: A4 ${orientation}; margin: 10mm 8mm 12mm 8mm; }
@media print {
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  body { visibility: hidden; background: #fff; }
  .report-print-hide { display: none !important; }

  #${id}-printable {
    visibility: visible;
    position: absolute;
    left: 0; top: 0;
    width: 100%;
    margin: 0; padding: 0;
    background: #fff; color: #111;
    font-family: 'Helvetica Neue', Arial, sans-serif;
    font-size: 10px;
  }
  #${id}-printable * { visibility: visible; }
  #${id}-printable::before {
    content: "CARDOSO LEDGER";
    position: fixed;
    inset: 35% 0 auto 0;
    z-index: -1;
    text-align: center;
    font-size: 72px;
    font-weight: 800;
    letter-spacing: 0.18em;
    color: rgba(17, 17, 17, 0.045);
    transform: rotate(-18deg);
    pointer-events: none;
  }

  .report-print-header {
    display: flex !important;
    align-items: flex-end;
    justify-content: space-between;
    padding-bottom: 4mm;
    border-bottom: 2px solid #111;
    margin-bottom: 4mm;
  }
  .report-print-header h1 {
    font-size: 22px;
    font-weight: 700;
    margin: 0 0 1mm 0;
    letter-spacing: -0.01em;
  }
  .report-print-header .report-print-meta {
    font-size: 10px;
    color: #666;
    margin: 0;
    line-height: 1.4;
  }
  .report-print-header .report-print-brand {
    text-align: right;
    font-size: 9px;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.15em;
  }
  .report-print-header .report-print-brand strong {
    display: block;
    color: #111;
    font-size: 14px;
    letter-spacing: 0.05em;
    margin-bottom: 1mm;
  }
  .report-print-header .report-print-logo {
    display: block;
    height: 13mm;
    margin: 0 0 1.5mm auto;
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }

  .report-print-summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 2mm;
    margin-bottom: 4mm;
    page-break-inside: avoid;
  }
  .report-print-tile {
    border: 1px solid #ccc;
    padding: 2mm 3mm;
    background: #fafafa;
    border-left: 2.5pt solid #111;
  }
  .report-print-tile .label {
    font-size: 8px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #555;
    margin-bottom: 1mm;
  }
  .report-print-tile .value {
    font-size: 14px;
    font-weight: 700;
    color: #111;
  }
  .report-print-tile .sub {
    font-size: 8px;
    color: #777;
    margin-top: 1mm;
  }

  .report-print-section-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #111;
    border-bottom: 0.5pt solid #999;
    padding-bottom: 1mm;
    margin: 4mm 0 2mm 0;
  }

  table.report-print-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 9px;
  }
  table.report-print-table thead { display: table-header-group; }
  table.report-print-table tbody tr { page-break-inside: avoid; }
  table.report-print-table thead tr {
    background: #ececec;
    border-bottom: 1pt solid #555;
  }
  table.report-print-table th {
    text-align: left;
    padding: 2px 5px;
    font-weight: 700;
    font-size: 8px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  table.report-print-table td {
    padding: 2px 5px;
    border-bottom: 0.25pt solid #ddd;
    vertical-align: top;
  }
  table.report-print-table tbody tr:nth-child(even) { background: #fafafa; }
  table.report-print-table tfoot tr {
    border-top: 1pt solid #555;
    background: #ececec;
    font-weight: 700;
  }
  table.report-print-table tfoot td { padding: 3px 5px; }

  .td-right { text-align: right; }
  .td-mono  { font-family: 'Courier New', monospace; }
  .td-muted { color: #666; }

  .report-print-footer {
    position: fixed;
    bottom: 4mm;
    left: 8mm;
    right: 8mm;
    font-size: 8px;
    color: #999;
    border-top: 0.25pt solid #ccc;
    padding-top: 1mm;
    display: flex !important;
    justify-content: space-between;
  }
}
`;
}

// ── Common print header bit ──────────────────────────────────────────────
export function PrintHeader({ title, period, filters, generatedBy, generatedAt }) {
  const lines = [];
  if (period) lines.push(period);
  if (filters?.length) lines.push(filters.join(' · '));
  lines.push(`Generated ${generatedAt}${generatedBy ? ' by ' + generatedBy : ''}`);
  return (
    <div className="report-print-header" style={{ display: 'none' }}>
      <div>
        <h1>{title}</h1>
        <p className="report-print-meta">{lines.join('  ·  ')}</p>
      </div>
      <div className="report-print-brand">
        <img src="/cardoso-logo-orange.png" alt="Cardoso" className="report-print-logo" />
        Confidential business report
      </div>
    </div>
  );
}

export function PrintFooter({ note }) {
  const stamp = new Date().toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="report-print-footer" style={{ display: 'none' }}>
      <span>{note || getReportSignature()}</span>
      <span>{stamp}</span>
    </div>
  );
}

// ── Generic report frame ─────────────────────────────────────────────────
// Wraps a report with toolbar (Print + CSV), title, and the printable region.
export function ReportFrame({
  title, subtitle, sectionLabel, printId, orientation = 'landscape',
  onExportCsv, onExportPdf, onExportExcel, onPrint, isLoading, error, children,
  printHeader, printFooter,
}) {
  usePrintStyles({ id: printId, orientation });

  return (
    <div className="space-y-5">
      <div className="report-print-hide flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="font-display text-3xl leading-tight text-foreground">
            {title}
          </h2>
          {subtitle && <p className="text-xs text-muted-foreground mt-2">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          {onExportCsv && (
            <button
              onClick={onExportCsv}
              title="Download the on-screen rows as a CSV file"
              className="inline-flex items-center gap-1.5 border border-border px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
              style={{ borderRadius: '12px' }}
            >
              CSV
            </button>
          )}
          {onExportExcel && (
            <button
              onClick={onExportExcel}
              title="Download this report as a formatted Excel workbook (matches the current filters)"
              className="inline-flex items-center gap-1.5 border border-border px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
              style={{ borderRadius: '12px' }}
            >
              Excel
            </button>
          )}
          {onExportPdf && (
            <button
              onClick={onExportPdf}
              title="Download this report as a PDF (matches the current filters)"
              className="inline-flex items-center gap-1.5 border border-border px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
              style={{ borderRadius: '12px' }}
            >
              PDF
            </button>
          )}
          {onPrint && (
            <button
              onClick={onPrint}
              className="inline-flex items-center gap-1.5 border px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors"
              style={{
                borderRadius: '12px',
                borderColor: 'var(--phosphor)',
                color: 'var(--phosphor)',
                background: 'hsla(33, 95%, 55%, 0.08)',
              }}
            >
              Print
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="report-print-hide bg-card px-4 py-3" style={{ border: '1px solid hsl(var(--destructive))', borderRadius: '12px' }}>
          <p className="text-sm text-destructive font-mono">{error.message || String(error)}</p>
        </div>
      )}

      {isLoading && (
        <div className="report-print-hide flex items-center justify-center py-12 text-muted-foreground gap-2">
          <span className="font-mono text-[11px] uppercase tracking-[0.2em]">Loading…</span>
        </div>
      )}

      <div id={`${printId}-printable`} className="space-y-4">
        {printHeader}
        {children}
        {printFooter}
      </div>
    </div>
  );
}

// Small chart-card wrapper with a title.
export function ChartCard({ title, sub, children, height = 260 }) {
  return (
    <div className="bg-card p-4" style={{ border: '1px solid hsl(var(--border))', borderRadius: '12px' }}>
      <div className="flex items-baseline justify-between mb-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">{title}</div>
        {sub && <div className="font-mono text-[10px] text-muted-foreground/60">{sub}</div>}
      </div>
      <ResponsiveContainer width="100%" height={height}>
        {children}
      </ResponsiveContainer>
    </div>
  );
}

// Summary tile, both screen and print friendly.
export function SummaryTile({ label, value, sub, accent = 'var(--phosphor)', big = false, width = '1fr', title }) {
  return (
    <div
      className="report-print-tile relative overflow-hidden bg-card p-4 min-h-[100px]"
      style={{ border: '1px solid hsl(var(--border))', borderRadius: '12px', gridColumn: width }}
      title={title}
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-[2px]"
        style={{ background: accent, boxShadow: `0 0 10px ${accent}30` }}
      />
      <div className="pl-2">
        <div className="label font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-1.5">{label}</div>
        <div className={`value font-display ${big ? 'text-3xl' : 'text-2xl'} leading-none text-foreground tabular-nums`}>{value}</div>
        {sub && <div className="sub font-mono text-[10px] uppercase tracking-wider text-muted-foreground mt-1.5">{sub}</div>}
      </div>
    </div>
  );
}

// Fetch a server-generated binary report (PDF / XLSX) and trigger download.
// Used by the PDF/Excel toolbar buttons; the server reuses the same query
// params as the on-screen report so the download always matches the view.
export async function downloadReport(url, filename) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({}));
    throw new Error(msg.error || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(objUrl);
}

// Helper to build CSV blobs and trigger download.
export function downloadCsv(filename, rows) {
  if (!rows || rows.length === 0) return;
  const csv = rows.map(row =>
    row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
  ).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
