import React from 'react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

const fmt = (v) => {
  const abs = Math.abs(v || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 && Math.abs(v) >= 0.005 ? `−${abs}` : abs;
};

function Tile({ label, value, sub, accent = 'var(--phosphor)', glow = 'hsla(33, 95%, 55%, 0.35)', tip }) {
  const labelEl = (
    <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground pl-2 cursor-help inline-block">
      {label}
    </div>
  );
  return (
    <div className="relative bg-card p-6 min-h-[140px] flex flex-col justify-between">
      <div
        className="absolute left-0 top-0 bottom-0 w-[2px]"
        style={{ background: accent, boxShadow: `0 0 12px ${glow}` }}
      />
      {tip ? (
        <Tooltip>
          <TooltipTrigger asChild>{labelEl}</TooltipTrigger>
          <TooltipContent side="top">{tip}</TooltipContent>
        </Tooltip>
      ) : labelEl}
      <div className="pl-2">
        <div className="font-display text-4xl leading-none text-foreground tabular-nums">
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
      <div
        className="grid gap-px bg-border border border-border sm:grid-cols-2 lg:grid-cols-4 stagger-in"
        style={{ borderRadius: '2px' }}
      >
        <Tile
          label="Total BAT"
          value={<><span className="text-muted-foreground/60 text-3xl mr-1.5">R</span>{fmt(summary.totalSupplier)}</>}
          sub="across all reconciliations"
          tip="Sum of every BAT supplier spreadsheet you've uploaded — what BAT says they owe in credit notes."
        />
        <Tile
          label="Total Sage"
          value={<><span className="text-muted-foreground/60 text-3xl mr-1.5">R</span>{fmt(summary.totalSage)}</>}
          sub="posted credit notes"
          accent="hsl(145 55% 45%)"
          glow="hsla(145, 55%, 45%, 0.25)"
          tip="Sum of all credit notes actually posted in Sage 300 against the BAT supplier this calendar year."
        />
        <Tile
          label="Total Variance"
          value={<><span className="text-muted-foreground/60 text-3xl mr-1.5">R</span>{fmt(summary.totalVariance)}</>}
          sub={matched ? 'fully reconciled' : summary.totalVariance > 0 ? 'supplier higher' : 'sage higher'}
          accent={matched ? 'hsl(145 55% 45%)' : 'hsl(var(--destructive))'}
          glow={matched ? 'hsla(145, 55%, 45%, 0.25)' : 'hsla(0, 72%, 50%, 0.3)'}
          tip="Total BAT − Total Sage. Positive = BAT is claiming more than Sage has captured. Negative = Sage has captured more than BAT claimed."
        />
        <Tile
          label="Invoice Match Rate"
          value={<>{(summary.matchRate || 0).toFixed(1)}<span className="text-muted-foreground/60 text-3xl ml-1">%</span></>}
          sub={`${summary.totalExactMatched || 0}/${summary.totalPods || 0} exact match · ${(summary.totalMatched || 0) - (summary.totalExactMatched || 0)} amount mismatch`}
          tip="Percentage of POD invoices we extracted that match a Cardoso invoice on BOTH number AND amount (within R 0.01). Number-only matches with the wrong amount are excluded."
        />
      </div>

    </div>
  );
}
