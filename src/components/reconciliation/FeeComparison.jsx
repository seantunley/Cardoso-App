import React from 'react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

const fmt = (v) => {
  const abs = Math.abs(v || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Suppress minus when the rounded absolute value is effectively zero
  return v < 0 && Math.abs(v) >= 0.005 ? `−${abs}` : abs;
};

function ragMeta(status) {
  if (status === 'green') return { color: 'hsl(145 55% 45%)', label: 'Match',    glyph: '●', tip: 'BAT and Sage agree on this fee within R 0.01.' };
  if (status === 'amber') return { color: 'var(--phosphor)', label: 'Close', glyph: '◐', tip: 'Minor variance — within tolerance but worth a glance.' };
  return                         { color: 'hsl(var(--destructive))', label: 'Mismatch', glyph: '▲', tip: 'Material difference between what BAT claimed and what Sage captured. Needs investigation.' };
}

export default function FeeComparison({ comparison, creditNotes }) {
  if (!comparison?.length) {
    return (
      <section>

        <div
          className="border py-10 text-center"
          style={{ borderColor: 'hsl(var(--border))', background: 'hsl(var(--card))', borderRadius: '12px' }}
        >
          <p className="text-sm text-muted-foreground">
            No fee comparison data. Query Sage 300 first.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-5">
      <div>

        <h3 className="font-display text-3xl leading-tight text-foreground">
          BAT <em className="text-muted-foreground">vs</em> Sage.
        </h3>
      </div>

      <div
        className="border bg-card overflow-hidden"
        style={{ borderColor: 'hsl(var(--border))', borderRadius: '12px' }}
      >
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid hsl(var(--border))' }}>
              <Th align="left">Fee Type</Th>
              <Th align="right">BAT (excl VAT)</Th>
              <Th align="right">Sage 300</Th>
              <Th align="right">Difference</Th>
              <Th align="center">Status</Th>
            </tr>
          </thead>
          <tbody>
            {comparison.map((row, i) => {
              const rag = ragMeta(row.status);
              return (
                <tr
                  key={i}
                  className="border-t transition-colors hover:bg-muted/30"
                  style={{ borderColor: 'hsl(var(--border))' }}
                >
                  <td className="px-4 py-3 text-foreground font-medium">{row.type}</td>
                  <td className="px-4 py-3 text-right font-mono text-foreground tabular-nums">
                    <span className="text-muted-foreground/60 mr-1">R</span>
                    {fmt(row.supplier)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-foreground tabular-nums">
                    <span className="text-muted-foreground/60 mr-1">R</span>
                    {fmt(row.sage)}
                  </td>
                  <td
                    className="px-4 py-3 text-right font-mono tabular-nums"
                    style={{ color: rag.color }}
                  >
                    <span className="opacity-60 mr-1">R</span>
                    {fmt(row.difference)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.15em] cursor-help"
                          style={{ color: rag.color }}
                        >
                          <span>{rag.glyph}</span>
                          {rag.label}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{rag.tip}</TooltipContent>
                    </Tooltip>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {creditNotes?.length > 0 && (
        <details
          className="border bg-card p-4 group"
          style={{ borderColor: 'hsl(var(--border))', borderRadius: '12px' }}
        >
          <summary className="font-mono text-[10px] uppercase tracking-[0.2em] cursor-pointer text-muted-foreground hover:text-accent transition-colors list-none flex items-center gap-2">
            <span className="inline-block transition-transform group-open:rotate-90">›</span>
            Sage Credit Note Details · {creditNotes.length} lines
          </summary>
          <div className="mt-4 overflow-auto max-h-72 border-t border-border pt-3">
            <table className="w-full text-xs">
              <thead>
                <tr style={{ borderBottom: '1px solid hsl(var(--border))' }}>
                  <Th align="left" small>Batch</Th>
                  <Th align="left" small>Status</Th>
                  <Th align="left" small>Document</Th>
                  <Th align="left" small>Description</Th>
                  <Th align="left" small>Fee Type</Th>
                  <Th align="right" small>Amount</Th>
                </tr>
              </thead>
              <tbody>
                {creditNotes.map((cn, i) => (
                  <tr
                    key={i}
                    className="border-t"
                    style={{ borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                  >
                    <td className="px-3 py-2 font-mono tabular-nums">{cn.batch_number}</td>
                    <td className="px-3 py-2 text-muted-foreground">{cn.batch_status}</td>
                    <td className="px-3 py-2 font-mono">{cn.document_number}</td>
                    <td className="px-3 py-2 truncate max-w-48 text-muted-foreground">{cn.line_description}</td>
                    <td className="px-3 py-2 text-muted-foreground">{cn.fee_type}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      <span className="text-muted-foreground/60 mr-1">R</span>
                      {fmt(cn.line_amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

function Th({ children, align = 'left', small = false }) {
  return (
    <th
      className={`${small ? 'px-3 py-2' : 'px-4 py-3'} text-${align} font-mono text-[10px] uppercase tracking-[0.2em] font-medium text-muted-foreground`}
    >
      {children}
    </th>
  );
}
