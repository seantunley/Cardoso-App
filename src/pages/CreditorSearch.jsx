// Creditor Search — typeahead lookup + four drilldown tabs per vendor.
// Mirror of CustomerSearch but for AP: receipts (PORCPH1), open
// invoices (APOBL), payments (APTCR), and POs (POPORH1 + POPORL).
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, Search, Truck, FileText, Wallet, ClipboardList } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

function fmtR(v) {
  const n = Number(v) || 0;
  return n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtNum(v) {
  return (Number(v) || 0).toLocaleString();
}
function fmtDate(s) { return s || "—"; }

async function searchVendors(q) {
  if (!q || q.trim().length < 2) return { results: [] };
  const r = await fetch(`/api/creditors/search?q=${encodeURIComponent(q)}`, { credentials: "include" });
  if (!r.ok) throw new Error(`Search failed (HTTP ${r.status})`);
  return r.json();
}

async function fetchVendor(code) {
  const r = await fetch(`/api/creditors/${encodeURIComponent(code)}`, { credentials: "include" });
  if (!r.ok) throw new Error(`Vendor not found (HTTP ${r.status})`);
  return r.json();
}

async function fetchTab(code, tab) {
  const r = await fetch(`/api/creditors/${encodeURIComponent(code)}/${tab}`, { credentials: "include" });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${r.status}`);
  }
  return r.json();
}

function VendorTypeahead({ onPick }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);
  const { data, isFetching } = useQuery({
    queryKey: ["creditor-search", q],
    queryFn: () => searchVendors(q),
    enabled: q.trim().length >= 2,
    keepPreviousData: true,
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

function VendorHeader({ vendor }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">{vendor.vendor_code}</div>
          <h2 className="text-2xl font-semibold mt-1 truncate">{vendor.vendor_name || "—"}</h2>
          <div className="mt-2 flex flex-wrap gap-4 text-sm text-muted-foreground">
            {vendor.terms ? <span title="Sage terms code">Terms: <span className="text-foreground">{vendor.terms}</span></span> : null}
            {vendor.contact ? <span>Contact: <span className="text-foreground">{vendor.contact}</span></span> : null}
            {vendor.phone ? <span>Phone: <span className="text-foreground">{vendor.phone}</span></span> : null}
            {vendor.email ? <span>Email: <span className="text-foreground">{vendor.email}</span></span> : null}
          </div>
        </div>
        <div className="text-right">
          <span className={`inline-block rounded-full px-3 py-1 text-xs font-medium ${vendor.is_active ? "bg-emerald-500/10 text-emerald-300" : "bg-muted text-muted-foreground"}`}>
            {vendor.is_active ? "Active" : "Inactive"}
          </span>
          <div className="mt-3 text-[10px] uppercase tracking-wider text-muted-foreground space-y-0.5">
            {vendor.last_receipt_date && <div>Last receipt: <span className="text-foreground">{vendor.last_receipt_date}</span></div>}
            {vendor.last_payment_date && <div>Last payment: <span className="text-foreground">{vendor.last_payment_date}</span></div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function TabContainer({ children, loading, error, empty }) {
  if (loading) return <div className="h-[300px] animate-pulse rounded-xl border border-border bg-card" />;
  if (error) return <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-sm text-red-300">{error}</div>;
  if (empty) return <div className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">{empty}</div>;
  return children;
}

function ReceiptsTab({ code }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["creditor-receipts", code],
    queryFn: () => fetchTab(code, "receipts"),
    staleTime: 60_000,
  });
  const rows = data?.records || [];
  return (
    <TabContainer loading={isLoading} error={error?.message} empty={!isLoading && rows.length === 0 ? "No goods receipts found for this vendor." : null}>
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 text-left">Receipt #</th>
            <th className="px-3 py-2 text-left">Date</th>
            <th className="px-3 py-2 text-left">Item</th>
            <th className="px-3 py-2 text-left">Description</th>
            <th className="px-3 py-2 text-right">Qty</th>
            <th className="px-3 py-2 text-left">UOM</th>
            <th className="px-3 py-2 text-right">Unit cost</th>
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.receipt_number}-${r.line_no}-${i}`} className="border-b border-border last:border-0">
                <td className="px-3 py-1.5 font-mono text-xs">{r.receipt_number}</td>
                <td className="px-3 py-1.5">{fmtDate(r.receipt_date)}</td>
                <td className="px-3 py-1.5 font-mono text-xs">{r.item_number}</td>
                <td className="px-3 py-1.5">{r.item_description || "—"}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(r.qty_received)}</td>
                <td className="px-3 py-1.5">{r.uom || "—"}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">R {fmtR(r.unit_cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TabContainer>
  );
}

