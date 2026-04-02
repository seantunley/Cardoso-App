import { useState } from "react";
import { ChevronDown, ChevronUp, Edit2, Lock, Zap, MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";

const flagBorderColors = {
  none: "border-l-border",
  red: "border-l-red-500",
  green: "border-l-green-500",
  orange: "border-l-orange-500",
};

const flagPillColors = {
  none: "bg-muted text-muted-foreground border-border",
  red: "bg-red-500/10 text-red-400 border-red-500/30",
  green: "bg-green-500/10 text-green-400 border-green-500/30",
  orange: "bg-orange-500/10 text-orange-400 border-orange-500/30",
};

const flagDotColors = {
  none: "bg-muted-foreground/50",
  red: "bg-red-500",
  green: "bg-green-500",
  orange: "bg-orange-500",
};

export default function RecordCard({ record, customFields, onFlagChange, onEdit, isSelected }) {
  const [expanded, setExpanded] = useState(false);

  const canEdit = typeof onEdit === "function";
  const color = record.flag_color || "none";

  // Parse customer number from various locations
  let parsedData = record.data;
  if (typeof parsedData === "string") {
    try { parsedData = JSON.parse(parsedData); } catch { parsedData = {}; }
  }
  const customerNumber = record.customer_number || parsedData?.customer_number || record.source_id;
  const sourceTable = record.source_table || parsedData?.source_table;

  return (
    <div
      className={cn(
        "group bg-card rounded-xl border border-l-4 overflow-hidden transition-all duration-200",
        flagBorderColors[color],
        isSelected
          ? "border-primary ring-1 ring-primary/40 bg-primary/5"
          : "border-border hover:border-muted-foreground/40 hover:shadow-sm"
      )}
    >
      <div className="p-4">
        <div className="flex items-center justify-between gap-3">
          {/* Left: primary info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {/* Customer number — most prominent */}
              <span className="text-sm font-semibold text-foreground font-mono tracking-tight">
                {customerNumber}
              </span>

              {/* Notes indicator */}
              {record.notes && (
                <MessageSquare className="w-3.5 h-3.5 text-muted-foreground shrink-0" title="Has notes" />
              )}

              {/* Source table — subtle */}
              {sourceTable && (
                <span className="text-xs text-muted-foreground shrink-0">
                  {sourceTable}
                </span>
              )}

              {/* Auto-flag reason pill */}
              {record.auto_flagged && record.flag_reason && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-medium leading-none shrink-0",
                    flagPillColors[color]
                  )}
                  title={record.flag_reason}
                >
                  <Zap className="w-2.5 h-2.5 shrink-0" />
                  <span className="truncate max-w-[160px]">{record.flag_reason}</span>
                </span>
              )}

              {/* Auto-flagged but no reason — show a minimal indicator */}
              {record.auto_flagged && !record.flag_reason && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-medium leading-none shrink-0",
                    flagPillColors[color]
                  )}
                >
                  <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", flagDotColors[color])} />
                  Auto-flagged
                </span>
              )}
            </div>
          </div>

          {/* Right: sync time + actions */}
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-xs text-muted-foreground mr-2 hidden sm:block">
              {formatDistanceToNow(new Date(record.synced_at || record.created_date), { addSuffix: true })}
            </span>

            {canEdit ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={(e) => { e.stopPropagation(); onEdit(record); }}
                title="Edit record"
              >
                <Edit2 className="w-3.5 h-3.5 text-muted-foreground" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                disabled
                title="You don't have edit permission"
              >
                <Lock className="w-3.5 h-3.5 text-muted-foreground/40" />
              </Button>
            )}

            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title={expanded ? "Hide source data" : "Show source data"}
              onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            >
              {expanded ? (
                <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
              )}
            </Button>
          </div>
        </div>

        {/* Sync time on mobile (below main row) */}
        <p className="text-xs text-muted-foreground mt-1.5 sm:hidden">
          {formatDistanceToNow(new Date(record.synced_at || record.created_date), { addSuffix: true })}
        </p>

        {/* Custom Fields */}
        {customFields?.filter(cf => cf.is_active && record[cf.field_key]).length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3">
            {customFields.filter(cf => cf.is_active).map(cf => {
              const value = record[cf.field_key];
              if (!value) return null;
              return (
                <Badge key={cf.field_key} variant="secondary" className="text-[10px] h-5 bg-muted text-muted-foreground border-border">
                  {cf.label}: {value}
                </Badge>
              );
            })}
          </div>
        )}
      </div>

      {/* Expanded Source Data */}
      {expanded && (
        <div className="border-t border-border bg-muted/30 p-4">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2">
            Source Data
          </p>
          <pre className="text-xs text-muted-foreground bg-background p-3 rounded-lg border border-border overflow-x-auto leading-relaxed">
            {JSON.stringify(parsedData, null, 2)}
          </pre>

          {record.notes && (
            <div className="mt-3">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-1.5">
                Notes
              </p>
              <p className="text-sm text-foreground">{record.notes}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
