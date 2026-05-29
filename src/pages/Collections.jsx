// Collections — rebuilt UI sitting on top of worklist + assignment +
// activity tables. The page has three columns at desktop sizes:
//   1. Worklist sidebar (left) — pick which worklist you're working
//   2. Assignment list (centre) — customers on that worklist, with
//      bulk actions and quick filters
//   3. Customer drawer (right, slides in on row click) — activity
//      timeline, action buttons, status controls
//
// Auto-collection of zero-balance customers happens server-side in
// services/collectionsService.js#processCollectionBalanceDelta; this
// page just reflects the resulting status.

import { useMemo, useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useColorScheme } from "@/lib/useColorScheme";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ChevronRight, Plus, Search, UserCircle2, ClipboardList,
  ListPlus, Filter, Printer,
} from "lucide-react";
import SummaryTile from "@/components/shared/SummaryTile";
import CustomerDrawer from "@/components/collections/CustomerDrawer";
import NewWorklistDialog from "@/components/collections/NewWorklistDialog";
import AssignCustomersDialog from "@/components/collections/AssignCustomersDialog";
import { ASSIGNMENT_STATUS_META } from "@/components/collections/meta";
import { apiGet, parseAmount, formatCurrency, timeAgo } from "@/components/collections/utils";

// ── Main page ────────────────────────────────────────────────────

