import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, Plus, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";

// Fields available for rule conditions
export const RULE_FIELDS = [
  { value: "age_analysis",             label: "Age Analysis",             type: "text" },
  { value: "outstanding_balance",      label: "Outstanding Balance",      type: "number" },
  { value: "last_unpaid_invoice_date", label: "Last Unpaid Invoice Date", type: "date" },
  { value: "last_receipt_date",        label: "Last Receipt Date",        type: "date" },
  { value: "updated_date",             label: "Last Updated",             type: "date" },
  { value: "created_date",             label: "Date Created",             type: "date" },
];

export const conditionOptions = {
  text: [
    { value: "contains",     label: "Contains" },
    { value: "equals",       label: "Equals" },
    { value: "starts_with",  label: "Starts With" },
    { value: "ends_with",    label: "Ends With" },
    { value: "is_empty",     label: "Is Empty" },
    { value: "is_not_empty", label: "Is Not Empty" },
  ],
  number: [
    { value: "greater_than",     label: "Greater Than (>)" },
    { value: "less_than",        label: "Less Than (<)" },
    { value: "greater_or_equal", label: "Greater or Equal (≥)" },
    { value: "less_or_equal",    label: "Less or Equal (≤)" },
    { value: "range_between",    label: "Between" },
    { value: "is_empty",         label: "Is Empty" },
    { value: "is_not_empty",     label: "Is Not Empty" },
  ],
  date: [
    { value: "date_older_than", label: "Older Than (days ago)" },
    { value: "date_newer_than", label: "Newer Than (days ago)" },
    { value: "before_date",     label: "Before Date" },
    { value: "after_date",      label: "After Date" },
    { value: "is_empty",        label: "Is Empty / No Date" },
    { value: "is_not_empty",    label: "Has a Date" },
  ],
};

const NO_VALUE_TYPES = ["is_empty", "is_not_empty"];

export function getFieldType(fieldValue) {
  return RULE_FIELDS.find(f => f.value === fieldValue)?.type || "text";
}

