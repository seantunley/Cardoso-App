import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

const LIMIT = 30;

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

  const { data: rows = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: ["top-balances", limit],
    queryFn: () => fetchTopBalances(limit),
    staleTime: 60_000,
  });

  const grandTotal = rows.reduce((s, r) => s + parseAmount(r.outstanding_balance), 0);

  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <div className="max-w-4xl mx-auto">
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

        {/* Summary card */}
        {rows.length > 0 && (
          <div className="mb-4 rounded-xl border border-border bg-card px-4 py-3 flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Total outstanding ({rows.length} customers)</span>
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
        {!isLoading && !isError && rows.length === 0 && (
          <div className="rounded-xl border border-border bg-card p-12 text-center text-sm text-muted-foreground">
            No outstanding balances found.
          </div>
        )}

        {/* Table */}
        {!isLoading && !isError && rows.length > 0 && (
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground w-10">#</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground">Customer Name</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground">Customer ID</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground">Site</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-muted-foreground">Outstanding Balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => {
                  const amount = parseAmount(row.outstanding_balance);
                  const isTop = idx === 0;
                  return (
                    <tr
                      key={`${row.customer_number}-${row.site_name}-${idx}`}
                      className={`border-b border-border last:border-0 transition-colors hover:bg-muted/30 ${isTop ? "bg-amber-500/5" : ""}`}
                    >
                      <td className="px-4 py-3 text-xs text-muted-foreground">{idx + 1}</td>
                      <td className="px-4 py-3">
                        <span className={`font-medium ${isTop ? "text-amber-400" : "text-foreground"}`}>
                          {row.customer_name || "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground font-mono">
                        {row.customer_number || "—"}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {row.site_name || "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
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
