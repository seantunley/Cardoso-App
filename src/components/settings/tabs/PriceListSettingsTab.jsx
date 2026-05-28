import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Tag, X } from "lucide-react";
import { toast } from "sonner";

async function getExclusions() {
  const r = await fetch("/api/pricing/exclusions", { credentials: "include" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}
async function addExclusion(body) {
  const r = await fetch("/api/pricing/exclusions", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}
async function deleteExclusion(id) {
  const r = await fetch(`/api/pricing/exclusions/${id}`, { method: "DELETE", credentials: "include" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

export default function PriceListSettingsTab() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["pricing-exclusions"], queryFn: getExclusions });
  const [pattern, setPattern] = useState("");
  const [note, setNote] = useState("");

  const addMutation = useMutation({
    mutationFn: () => addExclusion({ pattern, note }),
    onSuccess: () => {
      setPattern("");
      setNote("");
      toast.success("Exclusion added");
      qc.invalidateQueries({ queryKey: ["pricing-exclusions"] });
      qc.invalidateQueries({ queryKey: ["pricing-items"] });
    },
    onError: (e) => toast.error("Failed", { description: e.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => deleteExclusion(id),
    onSuccess: () => {
      toast.success("Exclusion removed");
      qc.invalidateQueries({ queryKey: ["pricing-exclusions"] });
      qc.invalidateQueries({ queryKey: ["pricing-items"] });
    },
    onError: (e) => toast.error("Failed", { description: e.message }),
  });

  const onAdd = (e) => {
    e.preventDefault();
    if (!pattern.trim()) return;
    addMutation.mutate();
  };

  const exclusions = data?.exclusions || [];

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-start gap-3">
        <div className="p-2 bg-card border border-border rounded-lg">
          <Tag className="w-5 h-5 text-muted-foreground" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold text-foreground">Price list exclusions</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            Item-code patterns that are hidden from every customer-facing price list. Three syntaxes:
          </p>
          <ul className="text-sm text-muted-foreground mt-2 space-y-1 list-disc pl-5">
            <li>
              <strong>Wildcard</strong> — use
              <code className="mx-1 px-1 py-0.5 rounded bg-muted text-xs font-mono">*</code>
              for any chars or
              <code className="mx-1 px-1 py-0.5 rounded bg-muted text-xs font-mono">?</code>
              for one char. e.g.
              <code className="mx-1 px-1 py-0.5 rounded bg-muted text-xs font-mono">JT*</code>
              hides every code starting with JT.
            </li>
            <li>
              <strong>Numeric range</strong> — use
              <code className="mx-1 px-1 py-0.5 rounded bg-muted text-xs font-mono">low-high</code>
              with two integers. e.g.
              <code className="mx-1 px-1 py-0.5 rounded bg-muted text-xs font-mono">4000-4999</code>
              hides every code in the 4000 range (4069, 4070, …).
            </li>
            <li>
              <strong>Exact</strong> — type the code as-is. e.g.
              <code className="mx-1 px-1 py-0.5 rounded bg-muted text-xs font-mono">9999</code>
              hides only that single code.
            </li>
          </ul>
        </div>
      </div>

      {/* Add form */}
      <form onSubmit={onAdd} className="rounded-lg border border-border bg-card p-3">
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="Pattern (e.g. JT*, 4000-4999, 9999)"
            maxLength={50}
            className="flex-1 h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional — e.g. internal stock codes)"
            maxLength={200}
            className="flex-1 h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="submit"
            disabled={!pattern.trim() || addMutation.isPending}
            className="inline-flex items-center justify-center gap-1.5 rounded-md bg-foreground text-background px-3 py-1.5 text-sm font-medium hover:opacity-90 disabled:opacity-50 shrink-0"
          >
            {addMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Add
          </button>
        </div>
      </form>

      {/* List */}
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      )}

      {error && (
        <p className="text-sm text-destructive">Failed to load: {error.message}</p>
      )}

      {!isLoading && !error && (
        exclusions.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center">
            <Tag className="h-8 w-8 mx-auto mb-2 text-muted-foreground/60" />
            <p className="text-sm text-muted-foreground">No exclusions yet. Every Sage item will show in the price list.</p>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/30">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Pattern</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Note</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Added by</th>
                  <th className="px-3 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {exclusions.map((e) => (
                  <tr key={e.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-mono text-sm text-foreground">{e.pattern}</td>
                    <td className="px-3 py-2 text-muted-foreground">{e.note || "—"}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{e.created_by || "—"}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => deleteMutation.mutate(e.id)}
                        disabled={deleteMutation.isPending}
                        className="inline-flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-50"
                        title="Remove exclusion"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
