import { useState } from "react";
import { Flag, ChevronDown, ChevronUp, Edit2, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import moment from "moment";

const flagColors = {
  none: "bg-slate-100 text-slate-500 border-slate-200",
  red: "bg-red-100 text-red-700 border-red-200",
  green: "bg-green-100 text-green-700 border-green-200",
  orange: "bg-orange-100 text-orange-700 border-orange-200",
};

const flagLabels = {
  none: "No Flag",
  red: "Red Flag",
  green: "Green Flag",
  orange: "Orange Flag",
};

export default function RecordCard({ record, customFields, onFlagChange, onEdit, isSelected }) {
  const [expanded, setExpanded] = useState(false);

  const canFlag = typeof onFlagChange === "function";
  const canEdit = typeof onEdit === "function";

  return (
    <div className={cn("group bg-gray-900 rounded-xl border overflow-hidden transition-all duration-300 hover:shadow-lg hover:shadow-gray-800", isSelected ? "border-blue-500 bg-blue-900/10" : "border-gray-700 hover:border-gray-600")}>
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-2">
              <span className="text-xs font-mono text-gray-400 bg-gray-800 px-2 py-1 rounded">
                {record.customer_number || record.data?.customer_number || record.source_id}
              </span>
              <span className="text-xs text-gray-400">
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
                      className={cn("border gap-2", flagColors[record.flag_color || "none"])}
                    >
                      <Flag className="w-3.5 h-3.5" />
                      {flagLabels[record.flag_color || "none"]}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {Object.entries(flagLabels).map(([key, label]) => (
                      <DropdownMenuItem 
                        key={key}
                        onClick={() => onFlagChange(record.id, key)}
                        className={cn("gap-2", record.flag_color === key && "bg-slate-100")}
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
                    flagColors[record.flag_color || "none"]
                  )}
                >
                  <Flag className="w-3 h-3" />
                  {flagLabels[record.flag_color || "none"]}
                </span>
              )}

              <span className="text-xs text-gray-400">
                Synced {moment(record.synced_at || record.created_date).fromNow()}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {canEdit ? (
              <Button variant="ghost" size="icon" onClick={() => onEdit(record)}>
                <Edit2 className="w-4 h-4 text-gray-400" />
              </Button>
            ) : (
              <Button variant="ghost" size="icon" disabled title="No edit permission">
                <Lock className="w-4 h-4 text-gray-600" />
              </Button>
            )}
            <Button 
              variant="ghost" 
              size="icon"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? (
                <ChevronUp className="w-4 h-4 text-gray-400" />
              ) : (
                <ChevronDown className="w-4 h-4 text-gray-400" />
              )}
            </Button>
          </div>
        </div>

        {/* Custom Fields Preview */}
        <div className="flex flex-wrap gap-2 mt-4">
          {customFields?.filter(cf => cf.is_active).map(cf => {
            const value = record[cf.field_key];
            if (!value) return null;
            return (
              <Badge key={cf.field_key} variant="secondary" className="bg-gray-800 text-gray-300">
                {cf.label}: {value}
              </Badge>
            );
          })}
        </div>
      </div>

      {/* Expanded Data View */}
      {expanded && (
        <div className="border-t border-gray-800 bg-gray-850/50 p-5">
          <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">
            Source Data
          </h4>
          <pre className="text-xs text-gray-300 bg-gray-950 p-4 rounded-lg border border-gray-800 overflow-x-auto">
            {JSON.stringify(record.data, null, 2)}
          </pre>

          {record.notes && (
            <div className="mt-4">
              <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                Notes
              </h4>
              <p className="text-sm text-gray-300">{record.notes}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
