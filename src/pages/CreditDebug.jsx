import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, Loader2, ChevronDown, ChevronRight, CheckCircle, AlertTriangle, XCircle, HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const verdictMeta = {
  approve: { label: "APPROVE", className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", icon: CheckCircle },
  caution: { label: "CAUTION", className: "bg-amber-500/15 text-amber-400 border-amber-500/30", icon: AlertTriangle },
  hold:    { label: "HOLD",    className: "bg-red-500/15 text-red-400 border-red-500/30", icon: XCircle },
  dormant: { label: "DORMANT", className: "bg-purple-500/15 text-purple-400 border-purple-500/30", icon: HelpCircle },
};

function StepCard({ step, index, isLast }) {
  const [expanded, setExpanded] = useState(index === 0 || isLast);
  const isVerdict = step.label.startsWith("VERDICT") || step.label.startsWith("FINAL");
  const isScore = step.label === "Score calculation";

  return (
    <div className={cn(
      "border rounded-lg overflow-hidden transition-colors",
      isVerdict ? "border-accent/40 bg-accent/5" : isScore ? "border-amber-500/30 bg-amber-500/5" : "border-border bg-card"
    )}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
      >
        <span className="text-xs font-mono text-muted-foreground w-6 shrink-0">#{step.step}</span>
        {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
        <span className={cn("text-sm font-medium", isVerdict && "text-accent", isScore && "text-amber-400")}>{step.label}</span>
      </button>
      {expanded && (
        <div className="px-4 pb-4 pt-1">
          <DetailView data={step.detail} />
        </div>
      )}
    </div>
  );
}

function DetailView({ data }) {
  if (data === null || data === undefined) return <span className="text-xs text-muted-foreground">null</span>;
  if (typeof data !== "object") return <span className="text-xs font-mono">{String(data)}</span>;

  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="text-xs text-muted-foreground italic">empty array</span>;
    return (
      <div className="space-y-1">
        {data.map((item, i) => (
          <div key={i} className="pl-3 border-l-2 border-border">
            <DetailView data={item} />
          </div>
        ))}
      </div>
    );
  }

  // Special rendering for deductions array
  if (data.points !== undefined && data.reason !== undefined) {
    return (
      <div className="flex items-start gap-2">
        <Badge variant="outline" className="bg-red-500/10 text-red-400 border-red-500/30 text-xs shrink-0">
          -{data.points}
        </Badge>
        <span className="text-xs">{data.reason}</span>
        {data.runningTotal !== undefined && (
          <span className="text-xs text-muted-foreground ml-auto shrink-0">(total: -{data.runningTotal})</span>
        )}
      </div>
    );
  }

  // Special rendering for invoice/receipt matches
  if (data.invoice !== undefined && data.receipt !== undefined && data.lagDays !== undefined) {
    return (
      <div className="flex items-center gap-2 text-xs font-mono">
        <span>{data.invoice}</span>
        <span className="text-muted-foreground">({data.invoiceDate})</span>
        <span className="text-muted-foreground">→</span>
        <span className={data.receipt === "UNPAID" ? "text-red-400 font-semibold" : ""}>{data.receipt}</span>
        {data.receipt !== "UNPAID" && <span className="text-muted-foreground">({data.receiptDate})</span>}
        {data.lagDays !== null && (
          <Badge variant="outline" className={cn(
            "text-xs ml-auto",
            data.lagDays <= 14 ? "text-emerald-400 border-emerald-500/30" :
            data.lagDays <= 21 ? "text-amber-400 border-amber-500/30" :
            "text-red-400 border-red-500/30"
          )}>
            {data.lagDays}d lag
          </Badge>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {Object.entries(data).map(([key, value]) => {
        if (key === "deductions" && Array.isArray(value)) {
          return (
            <div key={key}>
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{key}</span>
              {value.length === 0 ? (
                <p className="text-xs text-emerald-400 ml-3 mt-1">No deductions applied</p>
              ) : (
                <div className="space-y-1 mt-1">
                  {value.map((d, i) => <DetailView key={i} data={d} />)}
                </div>
              )}
            </div>
          );
        }

        if (key === "matches" && Array.isArray(value)) {
          return (
            <div key={key}>
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Invoice → Receipt Matching</span>
              <div className="space-y-1 mt-1">
                {value.map((m, i) => <DetailView key={i} data={m} />)}
              </div>
            </div>
          );
        }

        if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object") {
          return (
            <div key={key}>
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{key}</span>
              <div className="space-y-1 mt-1 pl-3 border-l-2 border-border">
                {value.map((item, i) => <DetailView key={i} data={item} />)}
              </div>
            </div>
          );
        }

        const displayValue = typeof value === "boolean" ? (value ? "Yes" : "No")
          : value === null ? "N/A"
          : typeof value === "object" ? JSON.stringify(value)
          : String(value);

        const isHighlight = key === "verdict" || key === "finalScore" || key === "score";

        return (
          <div key={key} className="flex items-baseline gap-2">
            <span className="text-xs text-muted-foreground w-44 shrink-0 truncate" title={key}>{key}</span>
            <span className={cn("text-xs font-mono", isHighlight && "font-bold text-accent")}>{displayValue}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function CreditDebug() {
  const [customerNumber, setCustomerNumber] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleDebug = async () => {
    const q = customerNumber.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const resp = await fetch(`/api/credit-logic/debug?customer=${encodeURIComponent(q)}`, { credentials: "include" });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Debug request failed");
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const VerdictIcon = result?.verdict ? verdictMeta[result.verdict]?.icon || HelpCircle : null;

  return (
    <div className="mx-auto max-w-3xl px-8 py-10 space-y-6">
      <div className="border-b border-border pb-5">
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">§ Diagnostics</div>
        <h1 className="font-display text-4xl leading-tight tracking-tight text-foreground">
          Trace the <em className="text-phosphor">verdict</em>.
        </h1>
        <p className="text-sm text-muted-foreground mt-3">
          Step through the credit scoring logic and see exactly why a customer got their result.
        </p>
      </div>

      <div className="flex gap-2">
        <Input
          value={customerNumber}
          onChange={(e) => setCustomerNumber(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleDebug()}
          placeholder="Customer number..."
          className="max-w-xs"
        />
        <Button onClick={handleDebug} disabled={loading || !customerNumber.trim()}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Search className="h-4 w-4 mr-2" />}
          Debug
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {result && !result.found && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-400">
          Customer "{result.customerNumber}" not found in the database.
        </div>
      )}

      {result?.found && (
        <>
          {/* Summary banner */}
          <div className={cn(
            "rounded-xl border p-5 flex items-center gap-4",
            verdictMeta[result.verdict]?.className || "border-border bg-card"
          )}>
            {VerdictIcon && <VerdictIcon className="h-8 w-8 shrink-0" />}
            <div>
              <div className="font-bold text-lg">{verdictMeta[result.verdict]?.label || result.verdict}</div>
              <div className="text-sm opacity-80">
                {result.customerName} ({result.customerNumber}) — Score: {result.score}/100
                {result.avgLag !== null && ` — Avg lag: ${result.avgLag}d`}
              </div>
            </div>
          </div>

          {/* Step-by-step breakdown */}
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Step-by-step breakdown</h2>
            {result.steps.map((step, i) => (
              <StepCard key={i} step={step} index={i} isLast={i === result.steps.length - 1} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