function InvoicesTab({ code }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["creditor-ap-invoices", code],
    queryFn: () => fetchTab(code, "ap-invoices"),
    staleTime: 60_000,
  });
  const rows = data?.records || [];
  const total = rows.reduce((acc, r) => acc + (Number(r.outstanding_amount) || 0), 0);
  return (
    <TabContainer loading={isLoading} error={error?.message} empty={!isLoading && rows.length === 0 ? "No outstanding AP invoices for this vendor." : null}>
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 text-left">Document #</th>
            <th className="px-3 py-2 text-left">Type</th>
            <th className="px-3 py-2 text-left">Invoice date</th>
            <th className="px-3 py-2 text-left">Due date</th>
            <th className="px-3 py-2 text-left">Reference</th>
            <th className="px-3 py-2 text-right">Original</th>
            <th className="px-3 py-2 text-right">Outstanding</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.document_number} className="border-b border-border last:border-0">
                <td className="px-3 py-1.5 font-mono text-xs">{r.document_number}</td>
                <td className="px-3 py-1.5">{r.document_type || "—"}</td>
                <td className="px-3 py-1.5">{fmtDate(r.document_date)}</td>
                <td className="px-3 py-1.5">{fmtDate(r.due_date)}</td>
                <td className="px-3 py-1.5">{r.reference || "—"}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">R {fmtR(r.original_amount)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-amber-300">R {fmtR(r.outstanding_amount)}</td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="border-t border-border bg-muted/30">
                <td colSpan={6} className="px-3 py-2 text-right text-xs uppercase tracking-wider text-muted-foreground">Total outstanding</td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold">R {fmtR(total)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </TabContainer>
  );
}

function PaymentsTab({ code }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["creditor-ap-payments", code],
    queryFn: () => fetchTab(code, "ap-payments"),
    staleTime: 60_000,
  });
  const rows = data?.records || [];
  const total = rows.reduce((acc, r) => acc + (Number(r.amount) || 0), 0);
  return (
    <TabContainer loading={isLoading} error={error?.message} empty={!isLoading && rows.length === 0 ? "No payments to this vendor in the sync window." : null}>
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 text-left">Payment #</th>
            <th className="px-3 py-2 text-left">Date</th>
            <th className="px-3 py-2 text-left">Method</th>
            <th className="px-3 py-2 text-left">Bank</th>
            <th className="px-3 py-2 text-left">Reference</th>
            <th className="px-3 py-2 text-right">Amount</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.payment_number} className="border-b border-border last:border-0">
                <td className="px-3 py-1.5 font-mono text-xs">{r.payment_number}</td>
                <td className="px-3 py-1.5">{fmtDate(r.payment_date)}</td>
                <td className="px-3 py-1.5">{r.payment_method || "—"}</td>
                <td className="px-3 py-1.5">{r.bank_code || "—"}</td>
                <td className="px-3 py-1.5">{r.reference || "—"}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-emerald-300">R {fmtR(r.amount)}</td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr className="border-t border-border bg-muted/30">
                <td colSpan={5} className="px-3 py-2 text-right text-xs uppercase tracking-wider text-muted-foreground">Total paid</td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold">R {fmtR(total)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </TabContainer>
  );
}

