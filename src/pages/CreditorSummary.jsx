// Creditor Summary — vendor list with YTD spend.
// Mirrors the structure of CustomerBalances but for creditors: one row
// per vendor, sortable, with YTD paid + YTD PO amount + last activity.
//
// "Sync now" button kicks off the Sage pull on demand; otherwise the
// nightly 04:30 cron keeps the data fresh.
import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import CollapsibleFilterBar from "@/components/shared/CollapsibleFilterBar";
import AgingSummaryTiles from "@/components/shared/AgingSummaryTiles";
import DataTable from "@/components/shared/DataTable";
import LastSyncedBadge from "@/components/shared/LastSyncedBadge";
import VendorDetailModal from "@/components/creditors/VendorDetailModal";
import CreditorPrintableTable from "@/components/creditors/CreditorPrintableTable";
import { CREDITOR_PRINT_STYLE } from "@/components/creditors/creditorPrintStyle";

// A/P monthly periods for the aging tiles (matches the Aged Creditors report).
const AP_TILES = [
  { key: "1-30", label: "1–30 days", color: "hsl(80 60% 45%)" },
  { key: "31-60", label: "31–60 days", color: "hsl(50 90% 55%)" },
  { key: "61-90", label: "61–90 days", color: "hsl(33 95% 55%)" },
  { key: "over-90", label: "Over 90 days", color: "hsl(0 72% 50%)" },
];

const BALANCE_BUCKETS = [
  { value: "all",      label: "All" },
  { value: "lt1k",     label: "< R1k",     test: (n) => n > 0 && n < 1_000 },
  { value: "1k_10k",   label: "R1k–10k",   test: (n) => n >= 1_000 && n < 10_000 },
  { value: "10k_50k",  label: "R10k–50k",  test: (n) => n >= 10_000 && n < 50_000 },
  { value: "50k_250k", label: "R50k–250k", test: (n) => n >= 50_000 && n < 250_000 },
  { value: "gt250k",   label: "> R250k",   test: (n) => n >= 250_000 },
];

const AGE_BUCKETS = [
  { value: "all",   label: "All" },
  { value: "30",    label: "30+ days" },
  { value: "60",    label: "60+ days" },
  { value: "90",    label: "90+ days" },
  { value: "180",   label: "180+ days" },
  { value: "365",   label: "1+ year" },
  { value: "never", label: "Never" },
];

