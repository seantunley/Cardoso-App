import { Router } from 'express';
import {
  syncDebtorsFromSage,
  getSyncMeta,
  getSyncSettings,
  setSyncSettings,
  DEFAULT_AR_INVOICE_SQL,
} from '../services/debtorSync.js';
import { logError } from '../lib/errorLog.js';

function isHub() { return process.env.HUB_MODE === 'true'; }

// AR open-item sync admin. The Aged Debtors report itself is served by the
// reporting router (gated on can_access_reports); these routes are just the
// sync controls, so they're admin-only — persisting/executing Sage SQL is
// privileged. Mirrors the sync-admin half of routes/creditors.js.
export function createDebtorRouter({ requireAuth, requireAdmin }) {
  const router = Router();
  const adminGuard = [requireAuth, requireAdmin];

  router.get('/api/debtors/sync-meta', ...adminGuard, (_req, res) => {
    try {
      if (isHub()) return res.json({ hub: true, message: 'Hub pulls debtor data from sites during ETL.' });
      res.json(getSyncMeta());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/debtors/sync', ...adminGuard, async (_req, res) => {
    if (isHub()) return res.status(400).json({ error: 'Hub does not sync from Sage directly — data comes from sites during ETL.' });
    try {
      const summary = await syncDebtorsFromSage();
      res.json({ ok: true, summary });
    } catch (err) {
      const isSageDown = /no sage|not configured|ECONNREFUSED|ETIMEOUT|login failed/i.test(err.message);
      logError('routes.debtors.sync', err);
      res.status(isSageDown ? 503 : 500).json({ error: err.message });
    }
  });

  router.get('/api/debtors/sync-settings', ...adminGuard, (_req, res) => {
    try {
      res.json({
        settings: getSyncSettings(),
        defaults: { ar_invoice_sql: DEFAULT_AR_INVOICE_SQL },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/api/debtors/sync-settings', ...adminGuard, (req, res) => {
    try {
      const updated = setSyncSettings(req.body || {});
      res.json({ ok: true, settings: updated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
