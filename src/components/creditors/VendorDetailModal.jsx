// Vendor detail modal — the full creditor picture in a popup: true-position
// header (posted + unposted invoices − unposted payments, capture warning)
// and the four drilldown tabs (receipts / open invoices / payments / POs).
// No flagging system — vendors don't carry flags (operator decision).
//
// Used by Creditor Search (typeahead → popup) and Creditor Balances (row
// click → popup in place, mirroring the customer popup on Customer Balances).
// Everything here moved verbatim out of pages/CreditorSearch.jsx.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Truck, FileText, Wallet, ClipboardList, PackageCheck } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

function fmtR(v) {
  const n = Number(v) || 0;
  return n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtNum(v) {
  return (Number(v) || 0).toLocaleString();
}
function fmtDate(s) { return s || "—"; }

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

function VendorHeader({ vendor }) {
  const inv = Number(vendor.unposted_invoices) || 0;
  const pay = Number(vendor.unposted_payments) || 0;
  const hasAdjustments = inv !== 0 || pay > 0;
  // Payment-capture cutoff — same warning as Creditor Balances: payments made
  // at the bank after this date are not in Sage yet and cannot reflect here.
  const lastCapture = (vendor.last_cb_payment_capture || "") > (vendor.last_ap_payment_date || "")
    ? vendor.last_cb_payment_capture
    : (vendor.last_ap_payment_date || vendor.last_cb_payment_capture);
  const captureDays = lastCapture
    ? Math.floor((Date.now() - new Date(lastCapture).getTime()) / 86_400_000)
    : null;
  const captureStale = Number.isFinite(captureDays) && captureDays > 7;

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground">{vendor.vendor_code}</div>
          <h2 className="text-2xl font-semibold mt-1 truncate">{vendor.vendor_name || "—"}</h2>
          <div className="mt-2 flex flex-wrap gap-4 text-sm text-muted-foreground">
            {vendor.terms ? <span title="Sage terms code">Terms: <span className="text-foreground">{vendor.terms}</span></span> : null}
            {vendor.contact ? <span>Contact: <span className="text-foreground">{vendor.contact}</span></span> : null}
            {vendor.phone ? <span>Phone: <span className="text-foreground">{vendor.phone}</span></span> : null}
            {vendor.email ? <span>Email: <span className="text-foreground">{vendor.email}</span></span> : null}
          </div>
          {/* Last activity — promoted from tiny corner text (operator request):
              payment recency is a primary fact for a vendor. */}
          <div className="mt-4 flex flex-wrap gap-6">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Last payment</div>
              <div className="text-lg font-semibold tabular-nums">{vendor.last_payment_date || "—"}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Last receipt</div>
              <div className="text-lg font-semibold tabular-nums">{vendor.last_receipt_date || "—"}</div>
            </div>
          </div>
        </div>
        <div className="text-right">
          <span className={`inline-block rounded-full px-3 py-1 text-xs font-medium ${vendor.is_active ? "bg-emerald-500/10 text-emerald-300" : "bg-muted text-muted-foreground"}`}>
            {vendor.is_active ? "Active" : "Inactive"}
          </span>
          {/* True outstanding — same arithmetic as Creditor Balances:
              posted APOBL + unposted invoices − unposted payments. */}
          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Outstanding{hasAdjustments ? " (true position)" : ""}
            </div>
            <div className="text-2xl font-semibold tabular-nums">
              R {fmtR(vendor.outstanding_net)}
              {hasAdjustments && <span className="ml-1 text-accent" aria-hidden="true">●</span>}
            </div>
            {hasAdjustments && (
              <div className="mt-1 space-y-0.5 text-xs text-muted-foreground tabular-nums">
                <div>Posted in Sage: R {fmtR(vendor.outstanding_gross)}</div>
                {inv !== 0 && <div>+ R {fmtR(inv)} invoices in unposted batches</div>}
                {pay > 0 && <div>− R {fmtR(pay)} unposted payments</div>}
              </div>
            )}
          </div>
        </div>
      </div>
      {captureStale && (
        <div className="mt-4 flex items-center gap-2 border-t border-border pt-3 text-sm text-red-300">
          <span className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
          <span>
            Vendor payments captured in the Cashbook up to{" "}
            <span className="font-medium tabular-nums">{lastCapture}</span>
            {" "}({captureDays} days ago) — anything paid since is not in Sage yet and cannot reflect here.
          </span>
        </div>
      )}
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

  // Group lines by receipt # so the operator sees one row per receipt
  // and can drill into the line detail on demand. Preserves the API's
  // ordering (date DESC, line ASC) by streaming into a Map.
  const receipts = (() => {
    const byNum = new Map();
    for (const r of rows) {
      if (!byNum.has(r.receipt_number)) {
        byNum.set(r.receipt_number, {
          receipt_number: r.receipt_number,
          receipt_date: r.receipt_date,
          lines: [],
        });
      }
      byNum.get(r.receipt_number).lines.push(r);
    }
    return [...byNum.values()];
  })();

  return (
    <TabContainer loading={isLoading} error={error?.message} empty={!isLoading && rows.length === 0 ? "No goods receipts found for this vendor." : null}>
      <div className="space-y-3">
        {receipts.map((rcp) => {
          const totalQty = rcp.lines.reduce((acc, l) => acc + (Number(l.qty_received) || 0), 0);
          const totalCost = rcp.lines.reduce((acc, l) => acc + ((Number(l.qty_received) || 0) * (Number(l.unit_cost) || 0)), 0);
          return (
            <details key={rcp.receipt_number} className="rounded-xl border border-border bg-card overflow-hidden group">
              <summary className="cursor-pointer px-4 py-3 flex items-center justify-between gap-4 list-none hover:bg-muted/30">
                <div className="flex items-center gap-3 min-w-0">
                  <PackageCheck className="h-4 w-4 text-muted-foreground" />
                  <span className="font-mono text-sm">{rcp.receipt_number}</span>
                  <span className="text-xs text-muted-foreground">{fmtDate(rcp.receipt_date)}</span>
                </div>
                <div className="text-right tabular-nums">
                  <div className="text-sm">R {fmtR(totalCost)}</div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {rcp.lines.length} line{rcp.lines.length === 1 ? "" : "s"} · {fmtNum(totalQty)} units
                  </div>
                </div>
              </summary>
              <div className="border-t border-border">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-3 py-2 text-left">Item</th>
                    <th className="px-3 py-2 text-left">Description</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                    <th className="px-3 py-2 text-left">UOM</th>
                    <th className="px-3 py-2 text-right">Unit cost</th>
                  </tr></thead>
                  <tbody>
                    {rcp.lines.map((l, i) => (
                      <tr key={`${rcp.receipt_number}-${l.line_no}-${i}`} className="border-b border-border last:border-0">
                        <td className="px-3 py-1.5 font-mono text-xs">{l.item_number}</td>
                        <td className="px-3 py-1.5">{l.item_description || "—"}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(l.qty_received)}</td>
                        <td className="px-3 py-1.5">{l.uom || "—"}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">R {fmtR(l.unit_cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          );
        })}
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

export default function VendorDetailModal({ code, onClose }) {
  const open = !!code;
  const [tab, setTab] = useState("receipts");
  // Land on Receipts whenever a different vendor opens.
  useEffect(() => { setTab("receipts"); }, [code]);

  const { data: vendor, isLoading: vLoading, error: vError } = useQuery({
    queryKey: ["creditor", code],
    queryFn: () => fetchVendor(code),
    enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="sr-only">Vendor detail</DialogTitle>
          <DialogDescription className="sr-only">
            Vendor account header with outstanding position, plus receipts, open invoices, payments, and purchase orders.
          </DialogDescription>
        </DialogHeader>
        {vLoading && <div className="h-[140px] animate-pulse rounded-xl border border-border bg-card" />}
        {vError && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-sm text-red-300">{vError.message}</div>
        )}
        {vendor && (
          <div className="space-y-4">
            <VendorHeader vendor={vendor} />
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
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
