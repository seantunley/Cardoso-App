import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ReportFrame, PrintHeader, PrintFooter, fmtR, fmtCount, downloadCsv } from './lib';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';

// Sales by Vendor — every item's sales for a date range, grouped by the item's
// vendor (Sage ICITMV item/vendor master). Ex-VAT is Sage OE net sales; incl-VAT
// is derived at the standard rate. Optional prior-year toggle adds same-period
// last-year qty + value and a YoY % change (union of both years). A multi-select
// vendor filter narrows the view. Site = exact days; hub = whole months,
// selectable by one site or all sites combined.

const pad = (n) => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const monthStartISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`; };

function fetchData(from, to, site, compare) {
  const qs = new URLSearchParams({ from, to });
  if (site && site !== 'all') qs.set('site', site);
  if (compare) qs.set('compare', '1');
  return fetch(`/api/reports/sales-by-vendor?${qs.toString()}`, { credentials: 'include' })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

// YoY % as text (for CSV) and as a coloured cell (for screen/print).
const yoyText = (cur, py) => {
  if (!py) return cur > 0 ? 'new' : '—';
  const p = ((cur - py) / py) * 100;
  return `${p > 0 ? '+' : ''}${p.toFixed(1)}%`;
};
function YoY({ cur, py }) {
  if (!py) return cur > 0 ? <span className="text-emerald-500">new</span> : <span className="text-muted-subtle">—</span>;
  const p = ((cur - py) / py) * 100;
  const cls = p > 0 ? 'text-emerald-500' : p < 0 ? 'text-red-400' : 'text-muted-foreground';
  return <span className={cls}>{p > 0 ? '+' : ''}{p.toFixed(1)}%</span>;
}

function VendorBlock({ v, compare }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <div className="flex items-baseline justify-between border-b border-border px-4 py-2.5 print:break-after-avoid">
        <div className="font-display text-lg">{v.vendor}</div>
        <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {v.items.length} {v.items.length === 1 ? 'item' : 'items'} · {fmtCount(v.subtotal_qty)} units · <span className="tabular-nums text-foreground">R {fmtR(v.subtotal_ex)}</span> ex
          {compare && <span> · vs <span className="tabular-nums">R {fmtR(v.py_subtotal_ex)}</span> PY · <YoY cur={v.subtotal_ex} py={v.py_subtotal_ex} /></span>}
        </div>
      </div>
      <table className="w-full text-sm report-doc-table" style={{ minWidth: compare ? 1040 : 760 }}>
        <thead>
          <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-1.5 text-left font-medium">Item</th>
            <th className="px-3 py-1.5 text-left font-medium">Description</th>
            <th className="px-3 py-1.5 text-right font-medium">Qty</th>
            {compare && <th className="px-3 py-1.5 text-right font-medium">PY Qty</th>}
            {compare && <th className="px-3 py-1.5 text-right font-medium">Qty Δ</th>}
            <th className="px-3 py-1.5 text-right font-medium border-l border-border">Ex-VAT (R)</th>
            {compare && <th className="px-3 py-1.5 text-right font-medium">PY Ex-VAT (R)</th>}
            {compare && <th className="px-3 py-1.5 text-right font-medium">Value Δ</th>}
            <th className="px-3 py-1.5 text-right font-medium border-l border-border">Incl-VAT (R)</th>
          </tr>
        </thead>
        <tbody>
          {v.items.map((it, i) => (
            <tr key={i} className="border-b border-border/50 last:border-0 hover:bg-muted/20">
              <td className="px-3 py-1.5 font-mono text-xs text-foreground">{it.item_number}</td>
              <td className="px-3 py-1.5">{it.item_description || '—'}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{fmtCount(it.qty)}</td>
              {compare && <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{fmtCount(it.py_qty)}</td>}
              {compare && <td className="px-3 py-1.5 text-right tabular-nums text-xs"><YoY cur={it.qty} py={it.py_qty} /></td>}
              <td className="px-3 py-1.5 text-right tabular-nums border-l border-border/40"><span className="text-muted-subtle">R </span>{fmtR(it.ex_vat)}</td>
              {compare && <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground"><span className="text-muted-subtle">R </span>{fmtR(it.py_ex_vat)}</td>}
              {compare && <td className="px-3 py-1.5 text-right tabular-nums text-xs"><YoY cur={it.ex_vat} py={it.py_ex_vat} /></td>}
              <td className="px-3 py-1.5 text-right tabular-nums border-l border-border/40"><span className="text-muted-subtle">R </span>{fmtR(it.incl_vat)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border bg-muted/40">
            <td className="px-3 py-1.5 font-semibold" colSpan={2}>{v.vendor} subtotal</td>
            <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{fmtCount(v.subtotal_qty)}</td>
            {compare && <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-muted-foreground">{fmtCount(v.py_subtotal_qty)}</td>}
            {compare && <td className="px-3 py-1.5 text-right font-semibold text-xs"><YoY cur={v.subtotal_qty} py={v.py_subtotal_qty} /></td>}
            <td className="px-3 py-1.5 text-right font-semibold tabular-nums border-l border-border"><span className="text-muted-subtle">R </span>{fmtR(v.subtotal_ex)}</td>
            {compare && <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-muted-foreground"><span className="text-muted-subtle">R </span>{fmtR(v.py_subtotal_ex)}</td>}
            {compare && <td className="px-3 py-1.5 text-right font-semibold text-xs"><YoY cur={v.subtotal_ex} py={v.py_subtotal_ex} /></td>}
            <td className="px-3 py-1.5 text-right font-semibold tabular-nums border-l border-border"><span className="text-muted-subtle">R </span>{fmtR(v.subtotal_incl)}</td>
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
  const [compare, setCompare] = useState(false);
  const [vendorSel, setVendorSel] = useState([]); // empty = all vendors

  const { data, isLoading, error } = useQuery({
    queryKey: ['sales-by-vendor', from, to, site, compare],
    queryFn: () => fetchData(from, to, site, compare),
    staleTime: 60_000,
  });

  const isHub = !!data?.hub;
  const cmp = !!data?.compare;
  const allVendors = data?.vendors || [];
  const siteOptions = data?.filters?.sites || [];
  const vatPct = Math.round((data?.vat_rate ?? 0.15) * 100);
  const rangeLabel = isHub && data?.period_from ? `${data.period_from} to ${data.period_to}` : `${from} to ${to}`;
  const pyLabel = data?.py_period_from ? `${data.py_period_from} to ${data.py_period_to}` : (data?.py_from ? `${data.py_from} to ${data.py_to}` : '');

  const vendors = useMemo(
    () => (vendorSel.length ? allVendors.filter((v) => vendorSel.includes(v.vendor)) : allVendors),
    [allVendors, vendorSel],
  );
  const grand = useMemo(() => vendors.reduce((g, v) => ({
    qty: g.qty + v.subtotal_qty, ex: g.ex + v.subtotal_ex, incl: g.incl + v.subtotal_incl,
    py_qty: g.py_qty + (v.py_subtotal_qty || 0), py_ex: g.py_ex + (v.py_subtotal_ex || 0), py_incl: g.py_incl + (v.py_subtotal_incl || 0),
  }), { qty: 0, ex: 0, incl: 0, py_qty: 0, py_ex: 0, py_incl: 0 }), [vendors]);
  const hasData = vendors.length > 0;

  const exportCsv = () => {
    const header = ['Vendor', 'Item', 'Description', 'Qty', ...(cmp ? ['PY Qty', 'Qty %'] : []), 'Ex-VAT', ...(cmp ? ['PY Ex-VAT', 'Value %'] : []), 'Incl-VAT'];
    const rows = [];
    const line = (vendor, item, desc, it) => [vendor, item, desc,
      it.qty, ...(cmp ? [it.py_qty, yoyText(it.qty, it.py_qty)] : []),
      (Number(it.ex_vat) || 0).toFixed(2), ...(cmp ? [(Number(it.py_ex_vat) || 0).toFixed(2), yoyText(it.ex_vat, it.py_ex_vat)] : []),
      (Number(it.incl_vat) || 0).toFixed(2)];
    for (const v of vendors) {
      for (const it of v.items) rows.push(line(v.vendor, it.item_number, it.item_description || '', it));
      rows.push(line(v.vendor, `${v.vendor} subtotal`, '', {
        qty: v.subtotal_qty, py_qty: v.py_subtotal_qty, ex_vat: v.subtotal_ex, py_ex_vat: v.py_subtotal_ex, incl_vat: v.subtotal_incl,
      }));
    }
    rows.push(line('GRAND TOTAL', '', '', { qty: grand.qty, py_qty: grand.py_qty, ex_vat: grand.ex, py_ex_vat: grand.py_ex, incl_vat: grand.incl }));
    downloadCsv(`sales-by-vendor-${from}_to_${to}${cmp ? '-yoy' : ''}${isHub && site !== 'all' ? `-${site}` : ''}.csv`, [header, ...rows]);
  };

  const generatedAtFmt = new Date().toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const filterChips = [`Range: ${rangeLabel}`, ...(cmp ? [`vs PY: ${pyLabel}`] : []), ...(isHub ? [`Site: ${site === 'all' ? 'All sites' : site}`] : []), ...(vendorSel.length ? [`Vendors: ${vendorSel.length} selected`] : []), `${vendors.length} ${vendors.length === 1 ? 'vendor' : 'vendors'}`, `Ex- & incl-VAT @ ${vatPct}%`];

  return (
    <ReportFrame
      title={<>Sales <em className="text-phosphor">by Vendor</em>.</>}
      subtitle={`Every item's sales grouped by vendor (Sage item/vendor master) for ${rangeLabel}${cmp ? `, vs ${pyLabel}` : ''}${isHub && site === 'all' ? ', all sites combined' : ''}. Ex-VAT is Sage net sales; incl-VAT at ${vatPct}%.`}
      printId="sales-by-vendor"
      orientation="landscape"
      onExportCsv={hasData ? exportCsv : undefined}
      onPrint={() => window.print()}
      isLoading={isLoading}
      error={error?.message}
      printHeader={<PrintHeader title="Sales by Vendor" filters={filterChips} generatedAt={generatedAtFmt} />}
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
        {/* Vendor multi-select */}
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Vendors</span>
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className="h-9 rounded-xl border border-border bg-background px-3 text-sm text-foreground hover:border-foreground focus:outline-none focus:ring-2 focus:ring-primary">
                {vendorSel.length ? `${vendorSel.length} selected` : 'All vendors'} ▾
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 max-h-80 overflow-y-auto p-2">
              <div className="mb-1 flex items-center justify-between border-b border-border px-1 pb-2">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{allVendors.length} vendors</span>
                <button type="button" onClick={() => setVendorSel([])} className="font-mono text-[10px] uppercase tracking-wider text-phosphor hover:underline">Clear</button>
              </div>
              {allVendors.map((v) => (
                <label key={v.vendor} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted/40">
                  <Checkbox checked={vendorSel.includes(v.vendor)} onCheckedChange={(c) => setVendorSel(c ? [...vendorSel, v.vendor] : vendorSel.filter((x) => x !== v.vendor))} />
                  <span className="truncate">{v.vendor}</span>
                </label>
              ))}
            </PopoverContent>
          </Popover>
        </div>
        {/* Prior-year toggle */}
        <label className="flex cursor-pointer items-center gap-2">
          <Checkbox checked={compare} onCheckedChange={(c) => setCompare(!!c)} />
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Compare prior year</span>
        </label>
      </div>

      {!isLoading && !error && !hasData ? (
        <div className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          No sales found for {rangeLabel}{vendorSel.length ? ' for the selected vendors' : ''}.
        </div>
      ) : hasData ? (
        <div className="space-y-6">
          {vendors.map((v) => <VendorBlock key={v.vendor} v={v} compare={cmp} />)}

          {/* Grand total */}
          <div className="report-keep-together flex flex-wrap items-baseline justify-between gap-2 rounded-xl border-2 border-accent/40 bg-card px-5 py-3">
            <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">Grand total · {vendors.length} {vendors.length === 1 ? 'vendor' : 'vendors'}{isHub && site === 'all' ? ' · all sites' : ''}{vendorSel.length ? ' · filtered' : ''}</div>
            <div className="font-display text-xl tabular-nums">
              {fmtCount(grand.qty)} units · R {fmtR(grand.ex)} ex · R {fmtR(grand.incl)} incl
              {cmp && <span className="text-base text-muted-foreground"> · vs R {fmtR(grand.py_ex)} PY (<YoY cur={grand.ex} py={grand.py_ex} />)</span>}
            </div>
          </div>
        </div>
      ) : null}
    </ReportFrame>
  );
}
