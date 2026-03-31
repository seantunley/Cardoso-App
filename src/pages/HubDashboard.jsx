import { useState, useEffect, useCallback, useRef } from "react";
import {
  RefreshCw, AlertCircle, Clock, Search,
  Building2, Wifi, WifiOff, Loader2, User, Flag, Shield,
  Trash2, History, CheckCircle, Calendar,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import FlaggedCustomersModal from "../components/customer/FlaggedCustomersModal";
import { toast } from "sonner";

// ─── helpers ────────────────────────────────────────────────────────────────

const FLAG_COLORS = {
  red:    { bg: "bg-red-100",    text: "text-red-700",    border: "border-red-200",    label: "Red"    },
  orange: { bg: "bg-orange-100", text: "text-orange-700", border: "border-orange-200", label: "Orange" },
  green:  { bg: "bg-green-100",  text: "text-green-700",  border: "border-green-200",  label: "Green"  },
  none:   { bg: "bg-slate-100",  text: "text-slate-500",  border: "border-slate-200",  label: "No Flag"},
};

function parseAmount(val) {
  if (!val && val !== 0) return 0;
  const n = parseFloat(String(val).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
}

function formatAmount(val) {
  const n = parseAmount(val);
  if (n === 0) return "—";
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-R ${abs}` : `R ${abs}`;
}

function fuzzyMatch(str, pattern) {
  if (!str || !pattern) return { matches: false, score: 0 };
  const s = str.toLowerCase(), p = pattern.toLowerCase();
  if (s === p) return { matches: true, score: 1000 };
  if (s.includes(p)) return { matches: true, score: 500 };
  let pi = 0, score = 0, cons = 0;
  for (let i = 0; i < s.length && pi < p.length; i++) {
    if (s[i] === p[pi]) { score += 1 + cons; cons++; pi++; } else { cons = 0; }
  }
  return { matches: pi === p.length, score };
}

// ─── site card ──────────────────────────────────────────────────────────────

function SiteCard({ site, onFlagClick }) {
  const isOnline = site.status === "ok" || site.status === "online";
  const flags = site.kpis?.records_by_flag || {};
  const total = site.kpis?.total_records ?? null;
  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <span className="font-semibold text-foreground">{site.site_name || site.site_slug}</span>
        </div>
        <div className={cn("flex items-center gap-1.5 text-xs font-medium", isOnline ? "text-green-500" : "text-muted-foreground")}>
          {isOnline ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
          {isOnline ? "Online" : "Offline"}
        </div>
      </div>

      {site.kpis ? (
        <div className="grid grid-cols-4 gap-2">

          {/* Total */}
          <div className="group relative overflow-hidden rounded-xl border border-indigo-500/20 bg-gradient-to-br from-indigo-950/60 via-slate-900/80 to-slate-900/60 p-3">
            <p className="text-[9px] font-semibold text-indigo-400/70 uppercase tracking-widest mb-1">Total</p>
            <p className="text-xl font-extrabold text-white leading-none">{total ?? "—"}</p>
            <p className="text-[9px] text-indigo-300/60 mt-1">Records</p>
            <div className="mt-2 h-0.5 rounded-full bg-indigo-500/20">
              <div className="h-full rounded-full bg-indigo-500/60 w-full" />
            </div>
          </div>
          {/* Red */}
          <div onClick={() => onFlagClick(site, "red")} className="group relative overflow-hidden rounded-xl border border-rose-500/20 bg-gradient-to-br from-rose-950/60 via-slate-900/80 to-slate-900/60 p-3 cursor-pointer">
            <div className="absolute inset-0 bg-rose-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
            <p className="text-[9px] font-semibold text-rose-400/70 uppercase tracking-widest mb-1">Critical</p>
            <p className="text-xl font-extrabold text-white leading-none">{flags.red ?? 0}</p>
            <p className="text-[9px] text-rose-300/60 mt-1">Red Flagged</p>
            <div className="mt-2 h-0.5 rounded-full bg-rose-500/20">
              <div className="h-full rounded-full bg-rose-500/60" style={{ width: (flags.red ?? 0) > 0 ? "100%" : "0%" }} />
            </div>
          </div>
          {/* Orange */}
          <div onClick={() => onFlagClick(site, "orange")} className="group relative overflow-hidden rounded-xl border border-amber-500/20 bg-gradient-to-br from-amber-950/60 via-slate-900/80 to-slate-900/60 p-3 cursor-pointer">
            <div className="absolute inset-0 bg-amber-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
            <p className="text-[9px] font-semibold text-amber-400/70 uppercase tracking-widest mb-1">Attention</p>
            <p className="text-xl font-extrabold text-white leading-none">{flags.orange ?? 0}</p>
            <p className="text-[9px] text-amber-300/60 mt-1">Orange Flagged</p>
            <div className="mt-2 h-0.5 rounded-full bg-amber-500/20">
              <div className="h-full rounded-full bg-amber-500/60" style={{ width: (flags.orange ?? 0) > 0 ? "100%" : "0%" }} />
            </div>
          </div>
          {/* Green */}
          <div onClick={() => onFlagClick(site, "green")} className="group relative overflow-hidden rounded-xl border border-emerald-500/20 bg-gradient-to-br from-emerald-950/60 via-slate-900/80 to-slate-900/60 p-3 cursor-pointer">
            <div className="absolute inset-0 bg-emerald-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
            <p className="text-[9px] font-semibold text-emerald-400/70 uppercase tracking-widest mb-1">Approved</p>
            <p className="text-xl font-extrabold text-white leading-none">{flags.green ?? 0}</p>
            <p className="text-[9px] text-emerald-300/60 mt-1">Green Flagged</p>
            <div className="mt-2 h-0.5 rounded-full bg-emerald-500/20">
              <div className="h-full rounded-full bg-emerald-500/60" style={{ width: (flags.green ?? 0) > 0 ? "100%" : "0%" }} />
            </div>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No KPI data yet</p>
      )}

      {site.last_seen && (
        <p className="text-[10px] text-muted-foreground/60">
          Last sync: {new Date(site.last_seen).toLocaleString()}
        </p>
      )}
    </div>
  );
}

// ─── customer modal (read-only from hub) ────────────────────────────────────

function HubCustomerModal({ record, open, onClose }) {
  if (!record) return null;
  const flag = FLAG_COLORS[record.flag_color] || FLAG_COLORS.none;
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Enter') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        className={cn(
          "max-w-2xl border-4 bg-gray-900 max-h-[90vh] flex flex-col",
          record.flag_color === "red"    && "border-red-500",
          record.flag_color === "green"  && "border-green-500",
          record.flag_color === "orange" && "border-orange-500",
          (!record.flag_color || record.flag_color === "none") && "border-gray-700"
        )}
      >
        <DialogHeader className="pb-0">
          <DialogTitle className="flex items-center gap-2">
            <User className="h-4 w-4 text-gray-400 shrink-0" />
            <div className="leading-tight">
              <div className="text-base text-white leading-none">{record.customer_name || "—"}</div>
              <div className="text-xs text-gray-400 mt-0.5">
                Customer #{record.customer_number} · {record._siteName}
              </div>
            </div>
            <Badge className={cn("ml-auto border text-xs", flag.bg, flag.text)}>
              <Flag className="mr-1 h-3 w-3" />
              {flag.label}
            </Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-2 overflow-y-auto flex-1 pr-1">
          {/* Flag reason */}
          {record.flag_reason && (
            <div className="rounded-xl border border-gray-700 bg-gray-800 p-3">
              <p className="text-xs font-medium text-gray-400 mb-1">Flag Reason</p>
              <p className="text-sm text-gray-200">{record.flag_reason}</p>
            </div>
          )}

          {/* Outstanding Balance */}
          <div className="rounded-xl border border-gray-700 bg-gray-800 p-3">
            <div className="flex items-center gap-2 mb-2">
              <Calendar className="h-4 w-4 text-gray-400" />
              <h4 className="text-sm font-semibold text-gray-300">Outstanding Balance</h4>
            </div>
            <div className="grid grid-cols-2 gap-1 text-[10px] text-gray-500 uppercase tracking-wide px-1 mb-1">
              <span>Account</span><span className="text-right">Balance</span>
            </div>
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-gray-700 px-2 py-1.5">
              <span className="text-xs font-medium text-white truncate">{record.customer_number}</span>
              <span className="text-xs text-right text-white">{formatAmount(record.outstanding_balance)}</span>
            </div>
          </div>

          {/* Last Invoice */}
          <div className="rounded-xl border border-gray-700 bg-gray-800 p-3">
            <div className="flex items-center gap-2 mb-2">
              <Flag className="h-4 w-4 text-orange-400" />
              <h4 className="text-sm font-semibold text-gray-300">Last Invoice</h4>
            </div>
            <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)] gap-2 text-[10px] text-gray-500 uppercase tracking-wide px-1 mb-1">
              <span>Account</span><span>No.</span><span>Amount</span><span>Date</span>
            </div>
            <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)] gap-2 rounded-lg bg-gray-700 px-2 py-1.5">
              <span className="text-xs font-medium text-white truncate">{record.customer_number}</span>
              <span className="text-xs text-orange-400 truncate">{record.last_unpaid_invoice_1 || "—"}</span>
              <span className="text-xs text-white truncate">{formatAmount(record.last_unpaid_invoice_1_amount)}</span>
              <span className="text-xs text-gray-300 truncate">{record.last_unpaid_invoice_date || "—"}</span>
            </div>
          </div>

          {/* Last Receipt */}
          <div className="rounded-xl border border-gray-700 bg-gray-800 p-3">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle className="h-4 w-4 text-emerald-400" />
              <h4 className="text-sm font-semibold text-gray-300">Last Receipt</h4>
            </div>
            <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)] gap-2 text-[10px] text-gray-500 uppercase tracking-wide px-1 mb-1">
              <span>Account</span><span>No.</span><span>Amount</span><span>Date</span>
            </div>
            <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)] gap-2 rounded-lg bg-gray-700 px-2 py-1.5">
              <span className="text-xs font-medium text-white truncate">{record.customer_number}</span>
              <span className="text-xs text-emerald-400 truncate">{record.last_receipt_number || "—"}</span>
              <span className="text-xs text-white truncate">{formatAmount(record.last_receipt_amount)}</span>
              <span className="text-xs text-gray-300 truncate">{record.last_receipt_date || "—"}</span>
            </div>
          </div>

          {/* Sync info footer */}
          <div className="rounded-xl border border-indigo-800/40 bg-indigo-950/30 p-3">
            <p className="text-xs text-indigo-300">
              Hub snapshot · Changes must be made at the site directly.
              {(record._siteLastSeen || record.synced_at) && (
                <span className="block mt-0.5 text-indigo-400/60">
                  Last synced: {new Date(record._siteLastSeen || record.synced_at).toLocaleString()}
                </span>
              )}
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── hub customer search ─────────────────────────────────────────────────────

function HubCustomerSearch({ sites }) {
  const [selectedSiteId, setSelectedSiteId] = useState("");
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [allRecords, setAllRecords] = useState([]);
  const [modalRecord, setModalRecord] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const inputRef = useRef(null);

  // Fetch hub records for selected site (or all)
  const loadRecords = useCallback(async (siteId) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: 5000 });
      if (siteId) params.set("site_id", siteId);
      const res = await fetch(`/api/hub/records?${params}`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setAllRecords(data.records || []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadRecords(selectedSiteId); }, [selectedSiteId, loadRecords]);

  useEffect(() => {
    if (!query.trim()) { setSuggestions([]); setShowSuggestions(false); return; }
    const matches = [];
    for (const r of allRecords) {
      const numMatch  = fuzzyMatch(String(r.customer_number || ""), query);
      const nameMatch = fuzzyMatch(String(r.customer_name  || ""), query);
      if (numMatch.matches || nameMatch.matches) {
        matches.push({ record: r, score: Math.max(numMatch.score, nameMatch.score) });
      }
    }
    matches.sort((a, b) => b.score - a.score);
    setSuggestions(matches.slice(0, 8));
    setSelectedIdx(-1);
    setShowSuggestions(matches.length > 0);
  }, [query, allRecords]);

  const openRecord = (r) => {
    const site = sites.find(s => s.site_id === r.site_id);
    setModalRecord({ ...r, _siteName: site?.site_name || site?.site_slug || r.site_id, _siteLastSeen: site?.last_seen || null });
    setModalOpen(true);
    setShowSuggestions(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, suggestions.length - 1)); }
    if (e.key === "ArrowUp")   { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, -1)); }
    if (e.key === "Enter")     { e.preventDefault(); if (selectedIdx >= 0) openRecord(suggestions[selectedIdx].record); }
    if (e.key === "Escape")    { setShowSuggestions(false); }
  };

  const flag = (r) => FLAG_COLORS[r.flag_color] || FLAG_COLORS.none;

  return (
    <div className="w-full max-w-2xl">
      {/* Search card */}
      <div className="rounded-2xl border border-border bg-card shadow-sm">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Search className="h-4 w-4 text-muted-foreground" />
            Customer Search
          </div>
          <div className="flex items-center gap-2">
            <select
              className="rounded-md border border-input bg-background px-2.5 py-1.5 text-xs h-8"
              value={selectedSiteId}
              onChange={e => setSelectedSiteId(e.target.value)}
            >
              <option value="">All sites</option>
              {sites.map(s => (
                <option key={s.site_id} value={s.site_id}>{s.site_name || s.site_slug}</option>
              ))}
            </select>
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>
        </div>
        <div className="p-3">
          <div className="relative">
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none">
              <Search className="h-4 w-4" />
            </div>
            <Input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              placeholder="Search by customer number or name…"
              className="pl-10 h-10 text-sm bg-background"
            />
            {showSuggestions && suggestions.length > 0 && (
              <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 rounded-xl border border-border bg-card shadow-2xl overflow-hidden">
                {suggestions.map(({ record: r }, idx) => {
                  const f = flag(r);
                  const site = sites.find(s => s.site_id === r.site_id);
                  return (
                    <button
                      key={`${r.site_id}-${r.record_id}`}
                      onClick={() => openRecord(r)}
                      className={cn(
                        "w-full border-b border-border px-4 py-2.5 text-left last:border-0 transition-colors flex items-center justify-between gap-3",
                        idx === selectedIdx ? "bg-primary/10 text-foreground" : "hover:bg-muted/60 text-foreground"
                      )}
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{r.customer_name || "—"}</div>
                        <div className="text-[11px] text-muted-foreground mt-0.5">
                          #{r.customer_number} · {site?.site_name || site?.site_slug || r.site_id}
                        </div>
                      </div>
                      <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-semibold shrink-0 border", f.bg, f.text, f.border)}>
                        <span className={cn("h-1.5 w-1.5 rounded-full",
                          r.flag_color === "red" && "bg-red-500",
                          r.flag_color === "orange" && "bg-orange-500",
                          r.flag_color === "green" && "bg-green-500",
                          (!r.flag_color || r.flag_color === "none") && "bg-muted-foreground"
                        )} />
                        {f.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      <HubCustomerModal record={modalRecord} open={modalOpen} onClose={() => { setModalOpen(false); setModalRecord(null); }} />
    </div>
  );
}


// ─── main page ───────────────────────────────────────────────────────────────

export default function HubDashboard() {
  const [kpis, setKpis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);

  // Flag drill-down
  const [flagModal, setFlagModal] = useState({ open: false, color: null, customers: [], siteName: "" });
  const [flagDetailRecord, setFlagDetailRecord] = useState(null);
  const [flagDetailOpen, setFlagDetailOpen] = useState(false);

  const handleFlagClick = useCallback(async (site, flagColor) => {
    try {
      const params = new URLSearchParams({ site_id: site.site_id, flag_color: flagColor, limit: 5000 });
      const res = await fetch(`/api/hub/records?${params}`, { credentials: "include" });
      if (!res.ok) return;
      const data = await res.json();
      setFlagModal({
        open: true,
        color: flagColor,
        customers: data.records || [],
        siteName: site.site_name || site.site_slug,
        siteId: site.site_id,
      });
    } catch {}
  }, []);

  const openFlagDetail = useCallback((customer) => {
    setFlagDetailRecord(customer);
    setFlagDetailOpen(true);
  }, []);

  const fetchAll = useCallback(async () => {
    try {
      const kpiRes = await fetch("/api/hub/kpis", { credentials: "include" });
      if (!kpiRes.ok) throw new Error("Hub API unavailable — is this the Head Office instance?");
      setKpis(await kpiRes.json());
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const triggerSync = async () => {
    setSyncing(true);
    try {
      await fetch("/api/hub/sync", { method: "POST", credentials: "include" });
      setTimeout(() => { fetchAll(); setSyncing(false); }, 3000);
    } catch { setSyncing(false); }
  };

  if (loading) return (
    <div className="flex h-screen items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-border border-t-foreground" />
    </div>
  );

  if (error) return (
    <div className="flex h-screen items-center justify-center p-8">
      <div className="max-w-md text-center">
        <AlertCircle className="mx-auto h-10 w-10 text-muted-foreground mb-3" />
        <p className="font-semibold text-foreground">Hub not available</p>
        <p className="text-sm text-muted-foreground mt-1">{error}</p>
      </div>
    </div>
  );

  const sites = kpis?.sites || [];

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground">Customer Management</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Aggregated view across all sites</p>
        </div>
        <Button onClick={triggerSync} disabled={syncing} variant="outline" className="gap-2">
          <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} />
          {syncing ? "Syncing…" : "Sync Now"}
        </Button>
      </div>

      {/* Customer search */}
      <HubCustomerSearch sites={sites} />

      {/* Per-site cards */}
      {sites.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Sites</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sites.map(s => <SiteCard key={s.site_id} site={s} onFlagClick={handleFlagClick} />)}
          </div>
        </div>
      )}

      {/* Flag drill-down modal */}
      <FlaggedCustomersModal
        flagColor={flagModal.color}
        customers={flagModal.customers}
        open={flagModal.open}
        siteName={flagModal.siteName}
        onClose={() => setFlagModal(m => ({ ...m, open: false }))}
        onCustomerClick={openFlagDetail}
      />
      <HubCustomerModal
        record={flagDetailRecord}
        open={flagDetailOpen}
        onClose={() => { setFlagDetailOpen(false); setFlagDetailRecord(null); }}
      />
    </div>
  );
}
