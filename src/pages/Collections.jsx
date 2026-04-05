import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PhoneCall, Pencil, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const STATUS_META = {
  pending: { label: "Pending", className: "border-slate-500/30 bg-slate-500/10 text-slate-300" },
  contacted: { label: "Contacted", className: "border-sky-500/30 bg-sky-500/10 text-sky-300" },
  promised: { label: "Promised", className: "border-amber-500/30 bg-amber-500/10 text-amber-300" },
  resolved: { label: "Resolved", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" },
};

const FLAG_META = {
  red: { label: "Hold", dot: "bg-red-500", className: "border-red-500/30 bg-red-500/10 text-red-300" },
  orange: { label: "Caution", dot: "bg-orange-400", className: "border-orange-500/30 bg-orange-500/10 text-orange-300" },
};

function parseAmount(value) {
  const num = parseFloat(String(value ?? "").replace(/,/g, "").replace(/\s/g, ""));
  return Number.isFinite(num) ? num : 0;
}

function formatCurrency(value) {
  return `R ${parseAmount(value).toLocaleString("en-ZA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatContacted(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("en-ZA", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || STATUS_META.pending;
  return <span className={`inline-flex rounded-full border px-2 py-1 text-xs font-medium ${meta.className}`}>{meta.label}</span>;
}

function FlagBadge({ color, label }) {
  const meta = FLAG_META[color] || FLAG_META.orange;
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-2 py-1 text-xs font-medium ${meta.className}`}>
      <span className={`h-2.5 w-2.5 rounded-full ${meta.dot}`} />
      {label || meta.label}
    </span>
  );
}

async function fetchCollections() {
  const res = await fetch("/api/collections", { credentials: "include" });
  const data = await res.json().catch(() => []);
  if (!res.ok) throw new Error(data.error || "Failed to load collections pipeline");
  return data;
}

async function saveCollection({ customerId, status, notes }) {
  const res = await fetch(`/api/collections/${customerId}`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, notes }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to save collections item");
  return data;
}

