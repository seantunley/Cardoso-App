import { useState } from "react";
import { checkAutoFlagRules } from "@/lib/evalFlagRules";
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
import { Search, FileText, Download, Zap, ShieldOff, X } from "lucide-react";
import { toast } from "sonner";
import RecordCard from "../components/records/RecordCard";
import RecordEditModal from "../components/records/RecordEditModal";
import { hasPermission } from "@/lib/permissions";
import { cn } from "@/lib/utils";

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

  const { data: currentUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => api.auth.me(),
  });

  const canEditRecords = hasPermission(currentUser, "can_edit_records");
  const canFlagRecords = hasPermission(currentUser, "can_flag_records");
  const canAccessRecords = hasPermission(currentUser, "can_access_records");

  const { data: records = [], isLoading } = useQuery({
    queryKey: ["records"],
    queryFn: async () => {
      const allRecords = await api.entities.DataRecord.list();
      return allRecords;
    },
  });

  const { data: customFields = [] } = useQuery({
    queryKey: ["customFields"],
    queryFn: () => api.entities.CustomFieldConfig.list(),
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

  const filteredRecords = records.filter((record) => {
    let parsedData = record.data;
    if (typeof parsedData === "string") {
      try {
        parsedData = JSON.parse(parsedData);
      } catch {
        parsedData = {};
      }
    }

    const customerNumber = record.customer_number || parsedData?.customer_number;

    const matchesSearch =
      !searchQuery ||
      customerNumber?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      record.source_id?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      record.source_table?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      JSON.stringify(parsedData || {}).toLowerCase().includes(searchQuery.toLowerCase());

    const matchesFlag = flagFilter === "all" || record.flag_color === flagFilter;

    return matchesSearch && matchesFlag;
  });

  const exportRecords = () => {
    const data = filteredRecords.map((r) => ({
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
      toast.success("Records exported");
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
      <div className={cn("max-w-6xl mx-auto p-6 lg:p-8 space-y-5", hasSelection && "pb-24")}>

        {/* Page header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-foreground tracking-tight">
              Data Records
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {isLoading ? "Loading…" : `${filteredRecords.length} of ${records.length} records`}
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
            Export
          </Button>
        </div>

        {/* Record list */}
        {isLoading ? (
          <div className="space-y-2.5">
            {[1, 2, 3, 4, 5].map((i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : filteredRecords.length === 0 ? (
          <div className="text-center py-20 bg-card rounded-xl border border-border">
            <FileText className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
            <h3 className="text-sm font-semibold text-foreground">No records found</h3>
            <p className="text-xs text-muted-foreground mt-1">
              {records.length === 0
                ? "Sync data from your connections to see records here"
                : "Try adjusting your search or filter"}
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {filteredRecords.map((record) => (
              <div
                key={record.id}
                onClick={() => {
                  const newSelected = new Set(selectedRecords);
                  if (newSelected.has(record.id)) {
                    newSelected.delete(record.id);
                  } else {
                    newSelected.add(record.id);
                  }
                  setSelectedRecords(newSelected);
                }}
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
          "fixed bottom-0 left-0 right-0 z-50 transition-all duration-200",
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