function ageInDays(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (!Number.isFinite(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

function ageMatches(bucket, dateStr) {
  if (bucket === "all") return true;
  const days = ageInDays(dateStr);
  if (bucket === "never") return days === null;
  if (days === null) return false;
  return days >= Number(bucket);
}

function FilterPill({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
        active
          ? "bg-amber-500/20 border-amber-500/40 text-amber-300"
          : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
      }`}
    >
      {children}
    </button>
  );
}

// Column-width persistence, resize handles, sticky header, and row windowing
// all live in the shared DataTable now. Same storage key as the old in-page
// implementation so operators keep their saved column widths.
const COL_WIDTHS_KEY = "creditorSummary.columnWidths.v1";
const COL_DEFAULTS = {
  vendor_code: 110, vendor_name: 360, terms: 100,
  last_receipt_date: 120, last_payment_date: 120,
  ytd_receipt_count: 110, outstanding_amount: 150,
};

function fmtR(v) {
  const n = Number(v) || 0;
  return n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(s) {
  if (!s) return "—";
  return s;
}

async function fetchCreditors({ search, activeOnly, includeZero }) {
  const qs = new URLSearchParams();
  if (search) qs.set("search", search);
  if (activeOnly) qs.set("active_only", "true");
  if (includeZero) qs.set("include_zero_balance", "true");
  const r = await fetch(`/api/creditors?${qs.toString()}`, { credentials: "include" });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || `Failed to load creditors (HTTP ${r.status})`);
  }
  return r.json();
}

async function fetchSyncMeta() {
  const r = await fetch(`/api/creditors/sync-meta`, { credentials: "include" });
  if (!r.ok) return null;
  return r.json();
}

async function triggerSync() {
  const r = await fetch(`/api/creditors/sync`, { method: "POST", credentials: "include" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `Sync failed (HTTP ${r.status})`);
  return d;
}

const COLUMNS = [
  { key: "vendor_code",        label: "Code",          align: "left",  mono: true, format: (v) => v },
  { key: "vendor_name",        label: "Vendor",        align: "left",  format: (v) => v || "—" },
  { key: "terms",              label: "Terms",         align: "left",  format: (v) => v || "—" },
  { key: "last_receipt_date",  label: "Last receipt",  align: "left",  format: fmtDate },
  { key: "last_payment_date",  label: "Last payment",  align: "left",  format: fmtDate },
  { key: "ytd_receipt_count",  label: "YTD receipts",  align: "right", format: (v) => Number(v || 0).toLocaleString() },
  // Outstanding is the vendor's TRUE position: Sage's posted open items
  // (APOBL) PLUS invoices sitting in unposted AP batches (Sage understates)
  // MINUS payments captured but not yet posted (Sage overstates). Affected
  // vendors get an amber dot; hover shows the exact breakdown.
  { key: "outstanding_amount", label: "Outstanding",   align: "right", format: (v, r) => {
    const inv = Number(r?.unposted_invoices) || 0;
    const pay = Number(r?.unposted_payments) || 0;
    if (!inv && !pay) return `R ${fmtR(v)}`;
    const parts = [`Posted (Sage APOBL): R ${fmtR(r.outstanding_gross)}`];
    if (inv) parts.push(`+ R ${fmtR(inv)} invoices in unposted AP batches`);
    if (pay) parts.push(`− R ${fmtR(pay)} payments captured but not yet posted`);
    return (
      <span title={parts.join("\n")}>
        R {fmtR(v)} <span className="text-accent" aria-hidden="true">●</span>
      </span>
    );
  } },
];

export default function CreditorSummary() {
  const qc = useQueryClient();
  // Row drill → the full vendor popup, opened IN PLACE on this page
  // (mirrors the customer popup on Customer Balances).
  const [drillVendor, setDrillVendor] = useState("");
  // Vendor search removed from this page — the dedicated Creditor Search page
  // owns lookup now (operator request); this page is the balances overview.
  const [activeOnly, setActiveOnly] = useState(true);
  const [includeZero, setIncludeZero] = useState(false);
  const [balanceBucket, setBalanceBucket] = useState("all");
  const [lastReceiptAge, setLastReceiptAge] = useState("all");
  const [lastPaymentAge, setLastPaymentAge] = useState("all");
  const [paidOnly, setPaidOnly] = useState(true); // default ON: only creditors with a last-payment date
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sortKey, setSortKey] = useState("outstanding_amount");
  const [sortDir, setSortDir] = useState("desc");
  const [syncing, setSyncing] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["creditors", activeOnly, includeZero],
    queryFn: () => fetchCreditors({ search: "", activeOnly, includeZero }),
    // react-query v5 removed keepPreviousData; placeholderData: keepPreviousData
    // keeps the vendor table + AP tiles showing the prior data while the next
    // query loads instead of flashing to empty / R 0.00 on each change (UI-4).
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const { data: meta } = useQuery({
    queryKey: ["creditors-sync-meta"],
    queryFn: fetchSyncMeta,
    staleTime: 60_000,
  });

  // Inject the creditor print stylesheet once (same pattern as Customer
  // Balances) so the Print / PDF button produces the same letterhead sheet.
  useEffect(() => {
    const id = "creditor-print-style";
    if (!document.getElementById(id)) {
      const el = document.createElement("style");
      el.id = id;
      el.textContent = CREDITOR_PRINT_STYLE;
      document.head.appendChild(el);
    }
  }, []);

  const printDate = new Date().toLocaleString("en-ZA", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });

  const rows = useMemo(() => {
    let src = data?.records || [];
    // Client-side filters layered on top of the server's search/active/zero.
    if (balanceBucket !== "all") {
      const bucket = BALANCE_BUCKETS.find((b) => b.value === balanceBucket);
      if (bucket?.test) src = src.filter((r) => bucket.test(Number(r.outstanding_amount) || 0));
    }
    if (lastReceiptAge !== "all") src = src.filter((r) => ageMatches(lastReceiptAge, r.last_receipt_date));
    if (lastPaymentAge !== "all") src = src.filter((r) => ageMatches(lastPaymentAge, r.last_payment_date));
    // "Historically paid" — only creditors that have a last-payment date.
    if (paidOnly) src = src.filter((r) => r.last_payment_date && String(r.last_payment_date).trim() !== "");
    const sorted = [...src].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const an = typeof av === "number" ? av : Number(av);
      const bn = typeof bv === "number" ? bv : Number(bv);
      if (Number.isFinite(an) && Number.isFinite(bn) && (typeof av !== "string" && typeof bv !== "string")) {
        return sortDir === "asc" ? an - bn : bn - an;
      }
      const as = String(av ?? "");
      const bs = String(bv ?? "");
      return sortDir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
    });
    return sorted;
  }, [data, sortKey, sortDir, balanceBucket, lastReceiptAge, lastPaymentAge, paidOnly]);

  // Aging tiles computed over the CURRENT filtered rows (each row carries its
  // monthly buckets from the server), so the tiles follow the filters.
  const apAging = useMemo(() => {
    const keys = ["current", "1-30", "31-60", "61-90", "over-90"];
    const buckets = Object.fromEntries(keys.map((k) => [k, 0]));
    const bucket_counts = Object.fromEntries(keys.map((k) => [k, 0]));
    let total = 0;
    // Unposted adjustments at TOTAL level only (operator decision): the
    // buckets keep Sage's true POSTED aging distribution — vendor-level
    // adjustments can't honestly claim a bucket — but the headline shows the
    // true net figure alongside: + invoices in unposted batches (Sage
    // understates), − payments captured but unposted (Sage overstates).
    // Summed over the same filtered rows as the tiles.
    let unpostedPay = 0;
    let unpostedInv = 0;
    // Everything here is summed over the SAME filtered rows as the tiles, so
    // the headline always reconciles with what's on screen:
    //   visible Total Outstanding (posted buckets) + unposted invoices
    //   − unposted payments = the headline.
    // (Operator decision: the headline matches the tiles. Creditor Search's
    // True Outstanding tile is its own, whole-company figure — a different
    // scope by design, since this page keeps the paid-history filter.)
    for (const r of rows) {
      unpostedPay += Number(r.unposted_payments) || 0;
      unpostedInv += Number(r.unposted_invoices) || 0;
      const b = r.aging_buckets;
      if (!b) continue;
      for (const k of keys) {
        const v = Number(b[k]) || 0;
        buckets[k] += v;
        if (v !== 0) bucket_counts[k] += 1;
        total += v;
      }
    }
    return {
      buckets, bucket_counts, total_outstanding: total,
      unposted_payments_total: unpostedPay,
      unposted_invoices_total: unpostedInv,
      net_total: total + unpostedInv - unpostedPay,
    };
  }, [rows]);

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await triggerSync();
      toast.success("Creditors synced from Sage");
      qc.invalidateQueries({ queryKey: ["creditors"] });
      qc.invalidateQueries({ queryKey: ["creditors-sync-meta"] });
      const errors = Object.entries(result?.summary?.sources || {})
        .filter(([, v]) => v?.error)
        .map(([k, v]) => `${k}: ${v.error}`);
      if (errors.length) toast.warning(`Some sources failed: ${errors.join("; ")}`);
    } catch (err) {
      toast.error(err.message || "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const printTitle = "Creditor Balances";

  return (
    <div className="min-h-screen bg-background px-2 py-4 text-foreground sm:px-3">
      {/* Print-only block (hidden on screen) — same letterhead/rules as the
          Customer Balances print, vendor columns. Prints all filtered rows. */}
      <CreditorPrintableTable
        printTitle={printTitle}
        printDate={printDate}
        rows={rows}
        aging={apAging}
        site="all"
        showSite={false}
      />
      <div className="space-y-6">
        <div className="border-b border-border pb-5 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>

            <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
              Who you <em className="text-phosphor">owe</em>.
            </h1>
            <p className="text-sm text-muted-foreground mt-3">
              Vendors with outstanding balances, sortable and filterable.
            </p>
          </div>
          {/* Print / PDF — styled identically to the Customer Balances button. */}
          <div className="flex items-center gap-2 cb-no-print">
            <button
              onClick={() => window.print()}
              disabled={rows.length === 0}
              className="flex items-center gap-2 border px-4 py-2 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-h-[40px]"
              style={{ borderRadius: "12px", borderColor: "var(--phosphor)", color: "var(--phosphor)", background: "hsla(33, 95%, 55%, 0.08)" }}
              onMouseEnter={(e) => { if (e.currentTarget.disabled) return; e.currentTarget.style.background = "hsla(33, 95%, 55%, 0.18)"; e.currentTarget.style.boxShadow = "0 0 12px hsla(33,95%,55%,0.35)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "hsla(33, 95%, 55%, 0.08)"; e.currentTarget.style.boxShadow = "none"; }}
              title="Print or save as PDF"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 6 2 18 2 18 9" />
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                <rect x="6" y="14" width="12" height="8" />
              </svg>
              Print / PDF
            </button>
          </div>
        </div>

        <CollapsibleFilterBar
          open={filtersOpen}
          onOpenChange={setFiltersOpen}
          chips={[
            balanceBucket !== "all" && {
              key: "bal", label: BALANCE_BUCKETS.find((b) => b.value === balanceBucket)?.label,
              onClear: () => setBalanceBucket("all"),
            },
            lastReceiptAge !== "all" && {
              key: "rcp", label: `Last receipt ${AGE_BUCKETS.find((a) => a.value === lastReceiptAge)?.label}`,
              onClear: () => setLastReceiptAge("all"),
            },
            lastPaymentAge !== "all" && {
              key: "pay", label: `Last payment ${AGE_BUCKETS.find((a) => a.value === lastPaymentAge)?.label}`,
              onClear: () => setLastPaymentAge("all"),
            },
            !activeOnly && { key: "act", label: "Inactive included", onClear: () => setActiveOnly(true) },
            includeZero && { key: "zero", label: "Zero balances included", onClear: () => setIncludeZero(false) },
            paidOnly && { key: "paid", label: "Has payment history", onClear: () => setPaidOnly(false) },
          ].filter(Boolean)}
          onClearAll={() => {
            setBalanceBucket("all");
            setLastReceiptAge("all");
            setLastPaymentAge("all");
            setActiveOnly(true);
            setIncludeZero(false);
            setPaidOnly(false);
          }}
        >
          <div className="space-y-1.5">
            <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Outstanding balance</div>
            <div className="flex flex-wrap gap-2">
              {BALANCE_BUCKETS.map((b) => (
                <FilterPill key={b.value} active={balanceBucket === b.value} onClick={() => setBalanceBucket(b.value)}>
                  {b.label}
                </FilterPill>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Last receipt</div>
            <div className="flex flex-wrap gap-2">
              {AGE_BUCKETS.map((a) => (
                <FilterPill key={a.value} active={lastReceiptAge === a.value} onClick={() => setLastReceiptAge(a.value)}>
                  {a.label}
                </FilterPill>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Last payment</div>
            <div className="flex flex-wrap gap-2">
              {AGE_BUCKETS.map((a) => (
                <FilterPill key={a.value} active={lastPaymentAge === a.value} onClick={() => setLastPaymentAge(a.value)}>
                  {a.label}
                </FilterPill>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <FilterPill active={paidOnly} onClick={() => setPaidOnly((v) => !v)}>Has payment history</FilterPill>
            <FilterPill active={activeOnly} onClick={() => setActiveOnly((v) => !v)}>Active vendors only</FilterPill>
            <FilterPill active={includeZero} onClick={() => setIncludeZero((v) => !v)}>Include zero balances</FilterPill>
          </div>
        </CollapsibleFilterBar>

        {/* A/P aging overview — full open-item picture from the same engine as
            Aged Creditors (due date + monthly periods). Already shows Total
            Outstanding, so no separate outstanding tile below. */}
        {rows.length > 0 && <AgingSummaryTiles aging={apAging} tiles={AP_TILES} showCount={false} />}
        {/* Net-of-unposted line — only while a posting backlog exists. The
            tiles above keep Sage's true POSTED aging distribution; this line
            gives the honest net headline (operator decision: adjust the
            total, buckets stay pure). Follows the same filters as the tiles. */}
        {rows.length > 0 && (apAging.unposted_invoices_total !== 0 || apAging.unposted_payments_total > 0) && (
          <div className="-mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />
            <span className="text-muted-foreground">
              {/* Spelled out as arithmetic so it visibly adds up against the
                  Total Outstanding tile above. */}
              Total Outstanding <span className="tabular-nums text-foreground">R {fmtR(apAging.total_outstanding)}</span>
              {apAging.unposted_invoices_total !== 0 && (
                <> + <span className="tabular-nums text-foreground">R {fmtR(apAging.unposted_invoices_total)}</span> unposted invoices</>
              )}
              {apAging.unposted_payments_total > 0 && (
                <> − <span className="tabular-nums text-foreground">R {fmtR(apAging.unposted_payments_total)}</span> unposted payments</>
              )}
              {" ="}
            </span>
            <span className="font-medium tabular-nums text-foreground">
              true outstanding R {fmtR(apAging.net_total)}
            </span>
            <span
              className="cursor-help text-muted-subtle"
              title="The aging tiles above show Sage's POSTED aged figures only. Invoices and payments captured in batches that accounts hasn't posted yet can't be assigned to a specific aging bucket, so they adjust the total here instead. All three figures cover the same vendors currently shown in the table below. This line disappears once the batches post."
            >
              ⓘ
            </span>
          </div>
        )}
        {/* Payment-capture recency — how far behind accounts is on CAPTURING
            vendor payments. Payments that exist only at the bank are invisible
            to every Sage table (and therefore to every figure above); this
            states the cutoff plainly so nobody mistakes "true outstanding"
            for "includes last week's EFTs". Site mode only. */}
        {rows.length > 0 && !meta?.hub && meta?.last_cb_payment_capture && (() => {
          const lastCapture = meta.last_cb_payment_capture > (meta.last_ap_payment_date || "")
            ? meta.last_cb_payment_capture : (meta.last_ap_payment_date || meta.last_cb_payment_capture);
          const days = Math.floor((Date.now() - new Date(lastCapture).getTime()) / 86_400_000);
          if (!Number.isFinite(days) || days < 0) return null;
          const stale = days > 7;
          return (
            <div className="-mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span className={`h-1.5 w-1.5 rounded-full ${stale ? "bg-red-500" : "bg-muted-foreground"}`} aria-hidden="true" />
              <span className={stale ? "text-red-300" : "text-muted-foreground"}>
                Vendor payments captured in the Cashbook up to{" "}
                <span className="font-medium tabular-nums">{lastCapture}</span>
                {" "}({days} {days === 1 ? "day" : "days"} ago) — anything paid since is not in Sage yet and cannot reflect in these figures.
              </span>
            </div>
          );
        })()}

        {/* Sync from Sage + last-synced — moved here (just above the table,
            below the aging tiles) so the page leads with the numbers, not the
            controls (operator request). */}
        <div className="flex flex-wrap items-center justify-end gap-3 cb-no-print">
          <LastSyncedBadge
            iso={meta?.last_synced_at}
            detail="Scheduled nightly at 04:30 (Operations page lists every job)"
          />
          <button
            onClick={handleSync}
            disabled={syncing}
            className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
            title="Pull latest vendor, invoice, payment, and PO data from Sage"
          >
            <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Syncing…" : "Sync from Sage"}
          </button>
        </div>

        {isLoading && <div className="h-[400px] animate-pulse rounded-xl border border-border bg-card" />}
        {!isLoading && error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-sm text-red-300">
            {error.message}
          </div>
        )}
        {!isLoading && !error && rows.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card px-6 py-16 text-center">
            <Building2 className="mb-4 h-12 w-12 text-muted-foreground" />
            <h2 className="text-lg font-semibold text-foreground">No creditor data yet</h2>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              {meta?.last_synced_at
                ? "No vendors match the current filters. Try clearing the search or unchecking Active vendors only."
                : "Click \"Sync from Sage\" above to pull vendor master, AP transactions, and POs."}
            </p>
          </div>
        )}
        {!isLoading && !error && rows.length > 0 && (
          <DataTable
            columns={COLUMNS}
            rows={rows}
            rowKey={(r) => r.vendor_code}
            sortKey={sortKey}
            sortDir={sortDir}
            onSortChange={toggleSort}
            storageKey={COL_WIDTHS_KEY}
            defaultWidths={COL_DEFAULTS}
            maxHeight="70vh"
            rowTitle={(r) => `Open ${r.vendor_name || r.vendor_code} — full vendor popup`}
            // Drill into the vendor detail page (Creditor Search reads ?code=).
            // Site mode only — the vendor drilldown tabs read site-local
            // creditor_* tables the hub does not carry.
            onRowClick={data?.hub ? undefined : (r) => setDrillVendor(String(r.vendor_code))}
          />
        )}
        {/* Row drill target — full vendor popup, in place (close → stay here). */}
        <VendorDetailModal code={drillVendor} onClose={() => setDrillVendor("")} />
      </div>
    </div>
  );
}
