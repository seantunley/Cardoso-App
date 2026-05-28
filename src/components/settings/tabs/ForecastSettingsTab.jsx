import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RefreshCw, Info, TrendingUp } from "lucide-react";

async function apiFetch(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

const FIELDS = [
  {
    key: "lead_time_days",
    label: "Lead Time (days)",
    type: "int",
    description:
      "Average number of days between placing a purchase order and receiving the goods. " +
      "This drives the reorder point calculation — a longer lead time means you need to reorder earlier " +
      "to avoid stockouts. If your suppliers typically deliver in 5 business days, set this to 7 " +
      "(accounting for weekends). Items with different suppliers can eventually have per-item overrides.",
  },
  {
    key: "order_cycle_days",
    label: "Order Cycle (days)",
    type: "int",
    description:
      "How often you place purchase orders, in days. For example, if you order weekly set this to 7; " +
      "if fortnightly, 14. The suggested order quantity assumes the next order won't arrive for this " +
      "many days plus the lead time, so it orders enough to cover that full window. A shorter cycle " +
      "means smaller, more frequent orders; a longer cycle means larger, less frequent ones.",
  },
  {
    key: "service_level",
    label: "Service Level",
    type: "float",
    description:
      "The probability of not running out of stock during the lead time period, expressed as a " +
      "decimal between 0 and 1. A service level of 0.95 means you accept a 5% chance of a stockout " +
      "per order cycle — this is the industry standard for most FMCG distributors. Higher values " +
      "(e.g. 0.99) require significantly more safety stock and tied-up capital. Lower values (e.g. 0.90) " +
      "reduce safety stock but increase stockout risk. The system converts this to a statistical " +
      "z-score used in the safety stock formula: 0.90 → 1.28, 0.95 → 1.65, 0.99 → 2.33.",
  },
  {
    key: "min_order_qty",
    label: "Minimum Order Quantity",
    type: "float",
    description:
      "The smallest quantity you're willing to order for any single item. When the calculated " +
      "suggested order quantity is greater than zero but less than this value, it gets rounded up " +
      "to this minimum. Useful when suppliers have minimum order thresholds or when ordering very " +
      "small quantities isn't cost-effective. Set to 0 to disable.",
  },
];

function FieldRow({ field, value, onChange, disabled }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <label className="text-sm font-medium text-foreground">{field.label}</label>
        <Tooltip>
          <TooltipTrigger asChild>
            <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
          </TooltipTrigger>
          <TooltipContent className="max-w-sm text-xs leading-relaxed">{field.description}</TooltipContent>
        </Tooltip>
      </div>
      <Input
        type="number"
        step={field.type === "float" ? "0.01" : "1"}
        min={field.type === "float" && field.key === "service_level" ? "0.50" : "0"}
        max={field.key === "service_level" ? "0.999" : undefined}
        value={value ?? ""}
        onChange={(e) => {
          const parsed = field.type === "int" ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
          onChange(field.key, Number.isFinite(parsed) ? parsed : null);
        }}
        disabled={disabled}
        className="h-9 w-full max-w-[200px]"
      />
      <p className="text-[11px] text-muted-foreground leading-relaxed">{field.description}</p>
    </div>
  );
}

