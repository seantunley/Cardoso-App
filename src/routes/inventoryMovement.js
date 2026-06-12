import { Router } from 'express';
import db from '../db/index.js';
import { logAudit } from '../lib/audit.js';
import { logError } from '../lib/errorLog.js';
import {
  syncSalesFromSage,
  getSyncMeta,
  getTopMovers,
  getItemTrend,
  getDeadStock,
  getCommodities,
  getSuppliers,
  getItemTransactions,
  getItemStats,
} from '../services/inventoryMovement.js';
import {
  syncInventoryMovement,
  getInventoryMovementSyncMeta,
  searchMovementItems,
  getItemLedger,
} from '../services/inventoryMovementHistory.js';
import {
  computeAllForecasts,
  getForecastList,
  getForecastConfig,
  updateForecastConfig,
  getItemSeasonality,
  getReorderPlan,
} from '../services/inventoryForecast.js';
import { siteIdFilter, isSiteAllowed, getAllowedSiteIds } from '../lib/hubSiteScope.js';

function isHub() { return process.env.HUB_MODE === 'true'; }

function hubTopMovers({ from, to, limit = 50, commodity, siteId, siteFilter = { sql: '', params: [] } }) {
  // Build params in exact SQL placeholder order:
  //   1. scWhere: [siteId?, from?, to?]
  //   2. ir subquery WHERE: [siteId?]
  //   3. outer WHERE commodity: [commodity?]
  //   4. LIMIT: [limit]
  //
  // Sales are always grouped per (site_id, item_number) — each site
  // holds physical stock independently, so collapsing would pair
  // multi-site sales totals with one arbitrary site's inventory row.
  // Hub stores monthly aggregates only — accept YYYY-MM-DD from the
  // day-precision selector but slice to YYYY-MM to match hub_inventory_sales.period.
  const fromMo = from ? from.slice(0, 7) : from;
  const toMo = to ? to.slice(0, 7) : to;

  let scWhere = 'WHERE 1=1';
  const scParams = [];
  if (siteId) { scWhere += ' AND sc.site_id = ?'; scParams.push(siteId); }
  if (fromMo) { scWhere += ' AND sc.period >= ?'; scParams.push(fromMo); }
  if (toMo) { scWhere += ' AND sc.period <= ?'; scParams.push(toMo); }
  scWhere += siteFilter.sql; scParams.push(...siteFilter.params); // hub allow-list (sc.site_id)

  // When a commodity filter is active, use INNER JOIN so only items
  // matching that commodity appear in the results. Without a filter,
  // LEFT JOIN preserves items with sales but no hub_inventory record.
  let irFilter = 'WHERE 1=1';
  const irSubParams = [];
  if (siteId) { irFilter += ' AND site_id = ?'; irSubParams.push(siteId); }
  if (commodity) { irFilter += ' AND commodity = ?'; irSubParams.push(commodity); }
  const joinType = commodity ? 'INNER JOIN' : 'LEFT JOIN';

  const params = [...scParams, ...irSubParams, limit];

  return db.prepare(`
    SELECT
      agg.item_number,
      ir.item_description,
      ir.commodity,
      CAST(REPLACE(REPLACE(COALESCE(ir.qty_on_hand, '0'), ',', ''), ' ', '') AS REAL) AS qty_on_hand,
      CAST(REPLACE(REPLACE(COALESCE(ir.last_cost, '0'), ',', ''), ' ', '') AS REAL) AS last_cost,
      ir.price,
      ir.stocking_uom,
      COALESCE(s.name, agg.site_id) AS site_name,
      agg.site_id,
      agg.total_qty_sold,
      agg.total_revenue,
      agg.total_orders,
      agg.last_sale_date
    FROM (
      SELECT
        sc.site_id,
        sc.item_number,
        SUM(sc.qty_sold)       AS total_qty_sold,
        SUM(sc.revenue)        AS total_revenue,
        SUM(sc.order_count)    AS total_orders,
        MAX(sc.last_sale_date) AS last_sale_date
      FROM hub_inventory_sales sc
      ${scWhere}
      GROUP BY sc.site_id, sc.item_number
    ) agg
    ${joinType} (
      SELECT site_id, TRIM(item_number) AS item_number,
             TRIM(item_description) AS item_description,
             TRIM(commodity) AS commodity,
             qty_on_hand, last_cost, price,
             TRIM(stocking_uom) AS stocking_uom,
             ROW_NUMBER() OVER (PARTITION BY site_id, TRIM(item_number) ORDER BY synced_at DESC) AS rn
      FROM hub_inventory
      ${irFilter}
    ) ir ON ir.item_number = agg.item_number AND ir.rn = 1
            AND ir.site_id = agg.site_id
    LEFT JOIN hub_sites s ON s.id = agg.site_id
    ORDER BY agg.total_qty_sold DESC
    LIMIT ?
  `).all(...params);
}

