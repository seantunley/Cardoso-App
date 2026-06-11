// Creditor Search — "Search the ledger" pattern for AP, styled to match
// Customer Search: hero, stat tiles, a labelled lookup card, a last-sync
// card, and a capture-status strip. Picking a vendor opens the FULL detail
// in a popup (VendorDetailModal: true-position header + receipts / open
// invoices / payments / POs tabs — no flagging system, vendors don't carry
// flags). Closing the popup returns to the clean search page; ?code= deep
// links still open it directly (Creditor Balances uses the same modal in
// place).
import { useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "../hooks/useDebouncedValue.js";
import { Building2, Search, RefreshCw, Wallet, FileText, Database } from "lucide-react";
import { useSearchParamState } from "../hooks/useSearchParamState.js";
import VendorDetailModal from "@/components/creditors/VendorDetailModal";

function fmtR(v) {
  const n = Number(v) || 0;
  return n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function searchVendors(q) {
  if (!q || q.trim().length < 2) return { results: [] };
  const r = await fetch(`/api/creditors/search?q=${encodeURIComponent(q)}`, { credentials: "include" });
  if (!r.ok) throw new Error(`Search failed (HTTP ${r.status})`);
  return r.json();
}

// Same defaults as Creditor Balances (active vendors, zero balances hidden)
// so the tiles here agree with that page's totals.
async function fetchCreditorStats() {
  const r = await fetch(`/api/creditors?active_only=true`, { credentials: "include" });
  if (!r.ok) return null;
  return r.json();
}

async function fetchSyncMeta() {
  const r = await fetch(`/api/creditors/sync-meta`, { credentials: "include" });
  if (!r.ok) return null;
  return r.json();
}

// Stat tile — mirrors Customer Search's flag tiles (mono label, big figure,
// coloured bottom edge), with money facts instead of flags.
function StatTile({ label, value, sub, edge, icon: Icon }) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between">
        <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">{label}</p>
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
      </div>
      <div className="mt-2 text-3xl font-semibold tabular-nums text-foreground">{value}</div>
      {sub && <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{sub}</p>}
      <span className="absolute inset-x-0 bottom-0 h-[3px]" style={{ background: edge }} aria-hidden="true" />
    </div>
  );
}

