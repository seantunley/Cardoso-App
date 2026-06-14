import { useState, useMemo, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Package, CheckCircle2, AlertTriangle, RefreshCw, History, ArrowDownLeft, ArrowUpRight, Download } from "lucide-react";
import ItemCombobox from "./ItemCombobox";
import { downloadCsv } from "../reports/lib";

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

// LOCAL calendar date, not toISOString() (UTC) — SAST is UTC+2, so between
// 00:00 and 02:00 the UTC date is still yesterday and the card would silently
// exclude today's movements from its default window.
const localIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const daysAgoIso = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localIso(d);
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
  const [picked, setPicked] = useState(/** @type {{item_number:string, location:string, item_description?:string}|null} */ (null));
  const [from, setFrom] = useState(() => daysAgoIso(30));
  const [to, setTo] = useState(() => localIso(new Date()));

  // Guard an inverted range (From after To): the query would otherwise run and
  // return a confusing empty/odd card. We block the fetch and prompt instead.
  const invalidRange = !!(from && to && from > to);

  const ledgerQuery = useQuery({
    queryKey: ["inv-item-ledger", picked?.item_number, picked?.location, from, to],
    queryFn: () => apiFetch(`/api/inventory-movement/item-ledger?item=${encodeURIComponent(picked.item_number)}&location=${encodeURIComponent(picked.location)}&from=${from}&to=${to}`),
    enabled: !!picked && !invalidRange,
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
    onSuccess: (d) => {
      // The route answers 202 both for "started" and "already running" —
      // don't tell the user a new sync started when one was already going.
      if (d?.running) toast.info("A movement sync is already running.");
      else toast.info("Sync started — pulling the last 30 days from Sage in the background…");
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

  // Export the stock card exactly as shown — opening line, every movement with
  // its running balance, then closing — so it ties out in Excel the same way it
  // does on screen. Matches the CSV/export affordance on the other reports.
  const exportCsv = () => {
    if (!ledger || !picked) return;
    const qty = (v) => (v == null ? "" : (Math.round(Number(v) * 1000) / 1000).toFixed(3).replace(/\.?0+$/, ""));
    const money = (v) => (v == null ? "" : (Number(v) || 0).toFixed(2));
    const header = ["Date", "Movement", "App/Type", "Document", "In", "Out", "Balance", "Cost"];
    const rows = [["", "Opening balance", "", "", "", "", qty(ledger.opening_balance), ""]];
    for (const m of ledger.movements) {
      const q = Number(m.stock_qty) || 0;
      rows.push([
        m.transaction_date || "",
        m.movement_type || "",
        `${m.app || ""}/${m.transtype ?? ""}`,
        m.doc_number || "",
        q > 0 ? qty(q) : "",
        q < 0 ? qty(-q) : "",
        qty(m.balance),
        money(m.cost),
      ]);
    }
    rows.push(["", "Closing balance", "", "", "", "", qty(ledger.closing_balance), ""]);
    downloadCsv(`stock-card-${picked.item_number}-${picked.location}-${from}_${to}.csv`, [header, ...rows]);
  };

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
          ) : meta?.last_error ? (
            // A failed sync must be visible here, not only in a transition
            // toast: a sync that dies before the first poll (e.g. Sage down)
            // never shows `running`, so the toast never fires.
            <span className="inline-flex items-center gap-2 text-[hsl(0_72%_55%)]">
              <AlertTriangle className="h-3.5 w-3.5" />
              Last movement sync failed: {meta.last_error} — fix the Sage connection and run it again.
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
          <div className="flex-1 min-w-[260px]">
            <label htmlFor="mv-item" className="mb-1 block text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">Item</label>
            <ItemCombobox
              id="mv-item"
              value={picked}
              onChange={setPicked}
              fetchItems={(q) => apiFetch(`/api/inventory-movement/movement-items?q=${encodeURIComponent(q)}`)}
            />
          </div>
          <div>
            <label htmlFor="mv-from" className="mb-1 block text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">From</label>
            <input id="mv-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground" />
          </div>
          <div>
            <label htmlFor="mv-to" className="mb-1 block text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">To</label>
            <input id="mv-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground" />
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
          {picked && !invalidRange && ledger && (
            <button
              onClick={exportCsv}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-card px-3 text-xs font-medium hover:bg-muted"
              title="Download this stock card (opening, movements, closing) as a CSV"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
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

      {picked && invalidRange && (
        <div className="flex items-center gap-2 rounded-xl border border-[hsl(33_95%_55%_/_0.4)] bg-[hsl(33_95%_55%_/_0.08)] px-4 py-3 text-sm text-foreground">
          <AlertTriangle className="h-4 w-4 shrink-0 text-[hsl(33_95%_55%)]" />
          The “From” date (<span className="font-mono">{from}</span>) is after “To” (<span className="font-mono">{to}</span>). Adjust the range to see the stock card.
        </div>
      )}

      {picked && !invalidRange && ledgerQuery.isLoading && <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />}
      {picked && !invalidRange && ledgerQuery.error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">{ledgerQuery.error.message}</div>
      )}

      {picked && !invalidRange && ledger && (
        <>
          {/* Coverage warning: the bulk sync only holds the recent window, so a
              "From" before history_from means movements exist in Sage that
              aren't local — they'd be silently folded into the opening balance.
              Once this item has been deep-synced (item_earliest predates the
              window), every local date is covered and the warning goes away. */}
          {ledger.history_from && from < ledger.history_from && (!ledger.item_earliest || ledger.item_earliest >= ledger.history_from) && (
            <div className="flex items-start gap-2 rounded-xl border border-[hsl(33_95%_55%_/_0.4)] bg-[hsl(33_95%_55%_/_0.08)] px-4 py-2.5 text-xs text-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(33_95%_55%)]" />
              <span>
                Movements before <span className="font-mono">{ledger.history_from}</span> aren&apos;t synced for this item — the opening balance shown for {from} includes them as a rollup but can&apos;t itemise them.
                Use <strong>Load full history</strong> to pull this item&apos;s complete record from Sage.
              </span>
            </div>
          )}

          {/* Reconciliation summary */}
          <div className="grid gap-3 sm:grid-cols-4">
            <Tile label="Opening balance" value={fmtQty(ledger.opening_balance)} sub={`as at ${from}`} />
            <Tile label="Movements in window" value={`${fmtQty(totals.inQty)} in · ${fmtQty(totals.outQty)} out`} sub={`net ${fmtQty(ledger.window_net)}`} />
            <Tile label="Closing balance" value={fmtQty(ledger.closing_balance)} sub={`as at ${to}`} />
            <Tile
              label="Current on hand"
              value={fmtQty(ledger.on_hand)}
              sub={ledger.reconciles ? "Anchored to on-hand ✓" : `Internal variance ${fmtQty(ledger.reconcile_variance)}`}
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
                      ? <span className="ml-1 text-[hsl(145_60%_42%)]">· anchored to on hand ✓</span>
                      : <span className="ml-1 text-[hsl(0_72%_55%)]">· internal variance {fmtQty(ledger.reconcile_variance)}</span>}
                  </td>
                  <td className="border-l border-border px-4 py-2 text-right font-semibold tabular-nums">{fmtQty(ledger.closing_balance)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-subtle">
            The running balance is anchored to current on-hand: the opening is derived from on-hand minus the movements shown, so the card always ties to stock by construction — Sage purges old transaction history, so a balance summed from zero would not. Anything not yet synced is part of the opening rollup. The bulk sync only carries the last 30 days; use “Load full history” to pull everything older for this item.
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
