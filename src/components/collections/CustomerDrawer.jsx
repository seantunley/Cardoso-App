import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/use-toast";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneCall, CalendarClock, RotateCcw } from "lucide-react";
import ActivityTimeline from "./ActivityTimeline";
import { ASSIGNMENT_STATUS_META } from "./meta";
import { apiGet, apiSend, formatCurrency, parseAmount } from "./utils";

export default function CustomerDrawer({ assignment, onClose, onChange }) {
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
