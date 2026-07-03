// Creditor Search — the AP twin of Customer Search ("Search the ledger").
// SAME page skeleton as CustomerSearch.jsx (max-w-5xl centred container,
// border-b hero, 3-up stat tiles, lookup + last-sync row, a status strip),
// with money facts in place of flag counts and no flagging. Picking a vendor
// opens the full detail in a popup (VendorDetailModal: true-position header +
// receipts / open invoices / payments / POs tabs). ?code= deep links open it
// directly; Creditor Balances opens the same modal in place.
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

// Same record set as Creditor Balances' default (active vendors), so this
// page's True Outstanding tile and the Balances headline are one number.
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

function VendorTypeahead({ onPick }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);
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

// Stat tile — IDENTICAL markup to the flag tiles on Customer Search
// (px-5 py-4, 14px radius, 2px coloured bottom bar, mono label + sub, icon
// top-right), money facts instead of flag counts. The figure size is a prop:
// the flag tiles show single digits at 4xl, but a rand value like
// "R 95 541 341,12" overflows the tile at that size, so money tiles render
// smaller (2xl) — same tile, sized to its content.
function StatTile({ label, value, sub, hue, glow, icon: Icon, big = false }) {
  return (
    <div
      className="relative bg-card px-5 py-4 border border-border overflow-hidden"
      style={{ borderRadius: "14px", boxShadow: "0 1px 2px rgba(0,0,0,0.25)" }}
    >
      <div className="absolute left-0 right-0 bottom-0 h-[2px]" style={{ background: hue, boxShadow: `0 0 12px ${glow}` }} />
      <div className="flex items-start justify-between gap-2">
        {/* flex-1 gives this column a definite width from the row (not its
            content) BEFORE it becomes an inline-size query container — without
            it, a `flex: 0 1 auto` + containerType item loses its intrinsic
            width and collapses, so cqi resolves to ~0 and the value sticks at
            the clamp minimum. */}
        <div className="min-w-0 flex-1" style={{ containerType: 'inline-size' }}>
          <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-2">{label}</div>
          <div className={`font-display leading-none text-foreground tabular-nums whitespace-nowrap ${big ? "text-[clamp(1.1rem,11cqi,2.25rem)]" : "text-[clamp(1rem,9cqi,1.5rem)]"}`}>{value}</div>
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mt-2 truncate">{sub}</div>
        </div>
        <Icon className="w-4 h-4 shrink-0 opacity-60" style={{ color: hue }} strokeWidth={1.5} />
      </div>
    </div>
  );
}

