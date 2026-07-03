import React from 'react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

const fmt = (v) => {
  const abs = Math.abs(v || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 && Math.abs(v) >= 0.005 ? `−${abs}` : abs;
};

function Tile({ label, value, sub, accent = 'var(--phosphor)', glow = 'hsla(33, 95%, 55%, 0.35)', tip }) {
  const labelEl = (
    <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground cursor-help inline-block">
      {label}
    </div>
  );
  return (
    <div
      className="relative bg-card border border-border p-6 min-h-[140px] flex flex-col justify-between overflow-hidden"
      style={{ borderRadius: '14px', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }}
    >
      <div
        className="absolute left-0 right-0 bottom-0 h-[2px]"
        style={{ background: accent, boxShadow: `0 0 12px ${glow}` }}
      />
      {tip ? (
        <Tooltip>
          <TooltipTrigger asChild>{labelEl}</TooltipTrigger>
          <TooltipContent side="top">{tip}</TooltipContent>
        </Tooltip>
      ) : labelEl}
      <div style={{ containerType: 'inline-size' }}>
        <div className="font-display text-[clamp(1.25rem,12cqi,2.25rem)] leading-none text-foreground tabular-nums whitespace-nowrap">
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

export default function DashboardOverview({ data }) {
  if (!data?.summary) return null;

  const { summary } = data;
  const matched = Math.abs(summary.totalVariance || 0) < 1;

  return (
    <div className="space-y-8">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 stagger-in">
        <Tile
          label="Total BAT"
          value={<><span className="text-muted-subtle text-3xl mr-1.5">R</span>{fmt(summary.totalSupplier)}</>}
          sub="across all reconciliations"
          tip="Sum of every BAT supplier spreadsheet you've uploaded — what BAT says they owe in credit notes."
        />
        <Tile
          label="Total Sage"
          value={<><span className="text-muted-subtle text-3xl mr-1.5">R</span>{fmt(summary.totalSage)}</>}
          sub="posted credit notes"
          accent="hsl(var(--status-ok))"
          glow="hsl(var(--status-ok) / 0.25)"
          tip="Sum of all credit notes actually posted in Sage 300 against the BAT supplier this calendar year."
        />
        <Tile
          label="Total Variance"
          value={<><span className="text-muted-subtle text-3xl mr-1.5">R</span>{fmt(summary.totalVariance)}</>}
          sub={matched ? 'fully reconciled' : summary.totalVariance > 0 ? 'supplier higher' : 'sage higher'}
          accent={matched ? 'hsl(var(--status-ok))' : 'hsl(var(--destructive))'}
          glow={matched ? 'hsl(var(--status-ok) / 0.25)' : 'hsl(var(--status-critical) / 0.3)'}
          tip="Total BAT − Total Sage. Positive = BAT is claiming more than Sage has captured. Negative = Sage has captured more than BAT claimed."
        />
      </div>

    </div>
  );
}