export default function Collections() {
  useColorScheme();
  const queryClient = useQueryClient();
  const [selectedWorklistId, setSelectedWorklistId] = useState(/** @type {number | null} */ (null));
  const [statusFilter, setStatusFilter] = useState("active");
  const [searchFilter, setSearchFilter] = useState("");
  const [openAssign, setOpenAssign] = useState(false);
  const [openNew, setOpenNew] = useState(false);
  const [drawerAssignment, setDrawerAssignment] = useState(/** @type {any} */ (null));

  const me = useQuery({ queryKey: ["me"], queryFn: () => /** @type {Promise<{ id?: number, role?: string } | null>} */ (apiGet("/api/auth/me")), staleTime: 60_000 });
  const users = useQuery({
    queryKey: ["collection-users"],
    queryFn: () => /** @type {Promise<Array<{ id: number, email?: string, full_name?: string }>>} */ (apiGet("/api/collections/assignable-users").then(d => d.users || [])),
    staleTime: 300_000,
  });
  const worklists = useQuery({
    queryKey: ["worklists"],
    queryFn: () => /** @type {Promise<Array<import('@/types/api-rows').Worklist & { owner_email?: string, collected_count?: number }>>} */ (apiGet("/api/collections/worklists").then(d => d.worklists || [])),
    staleTime: 30_000,
  });
  // Auto-select first worklist when list arrives
  useEffect(() => {
    if (selectedWorklistId == null && worklists.data?.length) {
      setSelectedWorklistId(worklists.data[0].id);
    }
  }, [worklists.data, selectedWorklistId]);

  const assignments = useQuery({
    queryKey: ["worklist-assignments", selectedWorklistId, statusFilter],
    queryFn: () => /** @type {Promise<Array<import('@/types/api-rows').Assignment & { outstanding_balance_num?: number, last_action_at?: string }>>} */ (apiGet(`/api/collections/worklists/${selectedWorklistId}/assignments?status=${statusFilter}`)
      .then(d => d.assignments || [])),
    enabled: !!selectedWorklistId,
    staleTime: 10_000,
  });

  const filteredAssignments = useMemo(() => {
    const rows = assignments.data || [];
    if (!searchFilter.trim()) return rows;
    const q = searchFilter.toLowerCase();
    return rows.filter(a =>
      (a.customer_name || "").toLowerCase().includes(q) ||
      (a.customer_number || "").toLowerCase().includes(q) ||
      (a.sales_rep || "").toLowerCase().includes(q)
    );
  }, [assignments.data, searchFilter]);

  const total = useMemo(
    () => filteredAssignments.reduce((s, r) => s + (r.outstanding_balance_num ?? parseAmount(r.outstanding_balance)), 0),
    [filteredAssignments]
  );
  const overdueFollowups = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return filteredAssignments.filter(a => a.next_followup_date && a.next_followup_date <= today && a.status === "active").length;
  }, [filteredAssignments]);

  const selectedWorklist = worklists.data?.find(w => w.id === selectedWorklistId);
  const isOwner = selectedWorklist && me.data?.id === selectedWorklist.owner_user_id;
  const isAdmin = me.data?.role === "admin";

  return (
    <div className="min-h-screen bg-background px-4 py-6 text-foreground sm:px-6">
      <div className="space-y-6">
        {/* Header */}
        <div className="border-b border-border pb-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">§ Collections</div>
          <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
            Chase the <em className="text-phosphor">outstanding</em>.
          </h1>
          <p className="text-sm text-muted-foreground mt-3">
            Worklists keep each rep on their assigned customers. Auto-detected payments come off the list; everything else stays manual.
          </p>
        </div>

        <div className="grid gap-5 lg:grid-cols-[260px_1fr] print:block">
          {/* Worklist sidebar */}
          <aside className="space-y-3 print:hidden">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Worklists</h2>
              <Button size="sm" variant="ghost" onClick={() => setOpenNew(true)} title="Create a new collections worklist. You become the owner. Logged to audit_log.">
                <Plus className="h-3.5 w-3.5 mr-1" />New
              </Button>
            </div>
            <div className="space-y-1">
              {worklists.isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
              {!worklists.isLoading && (worklists.data?.length ?? 0) === 0 && (
                <div className="rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
                  No worklists yet. Create one to start assigning customers.
                </div>
              )}
              {(worklists.data || []).map((w) => {
                const active = w.id === selectedWorklistId;
                return (
                  <button
                    key={w.id}
                    onClick={() => { setSelectedWorklistId(w.id); setDrawerAssignment(null); }}
                    title={`Open the "${w.name}" worklist (owner: ${w.owner_name || w.owner_email || "Unassigned"}). Shows ${w.active_count} active assignments.`}
                    className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                      active
                        ? "border-amber-500/40 bg-amber-500/10"
                        : "border-border bg-card hover:bg-muted/30"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold text-foreground truncate">{w.name}</div>
                      <ChevronRight className={`h-3.5 w-3.5 shrink-0 transition-colors ${active ? "text-amber-300" : "text-muted-foreground/60"}`} />
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground flex items-center gap-1">
                      <UserCircle2 className="h-3 w-3" />
                      <span className="truncate">{w.owner_name || w.owner_email || "Unassigned"}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[10px]">
                      <span className="rounded bg-amber-500/15 text-amber-300 px-1.5 py-0.5" title="Number of collection_assignments rows with status='active' on this worklist">{w.active_count} active</span>
                      {(w.collected_count ?? 0) > 0 && (
                        <span className="rounded bg-emerald-500/15 text-emerald-300 px-1.5 py-0.5" title="Number of collection_assignments auto-closed to status='collected' once the customer's outstanding balance fell to zero">{w.collected_count} collected</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          {/* Main column */}
          <section className="space-y-4">
            {selectedWorklist ? (
              <>
                {/* Worklist summary + actions */}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between border-b border-border pb-3 print:flex-row print:items-baseline">
                  <div>
                    <h2 className="text-lg font-semibold text-foreground">{selectedWorklist.name}</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Owner: {selectedWorklist.owner_name || selectedWorklist.owner_email || "Unassigned"}
                      {overdueFollowups > 0 && (
                        <span className="ml-2 text-amber-400 font-medium">
                          · {overdueFollowups} follow-up{overdueFollowups !== 1 ? "s" : ""} due
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap print:hidden">
                    {(isOwner || isAdmin) && (
                      <Button size="sm" onClick={() => setOpenAssign(true)} title="Pick customers with outstanding balances and add them to this worklist. Each insert is logged to audit_log.">
                        <ListPlus className="h-3.5 w-3.5 mr-1" />Assign customers
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => window.print()} disabled={filteredAssignments.length === 0} title="Print the visible assignment list via the browser print dialog (filters and search are preserved).">
                      <Printer className="h-3.5 w-3.5 mr-1" />Print
                    </Button>
                  </div>
                  <div className="hidden print:block text-xs text-muted-foreground">
                    Printed {new Date().toLocaleString("en-ZA")}
                  </div>
                </div>

                {/* Filter bar */}
                <div className="flex flex-wrap items-center gap-2 print:hidden">
                  <Filter className="h-4 w-4 text-amber-400" />
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Status:</span>
                  {["active", "collected", "escalated", "all"].map((s) => {
                    const tipMap = {
                      active: "Show open assignments (collection_assignments.status='active')",
                      collected: "Show assignments auto-closed when the customer's balance dropped to zero (status='collected')",
                      escalated: "Show assignments manually flagged for management attention (status='escalated')",
                      all: "Show every assignment on this worklist regardless of status",
                    };
                    return (
                      <button
                        key={s}
                        onClick={() => setStatusFilter(s)}
                        title={tipMap[s]}
                        className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                          statusFilter === s
                            ? "border-amber-500 bg-amber-500/15 text-amber-300"
                            : "border-border bg-card text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {ASSIGNMENT_STATUS_META[s]?.label || (s === "all" ? "All" : s)}
                      </button>
                    );
                  })}
                  <div className="relative flex-1 max-w-xs ml-auto">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input value={searchFilter} onChange={(e) => setSearchFilter(e.target.value)} placeholder="Filter customers…" title="Client-side filter on customer name, customer number, or sales rep — narrows the visible rows without re-querying." className="pl-8 h-8" />
                  </div>
                </div>

                {/* Summary tile */}
                {filteredAssignments.length > 0 && (
                  <div className="grid gap-4 md:grid-cols-2">
                    <SummaryTile
                      label={`Total outstanding (${filteredAssignments.length} customer${filteredAssignments.length !== 1 ? "s" : ""})`}
                      value={`R ${formatCurrency(total)}`}
                    />
                  </div>
                )}

                {/* Assignment list */}
                <div className="rounded-xl border border-border bg-card overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/30 border-b border-border">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-help" title="Customer name and Sage account number (ARCUS.NAMECUST / IDCUST)">Customer</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-help" title="Sales rep currently assigned to the customer (ARCUS.CODESLSP)">Rep</th>
                        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-help" title="Latest outstanding balance synced from Sage (datarecord.outstanding_balance)">Outstanding</th>
                        <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-help" title="collection_assignments.status — active, collected (auto when balance hits 0), or escalated">Status</th>
                        <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-help" title="Next promised contact date (collection_assignments.next_followup_date). Amber when overdue.">Follow-up</th>
                        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide cursor-help" title="Timestamp of the most recent collection_activity row for this assignment">Last action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {assignments.isLoading && (
                        <tr><td colSpan={6} className="px-3 py-12 text-center text-sm text-muted-foreground">Loading…</td></tr>
                      )}
                      {!assignments.isLoading && filteredAssignments.length === 0 && (
                        <tr>
                          <td colSpan={6} className="px-3 py-12 text-center text-sm text-muted-foreground">
                            <ClipboardList className="h-8 w-8 mx-auto mb-2 opacity-60" />
                            {(assignments.data || []).length === 0
                              ? "No customers on this list yet. Click Assign customers to add some."
                              : "No customers match your filters."}
                          </td>
                        </tr>
                      )}
                      {filteredAssignments.map((a) => {
                        const meta = ASSIGNMENT_STATUS_META[a.status] || ASSIGNMENT_STATUS_META.active;
                        const bal = a.outstanding_balance_num ?? parseAmount(a.outstanding_balance);
                        const today = new Date().toISOString().slice(0, 10);
                        const followupOverdue = a.next_followup_date && a.next_followup_date <= today && a.status === "active";
                        return (
                          <tr key={a.id}
                            onClick={() => setDrawerAssignment(a)}
                            role="button"
                            tabIndex={0}
                            aria-label={`Open ${a.customer_name || "assignment"}`}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setDrawerAssignment(a); } }}
                            className={`border-b border-border last:border-0 cursor-pointer transition-colors ${
                              drawerAssignment?.id === a.id ? "bg-amber-500/5" : "hover:bg-muted/30"
                            }`}
                          >
                            <td className="px-3 py-2">
                              <div className="font-medium text-foreground leading-tight">{a.customer_name || "—"}</div>
                              <div className="font-mono text-[11px] text-muted-foreground">{a.customer_number || "—"}</div>
                            </td>
                            <td className="px-3 py-2 text-xs text-muted-foreground">{a.sales_rep || "—"}</td>
                            <td className="px-3 py-2 text-right tabular-nums font-semibold">R {formatCurrency(bal)}</td>
                            <td className="px-3 py-2 text-center">
                              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${meta.cls}`}>{meta.label}</span>
                            </td>
                            <td className={`px-3 py-2 text-center text-xs ${followupOverdue ? "text-amber-400 font-semibold" : "text-muted-foreground"}`}>
                              {followupOverdue && a.next_followup_date ? `Overdue · ${a.next_followup_date}` : (a.next_followup_date || "—")}
                            </td>
                            <td className="px-3 py-2 text-right text-xs text-muted-foreground">{timeAgo(a.last_action_at)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div className="rounded-xl border border-dashed border-border p-10 text-center">
                <ClipboardList className="h-10 w-10 mx-auto mb-3 text-muted-foreground/60" />
                <p className="text-sm text-muted-foreground">
                  {worklists.data?.length === 0
                    ? "Create your first worklist to get started."
                    : "Pick a worklist on the left."}
                </p>
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Right drawer */}
      {drawerAssignment && (
        <CustomerDrawer
          assignment={drawerAssignment}
          onClose={() => setDrawerAssignment(null)}
          onChange={() => queryClient.invalidateQueries({ queryKey: ["worklist-assignments"] })}
        />
      )}

      <NewWorklistDialog
        open={openNew}
        onClose={() => setOpenNew(false)}
        users={users.data || []}
        onCreated={(w) => { queryClient.invalidateQueries({ queryKey: ["worklists"] }); setSelectedWorklistId(w.id); }}
      />
      <AssignCustomersDialog
        open={openAssign}
        onClose={() => setOpenAssign(false)}
        worklistId={selectedWorklistId}
        onAssigned={() => queryClient.invalidateQueries({ queryKey: ["worklist-assignments"] })}
      />
    </div>
  );
}
