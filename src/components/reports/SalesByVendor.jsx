import { useState, useMemo, Fragment } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ReportFrame, PrintHeader, PrintFooter, fmtR, fmtCount, downloadCsv } from './lib';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';

// Sales by Vendor — every item's sales grouped by the item's vendor (Sage ICITMV
// master) for a date range. Ex-VAT is Sage OE net sales; incl-VAT derived at the
// standard rate. Three controls:
//  • Compare prior year — same period last year + YoY %.
//  • By month — months become columns (ex-VAT); with compare, each month carries
//    a prior-year column beside it. Hub adds a Site dimension (Site -> Vendor ->
//    Item). CSV mirrors the matrix.
//  • Vendor multi-select filter.
// Site = exact days; hub = whole months from the rollups (range snaps to months).

const pad = (n) => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const monthStartISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`; };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mlabel = (p) => `${MON[parseInt(p.slice(5, 7), 10) - 1]} '${p.slice(2, 4)}`;
const pyMonth = (p) => `${parseInt(p.slice(0, 4), 10) - 1}${p.slice(4)}`;

function fetchData(from, to, site, compare, bymonth) {
  const qs = new URLSearchParams({ from, to });
  if (site && site !== 'all') qs.set('site', site);
  if (compare) qs.set('compare', '1');
  if (bymonth) qs.set('bymonth', '1');
  return fetch(`/api/reports/sales-by-vendor?${qs.toString()}`, { credentials: 'include' })
    .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

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
// ex-VAT cell: blank-ish dot for zero/empty so the matrix isn't a wall of 0.00.
const cell = (v) => (v ? <><span className="text-muted-subtle">R </span>{fmtR(v)}</> : <span className="text-muted-subtle">·</span>);

// ── Aggregate (non-by-month) vendor block ──────────────────────────────────
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

// ── By-month matrix: one vendor table, months as columns (PY beside if compare) ─
function MonthVendorBlock({ v, months, compare }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <div className="flex items-baseline justify-between border-b border-border px-4 py-2.5 print:break-after-avoid">
        <div className="font-display text-lg">{v.vendor}</div>
        <div className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
          {v.items.length} {v.items.length === 1 ? 'item' : 'items'} · <span className="tabular-nums text-foreground">R {fmtR(v.subtotal_total_ex)}</span> ex
          {compare && <span> · vs <span className="tabular-nums">R {fmtR(v.subtotal_py_total_ex)}</span> PY</span>}
        </div>
      </div>
      <table className="w-full text-sm report-doc-table" style={{ minWidth: 300 + months.length * (compare ? 215 : 90) + (compare ? 90 : 0) }}>
        <thead>
          <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-1.5 text-left font-medium">Item</th>
            <th className="px-3 py-1.5 text-left font-medium">Description</th>
            {months.map((m) => (
              <Fragment key={m}>
                <th className="px-3 py-1.5 text-right font-medium border-l border-border">{mlabel(m)}</th>
                {compare && <th className="px-3 py-1.5 text-right font-medium text-muted-subtle">{mlabel(pyMonth(m))}</th>}
                {compare && <th className="px-3 py-1.5 text-right font-medium">Δ</th>}
              </Fragment>
            ))}
            <th className="px-3 py-1.5 text-right font-medium border-l border-border">Total</th>
            {compare && <th className="px-3 py-1.5 text-right font-medium text-muted-subtle">PY</th>}
            {compare && <th className="px-3 py-1.5 text-right font-medium">YoY</th>}
          </tr>
        </thead>
        <tbody>
          {v.items.map((it, i) => (
            <tr key={i} className="border-b border-border/50 last:border-0 hover:bg-muted/20">
              <td className="px-3 py-1.5 font-mono text-xs text-foreground">{it.item_number}</td>
              <td className="px-3 py-1.5">{it.item_description || '—'}</td>
              {months.map((m) => (
                <Fragment key={m}>
                  <td className="px-3 py-1.5 text-right tabular-nums border-l border-border/40">{cell(it.cells[m])}</td>
                  {compare && <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{cell(it.py_cells[m])}</td>}
                  {compare && <td className="px-3 py-1.5 text-right tabular-nums text-xs"><YoY cur={it.cells[m] || 0} py={it.py_cells[m] || 0} /></td>}
                </Fragment>
              ))}
              <td className="px-3 py-1.5 text-right tabular-nums border-l border-border font-medium"><span className="text-muted-subtle">R </span>{fmtR(it.total_ex)}</td>
              {compare && <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{cell(it.py_total_ex)}</td>}
              {compare && <td className="px-3 py-1.5 text-right tabular-nums text-xs"><YoY cur={it.total_ex} py={it.py_total_ex} /></td>}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border bg-muted/40 font-semibold">
            <td className="px-3 py-1.5" colSpan={2}>{v.vendor} subtotal</td>
            {months.map((m) => (
              <Fragment key={m}>
                <td className="px-3 py-1.5 text-right tabular-nums border-l border-border">{cell(v.subtotal_cells[m])}</td>
                {compare && <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{cell(v.subtotal_py_cells[m])}</td>}
                {compare && <td className="px-3 py-1.5 text-right tabular-nums text-xs"><YoY cur={v.subtotal_cells[m] || 0} py={v.subtotal_py_cells[m] || 0} /></td>}
              </Fragment>
            ))}
            <td className="px-3 py-1.5 text-right tabular-nums border-l border-border"><span className="text-muted-subtle">R </span>{fmtR(v.subtotal_total_ex)}</td>
            {compare && <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{cell(v.subtotal_py_total_ex)}</td>}
            {compare && <td className="px-3 py-1.5 text-right tabular-nums text-xs"><YoY cur={v.subtotal_total_ex} py={v.subtotal_py_total_ex} /></td>}
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
  const [bymonth, setBymonth] = useState(false);
  const [vendorSel, setVendorSel] = useState([]); // empty = all vendors

  const { data, isLoading, error } = useQuery({
    queryKey: ['sales-by-vendor', from, to, site, compare, bymonth],
    queryFn: () => fetchData(from, to, site, compare, bymonth),
    staleTime: 60_000,
  });

  const isHub = !!data?.hub;
  const cmp = !!data?.compare;
  const bm = !!data?.bymonth;
  const months = data?.months || [];
  const siteOptions = data?.filters?.sites || [];
  const vatPct = Math.round((data?.vat_rate ?? 0.15) * 100);
  const rangeLabel = isHub && data?.period_from ? `${data.period_from} to ${data.period_to}` : `${from} to ${to}`;
  const pyLabel = data?.py_period_from ? `${data.py_period_from} to ${data.py_period_to}` : (data?.py_from ? `${data.py_from} to ${data.py_to}` : '');

  // Vendor names for the multi-select (union across hub site groups in by-month).
  const allVendorNames = useMemo(() => {
    if (bm) return Array.from(new Set((data?.groups || []).flatMap((g) => g.vendors.map((v) => v.vendor)))).sort();
    return (data?.vendors || []).map((v) => v.vendor);
  }, [bm, data]);
  const sel = (v) => (vendorSel.length ? vendorSel.includes(v) : true);

  // Aggregate-mode rows (filtered)
  const vendors = useMemo(
    () => ((data?.vendors || []).filter((v) => sel(v.vendor))),
    [data, vendorSel],
  );
  const grand = useMemo(() => vendors.reduce((g, v) => ({
    qty: g.qty + v.subtotal_qty, ex: g.ex + v.subtotal_ex, incl: g.incl + v.subtotal_incl,
    py_qty: g.py_qty + (v.py_subtotal_qty || 0), py_ex: g.py_ex + (v.py_subtotal_ex || 0), py_incl: g.py_incl + (v.py_subtotal_incl || 0),
  }), { qty: 0, ex: 0, incl: 0, py_qty: 0, py_ex: 0, py_incl: 0 }), [vendors]);

  // By-month groups (filtered) + grand
  const fGroups = useMemo(() => (
    (data?.groups || [])
      .map((g) => ({ ...g, vendors: g.vendors.filter((v) => sel(v.vendor)) }))
      .filter((g) => g.vendors.length)
  ), [data, vendorSel]);
  const bmGrand = useMemo(() => {
    const cells = {}, py_cells = {}; let total = 0, py_total = 0;
    for (const g of fGroups) for (const v of g.vendors) {
      for (const p of months) { cells[p] = (cells[p] || 0) + (v.subtotal_cells[p] || 0); py_cells[p] = (py_cells[p] || 0) + (v.subtotal_py_cells[p] || 0); }
      total += v.subtotal_total_ex; py_total += v.subtotal_py_total_ex;
    }
    return { cells, py_cells, total, py_total };
  }, [fGroups, months]);

  const hasData = bm ? fGroups.length > 0 : vendors.length > 0;

  const exportCsv = () => {
    if (bm) {
      const monthCols = months.flatMap((m) => (cmp ? [m, pyMonth(m), `${m} YoY%`] : [m]));
      const header = [...(isHub ? ['Site'] : []), 'Vendor', 'Item', 'Description', ...monthCols, 'Total', ...(cmp ? ['PY Total', 'YoY %'] : [])];
      const vals = (cells, py) => months.flatMap((m) => (cmp ? [(cells[m] || 0).toFixed(2), (py[m] || 0).toFixed(2), yoyText(cells[m] || 0, py[m] || 0)] : [(cells[m] || 0).toFixed(2)]));
      const totCols = (tot, pyTot) => [(tot || 0).toFixed(2), ...(cmp ? [(pyTot || 0).toFixed(2), yoyText(tot, pyTot)] : [])];
      const rows = [];
      for (const g of fGroups) {
        for (const v of g.vendors) {
          for (const it of v.items) rows.push([...(isHub ? [g.site_name || ''] : []), v.vendor, it.item_number, it.item_description || '', ...vals(it.cells, it.py_cells), ...totCols(it.total_ex, it.py_total_ex)]);
          rows.push([...(isHub ? [g.site_name || ''] : []), v.vendor, `${v.vendor} subtotal`, '', ...vals(v.subtotal_cells, v.subtotal_py_cells), ...totCols(v.subtotal_total_ex, v.subtotal_py_total_ex)]);
        }
      }
      rows.push([...(isHub ? [''] : []), 'GRAND TOTAL', '', '', ...vals(bmGrand.cells, bmGrand.py_cells), ...totCols(bmGrand.total, bmGrand.py_total)]);
      downloadCsv(`sales-by-vendor-bymonth-${from}_to_${to}${cmp ? '-yoy' : ''}${isHub && site !== 'all' ? `-${site}` : ''}.csv`, [header, ...rows]);
      return;
    }
    const header = ['Vendor', 'Item', 'Description', 'Qty', ...(cmp ? ['PY Qty', 'Qty %'] : []), 'Ex-VAT', ...(cmp ? ['PY Ex-VAT', 'Value %'] : []), 'Incl-VAT'];
    const rows = [];
    const line = (vendor, item, desc, it) => [vendor, item, desc,
      it.qty, ...(cmp ? [it.py_qty, yoyText(it.qty, it.py_qty)] : []),
      (Number(it.ex_vat) || 0).toFixed(2), ...(cmp ? [(Number(it.py_ex_vat) || 0).toFixed(2), yoyText(it.ex_vat, it.py_ex_vat)] : []),
      (Number(it.incl_vat) || 0).toFixed(2)];
    for (const v of vendors) {
      for (const it of v.items) rows.push(line(v.vendor, it.item_number, it.item_description || '', it));
      rows.push(line(v.vendor, `${v.vendor} subtotal`, '', { qty: v.subtotal_qty, py_qty: v.py_subtotal_qty, ex_vat: v.subtotal_ex, py_ex_vat: v.py_subtotal_ex, incl_vat: v.subtotal_incl }));
    }
    rows.push(line('GRAND TOTAL', '', '', { qty: grand.qty, py_qty: grand.py_qty, ex_vat: grand.ex, py_ex_vat: grand.py_ex, incl_vat: grand.incl }));
    downloadCsv(`sales-by-vendor-${from}_to_${to}${cmp ? '-yoy' : ''}${isHub && site !== 'all' ? `-${site}` : ''}.csv`, [header, ...rows]);
  };

  const generatedAtFmt = new Date().toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const filterChips = [`Range: ${rangeLabel}`, ...(cmp ? [`vs PY: ${pyLabel}`] : []), ...(bm ? ['By month'] : []), ...(isHub ? [`Site: ${site === 'all' ? 'All sites' : site}`] : []), ...(vendorSel.length ? [`Vendors: ${vendorSel.length} selected`] : []), `Ex-VAT @ ${vatPct}%`];

  return (
    <ReportFrame
      title={<>Sales <em className="text-phosphor">by Vendor</em>.</>}
      subtitle={`Item sales by vendor (Sage item/vendor master) for ${rangeLabel}${cmp ? `, vs ${pyLabel}` : ''}${bm ? ', by month' : ''}${isHub && site === 'all' ? ', all sites' : ''}. Ex-VAT is Sage net sales.`}
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
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{allVendorNames.length} vendors</span>
                <button type="button" onClick={() => setVendorSel([])} className="font-mono text-[10px] uppercase tracking-wider text-phosphor hover:underline">Clear</button>
              </div>
              {allVendorNames.map((name) => (
                <label key={name} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted/40">
                  <Checkbox checked={vendorSel.includes(name)} onCheckedChange={(c) => setVendorSel(c ? [...vendorSel, name] : vendorSel.filter((x) => x !== name))} />
                  <span className="truncate">{name}</span>
                </label>
              ))}
            </PopoverContent>
          </Popover>
        </div>
        <label className="flex cursor-pointer items-center gap-2">
          <Checkbox checked={compare} onCheckedChange={(c) => setCompare(!!c)} />
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Compare prior year</span>
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <Checkbox checked={bymonth} onCheckedChange={(c) => setBymonth(!!c)} />
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">By month</span>
        </label>
      </div>

      {bm && data?.partial && (
        <div className="report-print-hide mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200">
          {data.partial_note || `Stored sales data starts ${data.data_from}; earlier months are blank.`}
        </div>
      )}

      {data && data.vendor_map_rows === 0 && (
        <div className="report-print-hide mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-xs text-red-200">
          <span className="font-semibold uppercase tracking-wider">Vendor map empty</span> — every item shows as “(No vendor)” because the item→vendor master (Sage ICITMV) hasn’t loaded.{' '}
          {isHub
            ? 'The hub has pulled no item→vendor data from the sites — a site is likely failing reporting auth (401) or isn’t on this version yet.'
            : 'Run Inventory Movement → Sync to pull it (or this Sage company has no ICITMV item-vendor links configured).'}
        </div>
      )}

      {!isLoading && !error && !hasData ? (
        <div className="rounded-xl border border-border bg-card px-6 py-12 text-center text-sm text-muted-foreground">
          No sales found for {rangeLabel}{vendorSel.length ? ' for the selected vendors' : ''}.
        </div>
      ) : hasData ? (
        <div className="space-y-6">
          {bm ? (
            <>
              {fGroups.map((g) => (
                <Fragment key={g.site_id || 'site'}>
                  {isHub && (
                    <div className="flex items-baseline justify-between rounded-xl border border-border border-l-2 border-l-[var(--phosphor)] bg-card px-4 py-2.5">
                      <div className="font-display text-xl">{g.site_name || g.site_id}</div>
                    </div>
                  )}
                  <div className={isHub ? 'space-y-4 pl-1' : 'space-y-4'}>
                    {g.vendors.map((v) => <MonthVendorBlock key={`${g.site_id || ''}-${v.vendor}`} v={v} months={months} compare={cmp} />)}
                  </div>
                </Fragment>
              ))}
              <div className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl border-2 border-accent/40 bg-card px-5 py-3">
                <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">Grand total{isHub && site === 'all' ? ' · all sites' : ''}{vendorSel.length ? ' · filtered' : ''}</div>
                <div className="font-display text-xl tabular-nums">R {fmtR(bmGrand.total)} ex{cmp && <span className="text-base text-muted-foreground"> · vs R {fmtR(bmGrand.py_total)} PY (<YoY cur={bmGrand.total} py={bmGrand.py_total} />)</span>}</div>
              </div>
            </>
          ) : (
            <>
              {vendors.map((v) => <VendorBlock key={v.vendor} v={v} compare={cmp} />)}
              <div className="report-keep-together flex flex-wrap items-baseline justify-between gap-2 rounded-xl border-2 border-accent/40 bg-card px-5 py-3">
                <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-accent">Grand total · {vendors.length} {vendors.length === 1 ? 'vendor' : 'vendors'}{isHub && site === 'all' ? ' · all sites' : ''}{vendorSel.length ? ' · filtered' : ''}</div>
                <div className="font-display text-xl tabular-nums">
                  {fmtCount(grand.qty)} units · R {fmtR(grand.ex)} ex · R {fmtR(grand.incl)} incl
                  {cmp && <span className="text-base text-muted-foreground"> · vs R {fmtR(grand.py_ex)} PY (<YoY cur={grand.ex} py={grand.py_ex} />)</span>}
                </div>
              </div>
            </>
          )}
        </div>
      ) : null}
    </ReportFrame>
  );
}
