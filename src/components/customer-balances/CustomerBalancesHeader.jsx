// Page header for CustomerBalances — the title, subtitle (filter
// summary) and the Print / Refresh button pair. Pulled out so the
// page render stays focused on data wiring.
export default function CustomerBalancesHeader({ subtitleParts, rowsEmpty, onPrint, onRefresh }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8 pb-5 border-b border-border">
      <div>

        <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
          Customer <em className="text-phosphor">balances</em>.
        </h1>
        <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground mt-3">{subtitleParts.join(" · ")}</p>
      </div>
      <div className="flex items-center gap-2 cb-no-print">
        <button
          onClick={onPrint}
          disabled={rowsEmpty}
          className="flex items-center gap-2 border px-4 py-2 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-h-[40px]"
          style={{
            borderRadius: "12px",
            borderColor: 'var(--phosphor)',
            color: 'var(--phosphor)',
            background: 'hsla(33, 95%, 55%, 0.08)',
          }}
          onMouseEnter={(e) => {
            if (e.currentTarget.disabled) return;
            e.currentTarget.style.background = 'hsla(33, 95%, 55%, 0.18)';
            e.currentTarget.style.boxShadow = '0 0 12px hsla(33,95%,55%,0.35)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'hsla(33, 95%, 55%, 0.08)';
            e.currentTarget.style.boxShadow = 'none';
          }}
          title="Print or save as PDF"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="6 9 6 2 18 2 18 9"/>
            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
            <rect x="6" y="14" width="12" height="8"/>
          </svg>
          Print / PDF
        </button>
        <button
          onClick={onRefresh}
          className="flex items-center gap-2 border border-border bg-card px-4 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground transition-colors min-h-[40px]"
          style={{ borderRadius: "12px" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = 'var(--phosphor)';
            e.currentTarget.style.color = 'var(--phosphor)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'hsl(var(--border))';
            e.currentTarget.style.color = 'hsl(var(--muted-foreground))';
          }}
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M23 4v6h-6M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
          Refresh
        </button>
      </div>
    </div>
  );
}
