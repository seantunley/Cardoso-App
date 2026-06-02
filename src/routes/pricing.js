import { Router } from 'express';
import {
  getPriceLists, getPriceListItems, getSuppliers,
  getExclusions, addExclusion, deleteExclusion,
} from '../services/pricing.js';
import { logAudit } from '../lib/audit.js';
import { logError } from '../lib/errorLog.js';

export function createPricingRouter({ requireAuth, requireAdmin, requirePermission }) {
  const router = Router();
  const guard = [requireAuth, requirePermission('can_access_price_list')];

  router.get('/api/pricing/lists', ...guard, async (_req, res) => {
    try {
      const lists = await getPriceLists();
      res.json({ lists });
    } catch (err) {
      const isSageDown = /no sage|not configured|ECONNREFUSED|ETIMEOUT|login failed/i.test(err.message);
      logError('pricing.lists', err, { sage_down: isSageDown });
      res.status(isSageDown ? 503 : 500).json({
        error: isSageDown
          ? 'Sage connection unavailable. Check that the Sage connection is configured and active.'
          : err.message,
      });
    }
  });

  router.get('/api/pricing/suppliers', ...guard, (_req, res) => {
    try {
      res.json({ suppliers: getSuppliers() });
    } catch (err) {
      logError('pricing.suppliers', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/pricing/items', ...guard, async (req, res) => {
    try {
      const { price_list, commodity, supplier } = req.query;
      if (!price_list) return res.status(400).json({ error: 'price_list is required' });
      const items = await getPriceListItems({
        priceList: price_list,
        commodity: commodity && commodity !== 'all' ? commodity : undefined,
        supplier: supplier && supplier !== 'all' ? supplier : undefined,
      });
      res.json({
        items,
        price_list,
        commodity: commodity || 'all',
        supplier: supplier || 'all',
        count: items.length,
      });
    } catch (err) {
      const isSageDown = /no sage|not configured|ECONNREFUSED|ETIMEOUT|login failed/i.test(err.message);
      logError('pricing.items', err, {
        price_list: req.query?.price_list,
        commodity: req.query?.commodity,
        supplier: req.query?.supplier,
        sage_down: isSageDown,
      });
      res.status(isSageDown ? 503 : 500).json({ error: err.message });
    }
  });

  // ── Exclusions (admin-only, settings-managed) ──
  router.get('/api/pricing/exclusions', requireAuth, requireAdmin, (_req, res) => {
    try {
      res.json({ exclusions: getExclusions() });
    } catch (err) {
      logError('pricing.exclusions_list', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/pricing/exclusions', requireAuth, requireAdmin, (req, res) => {
    try {
      const { pattern, note } = req.body || {};
      const created = addExclusion({
        pattern, note,
        createdBy: req.currentUser?.email || null,
      });
      logAudit({
        req,
        action: 'pricing.exclusion_create',
        resourceType: 'price_list_exclusion',
        resourceId: String(created.id),
        resourceName: created.pattern,
        details: note ? `Pattern "${created.pattern}" (note: ${String(note).slice(0, 80)})` : `Pattern "${created.pattern}"`,
      });
      res.json({ exclusion: created });
    } catch (err) {
      logError('pricing.exclusion_create', err, { pattern: req.body?.pattern });
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/api/pricing/exclusions/:id', requireAuth, requireAdmin, (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const ok = deleteExclusion(id);
      if (!ok) return res.status(404).json({ error: 'Not found' });
      logAudit({
        req,
        action: 'pricing.exclusion_delete',
        resourceType: 'price_list_exclusion',
        resourceId: String(id),
        resourceName: `Exclusion ${id}`,
        details: `Removed price list exclusion #${id}`,
      });
      res.json({ ok: true });
    } catch (err) {
      logError('pricing.exclusion_delete', err, { id: req.params?.id });
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
