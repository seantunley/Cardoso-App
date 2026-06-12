import { useState, useMemo, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Search, Package, CheckCircle2, AlertTriangle, RefreshCw, History, ArrowDownLeft, ArrowUpRight } from "lucide-react";

// Inventory movement history ("stock card"): pick an item → see every movement
// (sales, receipts, credits/returns, adjustments, write-offs, transfers) with a
// running balance that ANCHORS to and reconciles with current on-hand. Opening
// is derived from on-hand, so it ties out even though Sage purges old history.
//
// The bulk sync only carries the recent window (30 days) so it stays fast and
// runs in the BACKGROUND (we poll for progress). Older history is pulled on
// demand for a single item via "Load full history".

async function apiFetch(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}
async function apiPost(url, body) {
  const res = await fetch(url, { method: "POST", credentials: "include", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
  return d;
}

const fmtQty = (v) => {
  if (v == null) return "—";
  const n = Math.round(Number(v) * 1000) / 1000;
  return n.toLocaleString("en-ZA", { maximumFractionDigits: 3 });
};
const fmtR = (v) => (v == null ? "—" : `R ${(Number(v) || 0).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

const daysAgoIso = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

// Classify a movement by direction so the stock card scans at a glance.
function direction(label) {
  if (/Sale|Write-off|decrease|Transfer out/i.test(label || "")) return "out";
  if (/Receipt|Purchase|Credit|Return|increase|Transfer in/i.test(label || "")) return "in";
  return "neutral";
}
const DIR_STYLE = {
  in: { color: "hsl(145 60% 42%)", bg: "hsl(145 60% 42% / 0.12)", Icon: ArrowDownLeft },
  out: { color: "hsl(0 72% 55%)", bg: "hsl(0 72% 55% / 0.12)", Icon: ArrowUpRight },
  neutral: { color: "hsl(var(--muted-foreground))", bg: "hsl(var(--muted) / 0.4)", Icon: null },
};

export default function MovementHistoryView() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState(/** @type {{item_number:string, location:string, item_description?:string}|null} */ (null));
  const [from, setFrom] = useState(() => daysAgoIso(30));
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

  // Poll the sync meta while a background sync is running so the bar updates live.
  const metaQuery = useQuery({
    queryKey: ["inv-movement-sync-meta"],
    queryFn: () => apiFetch(`/api/inventory-movement/movement-sync-meta`),
    refetchInterval: (q) => (q.state.data?.running ? 1500 : false),
    staleTime: 5_000,
  });
  const meta = metaQuery.data;
  const running = !!meta?.running;

  // When a background sync finishes, refresh the ledger + picker so new rows show.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      qc.invalidateQueries({ queryKey: ["inv-item-ledger"] });
      qc.invalidateQueries({ queryKey: ["inv-movement-items"] });
      if (meta?.last_error) toast.error(`Movement sync error: ${meta.last_error}`);
      else toast.success("Movement history sync finished");
    }
    wasRunning.current = running;
  }, [running, meta?.last_error, qc]);

  const syncMutation = useMutation({
    mutationFn: () => apiPost(`/api/inventory-movement/sync-movement`),
    onSuccess: () => {
      toast.info("Sync started — pulling the last 30 days from Sage in the background…");
      qc.invalidateQueries({ queryKey: ["inv-movement-sync-meta"] });
    },
    onError: (e) => toast.error(`Could not start sync: ${e.message}`),
  });

  // Deep history for the picked item only (cheap, index-seeked, runs inline).
  const itemSyncMutation = useMutation({
    mutationFn: () => apiPost(`/api/inventory-movement/sync-item-movement`, { item: picked.item_number, location: picked.location }),
    onSuccess: (d) => {
      toast.success(`Loaded ${d.inserted?.toLocaleString?.() ?? d.inserted} older rows · history back to ${d.earliest || "—"}`);
      if (d.earliest && d.earliest < from) setFrom(d.earliest);
      qc.invalidateQueries({ queryKey: ["inv-item-ledger"] });
    },
    onError: (e) => toast.error(`Load full history failed: ${e.message}`),
  });

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
          {running ? (
            <span className="inline-flex items-center gap-2 text-foreground">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              Syncing movement history… <span className="tabular-nums">{Number(meta?.inserted || 0).toLocaleString()}</span> new movements so far
            </span>
          ) : meta?.last_synced_at ? (
            <>Movement history synced <span className="text-foreground">{meta.last_synced_at}</span> · <span className="tabular-nums">{Number(meta.movement_rows || 0).toLocaleString()}</span> movements · last 30 days from <span className="tabular-nums">{meta.history_from || "—"}</span></>
          ) : (
            "Movement history not synced yet — run a sync to pull the last 30 days from Sage."
          )}
        </div>
        <button
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending || running}
          className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
          title="Pull the last 30 days of I/C transaction history from Sage in the background (incremental after the first run)"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${syncMutation.isPending || running ? "animate-spin" : ""}`} />
          {running ? "Syncing…" : "Sync movement history"}
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
          {picked && (
            <button
              onClick={() => itemSyncMutation.mutate()}
              disabled={itemSyncMutation.isPending}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-card px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
              title="Pull this item's FULL history from Sage (everything older than the 30-day window)"
            >
              <History className={`h-3.5 w-3.5 ${itemSyncMutation.isPending ? "animate-spin" : ""}`} />
              {itemSyncMutation.isPending ? "Loading…" : "Load full history"}
            </button>
          )}
        </div>
      </div>

      {!picked && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card px-6 py-16 text-center">
          <Package className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Search and pick an item to see its movement history and stock-on-hand reconciliation.</p>
          <p className="mt-1 text-xs text-muted-subtle">The window defaults to the last 30 days. Use “Load full history” to pull everything older for one item.</p>
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
              accent={ledger.reconciles ? "hsl(145 60% 42%)" : "hsl(0 72% 55%)"}
              icon={ledger.reconciles ? CheckCircle2 : AlertTriangle}
            />
          </div>

          {/* Ledger */}
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-card text-[10px] uppercase tracking-wider text-muted-foreground shadow-[0_1px_0_0_hsl(var(--border))]">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">Date</th>
                  <th className="px-4 py-2.5 text-left font-medium">Movement</th>
                  <th className="px-4 py-2.5 text-left font-medium">Document</th>
                  <th className="px-4 py-2.5 text-right font-medium">In</th>
                  <th className="px-4 py-2.5 text-right font-medium">Out</th>
                  <th className="px-4 py-2.5 text-right font-medium">Balance</th>
                  <th className="px-4 py-2.5 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                <tr className="bg-muted/40">
                  <td className="px-4 py-2 font-medium text-muted-foreground" colSpan={5}>Opening balance — as at {from}</td>
                  <td className="border-l border-border px-4 py-2 text-right font-semibold tabular-nums">{fmtQty(ledger.opening_balance)}</td>
                  <td />
                </tr>
                {ledger.movements.map((m, i) => {
                  const q = Number(m.stock_qty) || 0;
                  const dir = direction(m.movement_type);
                  const ds = DIR_STYLE[dir];
                  const prevDate = i > 0 ? ledger.movements[i - 1].transaction_date : null;
                  const showDate = m.transaction_date !== prevDate;
                  return (
                    <tr key={i} className="border-t border-border/50 transition-colors odd:bg-muted/[0.06] hover:bg-muted/30">
                      <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{showDate ? (m.transaction_date || "—") : ""}</td>
                      <td className="px-4 py-2">
                        <span
                          className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium"
                          style={{ color: ds.color, backgroundColor: ds.bg }}
                        >
                          {ds.Icon && <ds.Icon className="h-3 w-3" />}
                          {m.movement_type}
                        </span>
                        <span className="ml-1.5 text-[10px] text-muted-subtle">{m.app}/{m.transtype}</span>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{m.doc_number || "—"}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium" style={{ color: q > 0 ? "hsl(145 60% 42%)" : undefined }}>{q > 0 ? fmtQty(q) : ""}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium" style={{ color: q < 0 ? "hsl(0 72% 55%)" : undefined }}>{q < 0 ? fmtQty(-q) : ""}</td>
                      <td className="border-l border-border px-4 py-2 text-right font-semibold tabular-nums">{fmtQty(m.balance)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-xs text-muted-foreground">{fmtR(m.cost)}</td>
                    </tr>
                  );
                })}
                {ledger.movements.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">No movements in this window.</td></tr>
                )}
                <tr className="border-t-2 border-border bg-muted/40">
                  <td className="px-4 py-2 font-semibold" colSpan={5}>
                    Closing balance — as at {to}
                    {ledger.reconciles
                      ? <span className="ml-1 text-[hsl(145_60%_42%)]">· reconciles to on hand ✓</span>
                      : <span className="ml-1 text-[hsl(0_72%_55%)]">· variance {fmtQty(ledger.reconcile_variance)}</span>}
                  </td>
                  <td className="border-l border-border px-4 py-2 text-right font-semibold tabular-nums">{fmtQty(ledger.closing_balance)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-subtle">
            The running balance is anchored to current on-hand and the opening is derived from it, so the card always ties to stock — Sage purges old transaction history, so a balance summed from zero would not. The bulk sync only carries the last 30 days; use “Load full history” to pull everything older for this item.
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
