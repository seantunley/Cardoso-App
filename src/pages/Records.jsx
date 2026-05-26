import { useEffect, useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/apiClient";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, FileText, Download, Zap, ShieldOff, X, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import RecordCard from "../components/records/RecordCard";
import RecordEditModal from "../components/records/RecordEditModal";
import { hasPermission } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { getLedgerFortune } from "@/lib/fun";

// Skeleton card matching RecordCard shape
function SkeletonCard() {
  return (
    <div className="bg-card rounded-xl border border-l-4 border-border overflow-hidden animate-pulse">
      <div className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="h-4 w-28 bg-muted rounded" />
            <div className="h-3 w-16 bg-muted/60 rounded" />
          </div>
          <div className="flex items-center gap-2">
            <div className="h-3 w-20 bg-muted/40 rounded hidden sm:block" />
            <div className="h-7 w-7 bg-muted/40 rounded" />
            <div className="h-7 w-7 bg-muted/40 rounded" />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Records() {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [flagFilter, setFlagFilter] = useState("all");
  const [editingRecord, setEditingRecord] = useState(null);
  const [selectedRecords, setSelectedRecords] = useState(new Set());
  // Toggle a row's id in/out of the selection. Functional setState so we
  // don't capture a stale `selectedRecords` if React batches multiple
  // clicks; useCallback so the per-row inline arrow that wraps it
  // doesn't trigger useless re-renders if RecordCard ever moves to
  // React.memo. Previous form was inline `new Set(selectedRecords)` per
  // click, which read the closure copy of state.
  const toggleSelectedRecord = useCallback((id) => {
    setSelectedRecords((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const [page, setPage] = useState(0);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");

  const pageSize = 50;

  const { data: currentUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => api.auth.me(),
    staleTime: Infinity,
  });

  const canEditRecords = hasPermission(currentUser, "can_edit_records");
  const canFlagRecords = hasPermission(currentUser, "can_flag_records");
  const canAccessRecords = hasPermission(currentUser, "can_access_records");

  const { data: recordResult, isLoading, isFetching } = useQuery({
    queryKey: ["records", debouncedSearchQuery, flagFilter, page],
    queryFn: () => api.records.search({
      search: debouncedSearchQuery,
      flagColor: flagFilter,
      limit: pageSize,
      offset: page * pageSize,
    }),
  });

  const records = recordResult?.records ?? [];
  const totalRecords = recordResult?.total ?? 0;
  const hasMoreRecords = Boolean(recordResult?.has_more);

  const { data: customFields = [] } = useQuery({
    queryKey: ["customFields"],
    queryFn: () => api.entities.CustomFieldConfig.list(),
    staleTime: Infinity,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => api.entities.DataRecord.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["records"] });
      setEditingRecord(null);
      toast.success("Record updated");
    },
  });

  const applyAutoFlagMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/apply-auto-flags", {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Auto-flag failed");
      return data.flagged ?? 0;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ["records"] });
      setSelectedRecords(new Set());
      toast.success(`Applied auto-flagging: ${count} record(s) updated`);
    },
  });

  const handleFlagChange = (id, color) => {
    updateMutation.mutate({ id, data: { flag_color: color } });
  };

  const handleSaveEdit = (id, data) => {
    updateMutation.mutate({ id, data });
  };

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchQuery(searchQuery), 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    setPage(0);
    setSelectedRecords(new Set());
  }, [debouncedSearchQuery, flagFilter]);

  const exportRecords = () => {
    const data = records.map((r) => ({
      source_id: r.source_id,
      source_table: r.source_table,
      flag_color: r.flag_color,
      note: r.note,
      data: r.data,
    }));

    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = "records-export.json";
      a.click();
      toast.success("Current page exported");
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  if (currentUser && !canAccessRecords) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4 text-muted-foreground">
        <ShieldOff className="w-12 h-12 text-muted-foreground/50" />
        <p className="text-lg font-medium">Access Denied</p>
        <p className="text-sm">You don't have permission to view Records.</p>
      </div>
    );
  }

  const hasSelection = selectedRecords.size > 0;

  return (
    <div className="min-h-screen bg-background">
      {/* Extra bottom padding when selection bar is visible */}
      <div className={cn("max-w-6xl mx-auto p-6 lg:p-8 space-y-5", hasSelection ? "pb-40 lg:pb-24" : "")}>

        {/* Page header */}
        <div className="flex items-end justify-between gap-4 border-b border-border pb-5">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">§ Records</div>
            <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
              Raw <em className="text-phosphor">data</em>.
            </h1>
            <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground mt-3 tabular-nums">
              {isLoading ? "Loading…" : `${records.length.toLocaleString("en-US")} of ${totalRecords.toLocaleString("en-US")} shown`}
            </p>
          </div>
        </div>

        {/* Filter bar — compact single row */}
        <div className="bg-card border border-border rounded-xl p-3 flex items-center gap-2 flex-wrap sm:flex-nowrap">
          {/* Search */}
          <div className="relative flex-1 min-w-[160px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search records…"
              className="pl-8 h-8 text-sm bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          {/* Divider */}
          <div className="hidden sm:block h-6 w-px bg-border shrink-0" />

          {/* Flag filter */}
          <Select value={flagFilter} onValueChange={setFlagFilter}>
            <SelectTrigger className="w-full sm:w-[148px] h-8 text-sm bg-muted border-border text-foreground shrink-0">
              <SelectValue placeholder="All flags" />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              <SelectItem value="all">All Flags</SelectItem>
              <SelectItem value="none">No Flag</SelectItem>
              <SelectItem value="red">Red</SelectItem>
              <SelectItem value="green">Green</SelectItem>
              <SelectItem value="orange">Orange</SelectItem>
            </SelectContent>
          </Select>

          {/* Divider */}
          <div className="hidden sm:block h-6 w-px bg-border shrink-0" />

          {/* Export */}
          <Button
            variant="outline"
            size="sm"
            onClick={exportRecords}
            className="h-8 text-xs border-border text-muted-foreground hover:bg-muted hover:text-foreground shrink-0"
          >
            <Download className="w-3.5 h-3.5 mr-1.5" />
            Export Page
          </Button>
        </div>

        {/* Record list */}
        {isLoading ? (
          <div className="space-y-2.5">
            {[1, 2, 3, 4, 5].map((i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : records.length === 0 ? (
          <div className="text-center py-20 bg-card rounded-xl border border-border">
            <FileText className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
            <h3 className="text-sm font-semibold text-foreground">No records found</h3>
            <p className="text-xs text-muted-foreground mt-1">
              {totalRecords === 0
                ? getLedgerFortune()
                : "No matching rows. The filter did its job a little too well."}
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {records.map((record) => (
              <div
                key={record.id}
                onClick={() => toggleSelectedRecord(record.id)}
                className="cursor-pointer"
              >
                <RecordCard
                  record={record}
                  customFields={customFields}
                  onFlagChange={canFlagRecords ? handleFlagChange : null}
                  onEdit={canEditRecords ? setEditingRecord : null}
                  isSelected={selectedRecords.has(record.id)}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Selection bar — fixed bottom, slides in when records are selected */}
      <div
        className={cn(
          "fixed bottom-0 left-0 right-0 z-[60] transition-all duration-200",
          hasSelection ? "translate-y-0 opacity-100" : "translate-y-full opacity-0 pointer-events-none"
        )}
      >
        <div className="bg-card border-t border-border shadow-2xl">
          <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="text-sm font-semibold text-foreground">
                {selectedRecords.size}
              </span>
              <span className="text-sm text-muted-foreground">
                {selectedRecords.size === 1 ? "record selected" : "records selected"}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedRecords(new Set())}
                className="h-8 text-xs text-muted-foreground hover:text-foreground"
              >
                <X className="w-3.5 h-3.5 mr-1.5" />
                Clear
              </Button>

              <Button
                size="sm"
                onClick={() => applyAutoFlagMutation.mutate(Array.from(selectedRecords))}
                disabled={applyAutoFlagMutation.isPending}
                className="h-8 text-xs bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <Zap className="w-3.5 h-3.5 mr-1.5" />
                {applyAutoFlagMutation.isPending ? "Applying…" : "Apply Auto-Flag"}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {!isLoading && totalRecords > 0 && (() => {
        const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
        const currentPage = page + 1;
        return (
        <div className="max-w-6xl mx-auto px-6 pb-6 lg:px-8 lg:pb-8 flex flex-col sm:flex-row items-center justify-between gap-3 text-sm text-muted-foreground">
          <p>
            Page {currentPage} of {totalPages} · Showing {records.length} of {totalRecords.toLocaleString("en-US")}
            {isFetching ? " · Updating…" : ""}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(0)}
              disabled={page === 0 || isFetching}
              className="h-8 text-xs"
              title="First page"
            >
              First
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((current) => Math.max(current - 1, 0))}
              disabled={page === 0 || isFetching}
              className="h-8 text-xs"
            >
              <ChevronLeft className="w-3.5 h-3.5 mr-1" />
              Prev
            </Button>
            <div className="flex items-center gap-1.5 text-xs">
              <input
                type="number"
                min={1}
                max={totalPages}
                key={currentPage}
                defaultValue={currentPage}
                onBlur={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (Number.isFinite(v) && v >= 1 && v <= totalPages) setPage(v - 1);
                  else e.target.value = currentPage;
                }}
                onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
                disabled={isFetching}
                className="w-14 h-7 rounded border border-border bg-card px-1.5 text-center text-xs text-foreground tabular-nums"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((current) => current + 1)}
              disabled={!hasMoreRecords || isFetching}
              className="h-8 text-xs"
            >
              Next
              <ChevronRight className="w-3.5 h-3.5 ml-1" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(totalPages - 1)}
              disabled={currentPage >= totalPages || isFetching}
              className="h-8 text-xs"
              title="Last page"
            >
              Last
            </Button>
          </div>
        </div>
        );
      })()}

      <RecordEditModal
        record={editingRecord}
        customFields={customFields}
        open={!!editingRecord}
        onClose={() => setEditingRecord(null)}
        onSave={handleSaveEdit}
        isSaving={updateMutation.isPending}
      />
    </div>
  );
}
