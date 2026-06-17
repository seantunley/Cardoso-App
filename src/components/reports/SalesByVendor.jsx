import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ReportFrame, PrintHeader, PrintFooter, fmtR, fmtCount, downloadCsv } from './lib';

// Sales by Vendor — every item's sales for a date range, grouped by the item's
// vendor (the supplier of its most recent stock receipt; items never received
// fall under "(No vendor)"). Ex-VAT is Sage OE net sales; incl-VAT is derived at
// the standard rate. On a site the range is exact days (per-transaction data);
// on the hub it snaps to whole months (monthly rollups) and can be one site or
// all sites combined.

const pad = (n) => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const monthStartISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`; };

function fetchData(from, to, site) {
  const qs = new URLSearchParams({ from, to });
  if (site && site !== 'all') qs.set('site', site);
  return fetch(`/api/reports/sales-by-vendor?${qs.toString()}`, { credentials: 'include' })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

function VendorBlock({ v }) {
  return (
    <div className="report-keep-together overflow-x-auto rounded-xl border border-border bg-card">
      <div className="flex items-baseline justify-between border-b border-border px-4 py-2.5">
        <div className="font-display text-lg">{v.vendor}</div>
        <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {v.items.length} {v.items.length === 1 ? 'item' : 'items'} · {fmtCount(v.subtotal_qty)} units · <span className="tabular-nums text-foreground">R {fmtR(v.subtotal_ex)}</span> ex
        </div>
      </div>
      <table className="w-full text-sm report-doc-table" style={{ minWidth: 760 }}>
        <thead>
          <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-1.5 text-left font-medium">Item</th>
            <th className="px-3 py-1.5 text-left font-medium">Description</th>
            <th className="px-3 py-1.5 text-right font-medium">Qty</th>
            <th className="px-3 py-1.5 text-right font-medium border-l border-border">Ex-VAT (R)</th>
            <th className="px-3 py-1.5 text-right font-medium">Incl-VAT (R)</th>
          </tr>
        </thead>
        <tbody>
          {v.items.map((it, i) => (
            <tr key={i} className="border-b border-border/50 last:border-0 hover:bg-muted/20">
              <td className="px-3 py-1.5 font-mono text-xs text-foreground">{it.item_number}</td>
              <td className="px-3 py-1.5">{it.item_description || '—'}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{fmtCount(it.qty)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums border-l border-border/40"><span className="text-muted-subtle">R </span>{fmtR(it.ex_vat)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums"><span className="text-muted-subtle">R </span>{fmtR(it.incl_vat)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border bg-muted/40">
            <td className="px-3 py-1.5 font-semibold" colSpan={2}>{v.vendor} subtotal · {v.items.length} {v.items.length === 1 ? 'item' : 'items'}</td>
            <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{fmtCount(v.subtotal_qty)}</td>
            <td className="px-3 py-1.5 text-right font-semibold tabular-nums border-l border-border"><span className="text-muted-subtle">R </span>{fmtR(v.subtotal_ex)}</td>
            <td className="px-3 py-1.5 text-right font-semibold tabular-nums"><span className="text-muted-subtle">R </span>{fmtR(v.subtotal_incl)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export default function SalesByVendor() {
  const [from, setFrom] = useState(monthStartISO);
  const [to, setTo] = useState(todayISO);
  const [site, setSite] = useState('all');

  const { data, isLoading, error } = useQuery({
    queryKey: ['sales-by-vendor', from, to, site],
    queryFn: () => fetchData(from, to, site),
    staleTime: 60_000,
  });

  const isHub = !!data?.hub;
  const vendors = data?.vendors || [];
  const grand = data?.grand || { qty: 0, ex: 0, incl: 0 };
  const hasData = vendors.length > 0;
  const siteOptions = data?.filters?.sites || [];
  const vatPct = Math.round((data?.vat_rate ?? 0.15) * 100);
  const rangeLabel = isHub && data?.period_from ? `${data.period_from} to ${data.period_to}` : `${from} to ${to}`;

  const exportCsv = () => {
    const header = ['Vendor', 'Item', 'Description', 'Qty', 'Ex-VAT', 'Incl-VAT'];
    const rows = [];
    for (const v of vendors) {
      for (const it of v.items) rows.push([v.vendor, it.item_number, it.item_description || '', it.qty, (Number(it.ex_vat) || 0).toFixed(2), (Number(it.incl_vat) || 0).toFixed(2)]);
      rows.push([v.vendor, `${v.vendor} subtotal`, '', v.subtotal_qty, (Number(v.subtotal_ex) || 0).toFixed(2), (Number(v.subtotal_incl) || 0).toFixed(2)]);
    }
    rows.push(['GRAND TOTAL', '', '', grand.qty, (Number(grand.ex) || 0).toFixed(2), (Number(grand.incl) || 0).toFixed(2)]);
    downloadCsv(`sales-by-vendor-${from}_to_${to}${isHub && site !== 'all' ? `-${site}` : ''}.csv`, [header, ...rows]);
  };

  const generatedAtFmt = new Date().toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <ReportFrame
      title={<>Sales <em className="text-phosphor">by Vendor</em>.</>}
      subtitle={`Every item's sales grouped by vendor (the supplier of its latest stock receipt) for ${rangeLabel}${isHub ? (site === 'all' ? ', all sites combined' : '') : ''}. Ex-VAT is Sage net sales; incl-VAT derived at ${vatPct}%.`}
      printId="sales-by-vendor"
      orientation="landscape"
      onExportCsv={hasData ? exportCsv : undefined}
      onPrint={() => window.print()}
      isLoading={isLoading}
      error={error?.message}
      printHeader={<PrintHeader title="Sales by Vendor" filters={[`Range: ${rangeLabel}`, ...(isHub ? [`Site: ${site === 'all' ? 'All sites' : site}`] : []), `${vendors.length} ${vendors.length === 1 ? 'vendor' : 'vendors'}`, `Ex- & incl-VAT @ ${vatPct}%`]} generatedAt={generatedAtFmt} />}
      printFooter={<PrintFooter note="Sales by Vendor · Cardoso" />}
    >
      {/* Filters */}
      <div className="report-print-hide mb-4 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">From</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9 rounded-xl border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary" />
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">To</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9 rounded-xl border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary" />
        </div>
        {isHub && (
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Site</span>
            <select value={site} onChange={(e) => setSite(e.target.value)} className="h-9 rounded-xl border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary">
              <option value="all">All sites (combined)</option>
              {siteOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        )}
        {isHub && <span className="font-mono text-[10px] uppercase tracking-wide text-muted-subtle">Hub data is monthly — range covers whole months.</span>}
      </div>

      {!isLoading && !error && !hasData ? (
        <div className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          No sales found for {rangeLabel}{isHub && site !== 'all' ? ' at this site' : ''}.
        </div>
      ) : hasData ? (
        <div className="space-y-6">
          {vendors.map((v) => <VendorBlock key={v.vendor} v={v} />)}

          {/* Grand total */}
          <div className="report-keep-together flex items-baseline justify-between rounded-xl border-2 border-accent/40 bg-card px-5 py-3">
            <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">Grand total · {vendors.length} {vendors.length === 1 ? 'vendor' : 'vendors'}{isHub && site === 'all' ? ' · all sites' : ''}</div>
            <div className="font-display text-xl tabular-nums">{fmtCount(grand.qty)} units · R {fmtR(grand.ex)} ex · R {fmtR(grand.incl)} incl</div>
          </div>
        </div>
      ) : null}
    </ReportFrame>
  );
}
