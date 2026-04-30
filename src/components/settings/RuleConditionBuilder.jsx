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

export const RULE_FIELDS = [
  { value: "age_analysis",             label: "Age Analysis",             type: "text" },
  { value: "outstanding_balance",      label: "Outstanding Balance",      type: "number" },
  { value: "last_unpaid_invoice_1_date", label: "Invoice 1 Date", type: "date" },
  { value: "last_unpaid_invoice_2_date", label: "Invoice 2 Date", type: "date" },
  { value: "last_unpaid_invoice_3_date", label: "Invoice 3 Date", type: "date" },
  { value: "last_unpaid_invoice_4_date", label: "Invoice 4 Date", type: "date" },
  { value: "last_unpaid_invoice_5_date", label: "Invoice 5 Date", type: "date" },
  { value: "last_receipt_1_date", label: "Receipt 1 Date", type: "date" },
  { value: "last_receipt_2_date", label: "Receipt 2 Date", type: "date" },
  { value: "last_receipt_3_date", label: "Receipt 3 Date", type: "date" },
  { value: "last_receipt_4_date", label: "Receipt 4 Date", type: "date" },
  { value: "last_receipt_5_date", label: "Receipt 5 Date", type: "date" },
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

function newCondition(operator = "AND") {
  return {
    id: `cond-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    operator,           // "AND" | "OR" — how this condition connects to the previous one
    field: "age_analysis",
    condition_type: "contains",
    condition_value: "",
    condition_value_secondary: "",
  };
}

export default function RuleConditionBuilder({ conditions = [], onConditionsChange, isAdmin }) {
  let parsed = Array.isArray(conditions) ? conditions : [];
  if (typeof conditions === "string") {
    try { parsed = JSON.parse(conditions); } catch { parsed = []; }
  }
  // Migrate legacy conditions (no operator) — first gets none, rest default AND
  parsed = parsed.map((c, i) => ({ operator: i === 0 ? undefined : "AND", ...c }));

  const addCondition = () => {
    onConditionsChange([...parsed, newCondition("AND")]);
  };

  const removeCondition = (id) => {
    const remaining = parsed.filter(c => c.id !== id);
    // First condition should never have an operator displayed
    onConditionsChange(remaining);
  };

  const updateCondition = (id, updates) => {
    onConditionsChange(parsed.map(c => c.id === id ? { ...c, ...updates } : c));
  };

  const toggleOperator = (id) => {
    const current = parsed.find(c => c.id === id)?.operator;
    updateCondition(id, { operator: current === "AND" ? "OR" : "AND" });
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between mb-3">
        <Label className="text-gray-300">Conditions</Label>
        {isAdmin && (
          <Button type="button" size="sm" variant="outline" onClick={addCondition}
            className="border-gray-700 text-gray-300 hover:bg-gray-800">
            <Plus className="w-4 h-4 mr-1" /> Add Condition
          </Button>
        )}
      </div>

      {parsed.length === 0 && (
        <div className="p-3 rounded-lg border border-gray-700 text-center">
          <p className="text-sm text-gray-400">No conditions yet. Add one to get started.</p>
        </div>
      )}

      {parsed.map((condition, index) => {
        const fieldType = getFieldType(condition.field);
        const opts = conditionOptions[fieldType] || conditionOptions.text;
        const noValue = NO_VALUE_TYPES.includes(condition.condition_type);

        return (
          <div key={condition.id ?? `cond-${index}`}>
            {/* Operator connector — shown between conditions */}
            {index > 0 && (
              <div className="flex items-center gap-3 my-2">
                <div className="flex-1 h-px bg-gray-700" />
                {isAdmin ? (
                  <button
                    type="button"
                    onClick={() => toggleOperator(condition.id)}
                    className={cn(
                      "px-4 py-1 text-xs font-bold rounded-full border tracking-widest transition-colors",
                      condition.operator === "OR"
                        ? "bg-accent/15 text-accent border-accent/50 hover:bg-accent/25"
                        : "bg-gray-800 text-gray-300 border-gray-600 hover:bg-gray-700"
                    )}
                  >
                    {condition.operator ?? "AND"}
                  </button>
                ) : (
                  <span className={cn(
                    "px-4 py-1 text-xs font-bold rounded-full border tracking-widest",
                    condition.operator === "OR"
                      ? "bg-accent/15 text-accent border-accent/50"
                      : "bg-gray-800 text-gray-300 border-gray-600"
                  )}>
                    {condition.operator ?? "AND"}
                  </span>
                )}
                <div className="flex-1 h-px bg-gray-700" />
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

                {condition.condition_type === "range_between" && (
                  <div className="mt-3 max-w-xs">
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
  );
}