export default function ForecastSettingsTab() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(null);

  const config = useQuery({
    queryKey: ["forecast-config"],
    queryFn: () => apiFetch("/api/inventory-movement/forecast-config"),
  });

  useEffect(() => {
    if (config.data && !draft) {
      setDraft({ ...config.data });
    }
  }, [config.data, draft]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/inventory-movement/forecast-config", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadTimeDays: draft.lead_time_days,
          orderCycleDays: draft.order_cycle_days,
          serviceLevel: draft.service_level,
          minOrderQty: draft.min_order_qty,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    },
    onSuccess: (data) => {
      toast.success("Forecast settings saved");
      setDraft(data.config || draft);
      queryClient.invalidateQueries({ queryKey: ["forecast-config"] });
    },
    onError: (err) => toast.error("Save failed", { description: err.message }),
  });

  const recomputeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/inventory-movement/recompute-forecast", { method: "POST", credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    },
    onSuccess: (data) => {
      toast.success("Forecast recomputed", { description: `${data.computed} items updated` });
      queryClient.invalidateQueries({ queryKey: ["inv-movement-forecast"] });
    },
    onError: (err) => toast.error("Recompute failed", { description: err.message }),
  });

  const handleChange = (key, value) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const isDirty = draft && config.data && FIELDS.some((f) => draft[f.key] !== config.data[f.key]);

  if (config.isError) return <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">{config.error.message}</div>;
  if (config.isLoading || !draft) return <div className="h-32 animate-pulse rounded-xl bg-muted" />;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-amber-400" />
            <h3 className="text-sm font-semibold text-foreground">Demand Forecast Settings</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            These parameters control how the forecast engine calculates reorder points, safety stock,
            and suggested order quantities. Changes apply to all items that don't have per-item overrides.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => recomputeMutation.mutate()}
            disabled={recomputeMutation.isPending}
            className="gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${recomputeMutation.isPending ? "animate-spin" : ""}`} />
            {recomputeMutation.isPending ? "Recomputing…" : "Recompute Now"}
          </Button>
          <Button
            size="sm"
            onClick={() => saveMutation.mutate()}
            disabled={!isDirty || saveMutation.isPending}
            className="gap-1.5"
          >
            {saveMutation.isPending ? "Saving…" : "Save Changes"}
          </Button>
        </div>
      </div>

      {/* Explanation */}
      <Card className="border-border bg-card">
        <CardContent className="p-4 space-y-3">
          <h4 className="text-sm font-semibold text-foreground">How the forecast works</h4>
          <div className="text-xs text-muted-foreground space-y-2 leading-relaxed">
            <p>
              The system analyses your sales history from Sage shipment data to predict future demand
              for each inventory item. It runs nightly after the sales sync and can be triggered manually.
            </p>
            <p>
              <strong className="text-foreground">Weighted Moving Average:</strong> The last 3 months of sales are
              weighted so recent months count more (month-1 gets weight 3, month-2 gets 2, month-3 gets 1).
              This makes the forecast react to trends without being thrown off by one unusual month.
            </p>
            <p>
              <strong className="text-foreground">Seasonal Adjustment:</strong> If you have 12+ months of history,
              the system detects seasonal patterns (e.g. cigarettes sell more in winter). Each calendar month
              gets a seasonality index — values above 1.0 mean peak demand, below 1.0 mean a trough. The
              weighted average is multiplied by this index so forecasts don't systematically under-predict
              in peak months or over-predict in slow months.
            </p>
            <p>
              <strong className="text-foreground">Safety Stock:</strong> A buffer quantity kept on hand to absorb
              demand variability during the lead time. Calculated from your chosen service level and the
              observed variation in daily sales. Higher service levels require more safety stock.
            </p>
            <p>
              <strong className="text-foreground">Reorder Point:</strong> The stock level at which you should place
              a new order. Equals (daily demand × lead time) + safety stock. When qty-on-hand drops below
              this, the Forecast tab shows the item in red.
            </p>
            <p>
              <strong className="text-foreground">Suggested Order Quantity:</strong> How much to order right now.
              Equals (daily demand × order cycle) + safety stock − qty on hand. This covers the gap until
              the next order cycle plus a safety buffer.
            </p>
            <p>
              <strong className="text-foreground">ABC Classification:</strong> Items are ranked by total revenue.
              The top 80% by cumulative revenue are class A (your most valuable items — manage tightly),
              the next 15% are B, and the remaining 5% are C (low-value items — manage loosely).
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Parameters */}
      <Card className="border-border bg-card">
        <CardContent className="p-4 space-y-5">
          <h4 className="text-sm font-semibold text-foreground">Global Defaults</h4>
          <p className="text-xs text-muted-foreground">
            These values apply to all items unless overridden at the item level.
            After saving, click "Recompute Now" to recalculate forecasts with the new values.
          </p>
          <div className="grid gap-6 sm:grid-cols-2">
            {FIELDS.map((field) => (
              <FieldRow
                key={field.key}
                field={field}
                value={draft[field.key]}
                onChange={handleChange}
                disabled={saveMutation.isPending}
              />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
