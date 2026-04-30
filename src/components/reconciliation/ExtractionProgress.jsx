import React from 'react';
import { Loader2 } from 'lucide-react';

export default function ExtractionProgress({ progress }) {
  if (!progress) return null;
  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;

  return (
    <div
      className="relative border border-border bg-card p-5 space-y-3"
      style={{ borderRadius: '2px' }}
    >
      <div
        className="absolute left-0 top-0 bottom-0 w-[2px]"
        style={{ background: 'var(--phosphor)', boxShadow: '0 0 12px hsla(33, 95%, 55%, 0.35)' }}
      />
      <div className="pl-2 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          {progress.running && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" strokeWidth={1.5} />
          )}
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
            {progress.running ? 'Extracting invoices from PDFs' : 'Extraction complete'}
          </span>
        </div>
        <span className="font-mono text-xs text-foreground tabular-nums">
          {progress.processed}<span className="text-muted-foreground/50">/{progress.total}</span>
          <span className="text-accent ml-2">{pct}%</span>
        </span>
      </div>
      <div className="pl-2">
        <div className="h-[2px] bg-muted overflow-hidden">
          <div
            className="h-full transition-all duration-300"
            style={{
              width: `${pct}%`,
              background: 'var(--phosphor)',
              boxShadow: '0 0 8px hsla(33, 95%, 55%, 0.4)',
            }}
          />
        </div>
      </div>
      {progress.error && (
        <p className="pl-2 font-mono text-xs text-destructive">Error: {progress.error}</p>
      )}
    </div>
  );
}