function VendorTypeahead({ onPick }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);
  // Drive the query off a debounced copy so a fast typist fires one request per
  // pause, not per keystroke (the input stays bound to `q` for responsiveness).
  const debouncedQ = useDebouncedValue(q, 250);
  const { data, isFetching } = useQuery({
    queryKey: ["creditor-search", debouncedQ],
    queryFn: () => searchVendors(debouncedQ),
    enabled: debouncedQ.trim().length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
  const results = data?.results || [];

  return (
    <div className="relative">
      <Search className="absolute left-3.5 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Vendor code or supplier name…"
        className="h-11 w-full border border-border bg-background pl-10 pr-4 text-sm font-mono text-foreground placeholder:text-muted-subtle focus:border-[var(--phosphor)] focus:outline-none focus:ring-2 focus:ring-[var(--phosphor)]/30"
        style={{ borderRadius: "12px" }}
      />
      {open && q.trim().length >= 2 && (
        <div
          className="absolute left-0 right-0 top-full z-50 mt-1.5 max-h-[400px] overflow-y-auto bg-background"
          style={{
            borderRadius: "12px",
            border: "1px solid hsl(var(--border))",
            boxShadow: "0 12px 32px rgba(0,0,0,0.55), 0 0 0 1px hsla(33,95%,55%,0.12), 0 0 24px hsla(33,95%,55%,0.08)",
          }}
        >
          {isFetching && <div className="px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Searching…</div>}
          {!isFetching && results.length === 0 && <div className="px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">No vendors found</div>}
          {results.map((r) => (
            <button
              key={r.vendor_code}
              type="button"
              onMouseDown={() => { onPick(r.vendor_code); setQ(""); setOpen(false); inputRef.current?.blur(); }}
              className="flex w-full items-center justify-between gap-3 border-b border-border/60 px-4 py-3 text-left transition-colors last:border-0 hover:bg-muted/40"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold leading-tight text-foreground">{r.vendor_name || <span className="italic text-muted-foreground">(no name)</span>}</div>
                <div className="mt-1 font-mono text-[11px] tracking-wider text-muted-foreground">{r.vendor_code}</div>
              </div>
              <span className={`font-mono text-[10px] uppercase tracking-wider ${r.is_active ? "text-emerald-400" : "text-muted-foreground"}`}>
                {r.is_active ? "Active" : "Inactive"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CreditorSearch() {
  // URL-backed so links are shareable and Back works; setting a code opens
  // the vendor popup, closing it clears the code and stays on this page.
  const [code, setCode] = useSearchParamState("code", "");

  const { data: stats } = useQuery({
    queryKey: ["creditor-search-stats"],
    queryFn: fetchCreditorStats,
    staleTime: 60_000,
  });
  const { data: meta } = useQuery({
    queryKey: ["creditors-sync-meta"],
    queryFn: fetchSyncMeta,
    staleTime: 60_000,
  });

  const records = stats?.records || [];
  const vendorCount = records.length;
  const trueOutstanding = records.reduce((sum, r) => sum + (Number(r.outstanding_amount) || 0), 0);
  const unpostedInv = records.reduce((sum, r) => sum + (Number(r.unposted_invoices) || 0), 0);
  const unpostedPay = records.reduce((sum, r) => sum + (Number(r.unposted_payments) || 0), 0);

  // Payment-capture status for the bottom strip — green when current, red
  // when behind (same 7-day line as the Balances warning).
  const lastCapture = (meta?.last_cb_payment_capture || "") > (meta?.last_ap_payment_date || "")
    ? meta?.last_cb_payment_capture
    : (meta?.last_ap_payment_date || meta?.last_cb_payment_capture);
  const captureDays = lastCapture ? Math.floor((Date.now() - new Date(lastCapture).getTime()) / 86_400_000) : null;
  const captureStale = Number.isFinite(captureDays) && captureDays > 7;

  const lastSync = meta?.last_synced_at || null;
  const lastSyncTime = lastSync ? String(lastSync).slice(11, 16) : "—";
  const lastSyncDate = lastSync ? String(lastSync).slice(0, 10) : null;

  return (
    <div className="min-h-screen bg-background px-2 py-4 text-foreground sm:px-3">
      <div className="space-y-6">
        <div className="border-b border-border pb-5">
          <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
            Search the <em className="text-phosphor">creditors</em>.
          </h1>
          <p className="text-sm text-muted-foreground mt-3">
            Review vendor accounts, balances, payments, and purchase activity.
          </p>
        </div>

        {/* Stat tiles — the AP money picture instead of flag counts */}
        <div className="grid gap-4 sm:grid-cols-3">
          <StatTile
            label="Vendors"
            value={vendorCount.toLocaleString()}
            sub="With outstanding balance"
            edge="hsl(33 95% 55%)"
            icon={Building2}
          />
          <StatTile
            label="True outstanding"
            value={`R ${fmtR(trueOutstanding)}`}
            sub="Posted + unposted invoices − unposted payments"
            edge="hsl(0 72% 50%)"
            icon={Wallet}
          />
          <StatTile
            label="Unposted batches"
            value={`R ${fmtR(unpostedInv - unpostedPay)}`}
            sub={`+R ${fmtR(unpostedInv)} invoices · −R ${fmtR(unpostedPay)} payments`}
            edge="hsl(280 70% 65%)"
            icon={FileText}
          />
        </div>

        {/* Lookup card + last-sync card */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-stretch">
          <div className="min-w-0 flex-1 border border-border bg-card p-5" style={{ borderRadius: "14px", boxShadow: "0 1px 2px rgba(0,0,0,0.25)" }}>
            <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">Vendor Lookup</p>
            <VendorTypeahead onPick={setCode} />
            <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-subtle">
              Full detail opens in a popup — receipts, open invoices, payments, purchase orders
            </p>
          </div>
          <div className="relative shrink-0 overflow-hidden border border-border bg-card p-5 sm:w-64" style={{ borderRadius: "14px" }}>
            <p className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              <RefreshCw className="h-3 w-3" aria-hidden="true" /> Last sync
            </p>
            <p className="mt-2 font-mono text-xs text-muted-foreground">{lastSyncDate || "Never"}</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">{lastSyncTime}</p>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Creditors · Sage</p>
            <span className="absolute inset-x-0 bottom-0 h-[3px]" style={{ background: "hsl(33 95% 55%)" }} aria-hidden="true" />
          </div>
        </div>

        {/* Capture-status strip — the AP twin of Customer Search's CONNECTED
            strip: states how current payment capture is, because no figure on
            this page can include payments nobody has typed into Sage yet. */}
        <div
          className={`flex items-center gap-3 rounded-xl border bg-card px-4 py-3 ${captureStale ? "border-red-500/40" : "border-border"}`}
          style={{ borderLeftWidth: "3px", borderLeftColor: captureStale ? "hsl(0 72% 50%)" : "hsl(145 55% 45%)" }}
        >
          <Database className={`h-4 w-4 ${captureStale ? "text-red-400" : "text-emerald-400"}`} aria-hidden="true" />
          <div className="font-mono text-[11px] uppercase tracking-[0.18em]">
            <span className={captureStale ? "text-red-300" : "text-emerald-300"}>
              {captureStale ? "Capture behind" : "Capture current"}
            </span>
            <span className="ml-3 text-xs normal-case tracking-normal text-muted-foreground">
              {lastCapture
                ? `Vendor payments captured up to ${lastCapture} (${captureDays} day${captureDays === 1 ? "" : "s"} ago)${captureStale ? " — payments made since are not in Sage yet" : ""}`
                : "No payment capture data yet — run a creditors sync"}
            </span>
          </div>
        </div>

        <VendorDetailModal code={code} onClose={() => setCode("")} />
      </div>
    </div>
  );
}
