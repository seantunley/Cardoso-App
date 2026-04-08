import { useState, useEffect, useCallback, useRef } from "react";
import { useColorScheme } from "@/lib/useColorScheme";
import {
  RefreshCw, AlertCircle, ShieldCheck, Clock, Search,
  Building2, Wifi, WifiOff, Loader2, Flag, CheckCircle, Calendar, Network,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { analyseInvoiceCredit } from "@/lib/creditAnalysis";
import { DEFAULT_CREDIT_LOGIC_CONFIG } from "@/lib/creditLogic";
import { cn } from "@/lib/utils";
import FlaggedCustomersModal from "../components/customer/FlaggedCustomersModal";
import { toast } from "sonner";

// ─── helpers ────────────────────────────────────────────────────────────────

const FLAG_COLORS = {
  red:    { bg: "bg-red-500/15",    text: "text-red-400",    border: "border-red-500/30",    label: "Red"    },
  orange: { bg: "bg-orange-500/15", text: "text-orange-400", border: "border-orange-500/30", label: "Orange" },
  green:  { bg: "bg-green-500/15",  text: "text-green-400",  border: "border-green-500/30",  label: "Green"  },
  none:   { bg: "bg-muted",         text: "text-muted-foreground", border: "border-border",   label: "No Flag"},
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

const KPI_RANGE_OPTIONS = [
  { value: "all", label: "All time", days: null },
  { value: "7", label: "Last 7 days", days: 7 },
  { value: "30", label: "Last 30 days", days: 30 },
  { value: "90", label: "Last 90 days", days: 90 },
];

function getSinceDate(rangeValue) {
  const option = KPI_RANGE_OPTIONS.find((entry) => entry.value === rangeValue);
  if (!option?.days) return null;
  const date = new Date();
  date.setDate(date.getDate() - option.days);
  return date.toISOString().slice(0, 10);
}

// ─── site card ──────────────────────────────────────────────────────────────

function SiteCard({ site, onFlagClick, onResync }) {
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
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); onResync(site); }}
            aria-label="Force resync this site"
            className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors min-h-[36px]"
            title={`Resync ${site.site_name || site.site_slug}`}
          >
            <RefreshCw className="h-3 w-3" />
            Resync
          </button>
          <div className={cn("flex items-center gap-1.5 text-xs font-medium", isOnline ? "text-green-500" : "text-muted-foreground")}>
            {isOnline ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
            {isOnline ? "Online" : "Offline"}
          </div>
        </div>
      </div>

      {site.kpis ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">

          {/* Total */}
          <div className="group relative overflow-hidden rounded-xl border border-border bg-muted p-3">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest mb-1">Total</p>
            <p className="text-xl font-extrabold text-foreground leading-none">{total ?? "—"}</p>
            <p className="text-[11px] text-muted-foreground/60 mt-1">Records</p>
            <div className="mt-2 h-0.5 rounded-full bg-border">
              <div className="h-full rounded-full bg-muted-foreground/40 w-full" />
            </div>
          </div>
          {/* Red */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div onClick={() => onFlagClick(site, "red")} className="group relative overflow-hidden rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 cursor-pointer">
                <div className="absolute inset-0 bg-rose-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                <p className="text-[11px] font-semibold text-rose-400/70 uppercase tracking-widest mb-1">Critical</p>
                <p className="text-xl font-extrabold text-foreground leading-none">{flags.red ?? 0}</p>
                <p className="text-[11px] text-rose-300/60 mt-1">Red Flagged</p>
                <div className="mt-2 h-0.5 rounded-full bg-rose-500/20">
                  <div className="h-full rounded-full bg-rose-500/60" style={{ width: (total ?? 0) > 0 ? ((flags.red ?? 0) / total * 100).toFixed(0) + "%" : "0%" }} />
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent>Click to view Red flagged customers at this site</TooltipContent>
          </Tooltip>
          {/* Orange */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div onClick={() => onFlagClick(site, "orange")} className="group relative overflow-hidden rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 cursor-pointer">
                <div className="absolute inset-0 bg-amber-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                <p className="text-[11px] font-semibold text-amber-400/70 uppercase tracking-widest mb-1">Attention</p>
                <p className="text-xl font-extrabold text-foreground leading-none">{flags.orange ?? 0}</p>
                <p className="text-[11px] text-amber-300/60 mt-1">Orange Flagged</p>
                <div className="mt-2 h-0.5 rounded-full bg-amber-500/20">
                  <div className="h-full rounded-full bg-amber-500/60" style={{ width: (total ?? 0) > 0 ? ((flags.orange ?? 0) / total * 100).toFixed(0) + "%" : "0%" }} />
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent>Click to view Orange flagged customers at this site</TooltipContent>
          </Tooltip>
          {/* Green */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div onClick={() => onFlagClick(site, "green")} className="group relative overflow-hidden rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 cursor-pointer">
                <div className="absolute inset-0 bg-emerald-500/5 opacity-0 group-hover:opacity-100 transition-opacity" />
                <p className="text-[11px] font-semibold text-emerald-400/70 uppercase tracking-widest mb-1">Approved</p>
                <p className="text-xl font-extrabold text-foreground leading-none">{flags.green ?? 0}</p>
                <p className="text-[11px] text-emerald-300/60 mt-1">Green Flagged</p>
                <div className="mt-2 h-0.5 rounded-full bg-emerald-500/20">
                  <div className="h-full rounded-full bg-emerald-500/60" style={{ width: (total ?? 0) > 0 ? ((flags.green ?? 0) / total * 100).toFixed(0) + "%" : "0%" }} />
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent>Click to view Green flagged customers at this site</TooltipContent>
          </Tooltip>
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

// ─── customer modal (read-only from hub) ────────────────────────────────────────────


const verdictBannerHub = {
  approve: "bg-emerald-500/20 border-emerald-500/40 text-emerald-200",
  caution: "bg-amber-500/20 border-amber-500/40 text-amber-200",
  hold:    "bg-red-500/20 border-red-500/40 text-red-200",
  dormant: "bg-purple-500/20 border-purple-500/40 text-purple-200",
};
const verdictScoreHub = {
  approve: "bg-emerald-800/60 text-emerald-200 ring-1 ring-emerald-600/40",
  caution: "bg-amber-800/60 text-amber-200 ring-1 ring-amber-600/40",
  hold:    "bg-red-800/60 text-red-200 ring-1 ring-red-600/40",
  dormant: "bg-purple-800/60 text-purple-200 ring-1 ring-purple-600/40",
};

function HubCustomerModal({ record, open, onClose }) {
  const [creditLogicConfig, setCreditLogicConfig] = useState(DEFAULT_CREDIT_LOGIC_CONFIG);
  const [subAccounts, setSubAccounts] = useState([]);

  useEffect(() => {
    let cancelled = false;

    async function loadCreditLogicConfig() {
      try {
        const response = await fetch("/api/credit-logic/current", { credentials: "include" });
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && data?.analysis?.config) {
          setCreditLogicConfig(data.analysis.config);
        }
      } catch {
        // Keep the default config if the hub cannot fetch the live config.
      }
    }

    async function loadSubAccounts() {
      try {
        const siteId = record?.site_id;
        const q = String(record?.customer_number || '').trim();
        if (!q || !siteId) return;
        const res = await fetch(`/api/hub/customer-lookup?query=${encodeURIComponent(q)}&site_id=${encodeURIComponent(siteId)}`, { credentials: 'include' });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setSubAccounts(data.subAccounts || []);
      } catch {
        // Non-fatal
      }
    }

    if (open && record) {
      // Run both in parallel — they are independent
      await Promise.all([loadCreditLogicConfig(), loadSubAccounts()]);
    } else {
      setSubAccounts([]);
    }
    return () => { cancelled = true; };
  }, [open, record]);

  const allAccountRecords = record ? [record, ...subAccounts] : [];
  const hasSubAccounts = subAccounts.length > 0;
  const grandTotal = allAccountRecords.reduce((s, r) => s + parseAmount(r?.outstanding_balance), 0);
  const allAccounts = record
    ? [
        { label: `${record.customer_number} (main)`, record, isMain: true },
        ...subAccounts.map(r => ({ label: r.customer_number, record: r, isMain: false }))
      ]
    : [];

  const credit = record ? analyseInvoiceCredit(allAccountRecords, [], creditLogicConfig) : null;
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);
  if (!record) return null;
  const flag = FLAG_COLORS[record.flag_color] || FLAG_COLORS.none;
  const balance = parseAmount(record.outstanding_balance);

  const invoiceSlots = [1,2,3].map(i => ({
    num:  record[`last_unpaid_invoice_${i}`],
    amt:  record[`last_unpaid_invoice_${i}_amount`],
    date: record[`last_unpaid_invoice_${i}_date`],
  })).filter(s => s.num || s.amt);

  const receiptSlots = [1,2,3].map(i => ({
    num:  record[`last_receipt_${i}`],
    amt:  record[`last_receipt_${i}_amount`],
    date: record[`last_receipt_${i}_date`],
  })).filter(s => s.num || s.amt);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        className={cn(
          "max-w-[780px] w-full border-4 bg-background p-0 flex flex-col max-h-[85dvh]",
          record.flag_color === "red"    && "border-red-500",
          record.flag_color === "green"  && "border-green-500",
          record.flag_color === "orange" && "border-orange-500",
          (!record.flag_color || record.flag_color === "none") && "border-border"
        )}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{record.customer_name || "Customer"}</DialogTitle>
        </DialogHeader>

        {/* Verdict banner */}
        {credit && (
          <div className={cn("w-full px-5 py-3 border-b shrink-0", verdictBannerHub[credit.verdict])}>
            <div className="flex items-start gap-2 sm:gap-3 flex-wrap sm:flex-nowrap">
              {credit.verdict === "approve" ? (
                <ShieldCheck className="h-6 w-6 shrink-0 opacity-90 mt-0.5" strokeWidth={1.75} />
              ) : credit.verdict === "dormant" ? (
                <Clock className="h-6 w-6 shrink-0 opacity-90 mt-0.5" strokeWidth={1.75} />
              ) : (
                <AlertCircle className="h-6 w-6 shrink-0 opacity-90 mt-0.5" strokeWidth={1.75} />
              )}
              <div className="flex-1 min-w-0">
                <span className="text-base font-extrabold tracking-tight leading-tight">{credit.title}</span>
                {credit.summary && (
                  <p className="text-xs font-semibold mt-0.5 opacity-90">{credit.summary}</p>
                )}
              </div>
              <div className="flex flex-col sm:flex-row items-end sm:items-center gap-2 sm:gap-3 shrink-0 sm:pr-8">
                {credit.avgLag !== null && (
                  <span className={cn("hidden sm:inline-flex text-sm font-bold px-3 py-1 rounded-full", verdictScoreHub[credit.verdict])}>
                    &#9201; {credit.avgLag}d avg
                  </span>
                )}
                <span className={cn("text-xs font-semibold px-2.5 py-1 rounded-full", verdictScoreHub[credit.verdict])}>
                  {credit.score}/100
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Pinned header */}
        <div className="px-5 py-3 border-b border-border bg-background shrink-0">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-xl font-bold text-foreground">{record.customer_name || "—"}</span>
                <span className={cn("text-3xl font-extrabold", (hasSubAccounts ? grandTotal : balance) > 0 ? "text-rose-400" : "text-foreground")}>
                  {hasSubAccounts ? formatAmount(String(grandTotal)) : formatAmount(record.outstanding_balance)}
                </span>
                {hasSubAccounts && (
                  <Badge variant="outline" className="text-xs border-indigo-600 text-indigo-400">
                    {subAccounts.length} sub-account{subAccounts.length !== 1 ? 's' : ''}
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                #{record.customer_number} · {record._siteName}
              </div>
              {hasSubAccounts && (
                <div className="mt-2 space-y-0.5">
                  {allAccounts.map(({ label, record: r, isMain }) => (
                    <div key={label} className="flex justify-between text-xs">
                      <span className={isMain ? "text-foreground font-medium" : "text-muted-foreground"}>{label}</span>
                      <span className={parseAmount(r?.outstanding_balance) !== 0 ? "text-foreground" : "text-muted-foreground"}>
                        {formatAmount(r?.outstanding_balance)}
                      </span>
                    </div>
                  ))}
                  <div className="flex justify-between text-xs font-bold pt-1 border-t border-border/40">
                    <span className="text-foreground">Total</span>
                    <span className={grandTotal !== 0 ? "text-rose-400" : "text-muted-foreground"}>{formatAmount(String(grandTotal))}</span>
                  </div>
                </div>
              )}
            </div>
            <Badge className={cn("border text-xs shrink-0", flag.bg, flag.text, flag.border)}>
              <Flag className="mr-1 h-3 w-3" />{flag.label}
            </Badge>
          </div>
          {record.flag_reason && (
            <div className="mt-2 rounded-lg bg-muted px-3 py-1.5 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Flag reason: </span>{record.flag_reason}
            </div>
          )}
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 px-5 py-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Invoices */}
            <div className="bg-card border border-border rounded-xl p-3">
              <p className="text-xs font-semibold text-orange-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <Flag className="h-3.5 w-3.5" /> Invoices
              </p>
              {invoiceSlots.length > 0 ? (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wide pb-1.5">No.</th>
                      <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wide pb-1.5">Amount</th>
                      <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wide pb-1.5">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoiceSlots.map((s, i) => (
                      <tr key={i} className="border-b border-border/40 last:border-0">
                        <td className="text-sm py-1.5 text-orange-400 font-mono truncate max-w-[80px]">{s.num || "—"}</td>
                        <td className="text-sm py-1.5 text-right text-foreground">{formatAmount(s.amt)}</td>
                        <td className="text-sm py-1.5 text-right text-muted-foreground">{s.date || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-xs text-muted-foreground italic">No invoice data</p>
              )}
            </div>

            {/* Receipts */}
            <div className="bg-card border border-border rounded-xl p-3">
              <p className="text-xs font-semibold text-emerald-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <CheckCircle className="h-3.5 w-3.5" /> Receipts
              </p>
              {receiptSlots.length > 0 ? (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wide pb-1.5">No.</th>
                      <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wide pb-1.5">Amount</th>
                      <th className="text-right text-xs font-medium text-muted-foreground uppercase tracking-wide pb-1.5">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {receiptSlots.map((s, i) => (
                      <tr key={i} className="border-b border-border/40 last:border-0">
                        <td className="text-sm py-1.5 text-emerald-400 font-mono truncate max-w-[80px]">{s.num || "—"}</td>
                        <td className="text-sm py-1.5 text-right text-foreground">{formatAmount(s.amt)}</td>
                        <td className="text-sm py-1.5 text-right text-muted-foreground">{s.date || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-xs text-muted-foreground italic">No receipt data</p>
              )}
            </div>
          </div>

          {/* Hub note - keep indigo colour */}
          <div className="mt-4 rounded-xl border border-indigo-800/40 bg-indigo-950/20 px-3 py-2">
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
  const colorScheme = useColorScheme();
  const [selectedSiteId, setSelectedSiteId] = useState("");
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [modalRecord, setModalRecord] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const inputRef = useRef(null);

  // Server-side search: query the API when the user types, filtered by site
  const searchRecords = useCallback(async (searchQuery, siteId) => {
    if (!searchQuery.trim()) { setSuggestions([]); setShowSuggestions(false); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams({ search: searchQuery.trim(), limit: 20 });
      if (siteId) params.set("site_id", siteId);
      const res = await fetch(`/api/hub/records?${params}`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setSuggestions((data.records || []).map(r => ({ record: r, score: 1 })));
        setSelectedIdx(-1);
        setShowSuggestions((data.records || []).length > 0);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeout = setTimeout(() => searchRecords(query, selectedSiteId), 200);
    return () => clearTimeout(timeout);
  }, [query, selectedSiteId, searchRecords]);

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
              className="rounded-md border border-input bg-background px-2.5 py-1.5 text-sm h-10"
              style={{ colorScheme }}
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
  const colorScheme = useColorScheme();
  const [kpis, setKpis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [dateRange, setDateRange] = useState("all");

  // Flag drill-down
  const [flagModal, setFlagModal] = useState({ open: false, color: null, siteName: "", siteId: null });
  const [flagDetailRecord, setFlagDetailRecord] = useState(null);
  const [flagDetailOpen, setFlagDetailOpen] = useState(false);

  const handleFlagClick = useCallback((site, flagColor) => {
    setFlagModal({
      open: true,
      color: flagColor,
      siteName: site.site_name || site.site_slug,
      siteId: site.site_id,
    });
  }, []);

  const openFlagDetail = useCallback((customer) => {
    setFlagDetailRecord(customer);
    setFlagDetailOpen(true);
  }, []);

  const fetchAll = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      const since = getSinceDate(dateRange);
      if (since) params.set("since", since);
      const url = params.toString() ? `/api/hub/kpis?${params.toString()}` : "/api/hub/kpis";
      const kpiRes = await fetch(url, { credentials: "include" });
      if (!kpiRes.ok) throw new Error("Hub API unavailable — is this the Head Office instance?");
      setKpis(await kpiRes.json());
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [dateRange]);

  useEffect(() => { fetchAll(); }, [dateRange]);

  const triggerSync = async () => {
    setSyncing(true);
    try {
      await fetch("/api/hub/sync", { method: "POST", credentials: "include" });
      setTimeout(() => { fetchAll(); setSyncing(false); }, 3000);
    } catch { setSyncing(false); }
  };

  const resyncSite = async (site) => {
    const name = site.site_name || site.site_slug;
    toast(`Resyncing ${name}...`);
    try {
      const res = await fetch(`/api/hub/force-resync/${site.site_id}`, { method: "POST", credentials: "include" });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || "Resync failed"); }
      toast.success("Resync complete");
      setTimeout(() => fetchAll(), 5000);
    } catch (err) {
      toast.error(err.message || "Resync failed");
    }
  };

  const forceResync = async () => {
    if (!window.confirm('This will clear all synced data and do a full re-pull from all sites. Continue?')) return;
    setSyncing(true);
    try {
      await fetch("/api/hub/force-resync", { method: "POST", credentials: "include" });
      setTimeout(() => { fetchAll(); setSyncing(false); }, 5000);
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
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Customer Management</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Aggregated view across all sites</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={triggerSync} disabled={syncing} variant="outline" className="gap-2">
            <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} />
            {syncing ? "Syncing…" : "Sync Now"}
          </Button>
          <Button onClick={forceResync} disabled={syncing} variant="ghost" className="gap-2 text-muted-foreground text-xs" title="Clear all synced data and re-pull from all sites">
            Force Resync
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Calendar className="h-4 w-4" />
          KPI range
        </div>
        <select
          value={dateRange}
          onChange={(event) => setDateRange(event.target.value)}
          style={{ colorScheme }}
          className="min-h-[40px] rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          {KPI_RANGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>

      {/* Customer search */}
      <HubCustomerSearch sites={sites} />

      {/* Per-site cards */}
      {sites.length > 0 ? (
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Sites</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {sites.map(s => <SiteCard key={s.site_id} site={s} onFlagClick={handleFlagClick} onResync={resyncSite} />)}
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-20 rounded-xl border border-border bg-card">
          <Network className="w-12 h-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium text-foreground">No sites configured yet</h3>
          <p className="text-sm text-muted-foreground mt-1">Add site connections to start aggregating data.</p>
        </div>
      )}

      {/* Flag drill-down modal */}
      <FlaggedCustomersModal
        flagColor={flagModal.color}
        open={flagModal.open}
        siteName={flagModal.siteName}
        siteId={flagModal.siteId}
        mode="hub"
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
