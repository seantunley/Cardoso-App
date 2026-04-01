import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CheckCircle2, XCircle, Zap, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/api/apiClient";
import { RULE_FIELDS } from "./RuleConditionBuilder";

const FLAG_COLORS = {
  red:    { dot: "bg-red-500",    text: "text-red-400" },
  orange: { dot: "bg-orange-400", text: "text-orange-400" },
  green:  { dot: "bg-green-500",  text: "text-green-400" },
  none:   { dot: "bg-gray-600",   text: "text-gray-500" },
};

function ConditionBreakdown({ conditionResults, conditions }) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs mt-1">
      {conditionResults.map((r, i) => {
        const fieldLabel = RULE_FIELDS.find(f => f.value === r.field)?.label ?? r.field;
        return (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && (
              <span className={cn(
                "font-bold tracking-widest px-1",
                (r.operator ?? "AND") === "OR" ? "text-indigo-400" : "text-gray-500"
              )}>
                {r.operator ?? "AND"}
              </span>
            )}
            <span className={cn(
              "px-1.5 py-0.5 rounded border",
              r.passed
                ? "bg-green-900/30 border-green-800 text-green-300"
                : "bg-red-900/30 border-red-800 text-red-400"
            )}>
              {fieldLabel} {r.passed ? "✓" : "✗"}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function RecordRow({ record, conditions, index }) {
  const [expanded, setExpanded] = useState(false);
  const flagStyle = FLAG_COLORS[record.flag_color] ?? FLAG_COLORS.none;

  return (
    <div className={cn(
      "rounded-lg border p-3 text-sm",
      record.passes
        ? "bg-green-900/10 border-green-800/50"
        : "bg-gray-900/60 border-gray-700"
    )}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {record.passes
            ? <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
            : <XCircle className="w-4 h-4 text-gray-600 flex-shrink-0" />
          }
          <div className="min-w-0">
            <span className="font-medium text-gray-200 truncate">{record.customer_name}</span>
            <span className="text-gray-500 ml-2 text-xs">#{record.customer_number}</span>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {record.flag_color && record.flag_color !== "none" && (
            <div className={cn("w-2 h-2 rounded-full", flagStyle.dot)} title={`Currently: ${record.flag_color}`} />
          )}
          <button
            onClick={() => setExpanded(v => !v)}
            className="text-gray-500 hover:text-gray-300"
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Always show condition breakdown */}
      <ConditionBreakdown conditionResults={record.condition_results} conditions={conditions} />

      {/* Expanded: show relevant field values */}
      {expanded && (
        <div className="mt-2 pt-2 border-t border-gray-700 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-400">
          {record.condition_results.map((r, i) => {
            const fieldLabel = RULE_FIELDS.find(f => f.value === r.field)?.label ?? r.field;
            const val = record[r.field];
            return (
              <div key={i}>
                <span className="text-gray-500">{fieldLabel}: </span>
                <span className={r.passed ? "text-green-300" : "text-red-400"}>
                  {val !== null && val !== undefined && val !== "" ? String(val) : "(empty)"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function RuleTester({ rule }) {
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [showUnmatched, setShowUnmatched] = useState(false);

  const runTest = async () => {
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      let conditions = rule?.conditions ?? [];
      if (typeof conditions === "string") { try { conditions = JSON.parse(conditions); } catch { conditions = []; } }
      if (!conditions.length) { setError("Add at least one condition first."); return; }

      const data = await fetch("/api/test-rule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ conditions, sample_size: 5 }),
      }).then(r => r.json());

      if (data.error) throw new Error(data.error);
      setResults(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="bg-gray-800 border-gray-700">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base text-white">
          <Zap className="w-4 h-4 text-gray-400" />
          Test Against Real Records
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-gray-400">
          Runs this rule against a random sample of your records and shows which ones would match.
        </p>

        <Button onClick={runTest} disabled={loading}
          className="w-full bg-white hover:bg-gray-100 text-gray-900 font-medium">
          <Zap className="w-4 h-4 mr-2" />
          {loading ? "Testing..." : "Run Test (5 samples)"}
        </Button>

        {error && (
          <Alert className="bg-red-900/20 border-red-800">
            <AlertDescription className="text-red-300">{error}</AlertDescription>
          </Alert>
        )}

        {results && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 text-xs text-gray-400">
              <span>Sampled <strong className="text-gray-200">{results.total_sampled}</strong> records</span>
              <span>·</span>
              <span className="text-green-400"><strong>{results.matched.length}</strong> matched</span>
              <span>·</span>
              <span className="text-gray-500"><strong>{results.unmatched.length}</strong> didn't match</span>
            </div>

            {results.matched.length === 0 && (
              <Alert className="bg-orange-900/20 border-orange-800">
                <AlertDescription className="text-orange-300">
                  No records matched in the sample of {results.total_sampled}. Try relaxing the conditions.
                </AlertDescription>
              </Alert>
            )}

            {results.matched.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-green-400 uppercase tracking-wider">Would be flagged</p>
                {results.matched.map((r, i) => (
                  <RecordRow key={i} record={r} conditions={rule?.conditions} index={i} />
                ))}
              </div>
            )}

            {results.unmatched.length > 0 && (
              <div className="space-y-2">
                <button
                  onClick={() => setShowUnmatched(v => !v)}
                  className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300"
                >
                  {showUnmatched ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  {showUnmatched ? "Hide" : "Show"} non-matching samples ({results.unmatched.length})
                </button>
                {showUnmatched && results.unmatched.map((r, i) => (
                  <RecordRow key={i} record={r} conditions={rule?.conditions} index={i} />
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
