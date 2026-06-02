// Drill-down modal for a single inventory item, opened from the Forecast /
// Reorder tables. Surfaces the monthly sales trend and the 12-month
// seasonality profile (the seasonality endpoint already existed but was never
// charted) plus a forecast snapshot and lifetime stats. Self-contained — owns
// its own queries so it doesn't collide with the page's existing trend tab.
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, Cell,
  CartesianGrid, XAxis, YAxis, Tooltip, ReferenceLine,
} from "recharts";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { CHART_PRIMARY, CHART_POSITIVE, CHART_WARN } from "@/lib/chartColors";
import { formatNum as fmtNum } from "@/lib/format";

async function apiFetch(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function Stat({ label, value }) {
  return (
    <div className="rounded-lg border border-border bg-background p-2.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums text-foreground">{value}</div>
    </div>
  );
}

export default function ItemDetailModal({ item, onClose }) {
  const itemNumber = item?.item_number;

  const trend = useQuery({
    queryKey: ["item-detail-trend", itemNumber],
    queryFn: () => apiFetch(`/api/inventory-movement/item-trend?item=${encodeURIComponent(itemNumber)}`),
    enabled: !!itemNumber,
    staleTime: 60_000,
  });
  const seasonality = useQuery({
    queryKey: ["item-detail-seasonality", itemNumber],
    queryFn: () => apiFetch(`/api/inventory-movement/item-seasonality?item=${encodeURIComponent(itemNumber)}`),
    enabled: !!itemNumber,
    staleTime: 60_000,
  });
  const stats = useQuery({
    queryKey: ["item-detail-stats", itemNumber],
    queryFn: () => apiFetch(`/api/inventory-movement/item-stats?item=${encodeURIComponent(itemNumber)}`),
    enabled: !!itemNumber,
    staleTime: 60_000,
  });

  if (!item) return null;

  const trendRows = trend.data?.rows || [];
  const profile = seasonality.data?.profile || [];
  const st = stats.data || {};

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90vh] w-full max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{item.item_number}</DialogTitle>
          <DialogDescription className="normal-case tracking-normal text-sm text-muted-foreground">
            {item.item_description || "—"}
          </DialogDescription>
        </DialogHeader>

        {/* Forecast snapshot from the row that opened the modal */}
        <div className="mb-5 grid grid-cols-2 gap-2 md:grid-cols-5">
          <Stat label="On Hand" value={fmtNum(item.qty_on_hand)} />
          <Stat label="Adj Demand/Mo" value={fmtNum(item.adjusted_demand)} />
          <Stat label="Reorder Pt" value={fmtNum(item.reorder_point)} />
          <Stat label="Days of Stock" value={item.days_of_stock != null ? `${Math.round(item.days_of_stock)}d` : "—"} />
          <Stat label="Suggested Order" value={item.suggested_order_qty > 0 ? fmtNum(item.suggested_order_qty) : "—"} />
        </div>

        {/* Monthly sales trend */}
        <div className="mb-5 rounded-lg border border-border bg-background p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Monthly sales (qty)</div>
          {trend.isLoading ? (
            <div className="flex h-[220px] items-center justify-center text-muted-foreground"><RefreshCw className="mr-2 h-4 w-4 animate-spin" />Loading…</div>
          ) : trend.isError ? (
            <p className="text-sm text-red-500">{trend.error.message}</p>
          ) : trendRows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No sales history.</p>
          ) : (
            <div className="h-[220px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trendRows} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="period" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 12 }} />
                  <Line type="monotone" dataKey="qty_sold" name="Qty sold" stroke={CHART_PRIMARY} strokeWidth={2.5} dot={{ r: 2 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Seasonality profile */}
        <div className="mb-5 rounded-lg border border-border bg-background p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Seasonality (index by month · 1.0 = average)
          </div>
          {seasonality.isLoading ? (
            <div className="flex h-[200px] items-center justify-center text-muted-foreground"><RefreshCw className="mr-2 h-4 w-4 animate-spin" />Loading…</div>
          ) : !seasonality.data?.hasData ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Not enough history (needs 12+ months) to derive a seasonal profile.</p>
          ) : (
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={profile} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <Tooltip
                    contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 12 }}
                    formatter={(v) => [Number(v).toFixed(2), "Index"]}
                  />
                  <ReferenceLine y={1} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" />
                  <Bar dataKey="index" radius={[2, 2, 0, 0]}>
                    {profile.map((p, i) => (
                      <Cell key={i} fill={p.index >= 1 ? CHART_POSITIVE : CHART_WARN} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Lifetime stats */}
        {stats.data && (
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Stat label="Transactions" value={fmtNum(st.total_transactions)} />
            <Stat label="Total qty sold" value={fmtNum(st.total_qty)} />
            <Stat label="Unique customers" value={fmtNum(st.unique_customers)} />
            <Stat label="Avg days between sales" value={st.avg_days_between_sales != null ? Number(st.avg_days_between_sales).toFixed(1) : "—"} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
