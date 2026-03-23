import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CheckCircle2, AlertCircle, Zap } from "lucide-react";
import { cn } from "@/lib/utils";

const flagColors = {
  red: { bg: "bg-red-100", text: "text-red-700", label: "Red Flag" },
  green: { bg: "bg-green-100", text: "text-green-700", label: "Green Flag" },
  orange: { bg: "bg-orange-100", text: "text-orange-700", label: "Orange Flag" },
};

export default function RuleTester({ rule }) {
  const [testData, setTestData] = useState({
    age_analysis: "",
    custom_number: "",
    custom_date: "",
  });
  const [testResults, setTestResults] = useState(null);

  const evaluateCondition = (condition, data) => {
    const value = data[condition.field] || "";
    const condValue = condition.condition_value;
    const condValueSec = condition.condition_value_secondary;

    switch (condition.condition_type) {
      // Text conditions
      case "contains":
        return String(value).toLowerCase().includes(String(condValue).toLowerCase());
      case "equals":
        return String(value).toLowerCase() === String(condValue).toLowerCase();
      case "starts_with":
        return String(value).toLowerCase().startsWith(String(condValue).toLowerCase());
      case "ends_with":
        return String(value).toLowerCase().endsWith(String(condValue).toLowerCase());

      // Number conditions
      case "greater_than":
        return parseFloat(value) > parseFloat(condValue);
      case "less_than":
        return parseFloat(value) < parseFloat(condValue);
      case "greater_or_equal":
        return parseFloat(value) >= parseFloat(condValue);
      case "less_or_equal":
        return parseFloat(value) <= parseFloat(condValue);
      case "range_between":
        const num = parseFloat(value);
        return num >= parseFloat(condValue) && num <= parseFloat(condValueSec);

      // Date conditions
      case "date_older_than": {
        const date = new Date(value);
        const now = new Date();
        const daysDiff = (now - date) / (1000 * 60 * 60 * 24);
        return daysDiff > parseFloat(condValue);
      }
      case "date_newer_than": {
        const date = new Date(value);
        const now = new Date();
        const daysDiff = (now - date) / (1000 * 60 * 60 * 24);
        return daysDiff < parseFloat(condValue);
      }

      default:
        return false;
    }
  };

  const testRule = () => {
    if (!rule?.conditions || rule.conditions.length === 0) {
      setTestResults({ passed: false, message: "Rule has no conditions" });
      return;
    }

    const results = rule.conditions.map(cond => ({
      condition: cond,
      passed: evaluateCondition(cond, testData),
    }));

    const finalPassed =
      rule.logic === "AND"
        ? results.every(r => r.passed)
        : results.some(r => r.passed);

    setTestResults({
      passed: finalPassed,
      message: finalPassed
        ? `Rule MATCHED - Will apply ${flagColors[rule.flag_color]?.label}`
        : "Rule did not match",
      conditions: results,
    });
  };

  const conditionTypeLabels = {
    contains: "Contains",
    equals: "Equals",
    starts_with: "Starts With",
    ends_with: "Ends With",
    greater_than: "> (Greater Than)",
    less_than: "< (Less Than)",
    greater_or_equal: "≥ (Greater or Equal)",
    less_or_equal: "≤ (Less or Equal)",
    range_between: "Between",
    date_older_than: "Older Than (days)",
    date_newer_than: "Newer Than (days)",
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="space-y-2">
            <Label className="text-gray-300 text-sm">Age Analysis</Label>
            <Textarea
              value={testData.age_analysis}
              onChange={(e) => setTestData({ ...testData, age_analysis: e.target.value })}
              placeholder="e.g., 90+ days overdue"
              className="bg-gray-900 border-gray-700 text-gray-100 h-24 text-sm resize-none"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-gray-300 text-sm">Number Value</Label>
            <Input
              type="number"
              value={testData.custom_number}
              onChange={(e) => setTestData({ ...testData, custom_number: e.target.value })}
              placeholder="e.g., 250"
              className="bg-gray-900 border-gray-700 text-gray-100 text-sm"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-gray-300 text-sm">Date Value</Label>
            <Input
              type="date"
              value={testData.custom_date}
              onChange={(e) => setTestData({ ...testData, custom_date: e.target.value })}
              className="bg-gray-900 border-gray-700 text-gray-100 text-sm"
            />
          </div>
        </div>

        <Button
          onClick={testRule}
          className="w-full bg-white hover:bg-gray-100 text-gray-900 font-medium"
        >
          <Zap className="w-4 h-4 mr-2" />
          Test Rule
        </Button>

        {testResults && (
          <div className="space-y-3">
            <Alert className={testResults.passed ? "bg-green-900/20 border-green-800" : "bg-orange-900/20 border-orange-800"}>
              <div className="flex items-center gap-2">
                {testResults.passed ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                    <AlertDescription className="text-green-300">{testResults.message}</AlertDescription>
                  </>
                ) : (
                  <>
                    <AlertCircle className="w-4 h-4 text-orange-500" />
                    <AlertDescription className="text-orange-300">{testResults.message}</AlertDescription>
                  </>
                )}
              </div>
            </Alert>

            {testResults.conditions && (
              <div className="space-y-2">
                <p className="text-sm text-gray-400 font-medium">Condition Results ({rule.logic} logic):</p>
                <div className="space-y-2">
                  {testResults.conditions.map((result, idx) => (
                    <div
                      key={idx}
                      className={cn(
                        "p-3 rounded-lg border",
                        result.passed
                          ? "bg-green-900/20 border-green-800 text-green-300"
                          : "bg-red-900/20 border-red-800 text-red-300"
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <div className={cn(
                          "w-2 h-2 rounded-full",
                          result.passed ? "bg-green-500" : "bg-red-500"
                        )} />
                        <span className="text-sm">
                          <strong>{result.condition.field}</strong> {conditionTypeLabels[result.condition.condition_type]}
                          {result.condition.condition_value_secondary
                            ? ` ${result.condition.condition_value} and ${result.condition.condition_value_secondary}`
                            : ` "${result.condition.condition_value}"`
                          }
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}