export default function Collections() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [flagFilter, setFlagFilter] = useState("all");
  const [sortDirection, setSortDirection] = useState("desc");
  const [editingRecord, setEditingRecord] = useState(null);
  const [formState, setFormState] = useState({ status: "pending", notes: "" });
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data = [], isLoading, error } = useQuery({
    queryKey: ["collections-pipeline"],
    queryFn: fetchCollections,
    staleTime: 30_000,
  });

  const updateMutation = useMutation({
    mutationFn: saveCollection,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["collections-pipeline"] });
      setEditingRecord(null);
      toast({ title: "Collections item updated" });
    },
    onError: (err) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const filteredRows = useMemo(() => {
    let rows = data;
    if (statusFilter !== "all") rows = rows.filter((row) => row.status === statusFilter);
    if (flagFilter === "hold") rows = rows.filter((row) => row.flag_color === "red");
    if (flagFilter === "caution") rows = rows.filter((row) => row.flag_color === "orange");

    return [...rows].sort((a, b) => {
      const diff = parseAmount(a.outstanding_balance) - parseAmount(b.outstanding_balance);
      return sortDirection === "desc" ? -diff : diff;
    });
  }, [data, statusFilter, flagFilter, sortDirection]);

  const totalOutstanding = useMemo(
    () => filteredRows.reduce((sum, row) => sum + parseAmount(row.outstanding_balance), 0),
    [filteredRows]
  );

  const openEditor = (row) => {
    setEditingRecord(row);
    setFormState({ status: row.status || "pending", notes: row.notes || "" });
  };

  const submitEdit = async (event) => {
    event.preventDefault();
    if (!editingRecord) return;
    updateMutation.mutate({
      customerId: editingRecord.customer_id,
      status: formState.status,
      notes: formState.notes,
    });
  };

  return (
    <div className="min-h-screen bg-background px-4 py-6 text-foreground sm:px-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold">Collections Pipeline</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {filteredRows.length} customer{filteredRows.length === 1 ? "" : "s"} · {formatCurrency(totalOutstanding)} outstanding
            </p>
          </div>
          <div className="rounded-xl border border-border bg-card px-4 py-3 text-sm">
            <div className="text-muted-foreground">Displayed total outstanding</div>
            <div className="mt-1 text-lg font-semibold text-foreground">{formatCurrency(totalOutstanding)}</div>
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="all">All</option>
              <option value="pending">Pending</option>
              <option value="contacted">Contacted</option>
              <option value="promised">Promised</option>
              <option value="resolved">Resolved</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Flag</label>
            <select
              value={flagFilter}
              onChange={(e) => setFlagFilter(e.target.value)}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="all">All</option>
              <option value="hold">Hold only</option>
              <option value="caution">Caution only</option>
            </select>
          </div>

          <div className="sm:ml-auto flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sort</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSortDirection((current) => (current === "desc" ? "asc" : "desc"))}
            >
              Outstanding {sortDirection === "desc" ? "↓" : "↑"}
            </Button>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <span>{filteredRows.length} record{filteredRows.length === 1 ? "" : "s"} in pipeline</span>
            <span>Total outstanding: <span className="font-semibold text-foreground">{formatCurrency(totalOutstanding)}</span></span>
          </div>
        </div>

        {isLoading && (
          <div className="space-y-3 rounded-xl border border-border bg-card p-4">
            {Array.from({ length: 6 }).map((_, idx) => (
              <div key={idx} className="h-12 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        )}

        {!isLoading && error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-sm text-red-300">
            {error.message || "Failed to load collections pipeline"}
          </div>
        )}

        {!isLoading && !error && filteredRows.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card px-6 py-16 text-center">
            <PhoneCall className="mb-4 h-12 w-12 text-muted-foreground" />
            <h2 className="text-lg font-semibold text-foreground">No collections items right now</h2>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Hold and caution customers will appear here once flagged records have outstanding balances.
            </p>
          </div>
        )}

        {!isLoading && !error && filteredRows.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full min-w-[980px] text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left">
                  <th className="px-4 py-3 font-medium text-muted-foreground">Customer Name</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">Outstanding Balance</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">Flag</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">Status</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">Last Contacted</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">Terms</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">Notes</th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr key={row.customer_id} className="border-b border-border/80 align-top last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{row.name || "—"}</div>
                      <div className="text-xs text-muted-foreground">Customer #{row.customer_id}</div>
                    </td>
                    <td className="px-4 py-3 font-semibold tabular-nums text-foreground">{formatCurrency(row.outstanding_balance)}</td>
                    <td className="px-4 py-3"><FlagBadge color={row.flag_color} label={row.flag_label} /></td>
                    <td className="px-4 py-3"><StatusBadge status={row.status} /></td>
                    <td className="px-4 py-3 text-muted-foreground">{formatContacted(row.contacted_at)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{row.terms || "—"}</td>
                    <td className="max-w-[320px] px-4 py-3 text-muted-foreground">
                      <div className="line-clamp-3 whitespace-pre-wrap break-words">{row.notes || "—"}</div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button variant="outline" size="sm" onClick={() => openEditor(row)}>
                        <Pencil className="h-3.5 w-3.5" />
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Dialog open={!!editingRecord} onOpenChange={(open) => !open && !updateMutation.isPending && setEditingRecord(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit collections item</DialogTitle>
            <DialogDescription>
              {editingRecord?.name || "Customer"} · {editingRecord ? formatCurrency(editingRecord.outstanding_balance) : ""}
            </DialogDescription>
          </DialogHeader>

          <form className="space-y-4" onSubmit={submitEdit}>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Status</label>
              <select
                value={formState.status}
                onChange={(e) => setFormState((current) => ({ ...current, status: e.target.value }))}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="pending">Pending</option>
                <option value="contacted">Contacted</option>
                <option value="promised">Promised</option>
                <option value="resolved">Resolved</option>
              </select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Notes</label>
              <textarea
                value={formState.notes}
                onChange={(e) => setFormState((current) => ({ ...current, notes: e.target.value }))}
                rows={5}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="Add collection notes, promises, or follow-up context"
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setEditingRecord(null)} disabled={updateMutation.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
