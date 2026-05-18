import React from 'react';
import { CheckCircle, AlertCircle, AlertTriangle, Clock, CloudOff, MinusCircle } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { getLedgerFortune } from '@/lib/fun';

function statusMeta(status) {
  if (status === 'completed') return { color: 'hsl(145 55% 45%)', glow: 'hsla(145, 55%, 45%, 0.3)', Icon: CheckCircle, label: 'Complete', tip: 'OCR extraction finished. Has not been compared against Sage credit notes yet.' };
  if (status === 'error')     return { color: 'hsl(var(--destructive))', glow: 'hsla(0, 72%, 50%, 0.3)', Icon: AlertCircle, label: 'Error', tip: 'Something went wrong during OCR extraction. Check the per-week detail page for failed invoices and use Retry.' };
  return                            { color: 'var(--phosphor)', glow: 'hsla(33, 95%, 55%, 0.3)', Icon: Clock, label: 'Pending', tip: 'OCR extraction is still in progress.' };
}

const fmt = (v) => `${Number(v || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function WeekSelector({ reconciliations, onSelect, onUnmarkZero }) {
  if (!reconciliations?.length) {
    return (
      <div
        className="border py-16 text-center"
        style={{ borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))', borderRadius: '12px' }}
      >
        <p className="font-display text-2xl text-foreground mb-2">No reconciliations yet.</p>
        <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {getLedgerFortune()}
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
        const isMarkedZero = !!r.marked_zero;
        let badge;
        if (isMarkedZero) {
          // Marked-zero overrides every other status. The recon is synthetic
          // (no PODs, no extractions) so OCR/match badges are meaningless.
          const tipParts = [`Marked as zero${r.marked_zero_by ? ` by ${r.marked_zero_by}` : ''}`];
          if (r.marked_zero_at) tipParts.push(`on ${new Date(r.marked_zero_at).toLocaleString('en-ZA')}`);
          if (r.marked_zero_note) tipParts.push(`— ${r.marked_zero_note}`);
          badge = {
            color: 'hsl(145 55% 45%)',
            glow: 'hsla(145, 55%, 45%, 0.4)',
            Icon: MinusCircle,
            label: 'Zero',
            tip: tipParts.join(' '),
          };
        } else if (isMatched) {
          badge = { color: 'hsl(145 55% 45%)', glow: 'hsla(145, 55%, 45%, 0.4)', Icon: CheckCircle, label: 'Matched', tip: 'BAT supplier total and Sage credit-note total agree to within R 0.01.' };
        } else if (isMismatched) {
          badge = { color: 'hsl(var(--destructive))', glow: 'hsla(0, 72%, 50%, 0.4)', Icon: AlertTriangle, label: 'Mismatch', tip: `BAT and Sage totals differ by R ${variance.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Investigate fee-line differences.` };
        } else if (awaitingSage) {
          badge = { color: 'hsl(280 70% 65%)', glow: 'hsla(280, 70%, 55%, 0.4)', Icon: CloudOff, label: 'Awaiting Credit Notes', tip: 'BAT spreadsheet has been uploaded but no matching credit notes have been posted in Sage 300 yet.' };
        } else {
          badge = statusMeta(r.status);
        }
        const { color, glow, Icon, label, tip } = badge;
        const borderColor = isMatched || isMismatched || isMarkedZero ? badge.color : 'hsl(var(--border))';
        const borderGlow = isMatched || isMismatched || isMarkedZero ? `0 0 10px ${badge.glow}` : 'none';
        return (
          <div
            key={r.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(r.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(r.id); } }}
            className="relative overflow-hidden bg-card p-4 text-left transition-colors hover:bg-muted/30 group cursor-pointer"
            style={{
              border: `1px solid ${borderColor}`,
              boxShadow: borderGlow,
              borderRadius: '12px',
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

              {isMarkedZero ? (
                <>
                  {r.marked_zero_note && (
                    <div className="text-xs text-muted-foreground italic line-clamp-2" title={r.marked_zero_note}>
                      {r.marked_zero_note}
                    </div>
                  )}
                  <div className="pt-2 border-t border-border flex items-center justify-between font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                    <span>By {r.marked_zero_by || 'unknown'}</span>
                    {onUnmarkZero && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onUnmarkZero(r); }}
                        className="text-muted-foreground hover:text-destructive transition-colors underline-offset-2 hover:underline cursor-pointer"
                        title="Reverse the mark-zero on this week"
                      >
                        Unmark
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-1">
                    <DataRow label="BAT" value={fmt(r.supplier_total)} />
                    <DataRow label="Credit Notes" value={r.sage_present ? fmt(r.sage_total) : '—'} muted />
                  </div>

                  <div className="pt-2 border-t border-border space-y-1">
                    <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                      <span>OCR</span>
                      <span className="tabular-nums">
                        {r.found_count || 0}<span className="text-muted-foreground/50">/{r.pod_count || 0}</span>
                        <span className="text-accent ml-2">{ocrPct}%</span>
                      </span>
                    </div>
                    {/* Drift = BAT claim summary (Overview-tab fees) − live OCR sum
                        (Σ non-exception order_amount from extractions). Updates
                        on every page load — listReconciliations computes ocr_sum
                        live from bat_invoice_extractions, so as PODs OCR and
                        amounts backfill, the drift number tracks. Suppressed
                        when no extractions exist (nothing to verify). */}
                    {(() => {
                      const claim = r.claim_per_fee || 0;
                      const ocrSum = r.ocr_sum || 0;
                      const drift = claim - ocrSum;
                      const missing = r.ocr_missing_amount_count || 0;
                      const dupCount = r.duplicate_invoice_count || 0;
                      const dupInflation = r.duplicate_inflation || 0;
                      if ((r.pod_count || 0) === 0) return null;
                      const hasDrift = Math.abs(drift) >= 0.01;
                      const hasDups = dupCount > 0;
                      if (!hasDrift && !hasDups) return null;
                      const driftTip = hasDrift
                        ? drift > 0
                          ? `BAT claim R ${fmt(claim)} vs OCR-verified R ${fmt(ocrSum)} = R ${fmt(drift)} short${missing > 0 ? ` (${missing} row${missing === 1 ? '' : 's'} still awaiting an order_amount)` : ' (every row has an amount, so detail rows simply sum to less than the claim — missing POD or wrong amount on a row)'}.`
                          : `OCR-verified R ${fmt(ocrSum)} exceeds BAT claim R ${fmt(claim)} by R ${fmt(Math.abs(drift))} — likely duplicates or wrong amount on a row.`
                        : null;
                      const dupTip = hasDups
                        ? `${dupCount} invoice number${dupCount === 1 ? '' : 's'} OCR'd more than once. Inflation R ${fmt(dupInflation)} = extra amount included in OCR-verified figure beyond keeping one representative row per invoice. Dedup would bring OCR-verified to R ${fmt(ocrSum - dupInflation)}.`
                        : null;
                      return (
                        <>
                          {hasDrift && (
                            <div
                              className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider cursor-help"
                              style={{ color: 'var(--phosphor)' }}
                              title={driftTip}
                            >
                              <span>{drift > 0 ? 'OCR short' : 'OCR over'}</span>
                              <span className="tabular-nums">
                                R {fmt(Math.abs(drift))}
                              </span>
                            </div>
                          )}
                          {hasDups && (
                            <div
                              className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider cursor-help"
                              style={{ color: 'hsl(33 70% 60%)' }}
                              title={dupTip}
                            >
                              <span>Dup invoices</span>
                              <span className="tabular-nums">
                                {dupCount}
                                <span className="text-muted-foreground/70 ml-2">+R {fmt(dupInflation)}</span>
                              </span>
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                </>
              )}
            </div>
          </div>
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
