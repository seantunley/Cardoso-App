import React, { useEffect, useRef } from 'react';
import { getVariancePersonality, launchLedgerConfetti } from '@/lib/fun';

function Tile({ label, value, sub, accent = 'var(--phosphor)', glow = 'hsla(33, 95%, 55%, 0.35)', large = false }) {
  return (
    <div
      className="relative bg-card border border-border p-6 min-h-[140px] flex flex-col justify-between group overflow-hidden"
      style={{ borderRadius: '14px', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }}
    >
      <div
        className="absolute left-0 right-0 bottom-0 h-[2px] transition-all"
        style={{ background: accent, boxShadow: `0 0 12px ${glow}` }}
      />
      <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
        {label}
      </div>
      <div style={{ containerType: 'inline-size' }}>
        <div
          className={`font-display leading-none text-foreground tabular-nums whitespace-nowrap ${large ? 'text-[clamp(1.5rem,14cqi,3.75rem)]' : 'text-[clamp(1.25rem,12cqi,2.25rem)]'}`}
        >
          {value}
        </div>
        {sub && (
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mt-2.5">
            {sub}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ReconciliationSummary({ recon }) {
  const celebratedRef = useRef(null);
  const fmt = (v) => {
    const abs = Math.abs(v || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return v < 0 && Math.abs(v) >= 0.005 ? `−${abs}` : abs;
  };
  const variance = (recon.supplier_total || 0) - (recon.sage_total || 0);
  const absVariance = Math.abs(variance);
  const matched = absVariance < 0.01;
  const variancePersonality = getVariancePersonality(variance);
  const stats = recon.extractionStats || {};
  const needsAttention = stats.needsAttention || 0;
  const attentionRate = stats.total > 0 ? ((needsAttention / stats.total) * 100).toFixed(1) : '0.0';
  // When zero invoices need attention, the literal "0.0%" reads like a
  // completion progress bar (where 0% would be bad). Show an explicit
  // all-clear instead so the healthy state isn't misread as broken.
  const allClear = needsAttention === 0 && (stats.total || 0) > 0;

  useEffect(() => {
    const reconciliationId = recon?.id || `${recon?.week_number || 'week'}-${recon?.supplier_total}-${recon?.sage_total}`;
    if (!matched || celebratedRef.current === reconciliationId) return;

    celebratedRef.current = reconciliationId;
    launchLedgerConfetti({ duration: 650, particleCount: 2 });
  }, [matched, recon?.id, recon?.sage_total, recon?.supplier_total, recon?.week_number]);

  return (
    <section className="relative">

      {matched && (
        <div className="absolute right-0 top-0 rotate-[-2deg] border border-accent/60 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.22em] text-accent shadow-[0_0_18px_hsla(33,95%,55%,0.16)]">
          Closed clean
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 stagger-in">
        <Tile
          label="BAT Total"
          value={<><span className="text-muted-subtle text-3xl mr-1.5">R</span>{fmt(recon.supplier_total)}</>}
          sub={`Week ${recon.week_number}`}
        />
        <Tile
          label="Sage Total"
          value={<><span className="text-muted-subtle text-3xl mr-1.5">R</span>{fmt(recon.sage_total)}</>}
          sub={`${recon.creditNotes?.length || 0} credit note lines`}
          accent="hsl(var(--status-ok))"
          glow="hsl(var(--status-ok) / 0.25)"
        />
        <Tile
          label="Variance"
          value={<><span className="text-muted-subtle text-3xl mr-1.5">R</span>{fmt(variance)}</>}
          sub={matched ? 'Perfect match' : variancePersonality || (variance > 0 ? 'BAT higher' : 'Sage higher')}
          accent={matched ? 'hsl(var(--status-ok))' : 'hsl(var(--destructive))'}
          glow={matched ? 'hsl(var(--status-ok) / 0.25)' : 'hsl(var(--status-critical) / 0.3)'}
        />
        <Tile
          label="Needs Attention"
          value={allClear
            ? <>All clear<span className="text-muted-subtle text-3xl ml-1">✓</span></>
            : <>{attentionRate}<span className="text-muted-subtle text-3xl ml-1">%</span></>}
          sub={allClear
            ? `${stats.total || 0}/${stats.total || 0} invoices OK · 0 OCR fail · 0 dup`
            : `${needsAttention}/${stats.total || 0} invoices · ${(stats.notFound || 0) + (stats.failed || 0)} OCR fail · ${stats.duplicateExtractions || 0} dup`}
          accent={needsAttention > 0 ? 'hsl(var(--destructive))' : 'hsl(var(--status-ok))'}
          glow={needsAttention > 0 ? 'hsl(var(--status-critical) / 0.3)' : 'hsl(var(--status-ok) / 0.25)'}
        />
      </div>
    </section>
  );
}
