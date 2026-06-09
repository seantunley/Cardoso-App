import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, Database, RotateCcw, Save } from "lucide-react";

// Settings → Sage Queries. One screen listing every SQL query the app runs
// against Sage 300 (the central registry), each with its shipped default,
// override state, declared params + required output columns, and an editor.
// Replaces the per-module SQL textareas that were scattered across the debtor,
// creditor, commission, JTI and stock-receipt settings.
export default function SageQueriesTab() {
  const qc = useQueryClient();
  const [openKey, setOpenKey] = useState(null);
  const [draft, setDraft] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["sage-queries"],
    queryFn: async () => {
      const r = await fetch("/api/sage-queries", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });

  const save = useMutation({
    mutationFn: async ({ key, sql }) => {
      const r = await fetch(`/api/sage-queries/${encodeURIComponent(key)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      return d;
    },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["sage-queries"] });
      toast.success(d.cleared ? "Override cleared — back to the shipped default." : "Override saved.");
    },
    onError: (e) => toast.error(e.message || "Save failed"),
  });

  const queries = data?.queries || [];

  const toggle = (q) => {
    if (openKey === q.key) { setOpenKey(null); return; }
    setOpenKey(q.key);
    setDraft(q.override || q.defaultSql);
  };

  return (
    <div className="space-y-4 max-w-4xl">
      <div>
        <h3 className="text-sm font-semibold mb-1 flex items-center gap-1.5">
          <Database className="h-4 w-4 text-phosphor" /> Sage queries
        </h3>
        <p className="text-xs text-muted-foreground">
          Every SQL query the app runs against Sage 300, in one place. Each shows its shipped default — override it only
          if your Sage install is customised. Overrides are validated (read-only SELECT/WITH, required parameters and
          output columns) and can be reset to the default at any time.
        </p>
      </div>

      {isLoading && <div className="text-xs text-muted-foreground">Loading…</div>}
      {error && <div className="text-xs text-destructive">Couldn&apos;t load Sage queries: {error.message}</div>}

      <div className="space-y-2">
        {queries.map((q) => {
          const isOpen = openKey === q.key;
          const overridden = Boolean(q.override);
          return (
            <div key={q.key} className="rounded-lg border border-border bg-card">
              <button type="button" onClick={() => toggle(q)} className="w-full flex items-start gap-2 p-3 text-left">
                {isOpen
                  ? <ChevronDown className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
                  : <ChevronRight className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground">{q.label}</span>
                    <span className={`font-mono text-[9px] uppercase tracking-[0.15em] px-1.5 py-0.5 rounded ${overridden ? "bg-amber-500/15 text-amber-400" : "bg-emerald-500/10 text-emerald-400"}`}>
                      {overridden ? "Overridden" : "Default"}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground/70">{q.key}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">{q.purpose}</div>
                  <div className="font-mono text-[10px] text-muted-foreground/60 mt-1">
                    pool {q.pool} · tables {q.tables.join(", ")}
                    {q.params.length > 0 ? ` · params ${q.params.map((p) => "@" + p).join(" ")}` : ""}
                  </div>
                </div>
              </button>

              {isOpen && (
                <div className="px-3 pb-3 space-y-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    spellCheck={false}
                    className="w-full h-56 rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed outline-none focus:ring-2 focus:ring-ring resize-y"
                  />
                  {q.requiredColumns.length > 0 && (
                    <div className="font-mono text-[10px] text-muted-foreground/70">
                      must output columns: {q.requiredColumns.join(", ")}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => save.mutate({ key: q.key, sql: draft })} disabled={save.isPending}>
                      <Save className="h-3.5 w-3.5 mr-1.5" /> Save override
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setDraft(q.defaultSql)} disabled={save.isPending}>
                      Load default into editor
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => save.mutate({ key: q.key, sql: "" })}
                      disabled={save.isPending || !overridden}
                    >
                      <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Reset to default
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
