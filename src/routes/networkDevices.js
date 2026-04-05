import express from 'express';
import {
  getHubNetworkDevicesSnapshot,
  getNetworkDevicesSnapshot,
  scanNetworkDevicesNow,
  syncHubNetworkDevicesForAllSites,
} from '../services/networkDevices.js';
import db from '../db/index.js';

function requireReportingToken(req, res, next) {
  const token = process.env.REPORTING_TOKEN;
  if (!token) {
    return res.status(503).json({ error: 'Reporting API not configured' });
  }
  if (req.headers['x-reporting-token'] !== token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

export function createNetworkDevicesRouter({ requireAuth, requireAdmin, requirePermission }) {
  const router = express.Router();

  router.get('/api/network-devices', requireAuth, requirePermission('can_access_network_devices'), (req, res) => {
    try {
      res.json(getNetworkDevicesSnapshot());
    } catch (error) {
      console.error('[network-devices] snapshot error:', error);
      res.status(500).json({ error: 'Failed to load network devices' });
    }
  });

  router.post('/api/network-devices/scan', requireAuth, requirePermission('can_access_network_devices'), async (req, res) => {
    try {
      const result = await scanNetworkDevicesNow({
        triggerReason: req.currentUser?.email ? `manual:${req.currentUser.email}` : 'manual',
      });
      res.json(result);
    } catch (error) {
      console.error('[network-devices] scan error:', error);
      res.status(500).json({ error: error.message || 'Network scan failed' });
    }
  });

  router.get('/api/reporting/network-devices', requireReportingToken, (req, res) => {
    try {
      res.json(getNetworkDevicesSnapshot());
    } catch (error) {
      console.error('[network-devices] reporting snapshot error:', error);
      res.status(500).json({ error: 'Failed to load reporting snapshot' });
    }
  });

  router.get('/api/hub/network-devices', requireAuth, requirePermission('can_access_network_devices'), (req, res) => {
    try {
      if (process.env.HUB_MODE !== 'true') {
        return res.json({ devices: [], sites: [] });
      }
      const siteId = typeof req.query.site_id === 'string' && req.query.site_id.trim()
        ? req.query.site_id.trim()
        : null;
      const snapshot = getHubNetworkDevicesSnapshot({ siteId });
      const sites = db.prepare('SELECT id, slug, name FROM hub_sites ORDER BY name ASC, slug ASC').all();
      res.json({ ...snapshot, sites });
    } catch (error) {
      console.error('[hub/network-devices] snapshot error:', error);
      res.status(500).json({ error: 'Failed to load hub network devices' });
    }
  });

  router.post('/api/hub/network-devices/pull', requireAuth, requireAdmin, async (req, res) => {
    try {
      if (process.env.HUB_MODE !== 'true') {
        return res.status(400).json({ error: 'Hub mode is not enabled on this install' });
      }
      const rawSiteIds = Array.isArray(req.body?.site_ids) ? req.body.site_ids.filter(Boolean) : null;
      const allSites = db.prepare(
        'SELECT id, slug, name, url, token FROM hub_sites ORDER BY name ASC, slug ASC'
      ).all();
      const targetSites = rawSiteIds?.length
        ? allSites.filter((s) => rawSiteIds.includes(s.id))
        : allSites;

      if (!targetSites.length) {
        return res.status(400).json({ error: 'No target sites' });
      }

      const results = await syncHubNetworkDevicesForAllSites(targetSites);
      res.status(results.every((r) => r.ok) ? 200 : 207).json({ results });
    } catch (error) {
      console.error('[hub/network-devices] pull error:', error);
      res.status(500).json({ error: 'Failed to pull hub network devices' });
    }
  });

  return router;
}