export default function CreditorSearch() {
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

  const lastCapture = (meta?.last_cb_payment_capture || "") > (meta?.last_ap_payment_date || "")
    ? meta?.last_cb_payment_capture
    : (meta?.last_ap_payment_date || meta?.last_cb_payment_capture);
  const captureDays = lastCapture ? Math.floor((Date.now() - new Date(lastCapture).getTime()) / 86_400_000) : null;
  const captureStale = Number.isFinite(captureDays) && captureDays > 7;

  const lastSync = meta?.last_synced_at || null;
  const lastSyncMs = lastSync ? new Date(lastSync + (String(lastSync).endsWith("Z") ? "" : "Z")) : null;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-8 py-10 space-y-6">
        {/* Header — same border-b hero as Customer Search */}
        <div className="border-b border-border pb-5">
          <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
            Search the <em className="text-phosphor">creditors</em>.
          </h1>
          <p className="text-sm text-muted-foreground mt-3">
            Review vendor accounts, balances, payments, and purchase activity.
          </p>
        </div>

        {/* Stat tiles — same 3-up grid as the flag tiles */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 stagger-in">
          <StatTile
            label="Vendors"
            value={vendorCount.toLocaleString()}
            sub="With outstanding balance"
            hue="hsl(33 95% 55%)"
            glow="hsla(33,95%,55%,0.35)"
            icon={Building2}
            big
          />
          <StatTile
            label="True Outstanding"
            value={`R ${fmtR(trueOutstanding)}`}
            sub="All active vendors · incl. unposted"
            hue="hsl(var(--status-critical))"
            glow="hsl(var(--status-critical) / 0.3)"
            icon={Wallet}
          />
          <StatTile
            label="Unposted Batches"
            value={`R ${fmtR(unpostedInv - unpostedPay)}`}
            sub={`+R ${fmtR(unpostedInv)} inv · −R ${fmtR(unpostedPay)} pay`}
            hue="hsl(280 70% 65%)"
            glow="hsla(280,70%,65%,0.3)"
            icon={FileText}
          />
        </div>

        {/* Lookup + last-sync row — same flex layout, sizes, radii */}
        <div className="flex flex-col sm:flex-row gap-4 items-stretch">
          <div className="flex-1 bg-card border border-border min-w-0 px-5 py-4" style={{ borderRadius: "14px", boxShadow: "0 1px 2px rgba(0,0,0,0.25)" }}>
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-3">Vendor Lookup</p>
            <VendorTypeahead onPick={setCode} />
            <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-muted-subtle">
              Full detail opens in a popup
            </p>
          </div>

          <div
            className="w-full sm:flex-shrink-0 sm:w-56 bg-card border border-border relative px-5 py-4 flex flex-col justify-center overflow-hidden"
            style={{ borderRadius: "14px", boxShadow: "0 1px 2px rgba(0,0,0,0.25)" }}
          >
            <div className="absolute left-0 right-0 bottom-0 h-[2px]" style={{ background: "var(--phosphor)", boxShadow: "0 0 12px hsla(33,95%,55%,0.35)" }} />
            <div className="flex items-center gap-2 mb-2">
              <RefreshCw className="w-3 h-3 text-accent" />
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Last Sync</p>
            </div>
            <div>
              {lastSyncMs ? (
                <>
                  <p className="font-mono text-xs text-muted-foreground">
                    {lastSyncMs.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", day: "2-digit", month: "short", year: "numeric" })}
                  </p>
                  <p className="font-display text-3xl leading-none text-foreground tabular-nums mt-1">
                    {lastSyncMs.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg", hour: "2-digit", minute: "2-digit", hour12: false })}
                  </p>
                  <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mt-2 truncate">Creditors · Sage</p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Never synced</p>
              )}
            </div>
          </div>
        </div>

        {/* Capture-status strip — same shape as the CONNECTED banner (left bar). */}
        <div className="border border-border bg-card relative overflow-hidden px-5 py-3" style={{ borderRadius: "12px" }}>
          <div
            className="absolute left-0 top-0 bottom-0 w-[2px]"
            style={{
              background: captureStale ? "hsl(var(--status-critical))" : "hsl(var(--status-ok))",
              boxShadow: captureStale ? "0 0 12px hsl(var(--status-critical) / 0.3)" : "0 0 12px hsl(var(--status-ok) / 0.3)",
            }}
          />
          <div className="flex items-start gap-3 pl-2">
            <Database className="w-4 h-4 mt-0.5 shrink-0" style={{ color: captureStale ? "hsl(var(--status-critical))" : "hsl(var(--status-ok))" }} strokeWidth={1.5} />
            <div className="flex-1">
              <h3 className="font-mono text-[10px] uppercase tracking-[0.2em] mb-1" style={{ color: captureStale ? "hsl(var(--status-critical))" : "hsl(var(--status-ok))" }}>
                {captureStale ? "Capture Behind" : "Capture Current"}
              </h3>
              <p className="text-xs text-muted-foreground">
                {lastCapture
                  ? `Vendor payments captured up to ${lastCapture} (${captureDays} day${captureDays === 1 ? "" : "s"} ago)${captureStale ? " — payments made since are not in Sage yet" : ""}`
                  : "No payment capture data yet — run a creditors sync"}
              </p>
            </div>
          </div>
        </div>

        <VendorDetailModal code={code} onClose={() => setCode("")} />
      </div>
    </div>
  );
}
