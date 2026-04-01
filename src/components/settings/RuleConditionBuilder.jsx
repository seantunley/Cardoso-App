import { useState } from "react";
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
import { Trash2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

// Fields available for rule conditions
export const RULE_FIELDS = [
  { value: "age_analysis",            label: "Age Analysis",            type: "text" },
  { value: "outstanding_balance",     label: "Outstanding Balance",     type: "number" },
  { value: "last_unpaid_invoice_date",label: "Last Unpaid Invoice Date", type: "date" },
  { value: "last_receipt_date",       label: "Last Receipt Date",       type: "date" },
  { value: "updated_date",            label: "Last Updated",            type: "date" },
  { value: "created_date",            label: "Date Created",            type: "date" },
];

const conditionOptions = {
  text: [
    { value: "contains",    label: "Contains" },
    { value: "equals",      label: "Equals" },
    { value: "starts_with", label: "Starts With" },
    { value: "ends_with",   label: "Ends With" },
    { value: "is_empty",    label: "Is Empty" },
    { value: "is_not_empty",label: "Is Not Empty" },
  ],
  number: [
    { value: "greater_than",    label: "Greater Than (>)" },
    { value: "less_than",       label: "Less Than (<)" },
    { value: "greater_or_equal",label: "Greater or Equal (≥)" },
    { value: "less_or_equal",   label: "Less or Equal (≤)" },
    { value: "range_between",   label: "Between" },
    { value: "is_empty",        label: "Is Empty" },
    { value: "is_not_empty",    label: "Is Not Empty" },
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

function getFieldType(fieldValue) {
  return RULE_FIELDS.find(f => f.value === fieldValue)?.type || "text";
}

export default function RuleConditionBuilder({
  conditions = [],
  logic = "AND",
  onConditionsChange,
  onLogicChange,
  isAdmin,
}) {
  let parsedConditions = Array.isArray(conditions) ? conditions : [];
  if (typeof conditions === "string") {
    try { parsedConditions = JSON.parse(conditions); } catch { parsedConditions = []; }
  }

  const addCondition = () => {
    onConditionsChange([...parsedConditions, {
      id: `cond-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      field: "age_analysis",
      condition_type: "contains",
      condition_value: "",
      condition_value_secondary: "",
    }]);
  };

  const removeCondition = (id) => {
    onConditionsChange(parsedConditions.filter((c) => c.id !== id));
  };

  const updateCondition = (id, updates) => {
    onConditionsChange(parsedConditions.map((c) => (c.id === id ? { ...c, ...updates } : c)));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label className="text-gray-300">Conditions</Label>
        {isAdmin && (
          <Button type="button" size="sm" variant="outline" onClick={addCondition}
            className="border-gray-700 text-gray-300 hover:bg-gray-800">
            <Plus className="w-4 h-4 mr-1" /> Add Condition
          </Button>
        )}
      </div>

      {parsedConditions.length === 0 && (
        <div className="p-3 bg-gray-850 rounded-lg border border-gray-700 text-center">
          <p className="text-sm text-gray-400">No conditions yet. Add one to get started.</p>
        </div>
      )}

      {parsedConditions.map((condition, index) => {
        const fieldType = getFieldType(condition.field);
        const opts = conditionOptions[fieldType] || conditionOptions.text;
        const noValue = NO_VALUE_TYPES.includes(condition.condition_type);

        return (
          <Card key={condition.id ?? `condition-${index}`} className="bg-gray-850 border-gray-700">
            <CardContent className="pt-6">
              <div className="space-y-3">
                {index > 0 && (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-px bg-gray-700" />
                    <Select value={logic} onValueChange={onLogicChange} disabled={!isAdmin}>
                      <SelectTrigger className="w-20 bg-gray-900 border-gray-700 text-white h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-gray-800 border-gray-700">
                        <SelectItem value="AND">AND</SelectItem>
                        <SelectItem value="OR">OR</SelectItem>
                      </SelectContent>
                    </Select>
                    <div className="flex-1 h-px bg-gray-700" />
                  </div>
                )}

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

                  {/* Value — hidden for is_empty / is_not_empty */}
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
                          fieldType === "date" ? (["date_older_than","date_newer_than"].includes(condition.condition_type) ? "e.g., 30" : "") :
                          "e.g., overdue"
                        }
                        className="bg-gray-900 border-gray-700 text-gray-100 text-sm"
                      />
                    </div>
                  )}
                </div>

                {/* Secondary value for range_between */}
                {condition.condition_type === "range_between" && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
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
                  <div className="flex justify-end">
                    <Button type="button" variant="ghost" size="sm" onClick={() => removeCondition(condition.id)}
                      className="text-rose-400 hover:text-rose-300 hover:bg-rose-900/20">
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
