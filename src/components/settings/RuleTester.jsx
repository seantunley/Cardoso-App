import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CheckCircle2, AlertCircle, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { evaluateCondition, checkAutoFlagRules } from "@/lib/evalFlagRules";
import { RULE_FIELDS } from "./RuleConditionBuilder";

const flagColors = {
  red:    { label: "Red Flag" },
  green:  { label: "Green Flag" },
  orange: { label: "Orange Flag" },
};

const conditionTypeLabels = {
  contains:       "Contains",
  equals:         "Equals",
  starts_with:    "Starts With",
  ends_with:      "Ends With",
  is_empty:       "Is Empty",
  is_not_empty:   "Is Not Empty",
  greater_than:   "> (Greater Than)",
  less_than:      "< (Less Than)",
  greater_or_equal: "≥ (Greater or Equal)",
  less_or_equal:  "≤ (Less or Equal)",
  range_between:  "Between",
  date_older_than:"Older Than (days)",
  date_newer_than:"Newer Than (days)",
  before_date:    "Before Date",
  after_date:     "After Date",
};

export default function RuleTester({ rule }) {
  const [testData, setTestData] = useState({
    age_analysis: "",
    outstanding_balance: "",
    last_unpaid_invoice_date: "",
    last_receipt_date: "",
    updated_date: "",
    created_date: "",
  });
  const [testResults, setTestResults] = useState(null);

  const testRule = () => {
    if (!rule?.conditions || rule.conditions.length === 0) {
      setTestResults({ passed: false, message: "Rule has no conditions" });
      return;
    }
    let conditions = rule.conditions;
    if (typeof conditions === "string") { try { conditions = JSON.parse(conditions); } catch { conditions = []; } }

    const withGroups = conditions.map(c => ({ group: 1, ...c }));
    const groupNums = [...new Set(withGroups.map(c => c.group))];

    // Build per-condition results for display
    const results = withGroups.map(c => ({
      condition: c,
      passed: evaluateCondition(c, testData),
    }));

    // Group-aware final: any group where ALL conditions pass = match
    const finalPassed = groupNums.some(g => {
      const groupConds = withGroups.filter(c => c.group === g);
      return groupConds.every(c => evaluateCondition(c, testData));
    });

    setTestResults({
      passed: finalPassed,
      message: finalPassed
        ? `Rule MATCHED — Will apply ${flagColors[rule.flag_color]?.label}`
        : "Rule did not match",
      conditions: results,
      groupNums,
    });
  };

  return (
    <Card className="bg-gray-800 border-gray-700">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg text-white">
          <Zap className="w-5 h-5 text-gray-400" />
          Test Rule
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {RULE_FIELDS.map(f => (
            <div key={f.value} className="space-y-1">
              <Label className="text-gray-300 text-xs">{f.label}</Label>
              <Input
                type={f.type === "date" ? "date" : f.type === "number" ? "number" : "text"}
                value={testData[f.value] || ""}
                onChange={e => setTestData({ ...testData, [f.value]: e.target.value })}
                placeholder={f.type === "number" ? "e.g., 1500" : f.type === "date" ? "" : "e.g., overdue"}
                className="bg-gray-900 border-gray-700 text-gray-100 text-sm"
              />
            </div>
          ))}
        </div>

        <Button onClick={testRule} className="w-full bg-white hover:bg-gray-100 text-gray-900 font-medium">
          <Zap className="w-4 h-4 mr-2" />
          Test Rule
        </Button>

        {testResults && (
          <div className="space-y-3">
            <Alert className={testResults.passed ? "bg-green-900/20 border-green-800" : "bg-orange-900/20 border-orange-800"}>
              <div className="flex items-center gap-2">
                {testResults.passed
                  ? <><CheckCircle2 className="w-4 h-4 text-green-500" /><AlertDescription className="text-green-300">{testResults.message}</AlertDescription></>
                  : <><AlertCircle className="w-4 h-4 text-orange-500" /><AlertDescription className="text-orange-300">{testResults.message}</AlertDescription></>
                }
              </div>
            </Alert>

            {testResults.conditions && (
              <div className="space-y-2">
                <p className="text-sm text-gray-400 font-medium">Condition Results (groups OR'd, conditions AND'd within group):</p>
                {testResults.groupNums.map((g, gi) => {
                  const groupResults = testResults.conditions.filter(r => (r.condition.group ?? 1) === g);
                  const groupPassed = groupResults.every(r => r.passed);
                  return (
                    <div key={g} className="space-y-1">
                      {gi > 0 && (
                        <div className="flex items-center gap-2 my-1">
                          <div className="flex-1 h-px bg-gray-700" />
                          <span className="text-xs font-bold text-indigo-400 tracking-widest">OR</span>
                          <div className="flex-1 h-px bg-gray-700" />
                        </div>
                      )}
                      <div className={cn("rounded-lg border p-2 space-y-1", groupPassed ? "border-green-800/50" : "border-gray-700")}>
                        <p className="text-xs text-gray-500 mb-1">Group {gi + 1}</p>
                        {groupResults.map((result, idx) => (
                          <div key={idx}>
                            {idx > 0 && <p className="text-xs text-gray-600 text-center py-0.5">AND</p>}
                            <div className={cn(
                              "p-2 rounded border text-sm",
                              result.passed ? "bg-green-900/20 border-green-800 text-green-300" : "bg-red-900/20 border-red-800 text-red-300"
                            )}>
                              <div className="flex items-center gap-2">
                                <div className={cn("w-2 h-2 rounded-full flex-shrink-0", result.passed ? "bg-green-500" : "bg-red-500")} />
                                <span>
                                  <strong>{RULE_FIELDS.find(f => f.value === result.condition.field)?.label || result.condition.field}</strong>{" "}
                                  {conditionTypeLabels[result.condition.condition_type] || result.condition.condition_type}
                                  {!["is_empty","is_not_empty"].includes(result.condition.condition_type) && (
                                    result.condition.condition_value_secondary
                                      ? ` ${result.condition.condition_value} – ${result.condition.condition_value_secondary}`
                                      : ` "${result.condition.condition_value}"`
                                  )}
                                </span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
