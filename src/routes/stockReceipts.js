import { Router } from 'express';
import db from '../db/index.js';
import {
  syncReceiptsFromSage,
  getSyncMeta,
  listReceiptLines,
  getLineWithExpiries,
  addExpiry,
  normaliseIsoDate,
} from '../services/stockReceipts.js';
import { siteIdFilter, isSiteAllowed, getAllowedSiteIds } from '../lib/hubSiteScope.js';

function isHub() { return process.env.HUB_MODE === 'true'; }

function hubListLines({ search, missingExpiry, siteId, limit = 200, siteFilter = { sql: '', params: [] } }) {
  let whereSql = 'WHERE 1=1';
  const params = [];
  if (siteId) { whereSql += ' AND h.site_id = ?'; params.push(siteId); }
  if (search) {
    whereSql += ' AND (h.receipt_number LIKE ? OR h.item_number LIKE ? OR h.item_description LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (missingExpiry) {
    whereSql += ' AND h.expiry_date IS NULL';
  }
  whereSql += siteFilter.sql; params.push(...siteFilter.params); // hub allow-list (h.site_id)
  const safeLimit = Math.max(1, Math.min(limit, 1000));
  params.push(safeLimit);

  return db.prepare(`
    SELECT
      h.site_id,
      COALESCE(s.name, h.site_id) AS site_name,
      h.receipt_number, h.supplier_name, h.receipt_date,
      h.receipt_line_id, h.line_no, h.item_number, h.item_description,
      h.qty_received, h.uom, h.unit_cost,
      h.expiry_date, h.qty_at_expiry, h.entered_by, h.entry_source, h.notes, h.expiry_created
    FROM hub_stock_receipt_expiry h
    LEFT JOIN hub_sites s ON s.id = h.site_id
    ${whereSql}
    ORDER BY h.receipt_date DESC, h.receipt_number, h.line_no, h.expiry_date ASC
    LIMIT ?
  `).all(...params);
}

function hubSites() {
  return db.prepare("SELECT id, COALESCE(name, slug, id) AS name FROM hub_sites ORDER BY name").all();
}

export function createStockReceiptRouter({ requireAuth, requirePermission }) {
  const router = Router();
  const guard = [requireAuth, requirePermission('can_access_stock_receipt_expiry')];

  // Static paths BEFORE parameterised :lineId routes.

  router.get('/api/stock-receipts/sync-meta', ...guard, (_req, res) => {
    try {
      if (isHub()) return res.json({ hub: true, message: 'Hub syncs receipt data from sites during ETL' });
      res.json(getSyncMeta());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/stock-receipts/sync', ...guard, async (_req, res) => {
    if (isHub()) return res.status(400).json({ error: 'Hub does not sync from Sage directly — data comes from sites during ETL.' });
    try {
      const result = await syncReceiptsFromSage();
      res.json({ ok: true, ...result });
    } catch (err) {
      const isSageDown = /no sage|not configured|ECONNREFUSED|ETIMEOUT|login failed/i.test(err.message);
      res.status(isSageDown ? 503 : 500).json({ error: err.message });
    }
  });

  router.get('/api/stock-receipts/sites', ...guard, (req, res) => {
    try {
      let sites = isHub() ? hubSites() : [];
      const allowedIds = getAllowedSiteIds(req, res);
      if (isHub() && allowedIds !== null) {
        sites = sites.filter((s) => allowedIds.has(s.id) || allowedIds.has(Number(s.id)) || allowedIds.has(String(s.id)));
      }
      res.json({ hub: isHub(), sites });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/stock-receipts', ...guard, (req, res) => {
    try {
      const search = String(req.query.search || '').trim();
      const missingExpiry = req.query.missing_expiry === 'true';
      const limit = parseInt(req.query.limit, 10) || 200;

      if (isHub()) {
        const siteId = req.query.site_id && req.query.site_id !== 'all' ? req.query.site_id : undefined;
        if (siteId && !isSiteAllowed(req, res, siteId)) {
          return res.status(403).json({ error: 'Not permitted for this site' });
        }
        const rows = hubListLines({ search, missingExpiry, siteId, limit, siteFilter: siteIdFilter(req, res, 'h.site_id') });
        return res.json({ count: rows.length, records: rows });
      }

      const rows = listReceiptLines({ search, missingExpiry, limit });
      res.json({ count: rows.length, records: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/stock-receipts/:lineId/expiry', ...guard, (req, res) => {
    if (isHub()) return res.status(400).json({ error: 'Expiry detail is not available on hub — use the list view.' });
    const lineId = parseInt(req.params.lineId, 10);
    if (!Number.isFinite(lineId) || lineId <= 0) return res.status(400).json({ error: 'Invalid lineId' });
    try {
      const data = getLineWithExpiries(lineId);
      if (!data) return res.status(404).json({ error: 'Receipt line not found' });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/stock-receipts/:lineId/expiry', ...guard, (req, res) => {
    if (isHub()) return res.status(400).json({ error: 'Expiry entries can only be added on the site, not the hub.' });
    const lineId = parseInt(req.params.lineId, 10);
    if (!Number.isFinite(lineId) || lineId <= 0) return res.status(400).json({ error: 'Invalid lineId' });

    const expiryDate = normaliseIsoDate(req.body?.expiry_date);
    if (!expiryDate) return res.status(400).json({ error: 'expiry_date must be a valid YYYY-MM-DD date' });

    const qtyAtExpiry = String(req.body?.qty_at_expiry ?? '').trim() || null;
    const notes = String(req.body?.notes ?? '').trim().slice(0, 1000) || null;
    const enteredBy = req.currentUser?.email || req.currentUser?.full_name || 'unknown';

    try {
      const created = addExpiry({ receiptLineId: lineId, expiryDate, qtyAtExpiry, notes, enteredBy, req });
      res.status(201).json({ ok: true, record: created });
    } catch (err) {
      if (err.message === 'Receipt line not found') return res.status(404).json({ error: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
