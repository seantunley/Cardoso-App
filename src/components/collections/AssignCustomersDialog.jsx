import { useMemo, useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/components/ui/use-toast";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, X } from "lucide-react";
import { apiGet, apiSend, formatCurrency } from "./utils";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

export default function AssignCustomersDialog({ open, onClose, worklistId, onAssigned }) {
  const [search, setSearch] = useState("");
  const [minValue, setMinValue] = useState("");
  const [salesRep, setSalesRep] = useState("all");
  const [daysOverdue, setDaysOverdue] = useState("");
  const [selected, setSelected] = useState(new Set());
  // Free-typed fields key the query off debounced copies — one request per
  // typing pause, not per keystroke (PERF-4). Inputs stay bound to the
  // immediate state for responsiveness.
  const debouncedSearch = useDebouncedValue(search, 250);
  const debouncedMinValue = useDebouncedValue(minValue, 250);
  const debouncedDaysOverdue = useDebouncedValue(daysOverdue, 250);
  useEffect(() => {
    if (!open) {
      setSearch(""); setMinValue(""); setSalesRep("all"); setDaysOverdue("");
      setSelected(new Set());
    }
  }, [open]);

  const candidates = useQuery({
    queryKey: ["collection-candidates", worklistId, debouncedSearch, debouncedMinValue, salesRep, debouncedDaysOverdue],
    queryFn: () => {
      const params = new URLSearchParams({ worklist_id: String(worklistId) });
      if (debouncedSearch) params.set("q", debouncedSearch);
      if (debouncedMinValue && parseFloat(debouncedMinValue) > 0) params.set("min_value", debouncedMinValue);
      if (salesRep && salesRep !== "all") params.set("sales_rep", salesRep);
      if (debouncedDaysOverdue && parseInt(debouncedDaysOverdue, 10) > 0) params.set("days_overdue", debouncedDaysOverdue);
      return apiGet(`/api/collections/candidates?${params.toString()}`).then(d => d.candidates || []);
    },
    enabled: open && !!worklistId,
    staleTime: 30_000,
  });

  const reps = useQuery({
    queryKey: ["collection-candidate-reps"],
    queryFn: () => apiGet("/api/collections/candidate-reps").then(d => d.reps || []),
    enabled: open,
    staleTime: 300_000,
  });

  const { toast } = useToast();
  const assign = useMutation({
    mutationFn: () => apiSend(`/api/collections/worklists/${worklistId}/assignments`, "POST", {
      customer_ids: [...selected],
    }),
    onSuccess: (result) => {
      const parts = [];
      if (result.added) parts.push(`${result.added} added`);
      if (result.reopened) parts.push(`${result.reopened} reopened`);
      if (result.alreadyActive) parts.push(`${result.alreadyActive} already on list`);
      if (result.busy?.length) parts.push(`${result.busy.length} on another list`);
      toast({ title: "Assignments updated", description: parts.join(" · ") || "No changes" });
      onAssigned?.();
      onClose();
    },
    onError: (e) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });
  const selectable = useMemo(
    () => (candidates.data || []).filter(c => !c.blocked_worklist_id),
    [candidates.data]
  );
  const toggleAll = () => {
    if (selected.size === selectable.length) setSelected(new Set());
    else setSelected(new Set(selectable.map(c => String(c.id))));
  };
  const clearFilters = () => {
    setSearch(""); setMinValue(""); setSalesRep("all"); setDaysOverdue("");
  };
  const filtersActive = !!search || (!!minValue && parseFloat(minValue) > 0) || (salesRep !== "all") || (!!daysOverdue && parseInt(daysOverdue, 10) > 0);
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Assign customers</DialogTitle>
          <DialogDescription>Filter the pool, then tick the ones you want on this worklist. Customers already on another list are hidden.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {/* Filter row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or number…" title="Server-side search against customer name or Sage account number (datarecord.customer_name / customer_number)" className="pl-8" />
            </div>
            <select
              value={salesRep}
              onChange={(e) => setSalesRep(e.target.value)}
              title="Filter candidates by their Sage sales-rep code (ARCUS.CODESLSP) — only reps with overdue customers are listed."
              className="h-9 rounded-md border border-border bg-card px-3 text-sm text-foreground cursor-help"
            >
              <option value="all">All sales reps</option>
              {(reps.data || []).map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <div className="relative">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">R ≥</span>
              <Input
                value={minValue}
                onChange={(e) => setMinValue(e.target.value)}
                placeholder="Minimum outstanding"
                type="number"
                step="100"
                min="0"
                title="Only show customers whose current outstanding balance (datarecord.outstanding_balance) is at least this many rand."
                className="pl-10"
              />
            </div>
            <div className="relative">
              <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">≥</span>
              <Input
                value={daysOverdue}
                onChange={(e) => setDaysOverdue(e.target.value)}
                placeholder="Days overdue"
                type="number"
                step="1"
                min="0"
                title="Only show customers whose oldest unpaid invoice is at least this many days old (today − datarecord.last_unpaid_invoice_1_date)."
                className="pl-8"
              />
            </div>
          </div>
          {filtersActive && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{(candidates.data || []).length} candidate{(candidates.data || []).length !== 1 ? "s" : ""} matching filters</span>
              <button type="button" onClick={clearFilters} className="text-amber-400 hover:text-amber-300 inline-flex items-center gap-1">
                <X className="h-3 w-3" /> Clear filters
              </button>
            </div>
          )}
          <div className="max-h-[50vh] overflow-y-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 sticky top-0">
                <tr>
                  <th className="px-2 py-1.5 w-8">
                    <input type="checkbox"
                      checked={candidates.data?.length > 0 && selected.size === candidates.data.length}
                      onChange={toggleAll}
                      title="Toggle every candidate row that isn't already on another worklist"
                    />
                  </th>
                  <th className="px-2 py-1.5 text-left text-xs uppercase tracking-wide text-muted-foreground cursor-help" title="Customer name and Sage account number (datarecord.customer_name / customer_number)">Customer</th>
                  <th className="px-2 py-1.5 text-left text-xs uppercase tracking-wide text-muted-foreground cursor-help" title="Customer's assigned sales rep (ARCUS.CODESLSP)">Rep</th>
                  <th className="px-2 py-1.5 text-right text-xs uppercase tracking-wide text-muted-foreground cursor-help" title="Latest outstanding balance from Sage (datarecord.outstanding_balance)">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {candidates.isLoading && (
                  <tr><td colSpan={4} className="px-2 py-8 text-center text-sm text-muted-foreground">Loading…</td></tr>
                )}
                {!candidates.isLoading && (candidates.data?.length ?? 0) === 0 && (
                  <tr><td colSpan={4} className="px-2 py-8 text-center text-sm text-muted-foreground">No candidates found.</td></tr>
                )}
                {(candidates.data || []).map((c) => {
                  const id = String(c.id);
                  const blocked = !!c.blocked_worklist_id;
                  const isSel = selected.has(id);
                  return (
                    <tr key={id} className={`border-t border-border ${isSel ? "bg-amber-500/5" : ""} ${blocked ? "opacity-50" : ""}`}>
                      <td className="px-2 py-1.5">
                        <input
                          type="checkbox"
                          checked={isSel}
                          disabled={blocked}
                          title={blocked ? `On "${c.blocked_worklist_name}"${c.blocked_worklist_owner ? ` — owned by ${c.blocked_worklist_owner}` : ""}` : undefined}
                          onChange={() => {
                            if (blocked) return;
                            setSelected((prev) => {
                              const next = new Set(prev);
                              if (next.has(id)) next.delete(id); else next.add(id);
                              return next;
                            });
                          }}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <div className="font-medium text-foreground leading-tight">{c.customer_name || "—"}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">{c.customer_number || "—"}</div>
                        {blocked && (
                          <div className="mt-0.5 text-[10px] text-amber-400">
                            On "{c.blocked_worklist_name}"
                            {c.blocked_worklist_owner ? ` — ${c.blocked_worklist_owner}` : ""}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-xs text-muted-foreground">{c.sales_rep || "—"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-semibold">R {formatCurrency(c.outstanding_balance_num ?? c.outstanding_balance)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{selected.size} selected · {candidates.data?.length ?? 0} candidates shown</span>
            <button
              type="button"
              onClick={toggleAll}
              disabled={!selectable.length}
              title="Toggle selection for every candidate row that isn't already on another worklist"
              className="text-amber-400 hover:text-amber-300 disabled:opacity-50 font-semibold"
            >
              {selected.size === selectable.length && selectable.length > 0
                ? "Deselect all"
                : `Select all ${selectable.length}`}
            </button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => assign.mutate()} disabled={selected.size === 0 || assign.isPending} title="Insert one collection_assignments row per selected customer with status='active'. Each insertion is logged to audit_log.">
            Assign {selected.size > 0 ? `(${selected.size})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
