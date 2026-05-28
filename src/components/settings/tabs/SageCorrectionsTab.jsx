import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, Search, Check, X, Pencil, ShieldAlert, RefreshCw } from "lucide-react";

function ProblemBadge({ type }) {
  if (type === "NO_WEEK") return <Badge className="bg-red-500/15 text-red-400 border-red-500/30 text-[10px]">No Week</Badge>;
  if (type === "BAD_FEE_TYPE") return <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30 text-[10px]">Bad Fee Type</Badge>;
  return <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px]">OK</Badge>;
}

export default function SageCorrectionsTab() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");

  const [editing, setEditing] = useState(null);
  const [newDesc, setNewDesc] = useState("");
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [applying, setApplying] = useState(false);

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sage-corrections/lines?year=${year}`, { credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setLines(data.lines || []);
    } catch (err) {
      setError(err.message);
      setLines([]);
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => {
    let t;
    if (newDesc.trim().length > 0) {
      t = setTimeout(async () => {
        setPreviewLoading(true);
        try {
          const res = await fetch("/api/sage-corrections/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ newDescription: newDesc }),
          });
          const data = await res.json();
          setPreview(data.parsed || null);
        } catch {
          setPreview(null);
        } finally {
          setPreviewLoading(false);
        }
      }, 300);
    } else {
      setPreview(null);
    }
    return () => clearTimeout(t);
  }, [newDesc]);

  const startEdit = (line) => {
    setEditing(line);
    setNewDesc(line.line_description || "");
    setPreview(null);
  };

  const cancelEdit = () => {
    setEditing(null);
    setNewDesc("");
    setPreview(null);
  };

  const openConfirm = () => {
    setPassword("");
    setPasswordError("");
    setConfirmOpen(true);
  };

  const applyCorrection = async () => {
    if (!password) { setPasswordError("Password is required."); return; }
    setApplying(true);
    setPasswordError("");
    try {
      const res = await fetch("/api/sage-corrections/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          batchNumber: editing.batch_number,
          itemNumber: editing.item_number,
          lineNumber: editing.line_number,
          oldDescription: editing.line_description,
          newDescription: newDesc.trim(),
          password,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) { setPasswordError(data.error || "Incorrect password."); return; }
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      toast.success("Sage description updated", { description: `Batch ${editing.batch_number} → "${newDesc.trim()}"` });
      setConfirmOpen(false);
      cancelEdit();
      scan();
    } catch (err) {
      toast.error("Correction failed", { description: err.message });
    } finally {
      setApplying(false);
    }
  };

  const displayed = (showAll ? lines : lines.filter((l) => l.problem_type !== "OK"))
    .filter((l) => {
      if (!searchFilter) return true;
      const q = searchFilter.toLowerCase();
      return (
        String(l.batch_number).includes(q) ||
        (l.line_description || "").toLowerCase().includes(q) ||
        (l.batch_description || "").toLowerCase().includes(q) ||
        String(l.line_amount).includes(q)
      );
    });

  const problemCount = lines.filter((l) => l.problem_type !== "OK").length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <ShieldAlert className="h-5 w-5 text-amber-400" />
          <h3 className="text-lg font-semibold text-foreground">Sage Credit Note Corrections</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Detect and fix malformed credit note descriptions in Sage. Lines without a week number or with an unrecognised fee type
          are invisible to the BAT reconciliation and cause mismatched totals.
        </p>
      </div>

      {/* Scan controls */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground">Year</label>
          <Input
            type="number"
            value={year}
            onChange={(e) => setYear(parseInt(e.target.value, 10) || new Date().getFullYear())}
            className="w-24 h-9"
          />
        </div>
        <Button onClick={scan} disabled={loading} size="sm">
          {loading ? <RefreshCw className="h-4 w-4 animate-spin mr-1.5" /> : <Search className="h-4 w-4 mr-1.5" />}
          Scan Sage
        </Button>
        {lines.length > 0 && (
          <>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="rounded" />
              Show all lines ({lines.length})
            </label>
            <Input
              placeholder="Filter by batch, description, amount…"
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              className="h-9 w-64"
            />
          </>
        )}
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          {error}
        </div>
      )}

      {/* Summary */}
      {lines.length > 0 && !error && (
        <div className="text-sm text-muted-foreground">
          {problemCount === 0 ? (
            <span className="text-emerald-400 font-medium">No problematic lines found for {year}.</span>
          ) : (
            <span className="text-amber-400 font-medium">{problemCount} problematic line{problemCount !== 1 ? "s" : ""} found for {year}.</span>
          )}
          {" "}Showing {displayed.length} of {lines.length} total.
        </div>
      )}

      {/* Table */}
      {displayed.length > 0 && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-card border-b border-border">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Batch</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Batch Description</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Status</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Document</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Doc Date</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Line Description</th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground">Week</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground">Fee Type</th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground">Amount</th>
                  <th className="px-3 py-2 text-center font-medium text-muted-foreground">Status</th>
                  <th className="px-3 py-2 text-center font-medium text-muted-foreground"></th>
                </tr>
              </thead>
              <tbody>
                {displayed.map((line) => {
                  const isEditing = editing
                    && editing.batch_number === line.batch_number
                    && editing.item_number === line.item_number
                    && editing.line_number === line.line_number;
                  return (
                    <tr
                      key={`${line.batch_number}-${line.item_number}-${line.line_number}`}
                      className={`border-b border-border last:border-0 ${
                        line.problem_type !== "OK" ? "bg-red-500/5" : "hover:bg-muted/20"
                      } ${isEditing ? "ring-1 ring-amber-500/40 bg-amber-500/5" : ""}`}
                    >
                      <td className="px-3 py-2 font-mono tabular-nums">{line.batch_number}</td>
                      <td className="px-3 py-2 truncate max-w-[160px]">{line.batch_description || "—"}</td>
                      <td className="px-3 py-2">{line.batch_status}</td>
                      <td className="px-3 py-2 font-mono">{line.document_number}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{line.doc_date || "—"}</td>
                      <td className="px-3 py-2 font-mono max-w-[220px] truncate" title={line.line_description}>
                        {line.line_description}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{line.week_number ?? "—"}</td>
                      <td className="px-3 py-2">{line.fee_type}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-mono">
                        {line.line_amount != null ? parseFloat(line.line_amount).toLocaleString("en-ZA", { minimumFractionDigits: 2 }) : "—"}
                      </td>
                      <td className="px-3 py-2 text-center"><ProblemBadge type={line.problem_type} /></td>
                      <td className="px-3 py-2 text-center">
                        <button
                          onClick={() => startEdit(line)}
                          className="text-muted-foreground hover:text-foreground transition-colors"
                          title="Edit description"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Editor */}
      {editing && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Pencil className="h-4 w-4 text-amber-400" />
            <h4 className="font-semibold text-foreground text-sm">
              Edit — Batch {editing.batch_number}, Line {editing.line_number}
            </h4>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1 block">Current Description</label>
              <div className="px-3 py-2 rounded-lg bg-muted/30 text-sm font-mono text-muted-foreground">{editing.line_description}</div>
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1 block">
                New Description <span className="text-muted-foreground/60">({newDesc.length}/60)</span>
              </label>
              <Input
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value.slice(0, 60))}
                className="font-mono"
                placeholder="e.g. DELIVERY FEE WEEK 13 - BAT"
                autoFocus
              />
            </div>
          </div>

          {/* Preview */}
          {preview && (
            <div className="flex items-center gap-4 flex-wrap text-sm">
              <span className="text-muted-foreground">Preview:</span>
              <span className={preview.weekNumber ? "text-emerald-400" : "text-red-400"}>
                Week {preview.weekNumber ?? "—"}
              </span>
              <span className={preview.feeType !== "OTHER" ? "text-emerald-400" : "text-red-400"}>
                {preview.feeType}
              </span>
              {preview.isValid ? (
                <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px]">
                  <Check className="h-3 w-3 mr-1" /> Valid
                </Badge>
              ) : (
                <Badge className="bg-red-500/15 text-red-400 border-red-500/30 text-[10px]">
                  <X className="h-3 w-3 mr-1" /> Invalid
                </Badge>
              )}
              {preview.problems?.length > 0 && (
                <span className="text-red-400 text-xs">{preview.problems.join("; ")}</span>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              onClick={openConfirm}
              disabled={!preview?.isValid || previewLoading}
              size="sm"
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              Apply Correction
            </Button>
            <Button onClick={cancelEdit} variant="ghost" size="sm">Cancel</Button>
          </div>
        </div>
      )}

      {/* Confirm Dialog */}
      <Dialog open={confirmOpen} onOpenChange={(v) => { if (!v) setConfirmOpen(false); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <ShieldAlert className="h-5 w-5 text-red-400" />
              Confirm Sage Write
            </DialogTitle>
          </DialogHeader>

          <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300 space-y-1">
            <p className="font-semibold">This writes directly to the Sage 300 database.</p>
            <p>This action cannot be undone from within this application. Make sure the new description is correct.</p>
          </div>

          {editing && (
            <div className="space-y-3 text-sm">
              <div>
                <span className="text-muted-foreground">Batch:</span>{" "}
                <span className="font-mono text-foreground">{editing.batch_number}</span>
                <span className="text-muted-foreground ml-3">Item:</span>{" "}
                <span className="font-mono text-foreground">{editing.item_number}</span>
                <span className="text-muted-foreground ml-3">Line:</span>{" "}
                <span className="font-mono text-foreground">{editing.line_number}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Old:</span>{" "}
                <span className="font-mono text-red-400 line-through">{editing.line_description}</span>
              </div>
              <div>
                <span className="text-muted-foreground">New:</span>{" "}
                <span className="font-mono text-emerald-400">{newDesc.trim()}</span>
              </div>
              {preview && (
                <div>
                  <span className="text-muted-foreground">Parsed as:</span>{" "}
                  Week {preview.weekNumber} · {preview.feeType}
                </div>
              )}
            </div>
          )}

          <div>
            <label className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1 block">
              Enter admin password to confirm
            </label>
            <Input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setPasswordError(""); }}
              placeholder="Admin password"
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter" && password) applyCorrection(); }}
            />
            {passwordError && <p className="text-red-400 text-xs mt-1">{passwordError}</p>}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={applying}>Cancel</Button>
            <Button
              onClick={applyCorrection}
              disabled={!password || applying}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {applying ? <RefreshCw className="h-4 w-4 animate-spin mr-1.5" /> : <ShieldAlert className="h-4 w-4 mr-1.5" />}
              Confirm Write to Sage
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
