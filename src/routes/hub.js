/**
 * Hub-mode routes — extracted from server.js (US-010).
 *
 * Factory pattern: createHubRouter(deps) returns an Express router.
 * Also exports createNonHubFallbackRouter() for empty-response stubs.
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import db from '../db/index.js';
import { buildStatements } from '../db/statements.js';
import { boolFromRow } from '../helpers.js';
import { syncAllSites, HUB_SITES } from '../services/hubEtl.js';

export function createHubRouter({ requireAuth, requireAdmin }) {
  const stmts = buildStatements(db);
  const router = Router();

  // GET /api/hub/backup-settings
  router.get('/api/hub/backup-settings', requireAuth, requireAdmin, (req, res) => {
    const row = stmts.getHubSetting.get('backup_sync_enabled');
    res.json({ backup_sync_enabled: row ? row.value === 'true' : true });
  });

  router.post('/api/hub/backup-settings', requireAuth, requireAdmin, (req, res) => {
    const { backup_sync_enabled } = req.body;
    if (typeof backup_sync_enabled !== 'boolean') return res.status(400).json({ error: 'backup_sync_enabled must be boolean' });
    stmts.setHubSetting.run('backup_sync_enabled', backup_sync_enabled ? 'true' : 'false');
    res.json({ ok: true, backup_sync_enabled });
  });

  // GET /api/hub/proxy-backup?site_id=xxx
  // Proxies a backup download from a site through the Hub server to avoid CORS.
  // Admin-only.
  router.get('/api/hub/proxy-backup', requireAuth, requireAdmin, async (req, res) => {

    const { site_id } = req.query;
    if (!site_id) return res.status(400).json({ error: 'site_id required' });

    const site = db.prepare('SELECT id, name, url, token FROM hub_sites WHERE id = ?').get(site_id);
    if (!site || !site.url) return res.status(404).json({ error: 'Site not found or no URL' });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const upstream = await fetch(`${site.url}/api/backup/download`, {
        headers: { 'x-reporting-token': site.token || '' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!upstream.ok) return res.status(upstream.status).json({ error: `Site returned ${upstream.status}` });

      const filename = `cardoso-${site.id}-${new Date().toISOString().slice(0,10)}.db`;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // GET /api/hub/backup-status
  // Polls /api/backup/status on each registered site and returns aggregated results.
  // Admin-only (session required).
  router.get('/api/hub/backup-status', requireAuth, requireAdmin, async (req, res) => {

    const sites = db.prepare('SELECT id, name, url, token FROM hub_sites').all();

    const results = await Promise.all(sites.map(async (site) => {
      const base = { site_id: site.id, site_name: site.name, url: site.url };
      if (!site.url) return { ...base, error: 'No API URL configured', status: 'unknown' };
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const r = await fetch(`${site.url}/api/backup/status`, {
          headers: { 'x-reporting-token': site.token || '' },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!r.ok) return { ...base, error: `HTTP ${r.status}`, status: 'error' };
        const data = await r.json();
        // Determine health
        let status = 'ok';
        if (!data.last_backup) {
          status = 'never';
        } else {
          const hoursAgo = (Date.now() - new Date(data.last_backup.mtime).getTime()) / 3600000;
          if (hoursAgo > 48) status = 'stale';
          else if (hoursAgo > 25) status = 'warning';
        }
        return { ...base, ...data, status };
      } catch (err) {
        return { ...base, error: err.name === 'AbortError' ? 'Timeout' : err.message, status: 'unreachable' };
      }
    }));

    res.json({ sites: results });
  });

  // GET /api/hub/sites
  // Accessible via session (dashboard) OR x-reporting-token (scripts/hub-pull-backups.ps1)
  router.get('/api/hub/sites', (req, res) => {
    const tokenHeader = req.headers['x-reporting-token'];
    const expectedToken = process.env.REPORTING_TOKEN;
    const authedByToken = expectedToken && tokenHeader === expectedToken;
    if (!authedByToken && !req.session?.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const rawSites = db.prepare('SELECT * FROM hub_sites').all();
    const mapped = rawSites.map(s => ({ ...s, last_kpis: s.last_kpis ? JSON.parse(s.last_kpis) : null }));
    // Returns JSON array — compatible with both the UI and hub-pull-backups.ps1
    res.json(mapped);
  });

  // GET /api/hub/records
  router.get('/api/hub/records', requireAuth, (req, res) => {
    const { site_id, flag_color, search } = req.query;
    const limit = Math.min(parseInt(req.query.limit) || 500, 10000);
    let query = 'SELECT * FROM hub_records WHERE 1=1';
    const params = [];
    if (site_id) { query += ' AND site_id=?'; params.push(site_id); }
    if (flag_color) { query += ' AND flag_color=?'; params.push(flag_color); }
    if (search) { query += ' AND (customer_name LIKE ? OR customer_number LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    query += ` ORDER BY updated_date DESC LIMIT ${limit}`;
    const rows = db.prepare(query).all(...params).map(r => {
      // Parse JSON blob fields so frontend receives arrays, not raw strings
      try { r.unpaid_invoices = r.unpaid_invoices ? JSON.parse(r.unpaid_invoices) : []; } catch { r.unpaid_invoices = []; }
      try { r.receipts = r.receipts ? JSON.parse(r.receipts) : []; } catch { r.receipts = []; }
      return r;
    });
    res.json({ count: rows.length, records: rows });
  });

  // GET /api/hub/kpis
  router.get('/api/hub/kpis', requireAuth, (req, res) => {
    const sites = db.prepare('SELECT * FROM hub_sites').all();
    const totals = db.prepare('SELECT flag_color, COUNT(*) as count FROM hub_records GROUP BY flag_color').all();
    const totalRecords = db.prepare('SELECT COUNT(*) as count FROM hub_records').get();

    const flagTotals = { none: 0, red: 0, orange: 0, green: 0 };
    for (const row of totals) {
      if (row.flag_color in flagTotals) flagTotals[row.flag_color] = row.count;
    }

    const perSite = sites.map(s => {
      const kpis = s.last_kpis ? JSON.parse(s.last_kpis) : null;
      return {
        site_id: s.id,
        site_slug: s.slug,
        site_name: s.name,
        status: s.status,
        last_seen: s.last_seen,
        kpis,
      };
    });

    res.json({
      total_records: totalRecords.count,
      records_by_flag: flagTotals,
      sites: perSite,
      generated_at: new Date().toISOString(),
    });
  });

  // GET /api/hub/inventory
  router.get('/api/hub/inventory', requireAuth, (req, res) => {
    const { site_id, search, commodity } = req.query;
    let query = 'SELECT hi.*, COALESCE(s.name, hi.site_id) AS site_name FROM hub_inventory hi LEFT JOIN hub_sites s ON s.id = hi.site_id WHERE 1=1';
    const params = [];
    if (site_id) { query += ' AND hi.site_id=?'; params.push(site_id); }
    if (search) { query += ' AND (hi.item_number LIKE ? OR hi.item_description LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    if (commodity) { query += ' AND CAST(commodity AS TEXT)=?'; params.push(commodity); }
    query += ' ORDER BY hi.item_number ASC';
    try {
      const rows = db.prepare(query).all(...params);
      res.json({ count: rows.length, records: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/hub/sync-log
  router.get('/api/hub/sync-log', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const rows = db.prepare(
      'SELECT * FROM hub_sync_log ORDER BY started_at DESC LIMIT ?'
    ).all(limit);
    res.json(rows);
  });

  // POST /api/hub/force-resync — clears sync history and hub_records, triggers full re-pull
  router.post('/api/hub/force-resync', requireAuth, requireAdmin, (req, res) => {
    try {
      db.prepare('DELETE FROM hub_sync_log').run();
      db.prepare('DELETE FROM hub_records').run();
      db.prepare('DELETE FROM hub_inventory').run();
      res.status(202).json({ message: 'Force resync triggered — full pull from all sites' });
      syncAllSites().catch(err => console.error('[HUB] Force resync error:', err));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/hub/force-resync/:siteId — per-site force resync
  router.post('/api/hub/force-resync/:siteId', requireAuth, requireAdmin, (req, res) => {
    const { siteId } = req.params;
    try {
      db.prepare("DELETE FROM hub_sync_log WHERE site_id = ?").run(siteId);
      db.prepare("DELETE FROM hub_records WHERE site_id = ?").run(siteId);
      db.prepare("DELETE FROM hub_inventory WHERE site_id = ?").run(siteId);
      syncAllSites().catch(err => console.error("force-resync error:", err));
      res.status(202).json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/hub/sync
  router.post('/api/hub/sync', requireAuth, requireAdmin, (req, res) => {
    res.status(202).json({ message: 'Sync triggered', sites: HUB_SITES.map(s => s.slug) });
    syncAllSites().catch(err => console.error('[HUB] Manual sync error:', err));
  });

  // ==================== HUB: CENTRALISED USER MANAGEMENT ====================

  // GET /api/hub/users — list all users on this hub (admin only)
  router.get('/api/hub/users', requireAuth, requireAdmin, (req, res) => {
    try {
      const users = db.prepare(`
        SELECT id, email, full_name, role, is_active, hub_redirect,
               can_access_connections, can_manage_users, can_manage_rules,
               can_edit_records, can_flag_records, created_date
        FROM "user" ORDER BY role DESC, full_name ASC
      `).all();
      res.json(users.map(u => ({
        ...u,
        is_active: boolFromRow(u.is_active, true),
        hub_redirect: boolFromRow(u.hub_redirect, false),
        can_access_connections: boolFromRow(u.can_access_connections, false),
        can_manage_users: boolFromRow(u.can_manage_users, false),
        can_manage_rules: boolFromRow(u.can_manage_rules, false),
        can_edit_records: boolFromRow(u.can_edit_records, true),
        can_flag_records: boolFromRow(u.can_flag_records, true),
      })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/hub/push-users — push selected users to one or all sites
  router.post('/api/hub/push-users', requireAuth, requireAdmin, async (req, res) => {
    const { user_ids, site_ids } = req.body; // site_ids = null means all sites
    if (!Array.isArray(user_ids) || user_ids.length === 0) {
      return res.status(400).json({ error: 'user_ids required' });
    }

    const usersToSync = db.prepare(`
      SELECT id, email, full_name, role, is_active, hub_redirect,
             can_access_connections, can_manage_users, can_manage_rules,
             can_edit_records, can_flag_records
      FROM "user" WHERE id IN (${user_ids.map(() => '?').join(',')})
    `).all(...user_ids);

    if (usersToSync.length === 0) return res.status(404).json({ error: 'No matching users' });

    const targetSites = site_ids
      ? HUB_SITES.filter(s => site_ids.includes(s.id))
      : HUB_SITES;

    if (targetSites.length === 0) return res.status(400).json({ error: 'No target sites' });

    const results = await Promise.allSettled(targetSites.map(async (site) => {
      const resp = await fetch(`${site.url}/api/hub/receive-users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Reporting-Token': site.token,
        },
        body: JSON.stringify({ users: usersToSync }),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`${site.name}: HTTP ${resp.status} — ${body}`);
      }
      return { site: site.name, ok: true };
    }));

    const summary = results.map((r, i) => ({
      site: targetSites[i].name,
      ok: r.status === 'fulfilled',
      error: r.status === 'rejected' ? r.reason.message : null,
    }));

    const allOk = summary.every(s => s.ok);
    res.status(allOk ? 200 : 207).json({ results: summary });
  });

  // POST /api/hub/receive-users — site endpoint: receive users pushed from hub
  router.post(`/api/hub/receive-users`, async (req, res) => {
    const token = req.headers['x-reporting-token'];
    const expectedToken = process.env.REPORTING_TOKEN;
    if (!expectedToken || token !== expectedToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { users } = req.body;
    if (!Array.isArray(users) || users.length === 0) {
      return res.status(400).json({ error: 'users array required' });
    }

    let created = 0, updated = 0, errors = [];

    for (const u of users) {
      try {
        const existing = db.prepare('SELECT id FROM "user" WHERE email = ?').get(u.email);
        if (existing) {
          // Update everything except password_hash — never overwrite local password
          db.prepare(`
            UPDATE "user" SET
              full_name = ?, role = ?, is_active = ?, hub_redirect = ?,
              can_access_connections = ?, can_manage_users = ?, can_manage_rules = ?,
              can_edit_records = ?, can_flag_records = ?
            WHERE email = ?
          `).run(
            u.full_name || null,
            u.role || 'user',
            u.is_active ? 1 : 0,
            u.hub_redirect ? 1 : 0,
            u.can_access_connections ? 1 : 0,
            u.can_manage_users ? 1 : 0,
            u.can_manage_rules ? 1 : 0,
            u.can_edit_records ? 1 : 0,
            u.can_flag_records ? 1 : 0,
            u.email
          );
          updated++;
        } else {
          // Create new user — no password set (they must set one or reset locally)
          const defaultPw = process.env.DEFAULT_USER_PASSWORD || `Cardoso@${new Date().getFullYear()}`;
          const defaultHash = await bcrypt.hash(defaultPw, 12);
          db.prepare(`
            INSERT INTO "user" (email, full_name, role, is_active, hub_redirect, must_change_password,
              can_access_connections, can_manage_users, can_manage_rules,
              can_edit_records, can_flag_records, password_hash)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
          `).run(
            u.email,
            u.full_name || null,
            u.role || 'user',
            u.is_active ? 1 : 0,
            u.hub_redirect ? 1 : 0,
            u.can_access_connections ? 1 : 0,
            u.can_manage_users ? 1 : 0,
            u.can_manage_rules ? 1 : 0,
            u.can_edit_records ? 1 : 0,
            u.can_flag_records ? 1 : 0,
            defaultHash
          );
          created++;
        }
      } catch (err) {
        errors.push({ email: u.email, error: err.message });
      }
    }

    res.json({ created, updated, errors });
  });

  console.log('[HUB] Hub ETL initialized. Sites:', HUB_SITES.map(s => s.slug).join(', ') || 'none configured');

  return router;
}

// Non-hub fallback router — empty responses for hub endpoints called by UI on non-hub installs
export function createNonHubFallbackRouter() {
  const router = Router();
  router.get('/api/hub/sites', (req, res) => res.json([]));
  router.get('/api/hub/records', (req, res) => res.json({ records: [], total: 0 }));
  router.get('/api/hub/kpis', (req, res) => res.json({ sites: [] }));
  router.get('/api/hub/inventory', (req, res) => res.json([]));
  router.get('/api/hub/sync-log', (req, res) => res.json([]));
  return router;
}
