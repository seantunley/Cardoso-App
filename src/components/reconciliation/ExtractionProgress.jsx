import React from 'react';
import { Loader2 } from 'lucide-react';

function fmtElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

export default function ExtractionProgress({ progress }) {
  if (!progress) return null;
  const pct = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;
  const inFlight = Array.isArray(progress.in_flight) ? progress.in_flight : [];

  return (
    <div
      className="relative overflow-hidden border border-border bg-card p-5 space-y-3"
      style={{ borderRadius: '12px' }}
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

      {/* Live "currently processing" list. Without this, the progress bar
          hits 97% with the last few PDFs running and looks frozen. Showing
          which row is in-flight (with elapsed time) makes it obvious whether
          the worker is still chewing or actually stuck. Rows past 60s render
          in amber, past 90s in red — operator-visible cue without needing
          to open the System Log. */}
      {progress.running && inFlight.length > 0 && (
        <div className="pl-2 pt-1 space-y-1">
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
            Currently processing · {inFlight.length}
          </div>
          {inFlight.map((row) => {
            const slow  = row.elapsed_seconds >= 60;
            const stuck = row.elapsed_seconds >= 90;
            const color = stuck ? 'text-destructive' : slow ? 'text-amber-400' : 'text-muted-foreground';
            // Stage badge — same colour rules as the row, but the threshold is
            // measured against time-in-current-stage so we surface "stuck on
            // engine:Tesseract for 80s" even on a row that's only been alive
            // for 90s overall. That's the signal that pinpoints what's wedged.
            const stageStuck = row.stage_at_seconds != null && row.stage_at_seconds >= 60;
            const stageColor = stageStuck ? 'text-destructive' : 'text-muted-foreground/70';
            return (
              <div key={row.id} className="flex items-center justify-between font-mono text-[11px]">
                <span className={`truncate ${color}`}>
                  #{row.id} · {row.store_name || 'unknown'}
                  {row.stage && (
                    <span className={`ml-1.5 ${stageColor}`}>
                      · {row.stage}
                      {row.stage_at_seconds != null && row.stage_at_seconds >= 5 && (
                        <span className="ml-1 opacity-70">({row.stage_at_seconds}s)</span>
                      )}
                    </span>
                  )}
                </span>
                <span className={`tabular-nums ml-3 shrink-0 ${color}`}>{fmtElapsed(row.elapsed_seconds)}</span>
              </div>
            );
          })}
        </div>
      )}

      {progress.error && (
        <p className="pl-2 font-mono text-xs text-destructive">Error: {progress.error}</p>
      )}
    </div>
  );
}
