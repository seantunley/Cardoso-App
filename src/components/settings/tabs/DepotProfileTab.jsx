import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save, Building2 } from "lucide-react";
import { toast } from "sonner";

async function getProfile() {
  const r = await fetch("/api/depot-profile", { credentials: "include" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}
async function putProfile(body) {
  const r = await fetch("/api/depot-profile", {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

const FIELDS = [
  { key: "name",                label: "Depot name",          hint: "Trading name printed on the letterhead.", tooltip: "Trading name shown on the Price List letterhead and as the heading on the Commission report PDF. Stored on depot_profile.name." },
  { key: "address_line1",       label: "Address line 1",      hint: "Street number and street name.", tooltip: "First line of the postal address — printed beneath the depot name on the Price List PDF letterhead and the print-mode Collections worklist." },
  { key: "address_line2",       label: "Address line 2",      hint: "Suburb / business park (optional).", tooltip: "Optional second address line printed under address line 1 on the Price List PDF letterhead." },
  { key: "city",                label: "City",                hint: "", tooltip: "Used as the filename prefix on the Sales/Hub Commission Excel and PDF exports (e.g. 'Johannesburg Commission 2025-04-24 to 2025-05-23.pdf') and printed on the Price List letterhead." },
  { key: "postal_code",         label: "Postal code",         hint: "", tooltip: "Printed next to City on the Price List PDF letterhead. Stored on depot_profile.postal_code." },
  { key: "phone",               label: "Phone",               hint: "Main switchboard or sales line.", tooltip: "Switchboard or sales line printed on the Price List PDF letterhead. Stored on depot_profile.phone." },
  { key: "email",               label: "Email",               hint: "Sales / accounts email shown on documents.", tooltip: "Sales/accounts email printed on the Price List PDF letterhead. Stored on depot_profile.email." },
  { key: "vat_number",          label: "VAT number",          hint: "Required on tax invoices.", tooltip: "VAT registration number printed on the Price List PDF letterhead. Stored on depot_profile.vat_number." },
  { key: "registration_number", label: "Registration number", hint: "Company / CK registration number.", tooltip: "Company/CK registration number printed on the Price List PDF letterhead. Stored on depot_profile.registration_number." },
];

export default function DepotProfileTab() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["depot-profile"], queryFn: getProfile });
  const [form, setForm] = useState({});
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data?.profile) {
      const init = {};
      for (const f of FIELDS) init[f.key] = data.profile[f.key] || "";
      setForm(init);
      setDirty(false);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () => putProfile(form),
    onSuccess: () => {
      toast.success("Depot details saved");
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["depot-profile"] });
    },
    onError: (e) => toast.error("Save failed", { description: e.message }),
  });

  const onChange = (key) => (e) => {
    setForm(prev => ({ ...prev, [key]: e.target.value }));
    setDirty(true);
  };

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-start gap-3">
        <div className="p-2 bg-card border border-border rounded-lg">
          <Building2 className="w-5 h-5 text-muted-foreground" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold text-foreground">Depot details</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            Printed on the letterhead of customer-facing documents (price lists, statements). Update once
            and every generated PDF picks up the latest values.
          </p>
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      )}

      {error && (
        <p className="text-sm text-destructive">Failed to load: {error.message}</p>
      )}

      {!isLoading && !error && (
        <form
          onSubmit={(e) => { e.preventDefault(); save.mutate(); }}
          className="space-y-4"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-3">
            {FIELDS.map((f) => (
              <div key={f.key} className="space-y-1">
                <label htmlFor={f.key} title={f.tooltip} className="text-xs font-medium text-foreground cursor-help">{f.label}</label>
                <input
                  id={f.key}
                  type="text"
                  value={form[f.key] ?? ""}
                  onChange={onChange(f.key)}
                  title={f.tooltip}
                  className="w-full h-9 rounded-md border border-border bg-card px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
                {f.hint && <p className="text-[11px] text-muted-foreground">{f.hint}</p>}
              </div>
            ))}
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={!dirty || save.isPending}
              title="Persist all field changes to the depot_profile row. New values are picked up by the next Price List PDF and Commission export. Logged to audit_log."
              className="inline-flex items-center gap-1.5 rounded-md bg-foreground text-background px-3 py-1.5 text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save
            </button>
            {dirty && (
              <span className="text-xs text-muted-foreground">Unsaved changes</span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
