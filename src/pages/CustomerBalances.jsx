import { useState, useMemo, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";

const LIMIT = 200;

function parseAmount(val) {
  if (val === null || val === undefined || val === "") return 0;
  const cleaned = String(val).replace(/,/g, "").replace(/\s/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

function formatAmount(val) {
  const num = parseAmount(val);
  return num.toLocaleString("en-ZA", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const FLAG_DOT = {
  red:    "bg-red-500",
  orange: "bg-orange-400",
  yellow: "bg-yellow-400",
  green:  "bg-green-500",
  blue:   "bg-blue-500",
  purple: "bg-purple-500",
  pink:   "bg-pink-400",
  gray:   "bg-gray-400",
};

function FlagDot({ color, reason }) {
  if (!color || color === "none") return null;
  const cls = FLAG_DOT[color] || "bg-gray-400";
  return (
    <span
      title={reason || color}
      className={`inline-block h-2.5 w-2.5 rounded-full flex-shrink-0 ${cls}`}
    />
  );
}

function FilterToggle({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? "border-amber-500 bg-amber-500/15 text-amber-400"
          : "border-border bg-card text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

async function fetchTopBalances(limit) {
  const res = await fetch(`/api/top-balances?limit=${limit}`, {
    credentials: "include",
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || "Failed to load balances");
  }
  return res.json();
}

export default function CustomerBalances() {
  const [limit] = useState(LIMIT);
  const [siteFilter, setSiteFilter] = useState("all");
  const [hubMode, setHubMode] = useState(false);
  // Toggle: hide customers where invoice ≈ balance (within R0.10)
  const [hideInvoiceMatchesBalance, setHideInvoiceMatchesBalance] = useState(false);

  useEffect(() => {
    fetch("/api/hub/sites", { credentials: "include" })
      .then((r) => r.json())
      .catch(() => null)
      .then((d) => { if (d?.hub_mode) setHubMode(true); });
  }, []);

  const { data: rows = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: ["top-balances", limit],
    queryFn: () => fetchTopBalances(limit),
    staleTime: 60_000,
  });

  // Derive unique site names from data
  const sites = useMemo(() => {
    const names = [...new Set(rows.map((r) => r.site_name).filter(Boolean))].sort();
    return names;
  }, [rows]);

  // Apply filters
  const filtered = useMemo(() => {
    let result = rows;
    if (siteFilter !== "all") result = result.filter((r) => r.site_name === siteFilter);
    if (hideInvoiceMatchesBalance) {
      result = result.filter((r) => {
        const balance = parseAmount(r.outstanding_balance);
        const invoice = parseAmount(r.last_unpaid_invoice_1_amount);
        return Math.abs(balance - invoice) > 0.10;
      });
    }
    return result;
  }, [rows, siteFilter, hideInvoiceMatchesBalance]);

  const grandTotal = filtered.reduce((s, r) => s + parseAmount(r.outstanding_balance), 0);

  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Customer Balances</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Top {limit} customers by outstanding balance
            </p>
          </div>
          <button
            onClick={() => refetch()}
            className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 4v6h-6M1 20v-6h6"/>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
            Refresh
          </button>
        </div>

        {/* Filters row */}
        {!isLoading && !isError && (
          <div className="mb-4 flex flex-wrap items-center gap-3">
            {sites.length > 1 && (
              <>
                <label className="text-xs text-muted-foreground whitespace-nowrap">Site:</label>
                <select
                  value={siteFilter}
                  onChange={(e) => setSiteFilter(e.target.value)}
                  className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="all">All sites</option>
                  {sites.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                {siteFilter !== "all" && (
                  <button
                    onClick={() => setSiteFilter("all")}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Clear
                  </button>
                )}
                <div className="h-4 w-px bg-border mx-1" />
              </>
            )}
            <FilterToggle
              active={hideInvoiceMatchesBalance}
              onClick={() => setHideInvoiceMatchesBalance((v) => !v)}
            >
              {hideInvoiceMatchesBalance ? "⊘ " : ""}Last Invoice = Outstanding Balance
            </FilterToggle>
          </div>
        )}

        {/* Summary card */}
        {filtered.length > 0 && (
          <div className="mb-4 rounded-xl border border-border bg-card px-4 py-3 flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              Total outstanding ({filtered.length} customer{filtered.length !== 1 ? "s" : ""}
              {siteFilter !== "all" ? ` · ${siteFilter}` : ""})
            </span>
            <span className="text-lg font-bold text-foreground">R {formatAmount(grandTotal)}</span>
          </div>
        )}

        {/* State: loading */}
        {isLoading && (
          <div className="flex items-center justify-center py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-border border-t-foreground" />
          </div>
        )}

        {/* State: error */}
        {isError && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-center text-sm text-red-400">
            {error?.message || "Failed to load data"}
          </div>
        )}

        {/* State: empty */}
        {!isLoading && !isError && filtered.length === 0 && (
          <div className="rounded-xl border border-border bg-card p-12 text-center text-sm text-muted-foreground">
            {siteFilter !== "all" ? `No outstanding balances for "${siteFilter}".` : "No outstanding balances found."}
          </div>
        )}

        {/* Table */}
        {!isLoading && !isError && filtered.length > 0 && (
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="px-2 py-1.5 text-left text-xs font-semibold text-muted-foreground w-6">#</th>
                  <th className="px-2 py-1.5 text-left text-xs font-semibold text-muted-foreground">Customer Name</th>
                  <th className="px-2 py-1.5 text-left text-xs font-semibold text-muted-foreground">Customer ID</th>
                  <th className="px-2 py-1.5 text-left text-xs font-semibold text-muted-foreground">Site</th>
                  <th className="px-2 py-1.5 text-left text-xs font-semibold text-muted-foreground">Last Invoice</th>
                  <th className="px-2 py-1.5 text-left text-xs font-semibold text-muted-foreground">Last Receipt</th>
                  <th className="px-2 py-1.5 text-right text-xs font-semibold text-muted-foreground">Outstanding Balance</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row, idx) => {
                  const amount = parseAmount(row.outstanding_balance);
                  const isTop = idx === 0;
                  return (
                    <tr
                      key={`${row.customer_number}-${row.site_name}-${idx}`}
                      className={`border-b border-border last:border-0 transition-colors hover:bg-muted/30 ${isTop ? "bg-amber-500/5" : ""}`}
                    >
                      <td className="px-2 py-1 text-xs text-muted-foreground">{idx + 1}</td>
                      <td className="px-2 py-1">
                        <div className="flex items-center gap-1.5">
                          <FlagDot color={row.flag_color} reason={row.flag_reason} />
                          <span className={`font-medium ${isTop ? "text-amber-400" : "text-foreground"}`}>
                            {row.customer_name || "—"}
                          </span>
                        </div>
                      </td>
                      <td className="px-2 py-1 text-xs text-muted-foreground font-mono">
                        {row.customer_number || "—"}
                      </td>
                      <td className="px-2 py-1 text-xs text-muted-foreground">
                        {row.site_name || "—"}
                      </td>
                      <td className="px-2 py-1 text-xs">
                        <div className="font-mono text-foreground leading-tight">{row.last_unpaid_invoice_1 || "—"}</div>
                        {row.last_unpaid_invoice_1_amount && (
                          <div className="tabular-nums text-amber-400 leading-tight">R {formatAmount(row.last_unpaid_invoice_1_amount)}</div>
                        )}
                        {row.last_unpaid_invoice_date && (
                          <div className="text-muted-foreground/60 leading-tight">{row.last_unpaid_invoice_date}</div>
                        )}
                      </td>
                      <td className="px-2 py-1 text-xs">
                        <div className="font-mono text-foreground leading-tight">{row.last_receipt_number || "—"}</div>
                        {row.last_receipt_amount && (
                          <div className="tabular-nums text-amber-400 leading-tight">R {formatAmount(row.last_receipt_amount)}</div>
                        )}
                        {row.last_receipt_date && (
                          <div className="text-muted-foreground/60 leading-tight">{row.last_receipt_date}</div>
                        )}
                      </td>
                      <td className="px-2 py-1 text-right">
                        <span className={`font-semibold tabular-nums ${amount > 10000 ? "text-red-400" : amount > 0 ? "text-orange-400" : "text-muted-foreground"}`}>
                          R {formatAmount(amount)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
