import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Search, Package, CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";

// Inventory movement history ("stock card"): pick an item → see every movement
// (sales, receipts, credits/returns, adjustments, write-offs, transfers) with a
// running balance that ANCHORS to and reconciles with current on-hand. Opening
// is derived from on-hand, so it ties out even though Sage purges old history.

async function apiFetch(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

const fmtQty = (v) => {
  if (v == null) return "—";
  const n = Math.round(Number(v) * 1000) / 1000;
  return n.toLocaleString("en-ZA", { maximumFractionDigits: 3 });
};
const fmtR = (v) => (v == null ? "—" : `R ${(Number(v) || 0).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

// Colour movements by direction so a stock card scans quickly.
function typeColor(label) {
  if (/Sale|Write-off|decrease|Transfer out/.test(label || "")) return "hsl(0 72% 55%)"; // out — red
  if (/Receipt|Credit|increase|Transfer in/.test(label || "")) return "hsl(145 55% 45%)"; // in — green
  return "hsl(var(--muted-foreground))";
}

export default function MovementHistoryView() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState(/** @type {{item_number:string, location:string, item_description?:string}|null} */ (null));
  const [from, setFrom] = useState(() => {
    const d = new Date(); d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));

  const itemsQuery = useQuery({
    queryKey: ["inv-movement-items", search],
    queryFn: () => apiFetch(`/api/inventory-movement/movement-items?q=${encodeURIComponent(search)}`),
    enabled: search.trim().length >= 1 && !picked,
    staleTime: 30_000,
  });

  const ledgerQuery = useQuery({
    queryKey: ["inv-item-ledger", picked?.item_number, picked?.location, from, to],
    queryFn: () => apiFetch(`/api/inventory-movement/item-ledger?item=${encodeURIComponent(picked.item_number)}&location=${encodeURIComponent(picked.location)}&from=${from}&to=${to}`),
    enabled: !!picked,
  });

  const metaQuery = useQuery({
    queryKey: ["inv-movement-sync-meta"],
    queryFn: () => apiFetch(`/api/inventory-movement/movement-sync-meta`),
    staleTime: 30_000,
  });
  const syncMutation = useMutation({
    mutationFn: () => fetch(`/api/inventory-movement/sync-movement`, { method: "POST", credentials: "include" }).then(async (r) => {
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      return d;
    }),
    onSuccess: (d) => {
      toast.success(`Synced ${d.inserted?.toLocaleString?.() || d.inserted} new movements · ${d.onhand} on-hand`);
      qc.invalidateQueries({ queryKey: ["inv-movement-sync-meta"] });
      qc.invalidateQueries({ queryKey: ["inv-item-ledger"] });
      qc.invalidateQueries({ queryKey: ["inv-movement-items"] });
    },
    onError: (e) => toast.error(`Sync failed: ${e.message}`),
  });
  const meta = metaQuery.data;

  const ledger = ledgerQuery.data;
  const totals = useMemo(() => {
    const rows = ledger?.movements || [];
    let inQty = 0, outQty = 0;
    for (const m of rows) { const q = Number(m.stock_qty) || 0; if (q >= 0) inQty += q; else outQty += q; }
    return { inQty, outQty };
  }, [ledger]);

  return (
    <div className="space-y-4">
      {/* Sync status */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-2.5">
        <div className="text-xs text-muted-foreground">
          {meta?.last_synced_at
            ? <>Movement history synced <span className="text-foreground">{meta.last_synced_at}</span> · <span className="tabular-nums">{Number(meta.movement_rows || 0).toLocaleString()}</span> movements · from <span className="tabular-nums">{meta.history_from || "—"}</span></>
            : "Movement history not synced yet — run a sync to pull from Sage."}
        </div>
        <button
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending}
          className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          title="Pull new I/C transaction history from Sage (incremental after the first run)"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${syncMutation.isPending ? "animate-spin" : ""}`} />
          {syncMutation.isPending ? "Syncing…" : "Sync movement history"}
        </button>
      </div>

      {/* Item picker */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="relative flex-1 min-w-[260px]">
            <label className="mb-1 block text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">Item</label>
            <Search className="absolute left-3 top-[34px] h-4 w-4 text-muted-foreground pointer-events-none" />
            <input
              value={picked ? `${picked.item_number} — ${picked.item_description || ""}` : search}
              onChange={(e) => { setPicked(null); setSearch(e.target.value); }}
              placeholder="Search item number or description…"
              className="h-10 w-full rounded-xl border border-border bg-background pl-9 pr-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
            {!picked && search.trim() && (itemsQuery.data?.rows?.length > 0) && (
              <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-auto rounded-xl border border-border bg-card shadow-lg">
                {itemsQuery.data.rows.map((r) => (
                  <button
                    key={`${r.item_number}/${r.location}`}
                    type="button"
                    onClick={() => { setPicked(r); setSearch(""); }}
                    className="flex w-full items-center justify-between gap-3 border-b border-border/60 px-3 py-2 text-left last:border-0 hover:bg-muted/40"
                  >
                    <span className="min-w-0">
                      <span className="font-mono text-xs text-foreground">{r.item_number}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{r.item_description || "—"}</span>
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{r.location} · on hand {fmtQty(r.qty_on_hand)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground" />
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground" />
          </div>
        </div>
      </div>

      {!picked && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card px-6 py-16 text-center">
          <Package className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Search and pick an item to see its movement history and stock-on-hand reconciliation.</p>
        </div>
      )}

      {picked && ledgerQuery.isLoading && <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />}
      {picked && ledgerQuery.error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">{ledgerQuery.error.message}</div>
      )}

      {picked && ledger && (
        <>
          {/* Reconciliation summary */}
          <div className="grid gap-3 sm:grid-cols-4">
            <Tile label="Opening balance" value={fmtQty(ledger.opening_balance)} sub={`as at ${from}`} />
            <Tile label="Movements in window" value={`${fmtQty(totals.inQty)} in · ${fmtQty(totals.outQty)} out`} sub={`net ${fmtQty(ledger.window_net)}`} />
            <Tile label="Closing balance" value={fmtQty(ledger.closing_balance)} sub={`as at ${to}`} />
            <Tile
              label="Current on hand"
              value={fmtQty(ledger.on_hand)}
              sub={ledger.reconciles ? "Reconciles ✓" : `Variance ${fmtQty(ledger.reconcile_variance)}`}
              accent={ledger.reconciles ? "hsl(145 55% 45%)" : "hsl(0 72% 55%)"}
              icon={ledger.reconciles ? CheckCircle2 : AlertTriangle}
            />
          </div>

          {/* Ledger */}
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-xs">
              <thead className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Movement</th>
                  <th className="px-3 py-2 text-left">Document</th>
                  <th className="px-3 py-2 text-right">In</th>
                  <th className="px-3 py-2 text-right">Out</th>
                  <th className="px-3 py-2 text-right">Balance</th>
                  <th className="px-3 py-2 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-border bg-muted/20">
                  <td className="px-3 py-1.5 text-muted-foreground" colSpan={5}>Opening balance — as at {from}</td>
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{fmtQty(ledger.opening_balance)}</td>
                  <td />
                </tr>
                {ledger.movements.map((m, i) => {
                  const q = Number(m.stock_qty) || 0;
                  return (
                    <tr key={i} className="border-b border-border/60 last:border-0 hover:bg-muted/20">
                      <td className="px-3 py-1.5 font-mono text-muted-foreground">{m.transaction_date || "—"}</td>
                      <td className="px-3 py-1.5">
                        <span className="font-medium" style={{ color: typeColor(m.movement_type) }}>{m.movement_type}</span>
                        <span className="ml-1.5 text-[10px] text-muted-subtle">{m.app}/{m.transtype}</span>
                      </td>
                      <td className="px-3 py-1.5 font-mono text-muted-foreground">{m.doc_number || "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums" style={{ color: q > 0 ? "hsl(145 55% 45%)" : undefined }}>{q > 0 ? fmtQty(q) : ""}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums" style={{ color: q < 0 ? "hsl(0 72% 55%)" : undefined }}>{q < 0 ? fmtQty(-q) : ""}</td>
                      <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{fmtQty(m.balance)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{fmtR(m.cost)}</td>
                    </tr>
                  );
                })}
                {ledger.movements.length === 0 && (
                  <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">No movements in this window.</td></tr>
                )}
                <tr className="border-t border-border bg-muted/20">
                  <td className="px-3 py-1.5 font-medium" colSpan={5}>Closing balance — as at {to}{ledger.reconciles ? " · reconciles to on hand ✓" : ` · variance ${fmtQty(ledger.reconcile_variance)}`}</td>
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{fmtQty(ledger.closing_balance)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-subtle">
            The running balance is anchored to current on-hand and the opening is derived from it, so the card always ties to stock — Sage purges old transaction history, so a balance summed from zero would not.
          </p>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, sub, accent, icon: Icon }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between">
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{label}</div>
        {Icon && <Icon className="h-4 w-4" style={{ color: accent || "hsl(var(--muted-foreground))" }} />}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums text-foreground">{value}</div>
      {sub && <div className="mt-0.5 text-[11px]" style={{ color: accent || "hsl(var(--muted-foreground))" }}>{sub}</div>}
    </div>
  );
}
