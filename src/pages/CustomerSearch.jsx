import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/apiClient";
import { AlertCircle, Database, Flag, CheckCircle, RefreshCw, FileSearch, Search, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";
import { humanizeApiError } from "@/lib/humanizeApiError";
import CustomerLookup from "../components/customer/CustomerLookup";
import FlaggedCustomersModal from "../components/customer/FlaggedCustomersModal";
import { parseAmount } from "@/lib/format";

function fmtR(v) {
  return Math.abs(parseAmount(v)).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function AmountLookupModal({ open, onClose, onPickCustomer }) {
  const [amount, setAmount] = useState("");
  const [tolerance, setTolerance] = useState("5");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);
  const [results, setResults] = useState(null);
  const [sageResults, setSageResults] = useState(null);
  const [sageSearching, setSageSearching] = useState(false);
  const [sageError, setSageError] = useState(null);
  const [sageDays, setSageDays] = useState(365);

  useEffect(() => {
    if (!open) {
      setAmount(""); setTolerance("5"); setResults(null); setError(null); setSearching(false);
      setSageResults(null); setSageError(null); setSageSearching(false); setSageDays(365);
    }
  }, [open]);

  const search = async () => {
    const v = parseAmount(amount);
    if (!Number.isFinite(v) || v <= 0) { setError("Enter a valid rand amount"); return; }
    setSearching(true); setError(null); setResults(null);
    setSageResults(null); setSageError(null); // reset sage when local re-searches
    try {
      const qs = new URLSearchParams({ amount: String(v), tolerance });
      const r = await fetch(`/api/customer-by-invoice-amount?${qs.toString()}`, { credentials: "include" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Local lookup failed (HTTP ${r.status})`);
      setResults(d.matches || []);
    } catch (err) {
      setError(err.message);
      toast.error(humanizeApiError(err, `look up invoices for amount R${v}`));
    } finally { setSearching(false); }
  };

  const searchSage = async () => {
    const v = parseAmount(amount);
    if (!Number.isFinite(v) || v <= 0) return;
    setSageSearching(true); setSageError(null); setSageResults(null);
    try {
      const qs = new URLSearchParams({ amount: String(v), tolerance, days: String(sageDays) });
      const r = await fetch(`/api/customer-by-invoice-amount/sage?${qs.toString()}`, { credentials: "include" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Sage query failed (HTTP ${r.status})`);
      setSageResults(d.matches || []);
    } catch (err) {
      setSageError(err.message);
      toast.error(humanizeApiError(err, `look up invoices for amount R${v} in Sage`));
    } finally { setSageSearching(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-4xl" style={{ borderRadius: "12px" }}>
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">Find invoice by amount</DialogTitle>
          <DialogDescription className="font-sans normal-case tracking-normal text-sm leading-relaxed text-muted-foreground">
            For matching unidentified bank deposits — searches every unpaid invoice <em>and</em> recent receipt within the chosen rand tolerance.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 mt-2">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 font-mono text-xs text-muted-foreground pointer-events-none">R</span>
            <input
              autoFocus
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.,\-]/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && search()}
              placeholder="11710.66"
              className="w-full bg-background border border-border text-foreground pl-7 pr-3 py-2 text-sm font-mono tabular-nums outline-none focus:border-accent"
              style={{ borderRadius: "12px" }}
            />
            {amount && (
              <button onClick={() => setAmount("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <select
            value={tolerance}
            onChange={(e) => setTolerance(e.target.value)}
            className="bg-background border border-border text-foreground px-2 py-2 text-xs font-mono outline-none focus:border-accent"
            style={{ borderRadius: "12px" }}
            title="How far above or below the typed amount to search"
          >
            <option value="0">Exact</option>
            <option value="0.05">±R 0.05</option>
            <option value="0.50">±R 0.50</option>
            <option value="5">±R 5.00</option>
            <option value="50">±R 50.00</option>
          </select>
          <button
            onClick={search}
            disabled={searching || !amount.trim()}
            className="px-4 py-2 border font-mono text-[10px] uppercase tracking-[0.2em] transition-colors disabled:opacity-40"
            style={{
              borderRadius: "12px",
              borderColor: "var(--phosphor)",
              color: "var(--phosphor)",
              background: "hsla(33,95%,55%,0.08)",
            }}
            onMouseEnter={(e) => { if (!e.currentTarget.disabled) { e.currentTarget.style.background = "hsla(33,95%,55%,0.18)"; e.currentTarget.style.boxShadow = "0 0 12px hsla(33,95%,55%,0.35)"; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "hsla(33,95%,55%,0.08)"; e.currentTarget.style.boxShadow = "none"; }}
          >
            {searching ? "Searching…" : "Search"}
          </button>
        </div>

        {error && (
          <div className="mt-3 px-3 py-2 text-sm text-destructive font-mono" style={{ border: "1px solid hsl(var(--destructive))", borderRadius: "12px" }}>
            {error}
          </div>
        )}

        {results !== null && !searching && (
          <div className="mt-4 max-h-[55vh] overflow-auto">
            {results.length === 0 ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground font-mono text-center py-4">
                  No invoice in the local database within ±R {tolerance} of R {amount}.
                </p>
                <SageFallbackPanel
                  enabled
                  searching={sageSearching}
                  error={sageError}
                  results={sageResults}
                  onSearch={searchSage}
                  days={sageDays}
                  setDays={setSageDays}
                  onPickCustomer={onPickCustomer}
                  onClose={onClose}
                  variant="amount"
                  contextLabel={`±R ${tolerance} of R ${amount}`}
                />
              </div>
            ) : (
              <div className="space-y-2">
                <div className="font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground mb-1">
                  {results.length} match{results.length === 1 ? "" : "es"} · sorted by closest first
                  {results.some(m => m.match_type === "exact") && (
                    <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 text-[hsl(145_55%_75%)]" style={{ background: "hsla(145, 55%, 45%, 0.15)", border: "1px solid hsla(145, 55%, 45%, 0.5)", borderRadius: "12px" }}>
                      ● exact match found
                    </span>
                  )}
                </div>
                {results.map((m, i) => {
                  const exact = m.match_type === "exact";
                  const stripColour = exact ? "hsl(145 55% 45%)" : "var(--phosphor)";
                  const diffColour = exact ? "text-[hsl(145_55%_75%)]" : Math.abs(m.diff) < 0.10 ? "text-[var(--phosphor)]" : "text-muted-foreground";
                  return (
                    <button
                      key={`${m.customer_number}-${m.invoice_number}-${i}`}
                      onClick={() => { onPickCustomer(m.customer_number); onClose(); }}
                      className={`w-full relative p-3 text-left transition-colors ${exact ? "" : "bg-card border border-border hover:bg-muted/30"}`}
                      style={{
                        borderRadius: "12px",
                        ...(exact && {
                          background: "linear-gradient(90deg, hsla(145, 55%, 45%, 0.18) 0%, hsla(145, 55%, 45%, 0.06) 100%)",
                          border: "1px solid hsl(145 55% 45%)",
                          boxShadow: "0 0 14px hsla(145, 55%, 45%, 0.35)",
                        }),
                      }}
                    >
                      <div className="absolute left-0 top-0 bottom-0" style={{ width: exact ? "3px" : "2px", background: stripColour, boxShadow: `0 0 ${exact ? 12 : 8}px ${stripColour}80` }} />
                      {exact && (
                        <span className="absolute -top-2 right-3 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] font-semibold text-[hsl(24_8%_6%)]" style={{ background: "hsl(145 55% 45%)", borderRadius: "12px", boxShadow: "0 0 10px hsla(145,55%,45%,0.5)" }}>
                          Exact match
                        </span>
                      )}
                      <div className="pl-2 grid grid-cols-[1fr_auto] gap-3 items-baseline">
                        <div className="min-w-0">
                          <div className={`font-display text-lg truncate ${exact ? "text-[hsl(145_55%_85%)]" : "text-foreground"}`}>{m.customer_name || "—"}</div>
                          <div className="font-mono text-sm uppercase tracking-[0.12em] text-muted-foreground mt-0.5">
                            {m.customer_number || "—"}
                            {m.invoice_number ? ` · ${m.invoice_number}` : ""}
                            {m.invoice_date ? ` · ${m.invoice_date}` : ""}
                            {m.site_name ? ` · ${m.site_name}` : ""}
                            {m.source === "receipt" && (
                              <span className="ml-2 px-1.5 py-0.5 rounded-sm font-mono text-[10px] tracking-[0.15em]"
                                    style={{ color: "var(--phosphor)", border: "1px solid hsla(33,95%,55%,0.4)", background: "hsla(33,95%,55%,0.08)" }}
                                    title="Matched against a past payment receipt, not an open invoice">
                                Receipt
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className={`font-mono text-base tabular-nums ${exact ? "text-[hsl(145_55%_85%)] font-semibold" : "text-foreground"}`}>
                            <span className="text-muted-foreground/60 mr-1">R</span>{fmtR(m.invoice_amount)}
                          </div>
                          <div className={`font-mono text-sm tabular-nums uppercase tracking-[0.12em] mt-0.5 ${diffColour}`}>
                            {exact ? "● exact" : `${m.diff > 0 ? "+" : ""}${m.diff.toFixed(2)}`}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function InvoiceLookupModal({ open, onClose, onPickCustomer }) {
  const [invoice, setInvoice] = useState("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);
  const [results, setResults] = useState(null); // null = not searched; [] = no matches
  const [sageResults, setSageResults] = useState(null);
  const [sageSearching, setSageSearching] = useState(false);
  const [sageError, setSageError] = useState(null);
  const [sageDays, setSageDays] = useState(730);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setInvoice(""); setResults(null); setError(null); setSearching(false);
      setSageResults(null); setSageError(null); setSageSearching(false); setSageDays(730);
    }
  }, [open]);

  const search = async () => {
    const q = invoice.trim();
    if (q.length < 3) { setError("Enter at least 3 characters"); return; }
    setSearching(true); setError(null); setResults(null);
    setSageResults(null); setSageError(null);
    try {
      const r = await fetch(`/api/customer-by-invoice?invoice=${encodeURIComponent(q)}`, { credentials: "include" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Local lookup failed (HTTP ${r.status})`);
      setResults(d.matches || []);
    } catch (err) {
      setError(err.message);
      toast.error(humanizeApiError(err, `look up invoice "${q}"`));
    } finally {
      setSearching(false);
    }
  };

  const searchSage = async () => {
    const q = invoice.trim();
    if (q.length < 3) return;
    setSageSearching(true); setSageError(null); setSageResults(null);
    try {
      const r = await fetch(`/api/customer-by-invoice/sage?invoice=${encodeURIComponent(q)}&days=${sageDays}`, { credentials: "include" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Sage query failed (HTTP ${r.status})`);
      setSageResults(d.matches || []);
    } catch (err) {
      setSageError(err.message);
      toast.error(humanizeApiError(err, `look up invoice "${q}" in Sage`));
    } finally { setSageSearching(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-4xl" style={{ borderRadius: "12px" }}>
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">Find customer by invoice</DialogTitle>
          <DialogDescription className="font-sans normal-case tracking-normal text-sm leading-relaxed text-muted-foreground">
            Enter any unpaid invoice number to find the customer holding it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 mt-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" strokeWidth={1.5} />
            <input
              autoFocus
              value={invoice}
              onChange={(e) => setInvoice(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && search()}
              placeholder="e.g. IN587925"
              className="w-full bg-background border border-border text-foreground pl-9 pr-3 py-2 text-sm font-mono outline-none focus:border-accent"
              style={{ borderRadius: "12px" }}
            />
            {invoice && (
              <button onClick={() => setInvoice("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <button
            onClick={search}
            disabled={searching || invoice.trim().length < 3}
            className="px-4 py-2 border font-mono text-[10px] uppercase tracking-[0.2em] transition-colors disabled:opacity-40"
            style={{
              borderRadius: "12px",
              borderColor: "var(--phosphor)",
              color: "var(--phosphor)",
              background: "hsla(33,95%,55%,0.08)",
            }}
            onMouseEnter={(e) => { if (!e.currentTarget.disabled) { e.currentTarget.style.background = "hsla(33,95%,55%,0.18)"; e.currentTarget.style.boxShadow = "0 0 12px hsla(33,95%,55%,0.35)"; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "hsla(33,95%,55%,0.08)"; e.currentTarget.style.boxShadow = "none"; }}
          >
            {searching ? "Searching…" : "Search"}
          </button>
        </div>

        {error && (
          <div className="mt-3 px-3 py-2 text-sm text-destructive font-mono" style={{ border: "1px solid hsl(var(--destructive))", borderRadius: "12px" }}>
            {error}
          </div>
        )}

        {results !== null && !searching && (
          <div className="mt-4 max-h-[50vh] overflow-auto">
            {results.length === 0 ? (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground font-mono text-center py-4">
                  No customer in the local database with invoice "{invoice}".
                </p>
                <SageFallbackPanel
                  enabled
                  searching={sageSearching}
                  error={sageError}
                  results={sageResults}
                  onSearch={searchSage}
                  days={sageDays}
                  setDays={setSageDays}
                  onPickCustomer={onPickCustomer}
                  onClose={onClose}
                  variant="invoice"
                  contextLabel={`"${invoice}"`}
                />
              </div>
            ) : (
              <div className="space-y-2">
                <div className="font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground mb-1">
                  {results.length} match{results.length === 1 ? "" : "es"}
                </div>
                {results.map((m, i) => {
                  const balance = parseAmount(m.outstanding_balance);
                  const balanceColour = balance > 10000 ? "text-red-400" : balance > 0 ? "text-orange-400" : "text-muted-foreground";
                  return (
                    <button
                      key={`${m.customer_number}-${i}`}
                      onClick={() => { onPickCustomer(m.customer_number); onClose(); }}
                      className="w-full relative overflow-hidden bg-card border border-border p-3 text-left hover:bg-muted/30 transition-colors"
                      style={{ borderRadius: "12px" }}
                    >
                      <div className="absolute left-0 top-0 bottom-0 w-[2px]" style={{ background: "var(--phosphor)", boxShadow: "0 0 8px hsla(33,95%,55%,0.4)" }} />
                      <div className="pl-2 flex items-baseline justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-display text-lg text-foreground truncate">{m.customer_name || "—"}</div>
                          <div className="font-mono text-sm uppercase tracking-[0.12em] text-muted-foreground mt-0.5">
                            {m.customer_number || "—"}{m.site_name ? ` · ${m.site_name}` : ""}
                          </div>
                        </div>
                        <div className={`font-mono text-sm tabular-nums shrink-0 ${balanceColour}`}>
                          <span className="text-muted-foreground/60 mr-1">R</span>{fmtR(balance)}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// Shared "Search older in Sage" fallback panel — used by both lookup modals
// when the local database has no match. One-shot read-through query against
// Sage 300 via the BAT module's MSSQL pool. Nothing is persisted locally.
function SageFallbackPanel({ enabled, searching, error, results, onSearch, onPickCustomer, onClose, variant, contextLabel, days, setDays }) {
  if (!enabled) return null;

  return (
    <div className="rounded-[2px] border border-dashed border-border p-4 bg-card/50">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground mb-1">Older invoices?</div>
          <p className="text-sm text-foreground/90">
            Search Sage 300 directly for {contextLabel}. Read-only, nothing is stored locally.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {setDays && (
            <select
              value={days}
              onChange={(e) => setDays(parseInt(e.target.value, 10))}
              className="bg-background border border-border text-foreground px-2 py-2 text-xs font-mono outline-none focus:border-accent"
              style={{ borderRadius: "12px" }}
              title="How far back to search in Sage"
              disabled={searching}
            >
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={180}>Last 6 months</option>
              <option value={365}>Last year</option>
              <option value={730}>Last 2 years</option>
              <option value={3650}>Last 10 years</option>
            </select>
          )}
          <button
            onClick={onSearch}
            disabled={searching}
            className="px-4 py-2 border font-mono text-[10px] uppercase tracking-[0.2em] transition-colors disabled:opacity-40"
            style={{
              borderRadius: "12px",
              borderColor: "hsl(200 80% 55%)",
              color: "hsl(200 80% 75%)",
              background: "hsla(200, 80%, 55%, 0.10)",
            }}
            onMouseEnter={(e) => { if (!e.currentTarget.disabled) { e.currentTarget.style.background = "hsla(200, 80%, 55%, 0.20)"; e.currentTarget.style.boxShadow = "0 0 12px hsla(200, 80%, 55%, 0.35)"; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "hsla(200, 80%, 55%, 0.10)"; e.currentTarget.style.boxShadow = "none"; }}
          >
            {searching ? "Querying Sage…" : "Search older in Sage"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-3 px-3 py-2 text-sm text-destructive font-mono" style={{ border: "1px solid hsl(var(--destructive))", borderRadius: "12px" }}>
          {error}
        </div>
      )}

      {results !== null && !searching && (
        <div className="mt-4">
          {results.length === 0 ? (
            <p className="text-sm text-muted-foreground font-mono text-center py-4">
              Sage 300 also has no match for {contextLabel}.
            </p>
          ) : (
            <div className="space-y-2">
              <div className="font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground mb-1">
                {results.length} Sage match{results.length === 1 ? "" : "es"} · live read-through
              </div>
              {results.map((m, i) => {
                const exact = m.match_type === "exact";
                const stripColour = exact ? "hsl(145 55% 45%)" : "hsl(200 80% 55%)";
                return (
                  <button
                    key={`sage-${m.customer_number}-${m.invoice_number}-${i}`}
                    onClick={() => { onPickCustomer(m.customer_number); onClose(); }}
                    className={`w-full relative p-3 text-left transition-colors ${exact ? "" : "bg-card border border-border hover:bg-muted/30"}`}
                    style={{
                      borderRadius: "12px",
                      ...(exact && {
                        background: "linear-gradient(90deg, hsla(145, 55%, 45%, 0.18) 0%, hsla(145, 55%, 45%, 0.06) 100%)",
                        border: "1px solid hsl(145 55% 45%)",
                        boxShadow: "0 0 14px hsla(145, 55%, 45%, 0.35)",
                      }),
                    }}
                  >
                    <div className="absolute left-0 top-0 bottom-0" style={{ width: exact ? "3px" : "2px", background: stripColour, boxShadow: `0 0 ${exact ? 12 : 8}px ${stripColour}80` }} />
                    <span className="absolute -top-2 right-3 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] font-semibold" style={{ background: "hsl(200 80% 55%)", color: "hsl(200 25% 6%)", borderRadius: "12px", boxShadow: "0 0 8px hsla(200, 80%, 55%, 0.5)" }}>
                      Sage
                    </span>
                    {m.paid && (
                      <span className="absolute top-3 right-12 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em]" style={{ color: m.paid === "paid" ? "hsl(145 55% 75%)" : "hsl(33 95% 75%)", background: m.paid === "paid" ? "hsla(145, 55%, 45%, 0.12)" : "hsla(33, 95%, 55%, 0.12)", border: `1px solid ${m.paid === "paid" ? "hsla(145, 55%, 45%, 0.4)" : "hsla(33, 95%, 55%, 0.4)"}`, borderRadius: "12px" }}>
                        {m.paid}
                      </span>
                    )}
                    <div className="pl-2 grid grid-cols-[1fr_auto] gap-3 items-baseline">
                      <div className="min-w-0">
                        <div className={`font-display text-lg truncate ${exact ? "text-[hsl(145_55%_85%)]" : "text-foreground"}`}>{m.customer_name || "—"}</div>
                        <div className="font-mono text-sm uppercase tracking-[0.12em] text-muted-foreground mt-0.5">
                          {m.customer_number || "—"}
                          {m.invoice_number ? ` · ${m.invoice_number}` : ""}
                          {m.invoice_date ? ` · ${m.invoice_date}` : ""}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className={`font-mono text-base tabular-nums ${exact ? "text-[hsl(145_55%_85%)] font-semibold" : "text-foreground"}`}>
                          <span className="text-muted-foreground/60 mr-1">R</span>{fmtR(m.invoice_amount)}
                        </div>
                        {variant === "amount" && typeof m.diff === "number" && (
                          <div className={`font-mono text-sm tabular-nums uppercase tracking-[0.12em] mt-0.5 ${exact ? "text-[hsl(145_55%_75%)]" : "text-muted-foreground"}`}>
                            {exact ? "● exact" : `${m.diff > 0 ? "+" : ""}${m.diff.toFixed(2)}`}
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function CustomerSearch() {
  const queryClient = useQueryClient();
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [flagModalOpen, setFlagModalOpen] = useState(false);
  const [selectedFlagColor, setSelectedFlagColor] = useState(null);
  const [customerNumberToLookup, setCustomerNumberToLookup] = useState("");
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);
  const [amountModalOpen, setAmountModalOpen] = useState(false);

  const { data: currentUser } = useQuery({
    queryKey: ["currentUser"],
    queryFn: () => api.auth.me(),
    staleTime: Infinity,
  });

  const [selectedConnectionId, setSelectedConnectionId] = useState(null);

  const { data: connections = [] } = useQuery({
    queryKey: ["connections", currentUser?.email],
    queryFn: async () => {
      if (!currentUser) return [];
      const allConnections = await api.entities.DatabaseConnection.list();
      // BAT-only connections feed the BAT module's own pool — they must not
      // appear in customer-search context (no datarecord rows are sourced from them).
      return allConnections.filter(c => !c.is_bat_only);
    },
    enabled: !!currentUser,
  });

  // Auto-select first active connection if none selected
  useEffect(() => {
    if (connections.length > 0 && !selectedConnectionId) {
      const activeConnection = connections.find(c => c.status === "active");
      setSelectedConnectionId(activeConnection?.id || connections[0]?.id || null);
    }
  }, [connections, selectedConnectionId]);

  const { data: kpis = null } = useQuery({
    queryKey: ["kpis"],
    queryFn: async () => {
      try { return await api.kpis(); } catch { return null; }
    },
    staleTime: 30_000,
  });

  const { data: fallbackFlagCounts = null } = useQuery({
    queryKey: ["record-flag-counts"],
    queryFn: async () => {
      try { return await api.records.flagCounts(); } catch { return null; }
    },
    enabled: kpis === null,
    staleTime: 30_000,
  });

  useEffect(() => {
    let debounceTimer = null;
    const unsubscribe = api.entities.DataRecord.subscribe((event) => {
      if (["create", "update"].includes(event.type)) {
        // Batch rapid events (e.g., during a sync) into a single invalidation
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ["kpis"] });
        }, 1000);
      }
    });
    return () => {
      clearTimeout(debounceTimer);
      unsubscribe();
    };
  }, [queryClient]);

  const activeConnections = connections.filter(c => c.status === "active");
  const selectedConnection = connections.find(c => c.id === selectedConnectionId);
  
  // Prefer KPI endpoint, then lightweight grouped counts; never fall back to full-record fetches here.
  const redCount = kpis?.records_by_flag?.red ?? fallbackFlagCounts?.records_by_flag?.red ?? 0;
  const greenCount = kpis?.records_by_flag?.green ?? fallbackFlagCounts?.records_by_flag?.green ?? 0;
  const orangeCount = kpis?.records_by_flag?.orange ?? fallbackFlagCounts?.records_by_flag?.orange ?? 0;

  const handleFlagClick = (flagColor) => {
    setSelectedFlagColor(flagColor);
    setFlagModalOpen(true);
  };

  const handleCustomerClickFromModal = (customer) => {
    const customerNumber = customer.customer_number || customer.data?.customer_number;
    setCustomerNumberToLookup(customerNumber);
    setFlagModalOpen(false);
  };

  // FlaggedCustomersModal fetches its own records server-side

  const FLAG_TILES = [
    { key: "red",    label: "Critical",  sub: "red flagged",    count: redCount,    hue: "hsl(0 72% 50%)",   glow: "hsla(0, 72%, 50%, 0.35)",   icon: Flag },
    { key: "orange", label: "Attention", sub: "orange flagged", count: orangeCount, hue: "var(--phosphor)", glow: "hsla(33, 95%, 55%, 0.35)", icon: AlertCircle },
    { key: "green",  label: "Approved",  sub: "green flagged",  count: greenCount,  hue: "hsl(145 55% 45%)", glow: "hsla(145, 55%, 45%, 0.25)", icon: CheckCircle },
  ];

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-8 py-10 space-y-6">
        {/* Header */}
        <div className="border-b border-border pb-5 flex items-end justify-between gap-4 flex-wrap">
          <div>

            <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
              Search the <em className="text-phosphor">ledger</em>.
            </h1>
            <p className="text-sm text-muted-foreground mt-3">
              Review customer accounts, balances, and outstanding activity.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setInvoiceModalOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.2em] transition-colors"
              style={{
                borderRadius: "12px",
                border: "1px solid var(--phosphor)",
                color: "var(--phosphor)",
                background: "hsla(33, 95%, 55%, 0.08)",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "hsla(33, 95%, 55%, 0.18)"; e.currentTarget.style.boxShadow = "0 0 12px hsla(33,95%,55%,0.35)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "hsla(33, 95%, 55%, 0.08)"; e.currentTarget.style.boxShadow = "none"; }}
              title="Find a customer by an unpaid invoice number"
            >
              <FileSearch className="h-3.5 w-3.5" strokeWidth={1.75} />
              Find by invoice
            </button>
            <button
              onClick={() => setAmountModalOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.2em] transition-colors"
              style={{
                borderRadius: "12px",
                border: "1px solid var(--phosphor)",
                color: "var(--phosphor)",
                background: "hsla(33, 95%, 55%, 0.08)",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "hsla(33, 95%, 55%, 0.18)"; e.currentTarget.style.boxShadow = "0 0 12px hsla(33,95%,55%,0.35)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "hsla(33, 95%, 55%, 0.08)"; e.currentTarget.style.boxShadow = "none"; }}
              title="Find an unpaid invoice by its amount (with a few cents tolerance)"
            >
              <Search className="h-3.5 w-3.5" strokeWidth={1.75} />
              Find by amount
            </button>
          </div>
        </div>

        <InvoiceLookupModal
          open={invoiceModalOpen}
          onClose={() => setInvoiceModalOpen(false)}
          onPickCustomer={(num) => setCustomerNumberToLookup(num)}
        />
        <AmountLookupModal
          open={amountModalOpen}
          onClose={() => setAmountModalOpen(false)}
          onPickCustomer={(num) => setCustomerNumberToLookup(num)}
        />

        {/* Flag Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 stagger-in">
          {FLAG_TILES.map(({ key, label, sub, count, hue, glow, icon: Icon }) => (
            <button
              key={key}
              onClick={() => handleFlagClick(key)}
              className="relative bg-card text-left px-5 py-4 border border-border transition-all hover:bg-muted/30 hover:-translate-y-0.5 group cursor-pointer overflow-hidden"
              style={{ borderRadius: "14px", boxShadow: "0 1px 2px rgba(0,0,0,0.25)" }}
              onMouseEnter={(e) => { e.currentTarget.style.boxShadow = `0 6px 18px rgba(0,0,0,0.35), 0 0 0 1px ${glow}`; }}
              onMouseLeave={(e) => { e.currentTarget.style.boxShadow = "0 1px 2px rgba(0,0,0,0.25)"; }}
            >
              <div
                className="absolute left-0 right-0 bottom-0 h-[2px] transition-all"
                style={{ background: hue, boxShadow: `0 0 12px ${glow}` }}
              />
              <div className="flex items-start justify-between">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-2">
                    {label}
                  </div>
                  <div className="font-display text-4xl leading-none text-foreground tabular-nums">
                    {count.toLocaleString()}
                  </div>
                  <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mt-2">
                    {sub}
                  </div>
                </div>
                <Icon className="w-4 h-4 shrink-0 opacity-60 group-hover:opacity-100 transition-opacity" style={{ color: hue }} strokeWidth={1.5} />
              </div>
            </button>
          ))}
        </div>

        {/* Flagged Customers Modal */}
        <FlaggedCustomersModal
          flagColor={selectedFlagColor}
          open={flagModalOpen}
          onClose={() => setFlagModalOpen(false)}
          onCustomerClick={handleCustomerClickFromModal}
        />

        {/* Customer Lookup + Last Sync side by side */}
        <div className="flex flex-col sm:flex-row gap-4 items-stretch">
          <div className="flex-1 bg-card border border-border min-w-0" style={{ borderRadius: "14px", boxShadow: "0 1px 2px rgba(0,0,0,0.25)" }}>
            <CustomerLookup
              currentUser={currentUser}
              onRecordSelect={setSelectedRecord}
              triggerLookup={customerNumberToLookup}
              onLookupComplete={() => setCustomerNumberToLookup("")}
              selectedConnection={selectedConnection}
              onFlagChange={() => { queryClient.invalidateQueries({ queryKey: ["records"] }); queryClient.invalidateQueries({ queryKey: ["kpis"] }); }}
            />
          </div>

          {selectedConnection && (
            <div
              className="w-full sm:flex-shrink-0 sm:w-56 bg-card border border-border relative px-5 py-4 flex flex-col justify-center overflow-hidden"
              style={{ borderRadius: "14px", boxShadow: "0 1px 2px rgba(0,0,0,0.25)" }}
            >
              <div
                className="absolute left-0 right-0 bottom-0 h-[2px]"
                style={{ background: "var(--phosphor)", boxShadow: "0 0 12px hsla(33,95%,55%,0.35)" }}
              />
              <div className="flex items-center gap-2 mb-2">
                <RefreshCw className="w-3 h-3 text-accent" />
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Last Sync</p>
              </div>
              <div>
                {selectedConnection.last_sync ? (
                  <>
                    <p className="font-mono text-xs text-muted-foreground">
                      {new Date(selectedConnection.last_sync + (selectedConnection.last_sync.endsWith("Z") ? "" : "Z")).toLocaleString("en-ZA", {
                        timeZone: "Africa/Johannesburg",
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      })}
                    </p>
                    <p className="font-display text-3xl leading-none text-foreground tabular-nums mt-1">
                      {new Date(selectedConnection.last_sync + (selectedConnection.last_sync.endsWith("Z") ? "" : "Z")).toLocaleString("en-ZA", {
                        timeZone: "Africa/Johannesburg",
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      })}
                    </p>
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mt-2 truncate">
                      {selectedConnection.name}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">Never synced</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Connection Status Banner */}
        {activeConnections.length === 0 && (
          <div className="border border-border bg-card relative overflow-hidden px-5 py-3" style={{ borderRadius: "12px" }}>
            <div
              className="absolute left-0 top-0 bottom-0 w-[2px]"
              style={{ background: "var(--phosphor)", boxShadow: "0 0 12px hsla(33,95%,55%,0.35)" }}
            />
            <div className="flex items-start gap-3 pl-2">
              <AlertCircle className="w-4 h-4 text-accent mt-0.5 shrink-0" strokeWidth={1.5} />
              <div className="flex-1">
                <h3 className="font-mono text-[10px] uppercase tracking-[0.2em] text-accent mb-1">No Active Connections</h3>
                <p className="text-xs text-muted-foreground">
                  Configure a database connection in the Dashboard to enable live SQL lookups.
                </p>
              </div>
            </div>
          </div>
        )}

        {activeConnections.length > 0 && (
          <div className="border border-border bg-card relative overflow-hidden px-5 py-3" style={{ borderRadius: "12px" }}>
            <div
              className="absolute left-0 top-0 bottom-0 w-[2px]"
              style={{ background: "hsl(145 55% 45%)", boxShadow: "0 0 12px hsla(145,55%,45%,0.3)" }}
            />
            <div className="flex items-start gap-3 pl-2">
              <Database className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "hsl(145 55% 45%)" }} strokeWidth={1.5} />
              <div className="flex-1">
                <h3 className="font-mono text-[10px] uppercase tracking-[0.2em] mb-1" style={{ color: "hsl(145 55% 45%)" }}>Connected</h3>
                <p className="text-xs text-muted-foreground font-mono">
                  {activeConnections[0].name} · {activeConnections[0].database_name}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}