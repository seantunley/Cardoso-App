import React from 'react';
import { CheckCircle, AlertCircle, AlertTriangle, Clock, CloudOff } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

function statusMeta(status) {
  if (status === 'completed') return { color: 'hsl(145 55% 45%)', glow: 'hsla(145, 55%, 45%, 0.3)', Icon: CheckCircle, label: 'Complete', tip: 'OCR extraction finished. Has not been compared against Sage credit notes yet.' };
  if (status === 'error')     return { color: 'hsl(var(--destructive))', glow: 'hsla(0, 72%, 50%, 0.3)', Icon: AlertCircle, label: 'Error', tip: 'Something went wrong during OCR extraction. Check the per-week detail page for failed invoices and use Retry.' };
  return                            { color: 'var(--phosphor)', glow: 'hsla(33, 95%, 55%, 0.3)', Icon: Clock, label: 'Pending', tip: 'OCR extraction is still in progress.' };
}

const fmt = (v) => `${Number(v || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function WeekSelector({ reconciliations, onSelect }) {
  if (!reconciliations?.length) {
    return (
      <div
        className="border py-16 text-center"
        style={{ borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))', borderRadius: '2px' }}
      >
        <p className="font-display text-2xl text-foreground mb-2">No reconciliations yet.</p>
        <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          Upload a supplier spreadsheet to begin.
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 stagger-in">
      {reconciliations.map((r) => {
        const ocrPct = r.pod_count > 0 ? Math.round(((r.found_count || 0) / r.pod_count) * 100) : 0;
        const sageHasData = !!r.sage_present;
        const variance = Math.abs((r.supplier_total || 0) - (r.sage_total || 0));
        const isMatched = sageHasData && variance < 0.01;
        const isMismatched = sageHasData && variance >= 0.01;
        // Don't show "Complete" (green) if there's no Sage payment yet — that's
        // misleading. Awaiting Sage takes precedence over the extraction status.
        const awaitingSage = !sageHasData && (r.supplier_total || 0) > 0;
        let badge;
        if (isMatched) {
          badge = { color: 'hsl(145 55% 45%)', glow: 'hsla(145, 55%, 45%, 0.4)', Icon: CheckCircle, label: 'Matched', tip: 'BAT supplier total and Sage credit-note total agree to within R 0.01.' };
        } else if (isMismatched) {
          badge = { color: 'hsl(var(--destructive))', glow: 'hsla(0, 72%, 50%, 0.4)', Icon: AlertTriangle, label: 'Mismatch', tip: `BAT and Sage totals differ by R ${variance.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Investigate fee-line differences.` };
        } else if (awaitingSage) {
          badge = { color: 'hsl(280 70% 65%)', glow: 'hsla(280, 70%, 55%, 0.4)', Icon: CloudOff, label: 'Awaiting Credit Notes', tip: 'BAT spreadsheet has been uploaded but no matching credit notes have been posted in Sage 300 yet.' };
        } else {
          badge = statusMeta(r.status);
        }
        const { color, glow, Icon, label, tip } = badge;
        const borderColor = isMatched || isMismatched ? badge.color : 'hsl(var(--border))';
        const borderGlow = isMatched || isMismatched ? `0 0 10px ${badge.glow}` : 'none';
        return (
          <button
            key={r.id}
            onClick={() => onSelect(r.id)}
            className="relative bg-card p-4 text-left transition-colors hover:bg-muted/30 group"
            style={{
              border: `1px solid ${borderColor}`,
              boxShadow: borderGlow,
              borderRadius: '2px',
            }}
          >
            <div
              className="absolute left-0 top-0 bottom-0 w-[2px]"
              style={{ background: color, boxShadow: `0 0 10px ${glow}` }}
            />
            <div className="pl-2 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">Week · {r.year}</div>
                  <div className="font-display text-2xl leading-none text-foreground tabular-nums mt-0.5">{r.week_number}</div>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center gap-1.5 cursor-help">
                      <Icon className="h-3 w-3" style={{ color }} strokeWidth={1.5} />
                      <span className="font-mono text-[9px] uppercase tracking-[0.2em]" style={{ color }}>{label}</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="left">{tip}</TooltipContent>
                </Tooltip>
              </div>

              <div className="space-y-1">
                <DataRow label="BAT" value={fmt(r.supplier_total)} />
                <DataRow label="Credit Notes" value={r.sage_present ? fmt(r.sage_total) : '—'} muted />
              </div>

              <div className="pt-2 border-t border-border">
                <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                  <span>OCR</span>
                  <span className="tabular-nums">
                    {r.found_count || 0}<span className="text-muted-foreground/50">/{r.pod_count || 0}</span>
                    <span className="text-accent ml-2">{ocrPct}%</span>
                  </span>
                </div>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function DataRow({ label, value, muted }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={`font-mono text-sm tabular-nums ${muted ? 'text-muted-foreground' : 'text-foreground'}`}>
        <span className="text-muted-foreground/60 mr-1">R</span>{value}
      </span>
    </div>
  );
}
