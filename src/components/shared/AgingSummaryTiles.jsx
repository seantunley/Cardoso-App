// Aging summary tiles — a "Total Outstanding" headline plus one tile per aging
// period (amount + entity count + a coloured accent bar). Shared by the
// Customer Balances (A/R) and Creditor Balances (A/P) screens; each passes its
// own period set so the same component renders weekly or monthly buckets.
//
// `aging` is the { buckets, bucket_counts, total_outstanding } object the
// /api/top-balances and /api/creditors endpoints return from the shared aging
// engine, so these tiles always agree with the Aged Debtors / Aged Creditors
// reports.

const za = (n) => `R ${(Number(n) || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Tile({ label, value, sub, accent = 'var(--phosphor)', big = false }) {
  return (
    <div
      className="relative overflow-hidden bg-card p-4 min-h-[100px]"
      style={{ border: '1px solid hsl(var(--border))', borderRadius: '12px' }}
    >
      <div className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: accent, boxShadow: `0 0 10px ${accent}30` }} />
      <div className="pl-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground mb-1.5">{label}</div>
        <div className={`font-display ${big ? 'text-3xl' : 'text-2xl'} leading-none text-foreground tabular-nums`}>{value}</div>
        {sub != null && <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mt-1.5">{sub}</div>}
      </div>
    </div>
  );
}

export default function AgingSummaryTiles({ aging, tiles, entityWord = 'cust', className = '' }) {
  if (!aging) return null;
  return (
    <div className={`mb-4 grid gap-4 grid-cols-2 lg:grid-cols-5 ${className}`}>
      <Tile label="Total Outstanding" value={za(aging.total_outstanding)} big />
      {tiles.map((t) => (
        <Tile
          key={t.key}
          label={t.label}
          value={za(aging.buckets?.[t.key])}
          sub={`${(aging.bucket_counts?.[t.key] ?? 0).toLocaleString('en-ZA')} ${entityWord}`}
          accent={t.color}
        />
      ))}
    </div>
  );
}
