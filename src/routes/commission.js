import { Router } from 'express';
import {
  buildCommissionReport,
  getCommissionSettings,
  updateCommissionSettings,
} from '../services/commission.js';
import { logAudit } from '../lib/audit.js';
import { logError } from '../lib/errorLog.js';

export function createCommissionRouter({ requireAuth, requirePermission }) {
  const router = Router();
  const reportGuard = [requireAuth, requirePermission('can_access_commission')];
  const settingsGuard = [requireAuth, requirePermission('can_access_settings')];

  router.get('/api/commission/report', ...reportGuard, async (req, res) => {
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'from and to are required (YYYY-MM-DD)' });
    }
    try {
      const report = await buildCommissionReport({ from, to });
      res.json(report);
    } catch (err) {
      const isSageDown = /no sage|not configured|ECONNREFUSED|ETIMEOUT|login failed/i.test(err.message || '');
      logError('commission.report', err, { from, to, sage_down: isSageDown });
      res.status(isSageDown ? 503 : 500).json({
        error: isSageDown
          ? 'Sage connection unavailable. Check that the customer Sage connection is configured and active.'
          : err.message || 'Failed to build commission report',
      });
    }
  });

  router.get('/api/commission/settings', ...reportGuard, (_req, res) => {
    try {
      res.json(getCommissionSettings());
    } catch (err) {
      logError('commission.settings.get', err);
      res.status(500).json({ error: 'Failed to load commission settings' });
    }
  });

  router.put('/api/commission/settings', ...settingsGuard, (req, res) => {
    const { sweets_rate, cigtob_rate, reference_rate } = req.body || {};
    // Parsing here rather than at the service so the route can return a
    // clean 400 instead of letting the service throw a generic 500.
    const parsed = {
      sweets_rate: Number(sweets_rate),
      cigtob_rate: Number(cigtob_rate),
      reference_rate: Number(reference_rate),
    };
    if (![parsed.sweets_rate, parsed.cigtob_rate, parsed.reference_rate].every(Number.isFinite)) {
      return res.status(400).json({ error: 'All rates must be numeric (decimal, e.g. 0.015 for 1.5%)' });
    }
    try {
      const updated = updateCommissionSettings({ ...parsed, userId: req.currentUser?.id });
      logAudit({
        req,
        action: 'commission.settings_update',
        resourceType: 'commission_settings',
        resourceId: 1,
        details: `sweets=${(updated.sweets_rate * 100).toFixed(3)}% cigtob=${(updated.cigtob_rate * 100).toFixed(3)}% ref=${(updated.reference_rate * 100).toFixed(3)}%`,
      });
      res.json(updated);
    } catch (err) {
      logError('commission.settings.update', err, parsed);
      res.status(500).json({ error: 'Failed to update commission settings' });
    }
  });

  return router;
}