function PosTab({ code }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["creditor-pos", code],
    queryFn: () => fetchTab(code, "pos"),
    staleTime: 60_000,
  });
  const rows = data?.records || [];
  return (
    <TabContainer loading={isLoading} error={error?.message} empty={!isLoading && rows.length === 0 ? "No purchase orders for this vendor in the sync window." : null}>
      <div className="space-y-3">
        {rows.map((po) => (
          <details key={po.id} className="rounded-xl border border-border bg-card overflow-hidden group">
            <summary className="cursor-pointer px-4 py-3 flex items-center justify-between gap-4 list-none hover:bg-muted/30">
              <div className="flex items-center gap-3 min-w-0">
                <ClipboardList className="h-4 w-4 text-muted-foreground" />
                <span className="font-mono text-sm">{po.po_number}</span>
                <span className="text-xs text-muted-foreground">{fmtDate(po.po_date)}</span>
                {po.status && <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{po.status}</span>}
              </div>
              <div className="text-right tabular-nums">
                <div className="text-sm">R {fmtR(po.total_amount)}</div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{po.lines?.length || 0} lines</div>
              </div>
            </summary>
            <div className="border-t border-border">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="px-3 py-2 text-left">Item</th>
                  <th className="px-3 py-2 text-left">Description</th>
                  <th className="px-3 py-2 text-right">Ordered</th>
                  <th className="px-3 py-2 text-right">Received</th>
                  <th className="px-3 py-2 text-right">Unit cost</th>
                  <th className="px-3 py-2 text-right">Extended</th>
                </tr></thead>
                <tbody>
                  {(po.lines || []).map((l) => (
                    <tr key={`${po.id}-${l.line_no}`} className="border-b border-border last:border-0">
                      <td className="px-3 py-1.5 font-mono text-xs">{l.item_number}</td>
                      <td className="px-3 py-1.5">{l.item_description || "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(l.qty_ordered)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(l.qty_received)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">R {fmtR(l.unit_cost)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">R {fmtR(l.extended_cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ))}
      </div>
    </TabContainer>
  );
}

export default function CreditorSearch() {
  const [code, setCode] = useState(null);
  const [tab, setTab] = useState("receipts");

  const { data: vendor, isLoading: vLoading, error: vError } = useQuery({
    queryKey: ["creditor", code],
    queryFn: () => fetchVendor(code),
    enabled: !!code,
  });

  // Reset tab when switching vendors so we always land on Receipts first.
  useEffect(() => { setTab("receipts"); }, [code]);

  return (
    <div className="min-h-screen bg-background px-2 py-4 text-foreground sm:px-3">
      <div className="space-y-6">
        <div className="border-b border-border pb-5">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground mb-3">§ Creditors</div>
          <h1 className="font-display text-4xl lg:text-5xl leading-tight tracking-tight text-foreground">
            <em className="text-phosphor">Drill</em> into a vendor.
          </h1>
          <p className="text-sm text-muted-foreground mt-3">
            Goods receipts, open invoices, payments, and purchase orders — all synced from Sage.
          </p>
        </div>

        <VendorTypeahead onPick={setCode} />

        {!code && (
          <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card px-6 py-16 text-center">
            <Building2 className="mb-4 h-12 w-12 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Pick a vendor</h2>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              Type a vendor code or supplier name above to drill into receipts, payments, and POs.
            </p>
          </div>
        )}

        {code && vLoading && <div className="h-[140px] animate-pulse rounded-xl border border-border bg-card" />}
        {code && vError && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-sm text-red-300">{vError.message}</div>
        )}
        {code && vendor && <VendorHeader vendor={vendor} />}

        {code && vendor && (
          <Tabs value={tab} onValueChange={setTab} className="space-y-4">
            <TabsList className="inline-flex h-10 rounded-2xl border border-border bg-muted p-1 gap-1">
              <TabsTrigger value="receipts" title="Goods received from this vendor (PORCPH1)" className="rounded-xl px-4 py-1.5 text-sm">
                <Truck className="h-4 w-4 mr-1.5 inline-block" /> Receipts
              </TabsTrigger>
              <TabsTrigger value="invoices" title="Open AP invoices (APOBL)" className="rounded-xl px-4 py-1.5 text-sm">
                <FileText className="h-4 w-4 mr-1.5 inline-block" /> Open invoices
              </TabsTrigger>
              <TabsTrigger value="payments" title="Payments made to this vendor (APTCR)" className="rounded-xl px-4 py-1.5 text-sm">
                <Wallet className="h-4 w-4 mr-1.5 inline-block" /> Payments
              </TabsTrigger>
              <TabsTrigger value="pos" title="Issued purchase orders (POPORH1)" className="rounded-xl px-4 py-1.5 text-sm">
                <ClipboardList className="h-4 w-4 mr-1.5 inline-block" /> Purchase orders
              </TabsTrigger>
            </TabsList>

            <TabsContent value="receipts"><ReceiptsTab code={code} /></TabsContent>
            <TabsContent value="invoices"><InvoicesTab code={code} /></TabsContent>
            <TabsContent value="payments"><PaymentsTab code={code} /></TabsContent>
            <TabsContent value="pos"><PosTab code={code} /></TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}
