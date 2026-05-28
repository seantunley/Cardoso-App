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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/use-toast";
import { useColorScheme } from "@/lib/useColorScheme";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  ChevronRight, Plus, Search, X, UserCircle2, ClipboardList,
  CheckCircle2, AlertCircle, PhoneCall, FileText, ArrowDownCircle,
  ArrowRightCircle, CalendarClock, Archive, ListPlus, Filter,
  RotateCcw, Printer,
} from "lucide-react";
import SummaryTile from "@/components/shared/SummaryTile";

// ── API helpers ──────────────────────────────────────────────────

async function apiGet(url) {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}
async function apiSend(url, method, body) {
  const r = await fetch(url, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

// ── Utility ──────────────────────────────────────────────────────

function parseAmount(value) {
  const n = parseFloat(String(value ?? "").replace(/,/g, "").replace(/\s/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function formatCurrency(value) {
  const n = parseAmount(value);
  return n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function timeAgo(iso) {
  if (!iso) return "";
  // SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" without a
  // timezone marker. JS's lax Date parser treats that as LOCAL time,
  // but it's actually UTC — without normalising, "just now" events
  // show "2h ago" for a SAST user (UTC+2). Append Z when missing.
  const normalised = /[+\-Z]\d{2}|Z$/.test(iso) ? iso : iso.replace(" ", "T") + "Z";
  const t = new Date(normalised).getTime();
  if (Number.isNaN(t)) return "";
  const ms = Date.now() - t;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toLocaleDateString("en-ZA");
}

// ── Activity styling ─────────────────────────────────────────────

const ACTIVITY_META = {
  note:             { label: "Note",             Icon: FileText,        color: "text-muted-foreground" },
  contacted:        { label: "Contacted",        Icon: PhoneCall,       color: "text-sky-400" },
  promise_made:     { label: "Promise made",     Icon: CalendarClock,   color: "text-amber-400" },
  promise_kept:     { label: "Promise kept",     Icon: CheckCircle2,    color: "text-emerald-400" },
  promise_broken:   { label: "Promise broken",   Icon: AlertCircle,     color: "text-red-400" },
  payment_received: { label: "Payment received", Icon: ArrowDownCircle, color: "text-emerald-400" },
  status_changed:   { label: "Status changed",   Icon: ArrowRightCircle,color: "text-muted-foreground" },
};

const ASSIGNMENT_STATUS_META = {
  active:      { label: "Active",       cls: "border-amber-500/40 bg-amber-500/15 text-amber-300" },
  collected:   { label: "Collected",    cls: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300" },
  escalated:   { label: "Escalated",    cls: "border-red-500/40 bg-red-500/15 text-red-300" },
  written_off: { label: "Written off",  cls: "border-slate-500/40 bg-slate-500/15 text-slate-300" },
  closed:      { label: "Closed",       cls: "border-slate-500/40 bg-slate-500/15 text-slate-300" },
};

// ── Activity Timeline ────────────────────────────────────────────

function ActivityTimeline({ items }) {
  if (!items?.length) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        <ClipboardList className="h-6 w-6 mx-auto mb-2 opacity-60" />
        No activity logged yet. Use the buttons above to record a call, note, promise, or status change.
      </div>
    );
  }
  return (
    <ol className="space-y-2">
      {items.map((a) => {
        const meta = ACTIVITY_META[a.kind] || { label: a.kind, Icon: FileText, color: "text-muted-foreground" };
        const Icon = meta.Icon;
        return (
          <li key={a.id} className="flex gap-3 rounded-lg border border-border bg-card px-3 py-2">
            <div className={`mt-0.5 ${meta.color}`}>
              <Icon className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap text-xs">
                <span className="font-semibold text-foreground">{meta.label}</span>
                {a.amount != null && (
                  <span className="text-emerald-400 tabular-nums">R {formatCurrency(a.amount)}</span>
                )}
                {a.promise_date && (
                  <span className="text-amber-400">due {a.promise_date}</span>
                )}
                <span className="text-muted-foreground">· {timeAgo(a.at)}</span>
                {a.source === "sync" && (
                  <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">auto</span>
                )}
                <span className="ml-auto text-muted-foreground/70">
                  {a.user_name || a.user_email || (a.source === "sync" ? "system" : "")}
                </span>
              </div>
              {a.notes && <p className="mt-1 text-sm text-foreground leading-snug">{a.notes}</p>}
              {a.previous_balance != null && a.new_balance != null && (
                <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                  R {formatCurrency(a.previous_balance)} → R {formatCurrency(a.new_balance)}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ── Customer Drawer ──────────────────────────────────────────────

function CustomerDrawer({ assignment, onClose, onChange }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const customerId = assignment?.customer_id;
  const activity = useQuery({
    queryKey: ["collection-activity", customerId],
    queryFn: () => apiGet(`/api/collections/customers/${customerId}/activity`).then(d => d.activity || []),
    enabled: !!customerId,
    staleTime: 10_000,
  });

  // Forms
  const [noteText, setNoteText] = useState("");
  const [contactedNote, setContactedNote] = useState("");
  const [promiseAmount, setPromiseAmount] = useState("");
  const [promiseDate, setPromiseDate] = useState("");
  const [promiseNote, setPromiseNote] = useState("");
  const [followup, setFollowup] = useState(assignment?.next_followup_date || "");
  useEffect(() => { setFollowup(assignment?.next_followup_date || ""); }, [assignment?.id]);

  const addActivity = useMutation({
    mutationFn: (body) => apiSend(`/api/collections/customers/${customerId}/activity`, "POST", {
      assignment_id: assignment?.id, ...body,
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["collection-activity", customerId] });
      queryClient.invalidateQueries({ queryKey: ["worklist-assignments"] });
      onChange?.();
    },
    onError: (e) => toast({ title: "Failed to log", description: e.message, variant: "destructive" }),
  });

  const setStatus = useMutation({
    mutationFn: ({ status, reason }) =>
      apiSend(`/api/collections/assignments/${assignment.id}/status`, "PUT", { status, reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["collection-activity", customerId] });
      queryClient.invalidateQueries({ queryKey: ["worklist-assignments"] });
      onChange?.();
      toast({ title: "Status updated" });
    },
    onError: (e) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  const setFollowupMut = useMutation({
    mutationFn: (date) => apiSend(`/api/collections/assignments/${assignment.id}/followup`, "PUT", { date }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["worklist-assignments"] });
      onChange?.();
      toast({ title: "Follow-up updated" });
    },
    onError: (e) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  if (!assignment) return null;
  const statusMeta = ASSIGNMENT_STATUS_META[assignment.status] || ASSIGNMENT_STATUS_META.active;
  const bal = assignment.outstanding_balance_num ?? parseAmount(assignment.outstanding_balance);

  return (
    <Dialog open={!!assignment} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="flex-row items-start justify-between gap-3 border-b border-border p-4 space-y-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusMeta.cls}`}>
                {statusMeta.label}
              </span>
              <span className="font-mono text-xs text-muted-foreground">{assignment.customer_number || "—"}</span>
            </div>
            <DialogTitle className="text-base font-semibold text-foreground leading-tight truncate text-left">
              {assignment.customer_name || "Customer"}
            </DialogTitle>
            <p className="mt-1 text-2xl font-bold text-foreground tabular-nums">R {formatCurrency(bal)}</p>
            {assignment.sales_rep && (
              <p className="mt-1 text-xs text-muted-foreground">Rep: {assignment.sales_rep}</p>
            )}
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {/* Quick actions */}
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Log activity</h4>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Note</label>
              <div className="flex gap-2">
                <Input value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Quick note…" className="flex-1" />
                <Button
                  onClick={() => {
                    if (!noteText.trim()) return;
                    addActivity.mutate({ kind: "note", notes: noteText.trim() });
                    setNoteText("");
                  }}
                  disabled={!noteText.trim() || addActivity.isPending}
                >Add</Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Contact outcome</label>
              <div className="flex gap-2">
                <Input value={contactedNote} onChange={(e) => setContactedNote(e.target.value)} placeholder="Called — spoke to Jane…" className="flex-1" />
                <Button
                  variant="secondary"
                  onClick={() => {
                    addActivity.mutate({ kind: "contacted", notes: contactedNote.trim() || null });
                    setContactedNote("");
                  }}
                  disabled={addActivity.isPending}
                ><PhoneCall className="h-4 w-4 mr-1" />Log</Button>
              </div>
            </div>

            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-amber-300">Record a promise</label>
              <div className="grid grid-cols-2 gap-2">
                <Input value={promiseAmount} onChange={(e) => setPromiseAmount(e.target.value)} placeholder="Amount" type="number" />
                <Input value={promiseDate} onChange={(e) => setPromiseDate(e.target.value)} type="date" />
              </div>
              <Input value={promiseNote} onChange={(e) => setPromiseNote(e.target.value)} placeholder="Optional note" />
              <Button
                className="w-full"
                onClick={() => {
                  if (!promiseAmount && !promiseDate) return;
                  addActivity.mutate({
                    kind: "promise_made",
                    amount: promiseAmount ? Number(promiseAmount) : null,
                    promise_date: promiseDate || null,
                    notes: promiseNote.trim() || null,
                  });
                  setPromiseAmount(""); setPromiseDate(""); setPromiseNote("");
                }}
                disabled={(!promiseAmount && !promiseDate) || addActivity.isPending}
              ><CalendarClock className="h-4 w-4 mr-1" />Record promise</Button>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Follow up on</label>
              <div className="flex gap-2">
                <Input value={followup} onChange={(e) => setFollowup(e.target.value)} type="date" className="flex-1" />
                <Button
                  variant="secondary"
                  onClick={() => setFollowupMut.mutate(followup || null)}
                  disabled={setFollowupMut.isPending}
                >Save</Button>
              </div>
            </div>
          </div>
        </section>

        {/* Status controls */}
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Status</h4>
          <div className="flex flex-wrap gap-2">
            {assignment.status !== "active" && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setStatus.mutate({ status: "active", reason: "Reopened" })}
              ><RotateCcw className="h-3.5 w-3.5 mr-1" />Reopen</Button>
            )}
            {assignment.status === "active" && (
              <>
                <Button variant="outline" size="sm" onClick={() => setStatus.mutate({ status: "escalated", reason: "Handed off" })}>Escalate</Button>
                <Button variant="outline" size="sm" onClick={() => setStatus.mutate({ status: "written_off", reason: "Bad debt" })}>Write off</Button>
                <Button variant="outline" size="sm" onClick={() => setStatus.mutate({ status: "closed", reason: "Closed manually" })}>Close</Button>
              </>
            )}
          </div>
        </section>

        {/* Activity timeline */}
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Timeline</h4>
          {activity.isLoading
            ? <p className="text-sm text-muted-foreground">Loading…</p>
            : <ActivityTimeline items={activity.data} />}
        </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── New Worklist Dialog ──────────────────────────────────────────

function NewWorklistDialog({ open, onClose, users, onCreated }) {
  const [name, setName] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [description, setDescription] = useState("");
  const { toast } = useToast();
  const create = useMutation({
    mutationFn: () => apiSend("/api/collections/worklists", "POST", {
      name, owner_user_id: ownerId ? Number(ownerId) : null, description: description || null,
    }),
    onSuccess: (data) => {
      toast({ title: "Worklist created" });
      onCreated?.(data.worklist);
      setName(""); setOwnerId(""); setDescription("");
      onClose();
    },
    onError: (e) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New worklist</DialogTitle>
          <DialogDescription>Name a worklist and (optionally) assign it to a rep.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mark — JHB Hold accounts" autoFocus />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Owner</label>
            <select
              value={ownerId}
              onChange={(e) => setOwnerId(e.target.value)}
              className="w-full h-9 rounded-md border border-border bg-card px-3 text-sm text-foreground"
            >
              <option value="">Unassigned</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.full_name || u.email} ({u.email})</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Description (optional)</label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Assign Customers Dialog ──────────────────────────────────────

function AssignCustomersDialog({ open, onClose, worklistId, onAssigned }) {
  const [search, setSearch] = useState("");
  const [minValue, setMinValue] = useState("");
  const [salesRep, setSalesRep] = useState("all");
  const [daysOverdue, setDaysOverdue] = useState("");
  const [selected, setSelected] = useState(new Set());
  useEffect(() => {
    if (!open) {
      setSearch(""); setMinValue(""); setSalesRep("all"); setDaysOverdue("");
      setSelected(new Set());
    }
  }, [open]);

  const candidates = useQuery({
    queryKey: ["collection-candidates", worklistId, search, minValue, salesRep, daysOverdue],
    queryFn: () => {
      const params = new URLSearchParams({ worklist_id: String(worklistId) });
      if (search) params.set("q", search);
      if (minValue && parseFloat(minValue) > 0) params.set("min_value", minValue);
      if (salesRep && salesRep !== "all") params.set("sales_rep", salesRep);
      if (daysOverdue && parseInt(daysOverdue, 10) > 0) params.set("days_overdue", daysOverdue);
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
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or number…" className="pl-8" />
            </div>
            <select
              value={salesRep}
              onChange={(e) => setSalesRep(e.target.value)}
              className="h-9 rounded-md border border-border bg-card px-3 text-sm text-foreground"
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
                    />
                  </th>
                  <th className="px-2 py-1.5 text-left text-xs uppercase tracking-wide text-muted-foreground">Customer</th>
                  <th className="px-2 py-1.5 text-left text-xs uppercase tracking-wide text-muted-foreground">Rep</th>
                  <th className="px-2 py-1.5 text-right text-xs uppercase tracking-wide text-muted-foreground">Outstanding</th>
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
          <Button onClick={() => assign.mutate()} disabled={selected.size === 0 || assign.isPending}>
            Assign {selected.size > 0 ? `(${selected.size})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ────────────────────────────────────────────────────

export default function Collections() {
  useColorScheme();
  const queryClient = useQueryClient();
  const [selectedWorklistId, setSelectedWorklistId] = useState(null);
  const [statusFilter, setStatusFilter] = useState("active");
  const [searchFilter, setSearchFilter] = useState("");
  const [openAssign, setOpenAssign] = useState(false);
  const [openNew, setOpenNew] = useState(false);
  const [drawerAssignment, setDrawerAssignment] = useState(null);

  const me = useQuery({ queryKey: ["me"], queryFn: () => apiGet("/api/auth/me"), staleTime: 60_000 });
  const users = useQuery({
    queryKey: ["collection-users"],
    queryFn: () => apiGet("/api/collections/assignable-users").then(d => d.users || []),
    staleTime: 300_000,
  });
  const worklists = useQuery({
    queryKey: ["worklists"],
    queryFn: () => apiGet("/api/collections/worklists").then(d => d.worklists || []),
    staleTime: 30_000,
    onSuccess: (data) => {
      if (selectedWorklistId == null && data?.length) setSelectedWorklistId(data[0].id);
    },
  });
  // Auto-select first worklist when list arrives
  useEffect(() => {
    if (selectedWorklistId == null && worklists.data?.length) {
      setSelectedWorklistId(worklists.data[0].id);
    }
  }, [worklists.data, selectedWorklistId]);

  const assignments = useQuery({
    queryKey: ["worklist-assignments", selectedWorklistId, statusFilter],
    queryFn: () => apiGet(`/api/collections/worklists/${selectedWorklistId}/assignments?status=${statusFilter}`)
      .then(d => d.assignments || []),
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
              <Button size="sm" variant="ghost" onClick={() => setOpenNew(true)}>
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
                      <span className="rounded bg-amber-500/15 text-amber-300 px-1.5 py-0.5">{w.active_count} active</span>
                      {w.collected_count > 0 && (
                        <span className="rounded bg-emerald-500/15 text-emerald-300 px-1.5 py-0.5">{w.collected_count} collected</span>
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
                      <Button size="sm" onClick={() => setOpenAssign(true)}>
                        <ListPlus className="h-3.5 w-3.5 mr-1" />Assign customers
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => window.print()} disabled={filteredAssignments.length === 0}>
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
                  {["active", "collected", "escalated", "all"].map((s) => (
                    <button
                      key={s}
                      onClick={() => setStatusFilter(s)}
                      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                        statusFilter === s
                          ? "border-amber-500 bg-amber-500/15 text-amber-300"
                          : "border-border bg-card text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {ASSIGNMENT_STATUS_META[s]?.label || (s === "all" ? "All" : s)}
                    </button>
                  ))}
                  <div className="relative flex-1 max-w-xs ml-auto">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input value={searchFilter} onChange={(e) => setSearchFilter(e.target.value)} placeholder="Filter customers…" className="pl-8 h-8" />
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
                        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Customer</th>
                        <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Rep</th>
                        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">Outstanding</th>
                        <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
                        <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground uppercase tracking-wide">Follow-up</th>
                        <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase tracking-wide">Last action</th>
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
                              {a.next_followup_date || "—"}
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
