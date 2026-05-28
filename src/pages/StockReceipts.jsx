import { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Package, RefreshCw, Search, Calendar, Plus, AlertTriangle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";

async function apiFetch(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiPost(url, body) {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function FilterPill({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? "border-amber-500 bg-amber-500/15 text-amber-400"
          : "border-border bg-card text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

export default function StockReceipts() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [missingOnly, setMissingOnly] = useState(true);
  const [siteFilter, setSiteFilter] = useState("all");
  const [selectedLineId, setSelectedLineId] = useState(null);
  const [newDate, setNewDate] = useState("");
  const [newQty, setNewQty] = useState("");
  const [newNotes, setNewNotes] = useState("");

  const sitesQuery = useQuery({
    queryKey: ["stock-receipt-sites"],
    queryFn: () => apiFetch("/api/stock-receipts/sites"),
    staleTime: 300_000,
  });
  const hubMode = sitesQuery.data?.hub === true;

  const syncMeta = useQuery({
    queryKey: ["stock-receipt-sync-meta"],
    queryFn: () => apiFetch("/api/stock-receipts/sync-meta"),
    staleTime: 60_000,
    enabled: !hubMode,
  });

  const receiptLines = useQuery({
    queryKey: ["stock-receipt-lines", search, missingOnly, siteFilter],
    queryFn: () => {
      const params = new URLSearchParams({ limit: "300" });
      if (search) params.set("search", search);
      if (missingOnly) params.set("missing_expiry", "true");
      if (hubMode && siteFilter !== "all") params.set("site_id", siteFilter);
      return apiFetch(`/api/stock-receipts?${params}`);
    },
    staleTime: 30_000,
  });

  const rows = receiptLines.data?.records || [];

  const lineDetail = useQuery({
    queryKey: ["stock-receipt-line-detail", selectedLineId],
    queryFn: () => apiFetch(`/api/stock-receipts/${selectedLineId}/expiry`),
    enabled: !!selectedLineId && !hubMode,
  });

  const syncMutation = useMutation({
    mutationFn: () => apiPost("/api/stock-receipts/sync", {}),
    onSuccess: (data) => {
      toast.success("Receipts synced from Sage", { description: `${data.linesUpserted} lines across ${data.receiptsUpserted} receipts` });
      queryClient.invalidateQueries({ queryKey: ["stock-receipt-lines"] });
      queryClient.invalidateQueries({ queryKey: ["stock-receipt-sync-meta"] });
    },
    onError: (err) => toast.error("Sync failed", { description: err.message }),
  });

  const addExpiryMutation = useMutation({
    mutationFn: () => apiPost(`/api/stock-receipts/${selectedLineId}/expiry`, {
      expiry_date: newDate,
      qty_at_expiry: newQty || null,
      notes: newNotes || null,
    }),
    onSuccess: () => {
      toast.success("Expiry entry added");
      setNewDate("");
      setNewQty("");
      setNewNotes("");
      queryClient.invalidateQueries({ queryKey: ["stock-receipt-line-detail", selectedLineId] });
      queryClient.invalidateQueries({ queryKey: ["stock-receipt-lines"] });
    },
    onError: (err) => toast.error("Failed to add expiry", { description: err.message }),
  });

  const selectedRow = useMemo(
    () => rows.find((r) => r.receipt_line_id === selectedLineId),
    [rows, selectedLineId],
  );

  // Clear selection when the selected row disappears from results
  // (e.g. after adding an expiry while "missing only" is active,
  // or after tightening search).
  useEffect(() => {
    if (selectedLineId && !selectedRow && !receiptLines.isLoading) {
      setSelectedLineId(null);
    }
  }, [selectedRow, selectedLineId, receiptLines.isLoading]);

  // Default the qty-at-expiry input to the line's received qty when a
  // new line is picked. Operators usually enter one expiry per line at
  // the full received quantity; splitting across multiple expiry dates
  // is the exception, not the rule.
  useEffect(() => {
    if (selectedLineId && selectedRow?.qty_received != null) {
      setNewQty(String(selectedRow.qty_received));
    }
  }, [selectedLineId, selectedRow?.qty_received]);

  return (
    <div className="min-h-screen bg-background text-foreground px-6 pt-4 pb-6">
      {/* Header */}
      <div className="border-b border-border pb-5 mb-5">
        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">
          § Stock Receipt Expiry
        </div>
        <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
          Track what <em className="text-phosphor">expires</em>.
        </h1>
        <p className="text-sm text-muted-foreground mt-3">
          Record expiry dates against receipt lines synced from Sage. Select a line on the left, add expiry entries on the right.
        </p>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 flex-wrap mb-6">
        {hubMode && (
          <select
            value={siteFilter}
            onChange={(e) => setSiteFilter(e.target.value)}
            className="h-9 rounded-full border border-border bg-card px-3 text-xs text-foreground"
          >
            <option value="all">All Sites</option>
            {(sitesQuery.data?.sites || []).map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )}

        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search receipt number, item…"
            className="w-full h-9 pl-8 pr-3 rounded-full border border-border bg-card text-xs text-foreground placeholder:text-muted-foreground"
          />
        </div>

        <FilterPill active={missingOnly} onClick={() => setMissingOnly((v) => !v)}>
          {missingOnly ? "Missing expiry only" : "All lines"}
        </FilterPill>

        {!hubMode && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncMutation.isPending ? "animate-spin" : ""}`} />
              Sync from Sage
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {syncMeta.data?.last_synced_at
              ? `Last synced: ${new Date(syncMeta.data.last_synced_at).toLocaleString("en-ZA")}`
              : "Never synced — click to pull receipts from Sage"}
          </TooltipContent>
        </Tooltip>
        )}
      </div>

      {/* Error state */}
      {receiptLines.isError && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400 flex items-start gap-2 mb-4">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          {receiptLines.error.message}
        </div>
      )}

      {/* Empty state */}
      {!receiptLines.isLoading && !receiptLines.isError && rows.length === 0 && (
        <div className="rounded-xl border border-border bg-card p-12 text-center text-sm text-muted-foreground">
          <Package className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
          {syncMeta.data?.last_synced_at
            ? "No receipt lines found for the current filters."
            : hubMode
              ? "No receipt expiry data synced from sites yet."
              : 'No receipt data yet. Click "Sync from Sage" to pull purchase order receipts.'}
        </div>
      )}

      {/* Hub mode: flat table with inline expiry data */}
      {hubMode && rows.length > 0 && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="text-xs text-muted-foreground px-3 py-2 border-b border-border">
            {rows.length} row{rows.length !== 1 ? "s" : ""}{siteFilter === "all" ? " across all sites" : ""}
          </div>
          <div className="max-h-[calc(100vh-320px)] overflow-y-auto overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-card border-b border-border">
                <tr>
                  {siteFilter === "all" && <th className="px-3 py-2 text-left font-medium text-muted-foreground uppercase">Site</th>}
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground uppercase">Receipt</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground uppercase">Date</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground uppercase">Item</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground uppercase">Description</th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground uppercase">Qty Rcvd</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground uppercase">Expiry Date</th>
                  <th className="px-3 py-2 text-right font-medium text-muted-foreground uppercase">Expiry Qty</th>
                  <th className="px-3 py-2 text-left font-medium text-muted-foreground uppercase">Entered By</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => (
                  <tr key={`${r.site_id}-${r.receipt_line_id}-${idx}`} className="border-b border-border last:border-0 hover:bg-muted/20">
                    {siteFilter === "all" && <td className="px-3 py-2 text-muted-foreground">{r.site_name || r.site_id || "—"}</td>}
                    <td className="px-3 py-2 font-mono whitespace-nowrap">{r.receipt_number}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{r.receipt_date || "—"}</td>
                    <td className="px-3 py-2 font-mono whitespace-nowrap">{r.item_number}</td>
                    <td className="px-3 py-2 max-w-[180px] truncate" title={r.item_description}>{r.item_description || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.qty_received || "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {r.expiry_date ? (
                        <span className="font-mono">{r.expiry_date}</span>
                      ) : (
                        <span className="text-red-400 text-[10px] font-semibold">None</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.qty_at_expiry || "—"}</td>
                    <td className="px-3 py-2 text-muted-foreground">{r.entered_by || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Site mode: split-panel (receipt list + detail) */}
      {!hubMode && rows.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-4">
          {/* Left: receipt lines list */}
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="text-xs text-muted-foreground px-3 py-2 border-b border-border">
              {rows.length} receipt line{rows.length !== 1 ? "s" : ""}
            </div>
            <div className="max-h-[calc(100vh-320px)] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 z-10 bg-card border-b border-border">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground uppercase">Receipt</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground uppercase">Date</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground uppercase">Item</th>
                    <th className="px-3 py-2 text-left font-medium text-muted-foreground uppercase">Description</th>
                    <th className="px-3 py-2 text-right font-medium text-muted-foreground uppercase">Qty</th>
                    <th className="px-3 py-2 text-center font-medium text-muted-foreground uppercase">Expiry</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const isSelected = selectedLineId === r.receipt_line_id;
                    const hasExpiry = r.expiry_count > 0;
                    return (
                      <tr
                        key={r.receipt_line_id}
                        onClick={() => setSelectedLineId(r.receipt_line_id)}
                        className={`border-b border-border last:border-0 cursor-pointer transition-colors ${
                          isSelected ? "bg-amber-500/10" : "hover:bg-muted/20"
                        }`}
                      >
                        <td className="px-3 py-2 font-mono whitespace-nowrap">{r.receipt_number}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{r.receipt_date || "—"}</td>
                        <td className="px-3 py-2 font-mono whitespace-nowrap">{r.item_number}</td>
                        <td className="px-3 py-2 max-w-[180px] truncate" title={r.item_description}>
                          {r.item_description || "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.qty_received || "—"}</td>
                        <td className="px-3 py-2 text-center">
                          {hasExpiry ? (
                            <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
                              {r.expiry_count}
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-400">
                              None
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Right: expiry detail + add form */}
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            {!selectedLineId && (
              <div className="p-6 text-center text-sm text-muted-foreground">
                <Calendar className="h-8 w-8 mx-auto mb-3 opacity-40" />
                Select a receipt line to view and add expiry entries.
              </div>
            )}

            {selectedLineId && selectedRow && (
              <div className="flex flex-col h-full">
                {/* Line header */}
                <div className="px-4 py-3 border-b border-border bg-muted/20">
                  <div className="text-sm font-semibold text-foreground">
                    {selectedRow.receipt_number} · Line {selectedRow.line_no ?? "—"}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {selectedRow.item_number} — {selectedRow.item_description || "No description"}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Qty received: {selectedRow.qty_received || "—"} · Date: {selectedRow.receipt_date || "—"}
                  </div>
                </div>

                {/* Existing expiry entries */}
                <div className="flex-1 overflow-y-auto px-4 py-3">
                  <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
                    Expiry Entries
                  </div>

                  {lineDetail.isLoading && (
                    <div className="text-xs text-muted-foreground">Loading…</div>
                  )}
                  {lineDetail.isError && (
                    <div className="text-xs text-red-400 mb-2">{lineDetail.error.message}</div>
                  )}
                  {lineDetail.data?.expiries?.length === 0 && (
                    <div className="text-xs text-muted-foreground py-3">No expiry entries yet.</div>
                  )}
                  {lineDetail.data?.expiries?.map((e) => (
                    <div key={e.id} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0 text-xs">
                      <div>
                        <span className="font-mono font-medium text-foreground">{e.expiry_date}</span>
                        {e.qty_at_expiry && <span className="text-muted-foreground ml-2">Qty: {e.qty_at_expiry}</span>}
                      </div>
                      <div className="text-muted-foreground text-[10px]">
                        {e.entered_by || "unknown"} · {e.entry_source}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Add form */}
                <div className="border-t border-border px-4 py-3 bg-muted/10">
                  <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
                    Add Expiry
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    <input
                      type="date"
                      value={newDate}
                      onChange={(e) => setNewDate(e.target.value)}
                      className="w-full h-8 rounded-lg border border-border bg-card px-2 text-xs text-foreground"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        value={newQty}
                        onChange={(e) => setNewQty(e.target.value)}
                        placeholder="Qty at expiry"
                        className="h-8 rounded-lg border border-border bg-card px-2 text-xs text-foreground placeholder:text-muted-foreground"
                      />
                      <input
                        value={newNotes}
                        onChange={(e) => setNewNotes(e.target.value)}
                        placeholder="Notes (optional)"
                        className="h-8 rounded-lg border border-border bg-card px-2 text-xs text-foreground placeholder:text-muted-foreground"
                      />
                    </div>
                    <button
                      disabled={!newDate || addExpiryMutation.isPending}
                      onClick={() => addExpiryMutation.mutate()}
                      className="flex items-center justify-center gap-1.5 h-9 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium transition-colors disabled:opacity-50"
                    >
                      {addExpiryMutation.isPending ? (
                        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Plus className="h-3.5 w-3.5" />
                      )}
                      Add Expiry Entry
                    </button>
                    {addExpiryMutation.isError && (
                      <div className="text-xs text-red-400">{addExpiryMutation.error.message}</div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Loading */}
      {receiptLines.isLoading && (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <RefreshCw className="h-5 w-5 animate-spin mr-2" /> Loading receipt lines…
        </div>
      )}
    </div>
  );
}
