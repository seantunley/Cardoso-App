/**
 * networkDevices.js (routes)
 *
 * Hub-only: queries ntopng REST API and surfaces per-site network data.
 * Site-mode: returns nProbe setup guide and configuration info only.
 *
 * The old PowerShell-based scanning is removed entirely.
 */

import express from 'express';
import {
  testNtopngConnection,
  getInterfaceSummaries,
  getTopTalkers,
  mapSitesToInterfaces,
  getNtopngConfig,
} from '../services/ntopngService.js';
import db from '../db/index.js';

export function createNetworkDevicesRouter({ requireAuth, requireAdmin, requirePermission }) {
  const router = express.Router();

  /** ── Hub: connection status ── */
  router.get(
    '/api/hub/ntopng/status',
    requireAuth,
    requirePermission('can_access_network_devices'),
    async (req, res) => {
      if (process.env.HUB_MODE !== 'true') {
        return res.status(400).json({ error: 'Hub mode not enabled' });
      }
      try {
        const status = await testNtopngConnection();
        res.json(status);
      } catch (err) {
        res.status(500).json({ ok: false, message: err.message });
      }
    }
  );

  /** ── Hub: per-site network summary ── */
  router.get(
    '/api/hub/network-devices',
    requireAuth,
    requirePermission('can_access_network_devices'),
    async (req, res) => {
      if (process.env.HUB_MODE !== 'true') {
        return res.json({ sites: [], configured: false });
      }

      const config = getNtopngConfig();
      const configured = !!config.password;

      if (!configured) {
        return res.json({ sites: [], configured: false, message: 'ntopng not configured — set ntopng_url, ntopng_user, ntopng_password in Hub Settings.' });
      }

      try {
        const allSites = db
          .prepare('SELECT id, slug, name FROM hub_sites ORDER BY name ASC, slug ASC')
          .all();

        const [summaries, siteIfaceMap] = await Promise.all([
          getInterfaceSummaries(),
          mapSitesToInterfaces(allSites),
        ]);

        const now = Date.now();
        const STALE_MS = 5 * 60 * 1000; // 5 minutes

        const sites = await Promise.all(
          allSites.map(async (site) => {
            const slug = site.slug || site.id;
            const iface = siteIfaceMap.get(slug);

            if (!iface) {
              return {
                id: site.id,
                slug: site.slug,
                name: site.name,
                connected: false,
                ifid: null,
                ifname: null,
                bytes_sent: 0,
                bytes_rcvd: 0,
                num_flows: 0,
                num_hosts: 0,
                top_talkers: [],
              };
            }

            // Find matching summary
            const summary = summaries.find((s) => s.ifid === iface.id) || {};

            // Get top talkers for this interface
            let top_talkers = [];
            try {
              top_talkers = await getTopTalkers(iface.id, 5);
            } catch {
              // non-fatal
            }

            return {
              id: site.id,
              slug: site.slug,
              name: site.name,
              connected: true,
              ifid: iface.id,
              ifname: iface.name,
              bytes_sent: summary.bytes_sent || 0,
              bytes_rcvd: summary.bytes_rcvd || 0,
              num_flows: summary.num_flows || 0,
              num_hosts: summary.num_hosts || 0,
              top_talkers,
            };
          })
        );

        res.json({ sites, configured: true });
      } catch (err) {
        console.error('[hub/network-devices]', err.message);
        res.status(500).json({ error: err.message, configured: true });
      }
    }
  );

  /** ── Hub: update ntopng settings ── */
  router.post(
    '/api/hub/ntopng/settings',
    requireAuth,
    requireAdmin,
    (req, res) => {
      if (process.env.HUB_MODE !== 'true') {
        return res.status(400).json({ error: 'Hub mode not enabled' });
      }
      const { ntopng_url, ntopng_user, ntopng_password } = req.body || {};
      const upsert = db.prepare(
        `INSERT INTO hub_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      );
      const apply = db.transaction(() => {
        if (ntopng_url !== undefined) upsert.run('ntopng_url', String(ntopng_url).trim());
        if (ntopng_user !== undefined) upsert.run('ntopng_user', String(ntopng_user).trim());
        if (ntopng_password !== undefined) upsert.run('ntopng_password', String(ntopng_password));
      });
      apply();
      res.json({ ok: true });
    }
  );

  /** ── Hub: read ntopng settings (password redacted) ── */
  router.get(
    '/api/hub/ntopng/settings',
    requireAuth,
    requireAdmin,
    (req, res) => {
      if (process.env.HUB_MODE !== 'true') {
        return res.status(400).json({ error: 'Hub mode not enabled' });
      }
      const rows = db.prepare(
        `SELECT key, value FROM hub_settings WHERE key IN ('ntopng_url','ntopng_user','ntopng_password')`
      ).all();
      const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      res.json({
        ntopng_url: cfg.ntopng_url || 'http://localhost:3000',
        ntopng_user: cfg.ntopng_user || 'admin',
        ntopng_password_set: !!cfg.ntopng_password,
      });
    }
  );

  /** ── Site: nProbe setup guide ── */
  router.get(
    '/api/network-devices/setup',
    requireAuth,
    requirePermission('can_access_network_devices'),
    (req, res) => {
      const siteSlug = process.env.SITE_SLUG || 'mysite';
      const hubCollectorPort = 2055;

      res.json({
        guide: {
          title: 'Network Monitoring Setup (ntopng + nProbe)',
          steps: [
            {
              step: 1,
              title: 'Install nProbe on this machine',
              detail: 'Download nProbe from https://packages.ntop.org/ — choose the Windows installer. nProbe runs as a Windows service and exports NetFlow/IPFIX to your Hub.',
              link: 'https://packages.ntop.org/win/',
            },
            {
              step: 2,
              title: 'Configure nProbe',
              detail: `Edit nProbe's configuration to export flows to your Hub. Use the config snippet below as a starting point.`,
              config_snippet: [
                `--interface=0`,
                `--collector-port=${hubCollectorPort}`,
                `--ntopng=zmq://YOUR_HUB_TAILSCALE_IP:5556`,
                `--interface-name=nprobe-${siteSlug}`,
                `--zmq-probe-mode`,
              ].join('\n'),
            },
            {
              step: 3,
              title: 'Install ntopng on the Hub',
              detail: 'On the Hub server (Linux), install ntopng: sudo apt install ntopng. Enable it to receive flows from nProbe over ZMQ.',
              link: 'https://packages.ntop.org/',
            },
            {
              step: 4,
              title: 'Configure Hub ntopng settings',
              detail: 'In the Hub → Settings → Network tab, enter the ntopng URL (default: http://localhost:3000), username, and password. Then test the connection.',
            },
          ],
        },
        site_slug: siteSlug,
      });
    }
  );

  return router;
}