function hubItemTrend({ itemNumber, from, to, siteId, siteFilter = { sql: '', params: [] } }) {
  const fromMo = from ? from.slice(0, 7) : from;
  const toMo = to ? to.slice(0, 7) : to;
  let where = 'WHERE sc.item_number = ?';
  const params = [itemNumber];
  if (siteId) { where += ' AND sc.site_id = ?'; params.push(siteId); }
  if (fromMo) { where += ' AND sc.period >= ?'; params.push(fromMo); }
  if (toMo) { where += ' AND sc.period <= ?'; params.push(toMo); }
  where += siteFilter.sql; params.push(...siteFilter.params); // hub allow-list (sc.site_id)

  return db.prepare(`
    SELECT
      sc.period,
      SUM(sc.qty_sold)    AS qty_sold,
      SUM(sc.revenue)     AS revenue,
      SUM(sc.order_count) AS order_count,
      MAX(sc.last_sale_date) AS last_sale_date
    FROM hub_inventory_sales sc
    ${where}
    GROUP BY sc.period
    ORDER BY sc.period ASC
  `).all(...params);
}

function hubDeadStock({ thresholdDays = 90, minValue = 0, limit = 100, commodity, siteId, siteFilter = { sql: '', params: [] } }) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - thresholdDays);
  const cutoff = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, '0')}-${String(cutoffDate.getDate()).padStart(2, '0')}`;

  // Always partition/group by (site_id, item_number) — each site holds
  // physical stock independently, so collapsing across sites would hide
  // which location has the dead stock and inflate/deflate qty + capital.
  //
  // Params are assembled in exact SQL placeholder order:
  //   irWhere: [siteId?, commodity?]
  //   then:    [cutoff, minValue]
  //   LIMIT:   [limit]
  let irWhere = 'WHERE ir.rn = 1 AND ir.qty_num > 0';
  const irParams = [];
  if (siteId) { irWhere += ' AND ir.site_id = ?'; irParams.push(siteId); }
  if (commodity) { irWhere += ' AND ir.commodity = ?'; irParams.push(commodity); }
  irWhere += siteFilter.sql; irParams.push(...siteFilter.params); // hub allow-list (ir.site_id)
  const params = [...irParams, cutoff, minValue, limit];

  return db.prepare(`
    SELECT
      ir.item_number,
      ir.item_description,
      ir.commodity,
      ir.qty_num   AS qty_on_hand,
      ir.cost_num  AS last_cost,
      ir.price,
      ir.stocking_uom,
      COALESCE(s.name, ir.site_id) AS site_name,
      ir.site_id,
      COALESCE(sale.last_sale_date, 'never') AS last_sale_date,
      CASE
        WHEN sale.last_sale_date IS NULL THEN 999999
        ELSE CAST(julianday('now') - julianday(sale.last_sale_date) AS INTEGER)
      END AS days_since_sale,
      ROUND(ir.qty_num * ir.cost_num, 2) AS capital_tied_up
    FROM (
      SELECT site_id, item_number, item_description, commodity, qty_on_hand, last_cost, price, stocking_uom,
             CAST(REPLACE(REPLACE(COALESCE(qty_on_hand, '0'), ',', ''), ' ', '') AS REAL) AS qty_num,
             CAST(REPLACE(REPLACE(COALESCE(last_cost, '0'), ',', ''), ' ', '') AS REAL) AS cost_num,
             ROW_NUMBER() OVER (PARTITION BY site_id, item_number ORDER BY synced_at DESC) AS rn
      FROM hub_inventory
    ) ir
    LEFT JOIN (
      SELECT site_id, item_number, MAX(last_sale_date) AS last_sale_date
      FROM hub_inventory_sales
      GROUP BY site_id, item_number
    ) sale ON sale.item_number = ir.item_number AND sale.site_id = ir.site_id
    LEFT JOIN hub_sites s ON s.id = ir.site_id
    ${irWhere}
      AND (sale.last_sale_date IS NULL OR sale.last_sale_date < ?)
      AND ROUND(ir.qty_num * ir.cost_num, 2) >= ?
    ORDER BY capital_tied_up DESC
    LIMIT ?
  `).all(...params);
}

function hubCommodities() {
  return db.prepare(
    "SELECT DISTINCT commodity FROM hub_inventory WHERE commodity IS NOT NULL AND TRIM(commodity) != '' ORDER BY commodity"
  ).all().map(r => r.commodity);
}

function hubSites() {
  return db.prepare("SELECT id, COALESCE(name, slug, id) AS name FROM hub_sites ORDER BY name").all();
}

export function createInventoryMovementRouter({ requireAuth, requireAdmin, requirePermission }) {
  const router = Router();
  const guard = [requireAuth, requirePermission('can_access_inventory_movement')];

  router.get('/api/inventory-movement/top-movers', ...guard, (req, res) => {
    try {
      const { from, to, limit, commodity, site_id, supplier } = req.query;
      if (isHub() && site_id && site_id !== 'all' && !isSiteAllowed(req, res, site_id)) {
        return res.status(403).json({ error: 'Not permitted for this site' });
      }
      const rows = isHub()
        ? hubTopMovers({
            from: from || undefined, to: to || undefined,
            limit: Math.max(1, parseInt(limit, 10) || 50),
            commodity: commodity && commodity !== 'all' ? commodity : undefined,
            siteId: site_id && site_id !== 'all' ? site_id : undefined,
            siteFilter: siteIdFilter(req, res, 'sc.site_id'),
          })
        : getTopMovers({
            from: from || undefined, to: to || undefined,
            limit: Math.max(1, parseInt(limit, 10) || 50),
            commodity: commodity && commodity !== 'all' ? commodity : undefined,
            supplier: supplier && supplier !== 'all' ? supplier : undefined,
          });
      res.json({ rows });
    } catch (err) {
      logError('inventoryMovement.top_movers', err, { query: req.query });
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/inventory-movement/item-trend', ...guard, (req, res) => {
    try {
      const { item, from, to, site_id } = req.query;
      if (!item) return res.status(400).json({ error: 'item is required' });
      if (isHub() && site_id && site_id !== 'all' && !isSiteAllowed(req, res, site_id)) {
        return res.status(403).json({ error: 'Not permitted for this site' });
      }
      const rows = isHub()
        ? hubItemTrend({
            itemNumber: item, from: from || undefined, to: to || undefined,
            siteId: site_id && site_id !== 'all' ? site_id : undefined,
            siteFilter: siteIdFilter(req, res, 'sc.site_id'),
          })
        : getItemTrend({ itemNumber: item, from: from || undefined, to: to || undefined });
      res.json({ rows });
    } catch (err) {
      logError('inventoryMovement.item_trend', err, { item: req.query?.item });
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/inventory-movement/dead-stock', ...guard, (req, res) => {
    try {
      const { threshold, minValue, limit, commodity, site_id, supplier } = req.query;
      if (isHub() && site_id && site_id !== 'all' && !isSiteAllowed(req, res, site_id)) {
        return res.status(403).json({ error: 'Not permitted for this site' });
      }
      const rows = isHub()
        ? hubDeadStock({
            thresholdDays: Math.max(1, parseInt(threshold, 10) || 90),
            minValue: parseFloat(minValue) || 0,
            limit: Math.max(1, parseInt(limit, 10) || 100),
            commodity: commodity && commodity !== 'all' ? commodity : undefined,
            siteId: site_id && site_id !== 'all' ? site_id : undefined,
            siteFilter: siteIdFilter(req, res, 'ir.site_id'),
          })
        : getDeadStock({
            thresholdDays: Math.max(1, parseInt(threshold, 10) || 90),
            minValue: parseFloat(minValue) || 0,
            limit: Math.max(1, parseInt(limit, 10) || 100),
            commodity: commodity && commodity !== 'all' ? commodity : undefined,
            supplier: supplier && supplier !== 'all' ? supplier : undefined,
          });
      res.json({ rows });
    } catch (err) {
      logError('inventoryMovement.dead_stock', err, { query: req.query });
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/inventory-movement/sync-meta', ...guard, (_req, res) => {
    try {
      if (isHub()) return res.json({ hub: true, message: 'Hub syncs movement data from sites during ETL' });
      res.json(getSyncMeta());
    } catch (err) {
      logError('inventoryMovement.sync_meta', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/inventory-movement/sync', requireAuth, requirePermission('can_access_inventory_movement'), async (req, res) => {
    if (isHub()) return res.status(400).json({ error: 'Hub does not sync from Sage directly — data comes from sites during ETL sync.' });
    try {
      const result = await syncSalesFromSage();
      // Sales cache + forecast inputs just changed — drop the insights cache
      // so the next load recomputes. (Can't centralise in the sales-sync
      // service: insights imports it, so importing insights back would cycle.)
      try {
        const { invalidateInsightsCache } = await import('../services/insights.js');
        invalidateInsightsCache();
      } catch (e) {
        console.error('[insights] cache invalidation after sales sync failed:', e.message);
      }
      logAudit({
        req,
        action: 'inventoryMovement.sync',
        resourceType: 'inventory_sales_cache',
        resourceId: 'sync',
        resourceName: 'Inventory sales sync',
        details: `Synced ${result.synced} aggregates, ${result.transactions} transactions from Sage`,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      const isSageDown = /no sage|not configured|ECONNREFUSED|ETIMEOUT|login failed/i.test(err.message);
      logError('inventoryMovement.sync', err, { sage_down: isSageDown });
      res.status(isSageDown ? 503 : 500).json({ error: err.message });
    }
  });

  // ── Movement history (stock card) — per-branch ──────────────────────────
  // Item picker: items with on-hand or movement history at this site.
  router.get('/api/inventory-movement/movement-items', ...guard, (req, res) => {
    try {
      if (isHub()) return res.json({ hub: true, rows: [] });
      const rows = searchMovementItems({ q: String(req.query.q || ''), limit: Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30)) });
      res.json({ rows });
    } catch (err) {
      logError('inventoryMovement.movement_items', err, { q: req.query?.q });
      res.status(500).json({ error: err.message });
    }
  });

  // The stock card for one item/location: opening → movements (running balance)
  // → closing, anchored to and reconciled against current on-hand.
  router.get('/api/inventory-movement/item-ledger', ...guard, (req, res) => {
    try {
      if (isHub()) return res.status(400).json({ error: 'Movement history is per-branch; open it on a site.' });
      const { item, location, from, to } = req.query;
      if (!item || !location) return res.status(400).json({ error: 'item and location are required' });
      const ledger = getItemLedger({ itemNumber: item, location, from: from || undefined, to: to || undefined });
      if (!ledger) return res.status(404).json({ error: 'No on-hand record for that item/location' });
      res.json(ledger);
    } catch (err) {
      logError('inventoryMovement.item_ledger', err, { item: req.query?.item, location: req.query?.location });
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/inventory-movement/movement-sync-meta', ...guard, (_req, res) => {
    try {
      if (isHub()) return res.json({ hub: true, message: 'Movement history is per-branch.' });
      res.json(getInventoryMovementSyncMeta());
    } catch (err) {
      logError('inventoryMovement.movement_sync_meta', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/inventory-movement/sync-movement', requireAuth, requirePermission('can_access_inventory_movement'), async (req, res) => {
    if (isHub()) return res.status(400).json({ error: 'Hub does not sync from Sage directly.' });
    try {
      const result = await syncInventoryMovement();
      logAudit({
        req,
        action: 'inventoryMovement.sync_movement',
        resourceType: 'inventory_movement',
        resourceId: 'sync',
        resourceName: 'Inventory movement history sync',
        details: `Pulled ${result.inserted} movements (${result.totalMovements} total), ${result.onhand} on-hand rows from Sage`,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      const isSageDown = /no sage|not configured|ECONNREFUSED|ETIMEOUT|login failed/i.test(err.message);
      logError('inventoryMovement.sync_movement', err, { sage_down: isSageDown });
      res.status(isSageDown ? 503 : 500).json({ error: err.message });
    }
  });

  router.get('/api/inventory-movement/commodities', ...guard, (_req, res) => {
    try {
      res.json({ commodities: isHub() ? hubCommodities() : getCommodities() });
    } catch (err) {
      logError('inventoryMovement.commodities', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/inventory-movement/suppliers', ...guard, (_req, res) => {
    try {
      // Hub doesn't have local stock_receipt rows; suppliers list is
      // site-only for now. Empty array is a clean signal to the UI to
      // hide the filter dropdown.
      res.json({ suppliers: isHub() ? [] : getSuppliers() });
    } catch (err) {
      logError('inventoryMovement.suppliers', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/inventory-movement/sites', ...guard, (req, res) => {
    try {
      let sites = isHub() ? hubSites() : [];
      // Restrict the site picker to the user's allowed sites.
      const allowedIds = getAllowedSiteIds(req, res);
      if (isHub() && allowedIds !== null) {
        sites = sites.filter((s) => allowedIds.has(s.id) || allowedIds.has(Number(s.id)) || allowedIds.has(String(s.id)));
      }
      res.json({ hub: isHub(), sites });
    } catch (err) {
      logError('inventoryMovement.sites', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/inventory-movement/item-transactions', ...guard, (req, res) => {
    if (isHub()) return res.status(400).json({ error: 'Transaction drill-through is only available on site installs. Hub shows aggregated data from ETL sync.' });
    try {
      const { item, from, to, limit } = req.query;
      if (!item) return res.status(400).json({ error: 'item is required' });
      const rows = getItemTransactions({
        itemNumber: item,
        from: from || undefined,
        to: to || undefined,
        limit: Math.max(1, parseInt(limit, 10) || 500),
      });
      res.json({ rows });
    } catch (err) {
      logError('inventoryMovement.item_transactions', err, { item: req.query?.item });
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/inventory-movement/item-stats', ...guard, (req, res) => {
    if (isHub()) return res.status(400).json({ error: 'Item stats are only available on site installs.' });
    try {
      const { item } = req.query;
      if (!item) return res.status(400).json({ error: 'item is required' });
      res.json(getItemStats({ itemNumber: item }));
    } catch (err) {
      logError('inventoryMovement.item_stats', err, { item: req.query?.item });
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/inventory-movement/forecast', ...guard, (req, res) => {
    if (isHub()) return res.status(400).json({ error: 'Forecast is only available on site installs.' });
    try {
      const { sort, dir, abc, limit, commodity, supplier } = req.query;
      const rows = getForecastList({
        sortField: sort || 'days_of_stock',
        sortDir: dir || 'asc',
        abcFilter: abc || 'all',
        limit: Math.max(1, parseInt(limit, 10) || 200),
        commodity: commodity && commodity !== 'all' ? commodity : undefined,
        supplier: supplier && supplier !== 'all' ? supplier : undefined,
      });
      res.json({ rows });
    } catch (err) {
      logError('inventoryMovement.forecast', err, { query: req.query });
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/inventory-movement/forecast-config', ...guard, (_req, res) => {
    if (isHub()) return res.status(400).json({ error: 'Forecast config is only available on site installs.' });
    try {
      res.json(getForecastConfig());
    } catch (err) {
      logError('inventoryMovement.forecast_config_get', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/inventory-movement/forecast-config', requireAuth, requireAdmin, (req, res) => {
    if (isHub()) return res.status(400).json({ error: 'Forecast config is only available on site installs.' });
    try {
      const before = getForecastConfig();
      updateForecastConfig(req.body || {});
      const after = getForecastConfig();
      logAudit({
        req,
        action: 'inventoryMovement.forecast_config_update',
        resourceType: 'inventory_forecast_config',
        resourceId: '__global__',
        resourceName: 'Forecast config (global)',
        details: 'Updated global forecast parameters',
        changes: { before, after },
      });
      res.json({ ok: true, config: after });
    } catch (err) {
      logError('inventoryMovement.forecast_config_update', err, { body: req.body });
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/inventory-movement/recompute-forecast', ...guard, (req, res) => {
    if (isHub()) return res.status(400).json({ error: 'Forecast is only available on site installs.' });
    try {
      const result = computeAllForecasts();
      logAudit({
        req,
        action: 'inventoryMovement.forecast_recompute',
        resourceType: 'inventory_forecast',
        resourceId: 'recompute',
        resourceName: 'Forecast recompute',
        details: `Recomputed forecast for ${result.computed} items`,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      logError('inventoryMovement.forecast_recompute', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/inventory-movement/item-seasonality', ...guard, (req, res) => {
    if (isHub()) return res.status(400).json({ error: 'Seasonality is only available on site installs.' });
    try {
      const { item } = req.query;
      if (!item) return res.status(400).json({ error: 'item is required' });
      res.json(getItemSeasonality(item));
    } catch (err) {
      logError('inventoryMovement.item_seasonality', err, { item: req.query?.item });
      res.status(500).json({ error: err.message });
    }
  });

  // Reorder / purchase plan — forecast rows that need ordering now, grouped
  // by supplier. JSON view backs the UI; ?export builds a supplier-grouped
  // purchase-suggestion spreadsheet.
  router.get('/api/inventory-movement/reorder-plan', ...guard, (req, res) => {
    if (isHub()) return res.status(400).json({ error: 'Reorder plan is only available on site installs.' });
    try {
      const { commodity, supplier } = req.query;
      const rows = getReorderPlan({
        commodity: commodity && commodity !== 'all' ? commodity : undefined,
        supplier: supplier && supplier !== 'all' ? supplier : undefined,
      });
      res.json({ rows });
    } catch (err) {
      logError('inventoryMovement.reorder_plan', err, { query: req.query });
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/inventory-movement/reorder-plan/export', ...guard, async (req, res) => {
    if (isHub()) return res.status(400).json({ error: 'Reorder plan is only available on site installs.' });
    try {
      const { commodity, supplier } = req.query;
      const rows = getReorderPlan({
        commodity: commodity && commodity !== 'all' ? commodity : undefined,
        supplier: supplier && supplier !== 'all' ? supplier : undefined,
      });

      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Reorder Plan');
      ws.addRow(['Supplier', 'Item', 'Description', 'Commodity', 'ABC', 'On Hand', 'Reorder Point', 'Days of Stock', 'Suggested Order Qty']);

      // Rows arrive supplier-grouped from getReorderPlan; emit a subtotal
      // row each time the supplier changes so the buyer can split POs.
      let currentSupplier = null;
      let supplierQty = 0;
      const flushSubtotal = () => {
        if (currentSupplier !== null) {
          ws.addRow(['', '', '', '', '', '', '', `${currentSupplier} total`, Math.round(supplierQty * 10) / 10]);
        }
      };
      for (const r of rows) {
        if (r.supplier_name !== currentSupplier) {
          flushSubtotal();
          currentSupplier = r.supplier_name;
          supplierQty = 0;
        }
        supplierQty += Number(r.suggested_order_qty) || 0;
        ws.addRow([
          r.supplier_name || '',
          String(r.item_number || '').trim(),
          String(r.item_description || '').trim(),
          String(r.commodity || '').trim(),
          r.abc_class || '',
          r.qty_on_hand ?? 0,
          r.reorder_point ?? 0,
          r.days_of_stock ?? null,
          r.suggested_order_qty ?? 0,
        ]);
      }
      flushSubtotal();

      const buf = await wb.xlsx.writeBuffer();
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="reorder-plan-${stamp}.xlsx"`);
      res.send(Buffer.from(buf));
    } catch (err) {
      logError('inventoryMovement.reorder_plan_export', err, { query: req.query });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
