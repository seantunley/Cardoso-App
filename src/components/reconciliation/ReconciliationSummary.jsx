import React from 'react';

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
      <div>
        <div
          className={`font-display leading-none text-foreground tabular-nums ${large ? 'text-5xl lg:text-6xl' : 'text-4xl'}`}
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
  const fmt = (v) => {
    const abs = Math.abs(v || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return v < 0 && Math.abs(v) >= 0.005 ? `−${abs}` : abs;
  };
  const variance = (recon.supplier_total || 0) - (recon.sage_total || 0);
  const absVariance = Math.abs(variance);
  const matched = absVariance < 0.01;
  const stats = recon.extractionStats || {};
  const needsAttention = stats.needsAttention || 0;
  const attentionRate = stats.total > 0 ? ((needsAttention / stats.total) * 100).toFixed(1) : '0.0';

  return (
    <section>
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-5">
        § Summary
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 stagger-in">
        <Tile
          label="BAT Total"
          value={<><span className="text-muted-foreground/60 text-3xl mr-1.5">R</span>{fmt(recon.supplier_total)}</>}
          sub={`Week ${recon.week_number}`}
        />
        <Tile
          label="Sage Total"
          value={<><span className="text-muted-foreground/60 text-3xl mr-1.5">R</span>{fmt(recon.sage_total)}</>}
          sub={`${recon.creditNotes?.length || 0} credit note lines`}
          accent="hsl(145 55% 45%)"
          glow="hsla(145, 55%, 45%, 0.25)"
        />
        <Tile
          label="Variance"
          value={<><span className="text-muted-foreground/60 text-3xl mr-1.5">R</span>{fmt(variance)}</>}
          sub={matched ? 'Matched' : variance > 0 ? 'BAT higher' : 'Sage higher'}
          accent={matched ? 'hsl(145 55% 45%)' : 'hsl(var(--destructive))'}
          glow={matched ? 'hsla(145, 55%, 45%, 0.25)' : 'hsla(0, 72%, 50%, 0.3)'}
        />
        <Tile
          label="Needs Attention"
          value={<>{attentionRate}<span className="text-muted-foreground/60 text-3xl ml-1">%</span></>}
          sub={`${needsAttention}/${stats.total || 0} invoices · ${(stats.notFound || 0) + (stats.failed || 0)} OCR fail · ${stats.duplicateExtractions || 0} dup`}
          accent={needsAttention > 0 ? 'hsl(var(--destructive))' : 'hsl(145 55% 45%)'}
          glow={needsAttention > 0 ? 'hsla(0, 72%, 50%, 0.3)' : 'hsla(145, 55%, 45%, 0.25)'}
        />
      </div>
    </section>
  );
}