function newCondition(group = 1) {
  return {
    id: `cond-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    group,
    field: "age_analysis",
    condition_type: "contains",
    condition_value: "",
    condition_value_secondary: "",
  };
}

export default function RuleConditionBuilder({
  conditions = [],
  onConditionsChange,
  isAdmin,
}) {
  let parsed = Array.isArray(conditions) ? conditions : [];
  if (typeof conditions === "string") {
    try { parsed = JSON.parse(conditions); } catch { parsed = []; }
  }
  // Migrate legacy conditions (no group) → group 1
  parsed = parsed.map(c => ({ group: 1, ...c }));

  // Derive sorted unique group numbers
  const groups = [...new Set(parsed.map(c => c.group))].sort((a, b) => a - b);
  const nextGroup = groups.length > 0 ? Math.max(...groups) + 1 : 1;

  const addConditionToGroup = (group) => {
    onConditionsChange([...parsed, newCondition(group)]);
  };

  const addGroup = () => {
    onConditionsChange([...parsed, newCondition(nextGroup)]);
  };

  const removeCondition = (id) => {
    const remaining = parsed.filter(c => c.id !== id);
    // Re-number groups to stay contiguous
    const oldGroups = [...new Set(remaining.map(c => c.group))].sort((a, b) => a - b);
    const remap = Object.fromEntries(oldGroups.map((g, i) => [g, i + 1]));
    onConditionsChange(remaining.map(c => ({ ...c, group: remap[c.group] })));
  };

  const updateCondition = (id, updates) => {
    onConditionsChange(parsed.map(c => c.id === id ? { ...c, ...updates } : c));
  };

  if (parsed.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Label className="text-gray-300">Conditions</Label>
          {isAdmin && (
            <Button type="button" size="sm" variant="outline" onClick={() => onConditionsChange([newCondition(1)])}
              className="border-gray-700 text-gray-300 hover:bg-gray-800">
              <Plus className="w-4 h-4 mr-1" /> Add Condition
            </Button>
          )}
        </div>
        <div className="p-3 rounded-lg border border-gray-700 text-center">
          <p className="text-sm text-gray-400">No conditions yet. Add one to get started.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-3">
        <Label className="text-gray-300">Conditions</Label>
        {isAdmin && (
          <Button type="button" size="sm" variant="outline" onClick={addGroup}
            className="border-indigo-700 text-indigo-300 hover:bg-indigo-900/30">
            <GitBranch className="w-4 h-4 mr-1" /> Add OR Group
          </Button>
        )}
      </div>

      {groups.map((group, groupIndex) => {
        const groupConditions = parsed.filter(c => c.group === group);
        return (
          <div key={group}>
            {/* OR separator between groups */}
            {groupIndex > 0 && (
              <div className="flex items-center gap-3 my-3">
                <div className="flex-1 h-px bg-gray-700" />
                <span className="px-3 py-1 text-xs font-bold rounded-full bg-indigo-900/50 text-indigo-300 border border-indigo-700 tracking-widest">
                  OR
                </span>
                <div className="flex-1 h-px bg-gray-700" />
              </div>
            )}

            {/* Group box */}
            <div className="rounded-lg border border-gray-700 bg-gray-900/40 p-3 space-y-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-500 uppercase tracking-wider">
                  Group {groupIndex + 1} — all must match (AND)
                </span>
                {isAdmin && (
                  <Button type="button" size="sm" variant="outline" onClick={() => addConditionToGroup(group)}
                    className="h-7 text-xs border-gray-700 text-gray-400 hover:bg-gray-800">
                    <Plus className="w-3 h-3 mr-1" /> Add Condition
                  </Button>
                )}
              </div>

              {groupConditions.map((condition, idx) => {
                const fieldType = getFieldType(condition.field);
                const opts = conditionOptions[fieldType] || conditionOptions.text;
                const noValue = NO_VALUE_TYPES.includes(condition.condition_type);

                return (
                  <div key={condition.id}>
                    {/* AND divider within group */}
                    {idx > 0 && (
                      <div className="flex items-center gap-2 my-2">
                        <div className="flex-1 h-px bg-gray-700/60" />
                        <span className="text-xs font-semibold text-gray-500 tracking-widest">AND</span>
                        <div className="flex-1 h-px bg-gray-700/60" />
                      </div>
                    )}

                    <Card className="bg-gray-850 border-gray-700">
                      <CardContent className="pt-4 pb-3">
                        <div className={`grid gap-3 ${noValue ? "grid-cols-2" : "grid-cols-1 sm:grid-cols-3"}`}>
                          {/* Field */}
                          <div className="space-y-1">
                            <Label className="text-xs text-gray-400">Field</Label>
                            <Select
                              value={condition.field}
                              onValueChange={(val) => {
                                const newType = getFieldType(val);
                                const defaultCond = conditionOptions[newType][0].value;
                                updateCondition(condition.id, { field: val, condition_type: defaultCond, condition_value: "", condition_value_secondary: "" });
                              }}
                              disabled={!isAdmin}
                            >
                              <SelectTrigger className="bg-gray-900 border-gray-700 text-white text-sm">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="bg-gray-800 border-gray-700">
                                {RULE_FIELDS.map(f => (
                                  <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>

                          {/* Condition type */}
                          <div className="space-y-1">
                            <Label className="text-xs text-gray-400">Condition</Label>
                            <Select
                              value={condition.condition_type}
                              onValueChange={(val) => updateCondition(condition.id, { condition_type: val })}
                              disabled={!isAdmin}
                            >
                              <SelectTrigger className="bg-gray-900 border-gray-700 text-white text-sm">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="bg-gray-800 border-gray-700">
                                {opts.map(opt => (
                                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>

                          {/* Value */}
                          {!noValue && (
                            <div className="space-y-1">
                              <Label className="text-xs text-gray-400">
                                {condition.condition_type === "range_between" ? "Min" :
                                 ["date_older_than","date_newer_than"].includes(condition.condition_type) ? "Days" :
                                 ["before_date","after_date"].includes(condition.condition_type) ? "Date" :
                                 "Value"}
                              </Label>
                              <Input
                                disabled={!isAdmin}
                                type={["before_date","after_date"].includes(condition.condition_type) ? "date" : "text"}
                                value={condition.condition_value || ""}
                                onChange={(e) => updateCondition(condition.id, { condition_value: e.target.value })}
                                placeholder={
                                  fieldType === "number" ? "e.g., 1000" :
                                  fieldType === "date" && ["date_older_than","date_newer_than"].includes(condition.condition_type) ? "e.g., 30" :
                                  "e.g., overdue"
                                }
                                className="bg-gray-900 border-gray-700 text-gray-100 text-sm"
                              />
                            </div>
                          )}
                        </div>

                        {/* Range secondary value */}
                        {condition.condition_type === "range_between" && (
                          <div className="mt-3">
                            <div className="space-y-1 max-w-xs">
                              <Label className="text-xs text-gray-400">Max</Label>
                              <Input
                                disabled={!isAdmin}
                                value={condition.condition_value_secondary || ""}
                                onChange={(e) => updateCondition(condition.id, { condition_value_secondary: e.target.value })}
                                placeholder="e.g., 5000"
                                className="bg-gray-900 border-gray-700 text-gray-100 text-sm"
                              />
                            </div>
                          </div>
                        )}

                        {isAdmin && (
                          <div className="flex justify-end mt-2">
                            <Button type="button" variant="ghost" size="sm" onClick={() => removeCondition(condition.id)}
                              className="text-rose-400 hover:text-rose-300 hover:bg-rose-900/20 h-7">
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
