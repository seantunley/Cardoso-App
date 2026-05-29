// Reorder / purchase plan — items that need ordering now (positive suggested
// order qty), grouped by supplier so a buyer can raise one PO per supplier.
// Backed by /api/inventory-movement/reorder-plan; the Export button pulls the
// supplier-grouped XLSX from the matching /export endpoint. Clicking a row
// opens the shared item drill-down modal.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { RefreshCw, Package, FileSpreadsheet, AlertTriangle, ChevronRight } from "lucide-react";
import EmptyState from "@/components/EmptyState";

async function apiFetch(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

const fmtNum = (v) => (v == null ? "—" : Number(v).toLocaleString("en-ZA", { maximumFractionDigits: 0 }));

export default function ReorderPlanView({ commodity, supplier, onRowClick }) {
  const params = new URLSearchParams();
  if (commodity && commodity !== "all") params.set("commodity", commodity);
  if (supplier && supplier !== "all") params.set("supplier", supplier);
  const qs = params.toString();

  const plan = useQuery({
    queryKey: ["inv-reorder-plan", commodity, supplier],
    queryFn: () => apiFetch(`/api/inventory-movement/reorder-plan${qs ? `?${qs}` : ""}`),
    staleTime: 60_000,
  });

  const rows = plan.data?.rows || [];

  // Group supplier-first (rows already arrive ordered) for subtotal rows.
  const groups = useMemo(() => {
    const map = new Map();
    for (const r of rows) {
      const key = r.supplier_name || "— No supplier";
      if (!map.has(key)) map.set(key, { supplier: key, items: [], totalQty: 0 });
      const g = map.get(key);
      g.items.push(r);
      g.totalQty += Number(r.suggested_order_qty) || 0;
    }
    return [...map.values()];
  }, [rows]);

  const handleExport = async () => {
    try {
      const res = await fetch(`/api/inventory-movement/reorder-plan/export${qs ? `?${qs}` : ""}`, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `reorder-plan-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error("Export failed", { description: e.message });
    }
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="text-xs text-muted-foreground">
          {rows.length} item{rows.length === 1 ? "" : "s"} to order · {groups.length} supplier{groups.length === 1 ? "" : "s"}
        </div>
        <button
          onClick={handleExport}
          disabled={!rows.length}
          className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          <FileSpreadsheet className="h-3.5 w-3.5" />
          Export Excel
        </button>
      </div>

      {plan.isLoading && (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <RefreshCw className="mr-2 h-5 w-5 animate-spin" /> Loading reorder plan…
        </div>
      )}
      {!plan.isLoading && plan.isError && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-center text-sm text-red-400">
          <AlertTriangle className="mx-auto mb-3 h-8 w-8 opacity-70" />
          <p className="font-semibold">Failed to load reorder plan</p>
          <p className="text-xs text-red-400/70">{plan.error.message}</p>
        </div>
      )}
      {!plan.isLoading && !plan.isError && rows.length === 0 && (
        <EmptyState
          icon={Package}
          title="Nothing to reorder"
          message="No items are below their reorder point right now. Recompute the forecast after syncing sales if this looks wrong."
        />
      )}

      {rows.length > 0 && (
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.supplier} className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <span className="text-sm font-semibold text-foreground">{g.supplier}</span>
                <span className="text-xs text-muted-foreground">
                  {g.items.length} items · order qty {fmtNum(g.totalQty)}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="border-b border-border text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left">Item</th>
                      <th className="px-3 py-2 text-left">Description</th>
                      <th className="px-3 py-2 text-center">ABC</th>
                      <th className="px-3 py-2 text-right">On Hand</th>
                      <th className="px-3 py-2 text-right">Reorder Pt</th>
                      <th className="px-3 py-2 text-right">Days of Stock</th>
                      <th className="px-3 py-2 text-right">Order Qty</th>
                      <th className="w-8 px-2 py-2" aria-hidden="true" />
                    </tr>
                  </thead>
                  <tbody>
                    {g.items.map((r) => {
                      const dos = r.days_of_stock;
                      const urgencyCls = dos == null ? "text-slate-400"
                        : dos < 7 ? "text-red-400"
                        : dos < 14 ? "text-amber-400"
                        : dos < 30 ? "text-yellow-400"
                        : "text-emerald-400";
                      return (
                        <tr
                          key={r.item_number}
                          onClick={() => onRowClick?.(r)}
                          className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/20"
                        >
                          <td className="px-3 py-2 font-mono whitespace-nowrap">{r.item_number}</td>
                          <td className="px-3 py-2 max-w-[200px] truncate" title={r.item_description}>{r.item_description || "—"}</td>
                          <td className="px-3 py-2 text-center">{r.abc_class || "—"}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.qty_on_hand)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.reorder_point)}</td>
                          <td className={`px-3 py-2 text-right tabular-nums font-semibold ${urgencyCls}`}>
                            <span className="inline-flex items-center justify-end gap-1">
                              {dos != null && dos < 14 && <AlertTriangle className="h-3 w-3" aria-hidden="true" />}
                              {dos != null ? `${Math.round(dos)}d` : "—"}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-semibold">{fmtNum(r.suggested_order_qty)}</td>
                          <td className="px-2 py-2 text-right">
                            <button
                              type="button"
                              aria-label={`View details for ${r.item_number}`}
                              onClick={(e) => { e.stopPropagation(); onRowClick?.(r); }}
                              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500"
                            >
                              <ChevronRight className="h-4 w-4" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
