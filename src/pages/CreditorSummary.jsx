// Creditor Summary — vendor list with YTD spend.
// Mirrors the structure of CustomerBalances but for creditors: one row
// per vendor, sortable, with YTD paid + YTD PO amount + last activity.
//
// "Sync now" button kicks off the Sage pull on demand; otherwise the
// nightly 04:30 cron keeps the data fresh.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";

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
  { key: "vendor_code",        label: "Code",          width: "110px",  align: "left",  format: (v) => v },
  { key: "vendor_name",        label: "Vendor",        width: "auto",   align: "left",  format: (v) => v || "—" },
  { key: "terms",              label: "Terms",         width: "100px",  align: "left",  format: (v) => v || "—" },
  { key: "last_receipt_date",  label: "Last receipt",  width: "120px",  align: "left",  format: fmtDate },
  { key: "last_payment_date",  label: "Last payment",  width: "120px",  align: "left",  format: fmtDate },
  { key: "ytd_receipt_count",  label: "YTD receipts",  width: "110px",  align: "right", format: (v) => Number(v || 0).toLocaleString() },
  { key: "ytd_po_count",       label: "YTD POs",       width: "90px",   align: "right", format: (v) => Number(v || 0).toLocaleString() },
  { key: "ytd_po_amount",      label: "YTD PO value",  width: "150px",  align: "right", format: (v) => `R ${fmtR(v)}` },
  { key: "ytd_paid",           label: "YTD paid",      width: "150px",  align: "right", format: (v) => `R ${fmtR(v)}` },
  { key: "outstanding_amount", label: "Outstanding",   width: "150px",  align: "right", format: (v) => `R ${fmtR(v)}` },
];

export default function CreditorSummary() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [activeOnly, setActiveOnly] = useState(true);
  const [includeZero, setIncludeZero] = useState(false);
  const [sortKey, setSortKey] = useState("outstanding_amount");
  const [sortDir, setSortDir] = useState("desc");
  const [syncing, setSyncing] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["creditors", search, activeOnly, includeZero],
    queryFn: () => fetchCreditors({ search, activeOnly, includeZero }),
    keepPreviousData: true,
    staleTime: 30_000,
  });

  const { data: meta } = useQuery({
    queryKey: ["creditors-sync-meta"],
    queryFn: fetchSyncMeta,
    staleTime: 60_000,
  });

  const rows = useMemo(() => {
    const src = data?.records || [];
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
  }, [data, sortKey, sortDir]);

  const totals = useMemo(() => {
    const acc = { ytd_paid: 0, ytd_po_amount: 0, outstanding_amount: 0, count: 0 };
    for (const r of rows) {
      acc.ytd_paid += Number(r.ytd_paid) || 0;
      acc.ytd_po_amount += Number(r.ytd_po_amount) || 0;
      acc.outstanding_amount += Number(r.outstanding_amount) || 0;
      acc.count++;
    }
    return acc;
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

  return (
    <div className="min-h-screen bg-background px-4 py-6 text-foreground sm:px-6">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div className="border-b border-border pb-5 flex items-end justify-between gap-6">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">§ Creditors</div>
            <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
              Who you <em className="text-phosphor">owe</em>.
            </h1>
            <p className="text-sm text-muted-foreground mt-3">
              Vendor activity for {new Date().getFullYear()} — receipts, POs, and payments year-to-date.
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
              title="Pull latest vendor, invoice, payment, and PO data from Sage"
            >
              <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
              {syncing ? "Syncing…" : "Sync from Sage"}
            </button>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground" title="Last successful sync">
              {meta?.last_synced_at ? `Last sync: ${meta.last_synced_at}` : "Never synced"}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[280px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search vendor code or name…"
              className="w-full rounded-xl border border-border bg-card pl-9 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          <label className="inline-flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
              className="rounded border-border"
            />
            Active vendors only
          </label>
          <label
            className="inline-flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none"
            title="By default we hide vendors you currently owe nothing — tick to show everyone"
          >
            <input
              type="checkbox"
              checked={includeZero}
              onChange={(e) => setIncludeZero(e.target.checked)}
              className="rounded border-border"
            />
            Include zero balances
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <SummaryTile label="Vendors" value={totals.count.toLocaleString()} />
          <SummaryTile label="YTD PO value" value={`R ${fmtR(totals.ytd_po_amount)}`} />
          <SummaryTile label="YTD paid" value={`R ${fmtR(totals.ytd_paid)}`} />
          <SummaryTile label="Outstanding" value={`R ${fmtR(totals.outstanding_amount)}`} />
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
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="overflow-auto max-h-[70vh]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card z-10">
                  <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                    {COLUMNS.map((c) => (
                      <th
                        key={c.key}
                        style={{ width: c.width, minWidth: c.width === "auto" ? "200px" : c.width }}
                        className={`px-3 py-2 cursor-pointer hover:text-foreground ${c.align === "right" ? "text-right" : "text-left"}`}
                        onClick={() => toggleSort(c.key)}
                        title={`Sort by ${c.label}`}
                      >
                        {c.label}{sortKey === c.key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.vendor_code} className="border-b border-border last:border-0 hover:bg-muted/30">
                      {COLUMNS.map((c) => (
                        <td
                          key={c.key}
                          className={`px-3 py-1.5 tabular-nums ${c.align === "right" ? "text-right" : "text-left"} ${c.key === "vendor_code" ? "font-mono text-xs" : ""}`}
                        >
                          {c.format(r[c.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryTile({ label, value }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
