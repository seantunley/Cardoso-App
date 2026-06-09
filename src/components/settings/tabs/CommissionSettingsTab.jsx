import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";

// Settings are stored as decimals (0.015 = 1.5%). The form takes/emits
// percentages because that's how operators think about commission rates.
function toPct(n) {
  if (!Number.isFinite(n)) return "";
  // Keep up to 4 decimal places ("0.17" needs 2, "0.005" needs 3, …) but
  // strip trailing zeros so a fresh value reads "1.5" not "1.5000".
  return (n * 100).toFixed(4).replace(/\.?0+$/, "");
}
function fromPct(s) {
  const v = Number(String(s).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(v) ? v / 100 : 0;
}

export default function CommissionSettingsTab() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["commission-settings"],
    queryFn: async () => {
      const r = await fetch("/api/commission/settings", { credentials: "include" });
      if (!r.ok) throw new Error((await r.json()).error || "Failed to load");
      return r.json();
    },
  });

  const [sweets, setSweets] = useState("");
  const [cigtob, setCigtob] = useState("");
  const [reference, setReference] = useState("");
  const [vat, setVat] = useState("");

  useEffect(() => {
    if (settings.data) {
      setSweets(toPct(settings.data.sweets_rate));
      setCigtob(toPct(settings.data.cigtob_rate));
      setReference(toPct(settings.data.reference_rate));
      setVat(toPct(settings.data.vat_rate ?? 0.15));
    }
  }, [settings.data]);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        sweets_rate: fromPct(sweets),
        cigtob_rate: fromPct(cigtob),
        reference_rate: fromPct(reference),
        vat_rate: fromPct(vat),
      };
      const r = await fetch("/api/commission/settings", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json()).error || "Save failed");
      return r.json();
    },
    onSuccess: () => {
      toast.success("Commission rates updated");
      queryClient.invalidateQueries({ queryKey: ["commission-settings"] });
      queryClient.invalidateQueries({ queryKey: ["commission-report"] });
    },
    onError: (err) => toast.error(err.message),
  });

  if (settings.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }
  if (settings.isError) {
    return <div className="text-sm text-red-400">{String(settings.error?.message)}</div>;
  }

  return (
    <div className="max-w-md space-y-5">
      <div>
        <h3 className="text-base font-semibold mb-1">Commission rates</h3>
        <p className="text-xs text-muted-foreground">
          Applied per sales rep on the Sales Commission report. Enter rates as percentages
          (e.g. <code>1.5</code> for 1.5%). Changes are audited and take effect on the next report run.
        </p>
      </div>

      <RateField
        label="Sweets commission"
        hint="Net Sweets × this rate. Spreadsheet default 1.5%."
        value={sweets}
        onChange={setSweets}
      />
      <RateField
        label="Cigarettes + Tobacco commission"
        hint="(Customer Payment Total − Net Sweets) × this rate. Spreadsheet default 0.17%."
        value={cigtob}
        onChange={setCigtob}
      />
      <RateField
        label="Reference rate"
        hint="Shown alongside the sweets column as a comparison. Spreadsheet default 1.0%."
        value={reference}
        onChange={setReference}
      />
      <RateField
        label="VAT rate"
        hint="AR receipts (AMTPAYMHC) are stripped of VAT before display: gross ÷ (1 + this rate). Default 15% (SA VAT rate); set 14% to match the older spreadsheet formula."
        value={vat}
        onChange={setVat}
      />

      <button
        type="button"
        onClick={() => save.mutate()}
        disabled={save.isPending}
        className="inline-flex items-center gap-1.5 rounded-md bg-amber-500 text-black hover:bg-amber-400 px-4 py-2 text-sm font-medium disabled:opacity-60"
      >
        {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        Save rates
      </button>

      {settings.data?.updated_at && (
        <p className="text-xs text-muted-foreground">
          Last updated {settings.data.updated_at}
          {settings.data.updated_by_user_id ? ` by user #${settings.data.updated_by_user_id}` : ""}.
        </p>
      )}
    </div>
  );
}

function RateField({ label, hint, value, onChange }) {
  return (
    <div>
      <label className="text-sm font-medium block mb-1 cursor-help" title={hint || undefined}>{label}</label>
      <div className="relative w-40">
        <input
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          title={hint || undefined}
          className="w-full pl-2 pr-8 py-1.5 bg-background border border-border rounded-md text-sm tabular-nums"
          placeholder="0.0"
        />
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
          %
        </span>
      </div>
      {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}
