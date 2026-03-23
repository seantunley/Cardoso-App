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

const conditionOptions = {
  text: [
    { value: "contains", label: "Contains" },
    { value: "equals", label: "Equals" },
    { value: "starts_with", label: "Starts With" },
    { value: "ends_with", label: "Ends With" },
  ],
  number: [
    { value: "greater_than", label: "Greater Than (>)" },
    { value: "less_than", label: "Less Than (<)" },
    { value: "greater_or_equal", label: "Greater or Equal (≥)" },
    { value: "less_or_equal", label: "Less or Equal (≤)" },
    { value: "range_between", label: "Between" },
  ],
  date: [
    { value: "date_older_than", label: "Older Than (days)" },
    { value: "date_newer_than", label: "Newer Than (days)" },
  ],
};

export default function RuleConditionBuilder({
  conditions = [],
  logic = "AND",
  onConditionsChange,
  onLogicChange,
  isAdmin,
}) {
  // Parse conditions if coming from DB as JSON string
  let parsedConditions = Array.isArray(conditions) ? conditions : [];
  if (typeof conditions === "string") {
    try {
      parsedConditions = JSON.parse(conditions);
    } catch (e) {
      console.error("Failed to parse conditions:", e);
      parsedConditions = [];
    }
  }

  const addCondition = () => {
    const newCondition = {
      id: `cond-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      field: "age_analysis",
      condition_type: "contains",
      condition_value: "",
      condition_value_secondary: "", // for range_between
    };
    onConditionsChange([...parsedConditions, newCondition]);
  };

  const removeCondition = (id) => {
    onConditionsChange(parsedConditions.filter((c) => c.id !== id));
  };

  const updateCondition = (id, updates) => {
    onConditionsChange(
      parsedConditions.map((c) => (c.id === id ? { ...c, ...updates } : c))
    );
  };

  const getConditionOptions = (field) => {
    if (field.includes("number")) return conditionOptions.number;
    if (field.includes("date")) return conditionOptions.date;
    return conditionOptions.text;
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label className="text-gray-300">Conditions</Label>
        {isAdmin && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={addCondition}
            className="border-gray-700 text-gray-300 hover:bg-gray-800"
          >
            <Plus className="w-4 h-4 mr-1" />
            Add Condition
          </Button>
        )}
      </div>

      {parsedConditions.length === 0 && (
        <div className="p-3 bg-gray-850 rounded-lg border border-gray-700 text-center">
          <p className="text-sm text-gray-400">No conditions yet. Add one to get started.</p>
        </div>
      )}

      {parsedConditions.map((condition, index) => (
        <Card
          // Guaranteed unique key: use id if available, otherwise index + random suffix
          key={condition.id ?? `condition-${index}-${Math.random().toString(36).slice(2, 8)}`}
          className="bg-gray-850 border-gray-700"
        >
          <CardContent className="pt-6">
            <div className="space-y-3">
              {index > 0 && (
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-px bg-gray-700"></div>
                  <Select value={logic} onValueChange={onLogicChange} disabled={!isAdmin}>
                    <SelectTrigger className="w-20 bg-gray-900 border-gray-700 text-white h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-gray-800 border-gray-700">
                      <SelectItem value="AND">AND</SelectItem>
                      <SelectItem value="OR">OR</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="flex-1 h-px bg-gray-700"></div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs text-gray-400">Field</Label>
                  <Select
                    value={condition.field}
                    onValueChange={(val) =>
                      updateCondition(condition.id, { field: val, condition_type: "contains" })
                    }
                    disabled={!isAdmin}
                  >
                    <SelectTrigger className="bg-gray-900 border-gray-700 text-white text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-gray-800 border-gray-700">
                      <SelectItem value="age_analysis">Age Analysis</SelectItem>
                      <SelectItem value="custom_number">Numerical Value</SelectItem>
                      <SelectItem value="custom_date">Date</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs text-gray-400">Type</Label>
                  <Select
                    value={condition.condition_type}
                    onValueChange={(val) => updateCondition(condition.id, { condition_type: val })}
                    disabled={!isAdmin}
                  >
                    <SelectTrigger className="bg-gray-900 border-gray-700 text-white text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-gray-800 border-gray-700">
                      {getConditionOptions(condition.field).map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label className="text-xs text-gray-400">
                    {condition.condition_type === "range_between"
                      ? "Min"
                      : condition.condition_type?.includes("date")
                      ? "Days"
                      : "Value"}
                  </Label>
                  <Input
                    disabled={!isAdmin}
                    value={condition.condition_value || ""}
                    onChange={(e) => updateCondition(condition.id, { condition_value: e.target.value })}
                    placeholder={
                      condition.field.includes("number")
                        ? "e.g., 100"
                        : condition.field.includes("date")
                        ? "e.g., 30"
                        : "e.g., overdue"
                    }
                    className="bg-gray-900 border-gray-700 text-gray-100 text-sm"
                  />
                </div>
              </div>

              {condition.condition_type === "range_between" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs text-gray-400">Max</Label>
                    <Input
                      disabled={!isAdmin}
                      value={condition.condition_value_secondary || ""}
                      onChange={(e) =>
                        updateCondition(condition.id, { condition_value_secondary: e.target.value })
                      }
                      placeholder="e.g., 500"
                      className="bg-gray-900 border-gray-700 text-gray-100 text-sm"
                    />
                  </div>
                </div>
              )}

              {isAdmin && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeCondition(condition.id)}
                    className="text-rose-400 hover:text-rose-300 hover:bg-rose-900/20"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}