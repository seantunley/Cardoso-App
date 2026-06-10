import { useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ReportFrame, ChartCard, SummaryTile, PrintHeader, PrintFooter,
  fmtR, fmtCount, downloadCsv, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  AXIS_TICK, AXIS_LINE, AXIS_LABEL,
  TOOLTIP_CONTENT, TOOLTIP_LABEL, TOOLTIP_ITEM, TOOLTIP_CURSOR,
  LEGEND_WRAPPER,
  PALETTE, REPORT_COLORS, fmtCompactR,
} from './lib';
import BranchFilter from './BranchFilter';

function fetchInventoryValue(topN, site) {
  const qs = new URLSearchParams({ top: String(topN) });
  if (site && site !== 'all') qs.set('site', site);
  return fetch(`/api/reports/inventory-value?${qs.toString()}`, { credentials: 'include' })
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
}

export default function InventoryValue() {
  const [topN, setTopN] = useState(25);
  const [searchParams] = useSearchParams();
  const site = searchParams.get('site') || 'all';

  const { data, isLoading, error } = useQuery({
    queryKey: ['inventory-value', topN, site],
    queryFn: () => fetchInventoryValue(topN, site),
    staleTime: 60_000,
  });

  const summary = data?.summary;
  const byCommodity = data?.by_commodity || [];
  const topItems = data?.top_items || [];

  const commodityChartData = useMemo(() => byCommodity.slice(0, 12).map((c, i) => ({
    name: c.commodity.length > 24 ? c.commodity.slice(0, 22) + '…' : c.commodity,
    fullName: c.commodity,
    value: c.total_value,
    items: c.item_count,
    color: PALETTE[i % PALETTE.length],
  })), [byCommodity]);

  const topItemsChartData = useMemo(() => topItems.slice(0, 15).map(it => ({
    name: it.item_number || '—',
    desc: it.item_description,
    value: it.inventory_value,
    qty: it.qty_on_hand,
  })), [topItems]);

  const handleExportCsv = () => {
    const headers = ['Section', 'Item Number', 'Description', 'Commodity', 'Qty', 'Cost (R)', 'Value (R)'];
    const rows = topItems.map(it => ['Top Item', it.item_number, it.item_description, it.commodity, it.qty_on_hand, it.last_cost.toFixed(2), it.inventory_value.toFixed(2)]);
    const commodityRows = byCommodity.map(c => ['Commodity', '', c.commodity, c.commodity, c.total_qty, '', c.total_value.toFixed(2)]);
    downloadCsv(`inventory-value-${new Date().toISOString().slice(0, 10)}.csv`, [headers, ...commodityRows, ...rows]);
  };

  const generatedAt = data?.generated_at ? new Date(data.generated_at) : new Date();
  const generatedAtFmt = generatedAt.toLocaleString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <ReportFrame
      sectionLabel="Inventory"
      title={<>Inventory <em className="text-phosphor">value</em>.</>}
      subtitle="Total stock value broken down by commodity, plus the highest-value SKUs."
      printId="inventory-value"
      orientation="landscape"
      onExportCsv={topItems.length ? handleExportCsv : null}
      onPrint={() => window.print()}
      isLoading={isLoading}
      error={error}
      printHeader={
        <PrintHeader
          title="Inventory Value & Composition"
          period={data?.site_name}
          filters={[`Top ${topN} items`]}
          generatedAt={generatedAtFmt}
        />
      }
      printFooter={<PrintFooter note="Inventory Value · Cardoso" />}
    >
      <div className="report-print-hide bg-card border border-border p-3 grid grid-cols-2 lg:grid-cols-4 gap-3" style={{ borderRadius: '12px' }}>
        <div>
          <label className="block font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-1">Top items</label>
          <select
            value={topN}
            onChange={(e) => setTopN(parseInt(e.target.value, 10))}
            className="w-full bg-background border border-border text-foreground px-2 py-1.5 text-xs outline-none focus:border-accent"
            style={{ borderRadius: '12px' }}
          >
            {[10, 25, 50, 100, 200].map(n => <option key={n} value={n}>Top {n}</option>)}
          </select>
        </div>
        <BranchFilter hubMode={data?.hub_mode} sites={data?.filters?.sites} />
      </div>

      {data && summary && (
        <>
          <div className="report-print-summary grid grid-cols-2 md:grid-cols-3 gap-3">
            <SummaryTile label="Total inventory value" value={<><span className="text-muted-subtle mr-1">R</span>{fmtR(summary.total_value)}</>} accent={REPORT_COLORS.primary} big />
            <SummaryTile label="Distinct items" value={fmtCount(summary.total_items)} accent={REPORT_COLORS.info} />
            <SummaryTile label="Distinct commodities" value={fmtCount(summary.distinct_commodities)} accent={REPORT_COLORS.purple} />
          </div>

          <div className="report-print-hide grid grid-cols-1 lg:grid-cols-2 gap-3 mt-4">
            <ChartCard title="Value by Commodity" sub="Top 12">
              <PieChart>
                <Pie data={commodityChartData} dataKey="value" nameKey="name" innerRadius={60} outerRadius={110} paddingAngle={1}>
                  {commodityChartData.map((e, i) => <Cell key={i} fill={e.color} />)}
                </Pie>
                <Legend wrapperStyle={LEGEND_WRAPPER} iconType="square" />
                <Tooltip contentStyle={TOOLTIP_CONTENT} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={TOOLTIP_CURSOR}
                  formatter={(v, n, p) => [`R ${fmtR(v)} · ${p.payload.items} items`, p.payload.fullName]} />
              </PieChart>
            </ChartCard>
            <ChartCard title={`Top ${Math.min(topN, 15)} Items by Value`} sub="Highest-value SKUs" height={Math.max(280, topItemsChartData.length * 22)}>
              <BarChart data={topItemsChartData} layout="vertical" margin={{ top: 10, right: 16, left: 100, bottom: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis type="number" tick={AXIS_TICK} tickLine={AXIS_LINE} axisLine={AXIS_LINE} tickFormatter={fmtCompactR}
                  label={{ value: 'Value (R)', position: 'insideBottom', offset: -5, style: AXIS_LABEL }} />
                <YAxis type="category" dataKey="name" width={120} tick={AXIS_TICK} tickLine={AXIS_LINE} axisLine={AXIS_LINE} />
                <Tooltip contentStyle={TOOLTIP_CONTENT} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={TOOLTIP_CURSOR}
                  formatter={(v, n, p) => [`R ${fmtR(v)} · qty ${p.payload.qty}`, p.payload.desc || p.payload.name]} />
                <Bar dataKey="value" fill={REPORT_COLORS.primary} radius={[0, 2, 2, 0]} />
              </BarChart>
            </ChartCard>
          </div>

          <div className="report-print-section-title hidden">Value by Commodity</div>
          <div className="bg-card border border-border mt-4 overflow-auto" style={{ borderRadius: '12px' }}>
            <div className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground border-b border-border">By commodity</div>
            <table className="report-print-table w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Commodity</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">Items</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">Total Qty</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">% of value</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {byCommodity.map((c) => {
                  const pct = summary.total_value > 0 ? (c.total_value / summary.total_value) * 100 : 0;
                  return (
                    <tr key={c.commodity} className="border-b border-border hover:bg-muted/30">
                      <td className="px-2 py-1.5 text-foreground">{c.commodity}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground td-right">{c.item_count}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground td-right">{c.total_qty.toLocaleString('en-ZA', { maximumFractionDigits: 0 })}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground td-right">{pct.toFixed(1)}%</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-foreground td-right">
                        <span className="text-muted-subtle mr-1">R</span>{fmtR(c.total_value)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border bg-muted/30 font-semibold">
                  <td className="px-2 py-2 text-foreground">Total</td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums">{summary.total_items}</td>
                  <td className="px-2 py-2"></td>
                  <td className="px-2 py-2"></td>
                  <td className="px-2 py-2 text-right font-mono tabular-nums text-foreground td-right">
                    <span className="text-muted-subtle mr-1">R</span>{fmtR(summary.total_value)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="bg-card border border-border mt-4 overflow-auto" style={{ borderRadius: '12px' }}>
            <div className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground border-b border-border">Top {topN} items by value</div>
            <table className="report-print-table w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Item</th>
                  <th className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Description</th>
                  <th className="px-2 py-2 text-left font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground">Commodity</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">Qty</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">Cost</th>
                  <th className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground td-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {topItems.map(it => (
                  <tr key={it.item_number} className="border-b border-border hover:bg-muted/30">
                    <td className="px-2 py-1.5 font-mono text-foreground">{it.item_number}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{it.item_description}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{it.commodity}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground td-right">{it.qty_on_hand.toLocaleString('en-ZA', { maximumFractionDigits: 0 })}</td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground td-right">
                      <span className="text-muted-subtle mr-1">R</span>{fmtR(it.last_cost)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-foreground td-right">
                      <span className="text-muted-subtle mr-1">R</span>{fmtR(it.inventory_value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </ReportFrame>
  );
}
