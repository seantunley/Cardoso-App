import { useState } from "react";
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
import { Search, Filter, FileText, Download, Zap, ShieldOff } from "lucide-react";
import { toast } from "sonner";
import RecordCard from "../components/records/RecordCard";
import RecordEditModal from "../components/records/RecordEditModal";
import { hasPermission } from "@/lib/permissions";

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
    mutationFn: async (recordIds) => {
      const rules = await api.entities.AutoFlagRule.list();
      const activeRules = rules.filter((r) => r.is_active);
      const now = new Date().toISOString();

      let flaggedCount = 0;
      const targetRecords = records.filter((r) => recordIds.includes(r.id));

      for (const record of targetRecords) {
        let parsedData = record.data;
        if (typeof parsedData === "string") {
          try {
            parsedData = JSON.parse(parsedData);
          } catch {
            parsedData = {};
          }
        }

        const ageAnalysis = record.age_analysis || parsedData?.age_analysis;
        if (!ageAnalysis) continue;

        const autoFlag = checkAutoFlagRulesSync(ageAnalysis, activeRules);

        if (autoFlag && autoFlag.flag_color !== record.flag_color) {
          await api.entities.DataRecord.update(record.id, {
            ...autoFlag,
            last_checked: now,
          });
          flaggedCount++;
        } else {
          await api.entities.DataRecord.update(record.id, { last_checked: now });
        }
      }

      return flaggedCount;
    },
    onSuccess: (count) => {
      queryClient.invalidateQueries({ queryKey: ["records"] });
      setSelectedRecords(new Set());
      toast.success(`Applied auto-flagging to ${count} record(s)`);
    },
  });

  const checkAutoFlagRulesSync = (ageAnalysis, rules) => {
    if (!ageAnalysis) return null;

    const evaluateCondition = (conditionType, conditionValue, conditionValueSecondary) => {
      if (['greater_than', 'less_than', 'greater_or_equal', 'less_or_equal'].includes(conditionType)) {
        const numbersInAgeAnalysis = ageAnalysis.match(/[+\-]?\d+/g)?.map(n => parseInt(n, 10)) || [];
        const threshold = parseFloat(conditionValue);
        if (!isNaN(threshold) && numbersInAgeAnalysis.length > 0) {
          for (const num of numbersInAgeAnalysis) {
            switch (conditionType) {
              case 'greater_than': if (num > threshold) return true; break;
              case 'less_than': if (num < threshold) return true; break;
              case 'greater_or_equal': if (num >= threshold) return true; break;
              case 'less_or_equal': if (num <= threshold) return true; break;
            }
          }
        }
        return false;
      } else if (conditionType === 'range_between') {
        const numbers = ageAnalysis.match(/[+\-]?\d+/g)?.map(n => parseInt(n, 10)) || [];
        const low = parseFloat(conditionValue);
        const high = parseFloat(conditionValueSecondary);
        return numbers.some(n => n >= low && n <= high);
      } else {
        const valueLower = String(conditionValue).toLowerCase();
        const ageAnalysisLower = ageAnalysis.toLowerCase();
        switch (conditionType) {
          case 'contains': return ageAnalysisLower.includes(valueLower);
          case 'equals': return ageAnalysisLower === valueLower;
          case 'starts_with': return ageAnalysisLower.startsWith(valueLower);
          case 'ends_with': return ageAnalysisLower.endsWith(valueLower);
          default: return false;
        }
      }
    };

    for (const rule of rules) {
      let conditions = rule.conditions;
      if (typeof conditions === 'string') {
        try { conditions = JSON.parse(conditions); } catch { conditions = []; }
      }
      if (!Array.isArray(conditions) || conditions.length === 0) continue;

      const logic = rule.logic || 'AND';
      const results = conditions.map(c =>
        evaluateCondition(c.condition_type, c.condition_value, c.condition_value_secondary)
      );

      const matches = logic === 'OR'
        ? results.some(Boolean)
        : results.every(Boolean);

      if (matches) {
        return {
          flag_color: rule.flag_color,
          flag_reason: `Auto-flagged: ${rule.rule_name}`,
          auto_flagged: true,
        };
      }
    }

    return null;
  };

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
      custom_field_1: r.custom_field_1,
      custom_field_2: r.custom_field_2,
      custom_field_3: r.custom_field_3,
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

  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      <div className="max-w-6xl mx-auto p-6 lg:p-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-[var(--text-primary)] tracking-tight">
              Data Records
            </h1>
            <p className="text-[var(--text-secondary)] mt-1">
              {filteredRecords.length} of {records.length} records
            </p>
          </div>
          <Button
            variant="outline"
            onClick={exportRecords}
            className="border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
          >
            <Download className="w-4 h-4 mr-2" />
            Export
          </Button>
        </div>

        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-4 p-4 bg-[var(--bg-secondary)] rounded-2xl border border-[var(--border-color)]">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-tertiary)]" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search records..."
                className="pl-10 bg-[var(--bg-tertiary)] border-[var(--border-color)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
              />
            </div>

            <Select value={flagFilter} onValueChange={setFlagFilter}>
              <SelectTrigger className="w-full sm:w-[180px] bg-[var(--bg-tertiary)] border-[var(--border-color)] text-[var(--text-primary)]">
                <Filter className="w-4 h-4 mr-2 text-[var(--text-tertiary)]" />
                <SelectValue placeholder="Filter by flag" />
              </SelectTrigger>
              <SelectContent className="bg-[var(--bg-secondary)] border-[var(--border-color)]">
                <SelectItem value="all">All Flags</SelectItem>
                <SelectItem value="none">No Flag</SelectItem>
                <SelectItem value="red">Red Flag</SelectItem>
                <SelectItem value="green">Green Flag</SelectItem>
                <SelectItem value="orange">Orange Flag</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {selectedRecords.size > 0 && (
            <div className="flex items-center justify-between p-4 bg-blue-900/20 border border-blue-800/50 rounded-2xl">
              <span className="text-sm text-blue-300">
                {selectedRecords.size} record(s) selected
              </span>
              <Button
                onClick={() => applyAutoFlagMutation.mutate(Array.from(selectedRecords))}
                disabled={applyAutoFlagMutation.isPending}
                size="sm"
                className="bg-blue-600 hover:bg-blue-700 text-white"
              >
                <Zap className="w-4 h-4 mr-2" />
                {applyAutoFlagMutation.isPending ? "Applying..." : "Apply Auto-Flag"}
              </Button>
            </div>
          )}
        </div>

        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="h-32 bg-[var(--bg-secondary)] rounded-xl animate-pulse"
              />
            ))}
          </div>
        ) : filteredRecords.length === 0 ? (
          <div className="text-center py-16 bg-gray-900 rounded-2xl border border-gray-700">
            <FileText className="w-12 h-12 text-gray-600 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-white">No records found</h3>
            <p className="text-gray-400 mt-1">
              {records.length === 0
                ? "Sync data from your connections to see records here"
                : "Try adjusting your search or filter"}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
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
                className={`cursor-pointer transition-all ${
                  selectedRecords.has(record.id) ? "ring-2 ring-blue-500 rounded-xl" : ""
                }`}
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

        <RecordEditModal
          record={editingRecord}
          customFields={customFields}
          open={!!editingRecord}
          onClose={() => setEditingRecord(null)}
          onSave={handleSaveEdit}
          isSaving={updateMutation.isPending}
        />
      </div>
    </div>
  );
}