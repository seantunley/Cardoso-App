import React, { memo, useDeferredValue, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

// Cross-reference tab of the BAT Reconciliation page. Split out of
// Reconciliation.jsx because /api/bat/cardoso-match returns every Cardoso
// invoice ever (grows forever): rendered inline, every keystroke anywhere on
// that page re-derived the counts/filters and re-rendered every row. Here the
// panel is memoized on `match`, owns its own filter state, memoizes the
// derived data, and virtualizes the rows.

const COLS = 12;
const fmtR = (v) => (v != null ? `R ${v.toFixed(2)}` : '—');

// extraction_id is unique per BAT row; Cardoso-only rows have no extraction
// but a unique cardoso_id (see services/bat/matching.js).
const rowKey = (r) => (r.extraction_id != null ? `e${r.extraction_id}` : `c${r.cardoso_id}`);

/** Pure filter used by the panel (exported for tests). */
export function deriveCrossref(allRows, year, week, invoice) {
  const invCounts = new Map();
  for (const r of allRows) {
    if (r.extraction_id && r.invoice_number) {
      const k = String(r.invoice_number).toUpperCase();
      invCounts.set(k, (invCounts.get(k) || 0) + 1);
    }
  }
  const availableYears = Array.from(new Set(allRows.map(r => r.year).filter(Boolean))).sort((a, b) => b - a);
  const yearScope = year === 'all' ? allRows : allRows.filter(r => String(r.year) === String(year));
  const availableWeeks = Array.from(new Set(yearScope.map(r => r.week_number).filter(v => v != null))).sort((a, b) => a - b);
  const invSearch = invoice.trim().toUpperCase();
  const filteredRows = yearScope.filter(r =>
    (week === 'all' || String(r.week_number) === String(week)) &&
    (!invSearch || String(r.invoice_number || '').toUpperCase().includes(invSearch))
  );
  return { invCounts, availableYears, availableWeeks, filteredRows };
}

function CrossrefPanel({ match }) {
  const [year, setYear] = useState('all');
  const [week, setWeek] = useState('all');
  const [invoice, setInvoice] = useState('');
  const deferredInvoice = useDeferredValue(invoice);
  const scrollRef = useRef(null);

  const allRows = useMemo(() => match.results || [], [match.results]);
  // Counts + year list depend only on the data; split from the filter pass so
  // typing doesn't recount duplicates.
  const { invCounts, availableYears } = useMemo(() => deriveCrossref(allRows, 'all', 'all', ''), [allRows]);
  const { availableWeeks, filteredRows } = useMemo(
    () => deriveCrossref(allRows, year, week, deferredInvoice),
    [allRows, year, week, deferredInvoice],
  );
  const filterActive = year !== 'all' || week !== 'all' || invoice.trim() !== '';
  const currentYear = new Date().getFullYear();

  const virtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 31,
    overscan: 12,
  });
  const items = virtualizer.getVirtualItems();
  const paddingTop = items.length ? items[0].start : 0;
  const paddingBottom = items.length ? virtualizer.getTotalSize() - items[items.length - 1].end : 0;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-5 stagger-in">
        <MatchTile label="Matched" value={match.stats.matched} color="hsl(var(--status-ok))" />
        <MatchTile label="Auto-Corrected" value={match.stats.autoCorrections || 0} color="hsl(200 80% 55%)" />
        <MatchTile label="Amount Mismatches" value={match.stats.mismatches} color="var(--phosphor)" />
        <MatchTile label="BAT Only" value={match.stats.unmatchedSupplier} color="hsl(var(--muted-foreground))" />
        <MatchTile label="Cardoso Only" value={match.stats.unmatchedCardoso} color="hsl(var(--destructive))" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Filter</span>
        <select
          value={year}
          onChange={(e) => { setYear(e.target.value); setWeek('all'); }}
          className="bg-card border border-border text-foreground px-2 py-1.5 font-mono text-xs tabular-nums focus:border-accent outline-none"
          style={{ borderRadius: '12px' }}
        >
          <option value="all">All years</option>
          {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <select
          value={week}
          onChange={(e) => setWeek(e.target.value)}
          className="bg-card border border-border text-foreground px-2 py-1.5 font-mono text-xs tabular-nums focus:border-accent outline-none"
          style={{ borderRadius: '12px' }}
        >
          <option value="all">All weeks</option>
          {availableWeeks.map(w => <option key={w} value={w}>Week {w}</option>)}
        </select>
        <input
          type="text"
          placeholder="Invoice #"
          value={invoice}
          onChange={(e) => setInvoice(e.target.value)}
          className="bg-card border border-border text-foreground px-2 py-1.5 font-mono text-xs tabular-nums focus:border-accent outline-none w-32"
          style={{ borderRadius: '12px' }}
        />
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground tabular-nums">
          {filteredRows.length} of {allRows.length} row{allRows.length !== 1 ? 's' : ''}
        </span>
        {filterActive && (
          <button
            onClick={() => { setYear('all'); setWeek('all'); setInvoice(''); }}
            className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent hover:text-foreground transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      <div ref={scrollRef} className="border overflow-auto max-h-[32rem]" style={{ borderColor: 'hsl(var(--border))', borderRadius: '12px' }}>
        <table className="min-w-full text-xs">
          <thead className="sticky top-0 z-10" style={{ background: 'hsl(24 8% 11%)' }}>
            <tr>
              <th className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">Invoice</th>
              <th className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">Week</th>
              <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">BAT Total</th>
              <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">S.Pricing</th>
              <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">S.Discount</th>
              <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">S.DelFee</th>
              <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">Cardoso Total</th>
              <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">C.PriceDiff</th>
              <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">C.Discount</th>
              <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">C.DelFee</th>
              <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">Difference</th>
              <th className="px-2 py-2 text-center font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground whitespace-nowrap">Status</th>
            </tr>
          </thead>
          <tbody>
            {paddingTop > 0 && <tr aria-hidden="true"><td colSpan={COLS} style={{ height: paddingTop, padding: 0, border: 0 }} /></tr>}
            {items.map((vi) => {
              const r = filteredRows[vi.index];
              return (
                <CrossrefRow
                  key={rowKey(r)}
                  r={r}
                  index={vi.index}
                  measureRef={virtualizer.measureElement}
                  dupCount={r.invoice_number ? (invCounts.get(String(r.invoice_number).toUpperCase()) || 0) : 0}
                  currentYear={currentYear}
                />
              );
            })}
            {paddingBottom > 0 && <tr aria-hidden="true"><td colSpan={COLS} style={{ height: paddingBottom, padding: 0, border: 0 }} /></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

const CrossrefRow = memo(function CrossrefRow({ r, index, measureRef, dupCount, currentYear }) {
  return (
    <tr
      ref={measureRef}
      data-index={index}
      className="border-t transition-colors hover:bg-muted/30"
      style={{
        borderColor: 'hsl(var(--border))',
        background: r.amount_mismatch ? 'hsla(33, 95%, 55%, 0.04)' : 'hsl(var(--card))',
      }}
    >
      <td className="px-2 py-1.5 font-mono tabular-nums text-foreground whitespace-nowrap">
        {r.invoice_number}
        {r.is_exception ? <span className="ml-1.5 font-mono text-[9px] uppercase tracking-[0.15em] px-1.5 py-0.5" style={{ color: 'hsl(280 70% 65%)', background: 'hsla(280,70%,55%,0.1)' }}>Exception</span> : null}
        {r.auto_corrected && <span className="ml-1.5 font-mono text-[9px] uppercase tracking-[0.15em] px-1 py-0.5" style={{ color: 'hsl(200 80% 55%)', background: 'hsla(200,80%,55%,0.1)' }}>fixed</span>}
        {dupCount > 1 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="ml-1.5 font-mono text-[9px] uppercase tracking-[0.15em] px-1 py-0.5 cursor-help" style={{ color: 'hsl(var(--destructive))', background: 'hsl(var(--status-critical) / 0.12)', border: '1px solid hsl(var(--status-critical) / 0.4)', borderRadius: '12px' }}>×{dupCount} dup</span>
            </TooltipTrigger>
            <TooltipContent>This invoice number appears on {dupCount} different POD extractions — at least {dupCount - 1} are wrong.</TooltipContent>
          </Tooltip>
        ) : null}
      </td>
      <td className="px-2 py-1.5 font-mono tabular-nums text-muted-foreground whitespace-nowrap">
        <span className="inline-flex items-center gap-1.5">
          <span>{r.week_number ? `W${r.week_number}/${r.year}` : '—'}</span>
          {r.delivery_date && parseInt(r.delivery_date) < currentYear && (
            <span className="font-mono text-[9px] uppercase tracking-[0.15em] px-1.5 py-0.5" style={{ color: 'hsl(var(--status-critical))', background: 'hsl(var(--status-critical) / 0.1)' }}>Delivered last year</span>
          )}
        </span>
      </td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-foreground">{fmtR(r.supplier_amount)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">{fmtR(r.supplier_pricing)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">{fmtR(r.supplier_discount)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">{fmtR(r.supplier_del_fee)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-foreground">{fmtR(r.cardoso_amount)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">{fmtR(r.cardoso_price_diff)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">{fmtR(r.cardoso_discount)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">{fmtR(r.cardoso_del_fee)}</td>
      <td className="px-2 py-1.5 text-right font-mono tabular-nums" style={{
        color: r.difference == null ? 'hsl(var(--muted-foreground))' : Math.abs(r.difference) < 0.01 ? 'hsl(var(--status-ok))' : 'hsl(var(--destructive))',
      }}>
        {fmtR(r.difference)}
      </td>
      <td className="px-2 py-1.5 text-center">
        {r.matched ? (
          r.amount_mismatch ? (
            <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-accent">◐ Mismatch</span>
          ) : (
            <span className="font-mono text-[10px] uppercase tracking-[0.15em]" style={{ color: 'hsl(var(--status-ok))' }}>● Match</span>
          )
        ) : r.extraction_id ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">○ BAT only</span>
        ) : (
          <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-destructive">▲ Cardoso only</span>
        )}
      </td>
    </tr>
  );
});

function MatchTile({ label, value, color }) {
  return (
    <div
      className="relative bg-card border border-border p-4 overflow-hidden"
      style={{ borderRadius: '14px', boxShadow: '0 1px 2px rgba(0,0,0,0.25)' }}
    >
      <div
        className="absolute left-0 right-0 bottom-0 h-[2px]"
        style={{ background: color, boxShadow: `0 0 10px ${color}40` }}
      />
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-1.5">{label}</div>
        <div className="font-display text-3xl leading-none tabular-nums" style={{ color }}>{value}</div>
      </div>
    </div>
  );
}

export default memo(CrossrefPanel);
