// Creditor Search — "Search the ledger" pattern for AP, mirroring Customer
// Search: a typeahead lookup that opens the FULL vendor detail in a popup
// (VendorDetailModal: true-position header + receipts / open invoices /
// payments / POs tabs — no flagging system, vendors don't carry flags).
// Closing the popup returns to the clean search page. ?code= deep links
// still work (Creditor Balances also opens the same modal in place).
import { useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "../hooks/useDebouncedValue.js";
import { Building2, Search } from "lucide-react";
import { useSearchParamState } from "../hooks/useSearchParamState.js";
import VendorDetailModal from "@/components/creditors/VendorDetailModal";

async function searchVendors(q) {
  if (!q || q.trim().length < 2) return { results: [] };
  const r = await fetch(`/api/creditors/search?q=${encodeURIComponent(q)}`, { credentials: "include" });
  if (!r.ok) throw new Error(`Search failed (HTTP ${r.status})`);
  return r.json();
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
    // react-query v5 removed keepPreviousData; placeholderData: keepPreviousData
    // keeps the prior results visible while the next query loads instead of
    // blanking the dropdown on every change (UI-4).
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
  const results = data?.results || [];

  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search vendor by code or name…"
        className="w-full rounded-xl border border-border bg-card pl-9 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
      />
      {open && q.trim().length >= 2 && (
        <div className="absolute z-20 mt-1 w-full rounded-xl border border-border bg-card shadow-lg max-h-[400px] overflow-auto">
          {isFetching && <div className="px-4 py-2 text-xs text-muted-foreground">Searching…</div>}
          {!isFetching && results.length === 0 && <div className="px-4 py-2 text-xs text-muted-foreground">No vendors found.</div>}
          {results.map((r) => (
            <button
              key={r.vendor_code}
              type="button"
              onMouseDown={() => { onPick(r.vendor_code); setQ(""); setOpen(false); inputRef.current?.blur(); }}
              className="w-full text-left px-4 py-2 hover:bg-muted/40 border-b border-border last:border-0 flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <div className="text-sm text-foreground truncate">{r.vendor_name || "(no name)"}</div>
                <div className="font-mono text-xs text-muted-foreground">{r.vendor_code}</div>
              </div>
              <span className={`text-[10px] uppercase tracking-wider ${r.is_active ? "text-emerald-400" : "text-muted-foreground"}`}>
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

  return (
    <div className="min-h-screen bg-background px-2 py-4 text-foreground sm:px-3">
      <div className="space-y-6">
        <div className="border-b border-border pb-5">

          <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
            <em className="text-phosphor">Drill</em> into a vendor.
          </h1>
          <p className="text-sm text-muted-foreground mt-3">
            Goods receipts, open invoices, payments, and purchase orders — all synced from Sage, in one popup.
          </p>
        </div>

        <VendorTypeahead onPick={setCode} />

        <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card px-6 py-16 text-center">
          <Building2 className="mb-4 h-12 w-12 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Pick a vendor</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Type a vendor code or supplier name above — the full vendor detail opens in a popup.
          </p>
        </div>

        <VendorDetailModal code={code} onClose={() => setCode("")} />
      </div>
    </div>
  );
}
