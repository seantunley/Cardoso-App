import { useState } from "react";
import { Flag, ChevronDown, ChevronUp, Edit2, Lock, Zap, MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";

const flagColors = {
  none: "bg-slate-800 text-slate-300 border-slate-600",
  red: "bg-red-950/60 text-red-300 border-red-800",
  green: "bg-green-950/60 text-green-300 border-green-800",
  orange: "bg-orange-950/60 text-orange-300 border-orange-800",
};

const flagLabels = {
  none: "No Flag",
  red: "Red Flag",
  green: "Green Flag",
  orange: "Orange Flag",
};

const autoBannerColors = {
  none: "bg-slate-800/80 border-slate-600 text-slate-300",
  red: "bg-red-950/70 border-red-700 text-red-300",
  green: "bg-green-950/70 border-green-700 text-green-300",
  orange: "bg-orange-950/70 border-orange-700 text-orange-300",
};

const autoDot = {
  none: "bg-slate-400",
  red: "bg-red-500",
  green: "bg-green-500",
  orange: "bg-orange-500",
};

export default function RecordCard({ record, customFields, onFlagChange, onEdit, isSelected }) {
  const [expanded, setExpanded] = useState(false);

  const canFlag = typeof onFlagChange === "function";
  const canEdit = typeof onEdit === "function";
  const color = record.flag_color || "none";

  return (
    <div className={cn("group bg-card rounded-xl border overflow-hidden transition-all duration-300 hover:shadow-lg hover:shadow-background", isSelected ? "border-blue-500 bg-blue-900/10" : "border-border hover:border-muted-foreground/30")}>

      {/* Auto-flag banner */}
      {record.auto_flagged ? (
        <div
          title={record.flag_reason}
          className={cn("flex items-center justify-center gap-2.5 px-4 py-2 border-b text-xs font-medium", autoBannerColors[color])}
        >
          <Zap className="w-3.5 h-3.5 shrink-0" />
          <span className="flex items-center gap-1.5">
            <span className={cn("w-2 h-2 rounded-full shrink-0", autoDot[color])} />
            Auto-flagged
            {color !== "none" && <span className="capitalize">· {color}</span>}
          </span>
          {record.flag_reason && (
            <>
              <span className="opacity-40">·</span>
              <span className="opacity-80 truncate max-w-[200px]">{record.flag_reason}</span>
            </>
          )}
        </div>
      ) : null}

      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-2">
              <span className="text-sm font-semibold text-foreground bg-muted px-2 py-1 rounded-md font-mono flex items-center gap-1.5">
                {record.customer_number || record.data?.customer_number || record.source_id}
                {record.notes && <MessageSquare className="w-3.5 h-3.5 text-muted-foreground" />}
              </span>
              <span className="text-sm text-muted-foreground">
                {record.source_table || record.data?.source_table}
              </span>
            </div>
            
            <div className="flex items-center gap-3">
              {canFlag ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button 
                      variant="outline" 
                      size="sm"
                      className={cn("border gap-2", flagColors[color])}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Flag className="w-3.5 h-3.5" />
                      {flagLabels[color]}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {Object.entries(flagLabels).map(([key, label]) => (
                      <DropdownMenuItem 
                        key={key}
                        onClick={() => onFlagChange(record.id, key)}
                        className={cn("gap-2", record.flag_color === key && "bg-muted")}
                      >
                        <div className={cn("w-2 h-2 rounded-full", {
                          "bg-slate-400": key === "none",
                          "bg-red-500": key === "red",
                          "bg-green-500": key === "green",
                          "bg-orange-500": key === "orange",
                        })} />
                        {label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs",
                    flagColors[color]
                  )}
                >
                  <Flag className="w-3 h-3" />
                  {flagLabels[color]}
                </span>
              )}

              <span className="text-xs text-muted-foreground">
                Synced {formatDistanceToNow(new Date(record.synced_at || record.created_date), { addSuffix: true })}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {canEdit ? (
              <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); onEdit(record); }}>
                <Edit2 className="w-4 h-4 text-muted-foreground" />
              </Button>
            ) : (
              <Button variant="ghost" size="icon" disabled title="You don't have edit permission">
                <Lock className="w-4 h-4 text-muted-foreground/50" />
              </Button>
            )}
            <Button 
              variant="ghost" 
              size="icon"
              title={expanded ? "Hide source data" : "Show source data"}
              onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            >
              {expanded ? (
                <ChevronUp className="w-4 h-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              )}
            </Button>
          </div>
        </div>

        {/* Custom Fields Preview */}
        {customFields?.filter(cf => cf.is_active && record[cf.field_key]).length > 0 && (
          <div className="flex flex-wrap gap-2 mt-4">
            {customFields.filter(cf => cf.is_active).map(cf => {
              const value = record[cf.field_key];
              if (!value) return null;
              return (
                <Badge key={cf.field_key} variant="secondary" className="bg-muted text-muted-foreground">
                  {cf.label}: {value}
                </Badge>
              );
            })}
          </div>
        )}
      </div>

      {/* Expanded Data View */}
      {expanded && (
        <div className="border-t border-border bg-muted/50 p-5">
          <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
            Source Data
          </h4>
          <pre className="text-xs text-muted-foreground bg-background p-4 rounded-lg border border-border overflow-x-auto">
            {JSON.stringify(record.data, null, 2)}
          </pre>

          {record.notes && (
            <div className="mt-4">
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                Notes
              </h4>
              <p className="text-sm text-foreground">{record.notes}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
