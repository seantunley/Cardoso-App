import React from 'react';
import { CheckCircle, AlertCircle, AlertTriangle, Clock, CloudOff, MinusCircle } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { getLedgerFortune } from '@/lib/fun';

function statusMeta(status) {
  if (status === 'completed') return { color: 'hsl(var(--status-ok))', glow: 'hsl(var(--status-ok) / 0.3)', Icon: CheckCircle, label: 'Complete', tip: 'OCR extraction finished. Has not been compared against Sage credit notes yet.' };
  if (status === 'error')     return { color: 'hsl(var(--destructive))', glow: 'hsl(var(--status-critical) / 0.3)', Icon: AlertCircle, label: 'Error', tip: 'Something went wrong during OCR extraction. Check the per-week detail page for failed invoices and use Retry.' };
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
        // Single BAT/Sage baseline used by every signal on this card (BAT
        // amount, Matched/Mismatch badge, awaiting-credit-notes detection,
        // drift block). Mirrors the parity that PR #354's dashboard tile and
        // per-week table established: both sides sum the same three fee
        // columns (Overview-tab claim on BAT, Sage cache per-fee on Sage)
        // rather than the supplier_total / sage.total cached columns, which
        // can drift after recompute/refresh and used to produce contradictory
        // readings — e.g. a "Matched" card on a week the dashboard variance
        // was still flagging.
        const claim = r.claim_per_fee || 0;
        const sagePerFee = (r.sage_delivery || 0) + (r.sage_discount || 0) + (r.sage_pricing || 0);
        const variance = Math.abs(claim - sagePerFee);
        const isMatched = sageHasData && variance < 0.01;
        const isMismatched = sageHasData && variance >= 0.01;
        // Don't show "Complete" (green) if there's no Sage payment yet — that's
        // misleading. Awaiting Sage takes precedence over the extraction status.
        const awaitingSage = !sageHasData && claim > 0;
        const isMarkedZero = !!r.marked_zero;
        let badge;
        if (isMarkedZero) {
          // Marked-zero overrides every other status. The recon is synthetic
          // (no PODs, no extractions) so OCR/match badges are meaningless.
          const tipParts = [`Marked as zero${r.marked_zero_by ? ` by ${r.marked_zero_by}` : ''}`];
          if (r.marked_zero_at) tipParts.push(`on ${new Date(r.marked_zero_at).toLocaleString('en-ZA')}`);
          if (r.marked_zero_note) tipParts.push(`— ${r.marked_zero_note}`);
          badge = {
            color: 'hsl(var(--status-ok))',
            glow: 'hsl(var(--status-ok) / 0.4)',
            Icon: MinusCircle,
            label: 'Zero',
            tip: tipParts.join(' '),
          };
        } else if (isMatched) {
          badge = { color: 'hsl(var(--status-ok))', glow: 'hsl(var(--status-ok) / 0.4)', Icon: CheckCircle, label: 'Matched', tip: 'BAT supplier total and Sage credit-note total agree to within R 0.01.' };
        } else if (isMismatched) {
          badge = { color: 'hsl(var(--destructive))', glow: 'hsl(var(--status-critical) / 0.4)', Icon: AlertTriangle, label: 'Mismatch', tip: `BAT and Sage totals differ by R ${variance.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Investigate fee-line differences.` };
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
                    <DataRow label="BAT" value={fmt(claim)} />
                    <DataRow label="Credit Notes" value={r.sage_present ? fmt(sagePerFee) : '—'} muted />
                  </div>

                  <div className="pt-2 border-t border-border space-y-1">
                    <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                      <span>OCR</span>
                      <span className="tabular-nums">
                        {r.found_count || 0}<span className="text-muted-subtle">/{r.pod_count || 0}</span>
                        <span className="text-accent ml-2">{ocrPct}%</span>
                      </span>
                    </div>
                    {/* POD-coverage signals (informational, not a drift in the
                        headline total). The BAT TOTAL above is BAT's Overview-tab
                        claim summary set at upload time — that's the authoritative
                        number. These three rows describe how thoroughly the per-
                        invoice PODs have been received and OCR'd against that
                        claim:
                          - OCR pending R X · N rows: PODs in the Delivery POD
                            sheet that OCR hasn't successfully matched yet
                            (failed / not_found / pending). Retry OCR or correct
                            manually.
                          - Missing PODs R Y: value of orders BAT itemised in the
                            Overview pivot for which no POD PDF was included in
                            the Delivery POD sheet of the same upload. Operator
                            action: chase BAT for the missing POD or accept the
                            shortfall.
                          - Dup invoices N · +R Z: same invoice number OCR'd on
                            multiple distinct PDFs in this recon (real OCR
                            pathology — typically same garbled barcode prefix).
                        Suppressed on weeks with no PODs uploaded yet. */}
                    {(() => {
                      if ((r.pod_count || 0) === 0) return null;
                      const unverified = r.unverified_amount || 0;
                      const unverifiedCount = r.unverified_count || 0;
                      // Rows with NULL order_amount get COALESCEd to 0 in
                      // the unverified sum. Surface the unknown count
                      // separately so the chip doesn't read "R 0.00 sits
                      // on N rows" when the true value is "amount not
                      // declared on these rows yet" — that understates
                      // reconciliation risk. ocr_missing_amount_count
                      // counts non-exception rows where order_amount is
                      // NULL, regardless of extraction_status.
                      const unknownAmountCount = r.ocr_missing_amount_count || 0;
                      const dupCount = r.duplicate_invoice_count || 0;
                      const dupInflation = r.duplicate_inflation || 0;
                      // Missing PODs reads from bat_overview_orders (the
                      // persisted Overview-pivot ODR list) MINUS extraction
                      // rows — same source as the audit-trail's Missing PODs
                      // tab, so tile and tab can never disagree. For recons
                      // predating v72 the table is empty for that recon
                      // (overview_orders_stored=0), and we render
                      // "Re-upload to verify" instead of a calculated proxy.
                      // The previous calc (claim − ocr_sum − unverified) was
                      // misleading on weeks where duplicate-inflated OCR sum
                      // understated the gap; honest answer is "we don't
                      // know yet, re-upload to seed the table".
                      const overviewStored = r.overview_orders_stored || 0;
                      const missingPodsCount = r.missing_pods_count || 0;
                      const missingPodsValue = r.missing_pods_value || 0;
                      // Subset of missing PODs whose Overview amount is
                      // NULL (BAT hasn't declared a value yet). Shown
                      // separately so missing_pods_value's R figure
                      // doesn't read as full exposure when some rows
                      // are intentionally unknown.
                      const missingPodsUnknown = r.missing_pods_unknown_count || 0;
                      const hasPending = unverifiedCount > 0;
                      const hasMissingPods = overviewStored > 0 && missingPodsCount > 0;
                      const needsReupload = overviewStored === 0;
                      const hasDups = dupCount > 0;
                      if (!hasPending && !hasMissingPods && !needsReupload && !hasDups) return null;
                      return (
                        <>
                          {hasPending && (
                            <div
                              className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider cursor-help"
                              style={{ color: 'var(--phosphor)' }}
                              title={`R ${fmt(unverified)} of declared per-row amount sits on ${unverifiedCount} POD row${unverifiedCount === 1 ? '' : 's'} OCR hasn't successfully matched yet (status: failed / not_found / pending).${unknownAmountCount > 0 ? ` ${unknownAmountCount} of those row${unknownAmountCount === 1 ? '' : 's'} also have NO declared amount yet — the R value above understates the true exposure by however much those undeclared amounts turn out to be.` : ''} Run Retry or manually correct the invoice number. The BAT TOTAL above does not change as these get resolved — only the OCR coverage signals.`}
                            >
                              <span>OCR pending</span>
                              <span className="tabular-nums">
                                R {fmt(unverified)}
                                <span className="text-muted-subtle ml-2">{unverifiedCount} row{unverifiedCount === 1 ? '' : 's'}</span>
                                {unknownAmountCount > 0 && (
                                  <span style={{ color: 'hsl(33 70% 60%)' }} className="ml-2">· {unknownAmountCount} unknown</span>
                                )}
                              </span>
                            </div>
                          )}
                          {hasMissingPods && (
                            <div
                              className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider cursor-help"
                              style={{ color: 'var(--phosphor)' }}
                              title={`R ${fmt(missingPodsValue)} across ${missingPodsCount} order${missingPodsCount === 1 ? '' : 's'} appears in BAT's Overview pivot but has no matching POD in the Delivery POD sheet of this upload — no extraction row was created.${missingPodsUnknown > 0 ? ` ${missingPodsUnknown} of those order${missingPodsUnknown === 1 ? '' : 's'} has NO declared amount in the Overview pivot — the R value understates true exposure by whatever those amounts turn out to be.` : ''} The Missing PODs tab on the audit trail lists each one. Chase BAT for the POD or accept the shortfall.`}
                            >
                              <span>Missing PODs</span>
                              <span className="tabular-nums">
                                R {fmt(missingPodsValue)}
                                <span className="text-muted-subtle ml-2">{missingPodsCount} order{missingPodsCount === 1 ? '' : 's'}</span>
                                {missingPodsUnknown > 0 && (
                                  <span style={{ color: 'hsl(33 70% 60%)' }} className="ml-2">· {missingPodsUnknown} unknown</span>
                                )}
                              </span>
                            </div>
                          )}
                          {needsReupload && (
                            <div
                              className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider cursor-help"
                              style={{ color: 'hsl(33 70% 60%)' }}
                              title="This recon predates the Overview-pivot persistence migration (v72). Missing-POD detection needs the spreadsheet's Overview ODR list, which is only recorded by uploads after v72 was deployed. Re-upload the same supplier spreadsheet to populate bat_overview_orders for this recon — the upload path does it automatically going forward."
                            >
                              <span>Missing PODs</span>
                              <span className="tabular-nums opacity-90">Re-upload to verify</span>
                            </div>
                          )}
                          {hasDups && (
                            <div
                              className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider cursor-help"
                              style={{ color: 'hsl(33 70% 60%)' }}
                              title={`${dupCount} invoice number${dupCount === 1 ? '' : 's'} OCR'd successfully on multiple distinct PDFs in this recon. Inflation R ${fmt(dupInflation)} = extra amount this duplication adds to the OCR-verified figure beyond keeping one representative row per invoice. Typically a garbled barcode prefix that consistently mis-reads to the same number.`}
                            >
                              <span>Dup invoices</span>
                              <span className="tabular-nums">
                                {dupCount}
                                <span className="text-muted-subtle ml-2">+R {fmt(dupInflation)}</span>
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
        <span className="text-muted-subtle mr-1">R</span>{value}
      </span>
    </div>
  );
}
