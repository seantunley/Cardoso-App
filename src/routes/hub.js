/**
 * Hub-mode routes — extracted from server.js (US-010).
 *
 * Factory pattern: createHubRouter(deps) returns an Express router.
 * Also exports createNonHubFallbackRouter() for empty-response stubs.
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { readdirSync, statSync } from 'fs';
import path from 'path';
import { boolFromRow, expandDataRecord } from '../helpers.js';
import { syncAllSites, runHubBackupPull, HUB_SITES } from '../services/hubEtl.js';
import { getHubStorageRuntime } from '../hub/storage/runtime.js';
import { logError } from '../lib/errorLog.js';
import { logAudit } from '../lib/audit.js';
import { describeFetchError } from '../lib/errorDescribe.js';

const { sqliteDb: db, repository: hubRepository } = getHubStorageRuntime();

export function createHubRouter({ requireAuth, requireAdmin, requirePermission }) {
  const router = Router();

  const writeHubAudit = db.prepare(`
    INSERT INTO hub_audit_log (action, performed_by, target, detail)
    VALUES (?, ?, ?, ?)
  `);

  function logHubAudit({ action, performedBy = null, target = null, detail = null }) {
    try {
      writeHubAudit.run(action, performedBy || null, target || null, detail == null ? null : String(detail));
    } catch (err) {
      console.warn('[hub-audit-log] failed:', err.message);
    }
  }

  function getSqlBackupHealth(sqlBackup) {
    if (!sqlBackup?.ok) {
      return { status: 'unavailable', needs_attention: true, last_success_at: null };
    }

    const databases = Array.isArray(sqlBackup.databases) ? sqlBackup.databases : [];
    if (databases.length === 0) {
      return { status: 'unavailable', needs_attention: true, last_success_at: null };
    }

    const successTimes = databases
      .filter((db) => db.isSuccess && db.backupAt)
      .map((db) => new Date(db.backupAt).getTime())
      .filter((value) => Number.isFinite(value));

    const latestSuccessMs = successTimes.length > 0 ? Math.max(...successTimes) : null;
    const latestSuccessAt = latestSuccessMs ? new Date(latestSuccessMs).toISOString() : null;
    const anyFailed = databases.some((db) => db.isSuccess === false);
    const stale = !latestSuccessMs || ((Date.now() - latestSuccessMs) > 24 * 3600000);

    return {
      status: anyFailed ? 'failed' : stale ? 'stale' : 'ok',
      needs_attention: anyFailed || stale,
      last_success_at: latestSuccessAt,
    };
  }

  function getMachineHealthSummary(machineHealth) {
    if (!machineHealth?.ok) {
      return {
        status: 'unavailable',
        needs_attention: true,
        reasons: [machineHealth?.message || 'Machine health unavailable'],
      };
    }

    const reasons = [];
    let status = 'ok';

    const promote = (nextStatus, reason) => {
      if (reason) reasons.push(reason);
      if (status === 'critical' || nextStatus === status) return;
      if (nextStatus === 'critical' || (nextStatus === 'warning' && status === 'ok')) {
        status = nextStatus;
      }
    };

    const cpuUsage = Number(machineHealth.cpu?.usage_percent);
    if (Number.isFinite(cpuUsage) && cpuUsage >= 90) promote('critical', `CPU ${cpuUsage.toFixed(1)}%`);
    else if (Number.isFinite(cpuUsage) && cpuUsage >= 75) promote('warning', `CPU ${cpuUsage.toFixed(1)}%`);

    const memoryUsed = Number(machineHealth.memory?.used_percent);
    if (Number.isFinite(memoryUsed) && memoryUsed >= 90) promote('critical', `RAM ${memoryUsed.toFixed(1)}% used`);
    else if (Number.isFinite(memoryUsed) && memoryUsed >= 80) promote('warning', `RAM ${memoryUsed.toFixed(1)}% used`);

    const disks = Array.isArray(machineHealth.disks) ? machineHealth.disks : [];
    disks.forEach((disk) => {
      const freePercent = Number(disk.free_percent);
      if (!Number.isFinite(freePercent)) return;
      const label = disk.drive || 'disk';
      if (freePercent <= 10) promote('critical', `${label} low space (${freePercent.toFixed(1)}% free)`);
      else if (freePercent <= 20) promote('warning', `${label} low space (${freePercent.toFixed(1)}% free)`);
    });

    const service = machineHealth.cardoso_service;
    if (service?.present && service.status && service.status !== 'Running') {
      promote('warning', `Cardoso service ${String(service.status).toLowerCase()}`);
    }

    return {
      status,
      needs_attention: status !== 'ok',
      reasons,
    };
  }

  // GET /api/hub/backup-settings
  router.get('/api/hub/backup-settings', requireAuth, requirePermission('can_access_hub_backups'), (req, res) => {
    res.json({ backup_sync_enabled: hubRepository.getBackupSyncEnabled() });
  });

  router.post('/api/hub/backup-settings', requireAuth, requirePermission('can_access_hub_backups'), (req, res) => {
    const { backup_sync_enabled } = req.body;
    if (typeof backup_sync_enabled !== 'boolean') return res.status(400).json({ error: 'backup_sync_enabled must be boolean' });
    hubRepository.setBackupSyncEnabled(backup_sync_enabled);
    logAudit({
      req, action: backup_sync_enabled ? 'enable_hub_backups' : 'disable_hub_backups',
      resourceType: 'system', resourceName: 'Hub backup sync',
      details: `Backup sync ${backup_sync_enabled ? 'enabled' : 'disabled'}`,
    });
    res.json({ ok: true, backup_sync_enabled });
  });

  // POST /api/hub/pull-backups-now
  // Immediately triggers a Hub backup pull from all sites (same as the nightly cron).
  // The async pull's outcome is recorded in hub_settings so the UI can poll
  // GET /api/hub/last-backup-pull to show success/failure after the fact.
  let backupPullInProgress = false;
  const setHubSetting = (key, value) => {
    try {
      db.prepare(`INSERT INTO hub_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
    } catch {}
  };
  router.post('/api/hub/pull-backups-now', requireAuth, requireAdmin, requirePermission('can_access_hub_backups'), async (req, res) => {
    if (backupPullInProgress) {
      return res.status(409).json({ error: 'A backup pull is already in progress' });
    }
    backupPullInProgress = true;
    setHubSetting('last_backup_pull', JSON.stringify({ status: 'running', startedAt: new Date().toISOString() }));
    logAudit({
      req, action: 'hub_backup_pull_trigger', resourceType: 'system',
      resourceName: 'Hub manual backup pull',
      details: 'Manual backup pull started',
    });
    res.json({ ok: true, message: 'Backup pull started' });
    try {
      await runHubBackupPull();
      setHubSetting('last_backup_pull', JSON.stringify({ status: 'ok', completedAt: new Date().toISOString() }));
      console.log('[hub] Manual backup pull completed');
    } catch (err) {
      // runHubBackupPull catches per-site errors internally (logs each via
      // hub.backupPull). A throw out here means a top-level failure (e.g.
      // mkdir on hub_backup_root, or hub_sites empty) — surface that
      // verbatim, but tag it so the operator knows it's the orchestrator,
      // not a site-pull, that failed.
      const friendly = `Backup-pull orchestrator: ${err.message || 'unknown failure'}`;
      logError('hub.manualBackupPull', err, { friendly });
      setHubSetting('last_backup_pull', JSON.stringify({ status: 'error', completedAt: new Date().toISOString(), error: friendly }));
    } finally {
      backupPullInProgress = false;
    }
  });

  // GET /api/hub/last-backup-pull — last manual pull outcome (UI polls this)
  router.get('/api/hub/last-backup-pull', requireAuth, requirePermission('can_access_hub_backups'), (req, res) => {
    try {
      const row = db.prepare(`SELECT value FROM hub_settings WHERE key = 'last_backup_pull'`).get();
      res.json(row?.value ? JSON.parse(row.value) : { status: 'idle' });
    } catch (err) {
      res.json({ status: 'idle' });
    }
  });

  // GET /api/hub/proxy-backup?site_id=xxx
  // Proxies a backup download from a site through the Hub server to avoid CORS.
  // Admin-only.
  router.get('/api/hub/proxy-backup', requireAuth, requireAdmin, requirePermission('can_access_hub_backups'), async (req, res) => {

    const { site_id } = req.query;
    if (!site_id) return res.status(400).json({ error: 'site_id required' });

    const site = db.prepare('SELECT id, slug, name, url, token FROM hub_sites WHERE id = ?').get(site_id);
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
      logHubAudit({
        action: 'backup_pull',
        performedBy: req.currentUser?.email,
        target: site.slug || site.id,
      });
      res.send(buf);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // GET /api/hub/proxy-config?site_id=xxx
  // Proxies the site .env download through the hub. Admin-only.
  router.get('/api/hub/proxy-config', requireAuth, requireAdmin, requirePermission('can_access_hub_backups'), async (req, res) => {
    const { site_id } = req.query;
    if (!site_id) return res.status(400).json({ error: 'site_id required' });

    const site = db.prepare('SELECT id, name, url, token FROM hub_sites WHERE id = ?').get(site_id);
    if (!site || !site.url) return res.status(404).json({ error: 'Site not found or no URL' });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const upstream = await fetch(`${site.url}/api/backup/config`, {
        headers: { 'x-reporting-token': site.token || '' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!upstream.ok) return res.status(upstream.status).json({ error: `Site returned ${upstream.status}` });

      const filename = `cardoso-config-${site.id}-${new Date().toISOString().slice(0,10)}.env`;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Backup-Config-Mode', upstream.headers.get('x-backup-config-mode') || 'unknown');
      const text = await upstream.text();
      res.send(text);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // GET /api/hub/backup-status
  // Polls /api/backup/status on each registered site and returns aggregated results.
  // Admin-only (session required).
  router.get('/api/hub/backup-status', requireAuth, requirePermission('can_access_hub_backups'), async (req, res) => {

    const sites = db.prepare('SELECT id, name, url, token FROM hub_sites').all();

    const results = await Promise.all(sites.map(async (site) => {
      const base = { site_id: site.id, site_name: site.name, url: site.url };
      if (!site.url) {
        return {
          ...base,
          error: 'No API URL configured',
          status: 'unknown',
          sql_backup: {
            ok: false,
            message: 'No API URL configured',
            databases: [],
            health: { status: 'unavailable', needs_attention: true, last_success_at: null },
          },
        };
      }
      try {
        const [backupResponse, sqlResponse] = await Promise.all([
          fetch(`${site.url}/api/backup/status`, {
            headers: { 'x-reporting-token': site.token || '' },
            signal: AbortSignal.timeout(8000),
          }),
          fetch(`${site.url}/api/backup/sql-status`, {
            headers: { 'x-reporting-token': site.token || '' },
            signal: AbortSignal.timeout(8000),
          }).catch((err) => ({ ok: false, error: err })),
        ]);

        if (!backupResponse.ok) return { ...base, error: `HTTP ${backupResponse.status}`, status: 'error' };
        const data = await backupResponse.json();

        let status = 'ok';
        if (!data.last_backup) {
          status = 'never';
        } else {
          const hoursAgo = (Date.now() - new Date(data.last_backup.mtime).getTime()) / 3600000;
          if (hoursAgo > 48) status = 'stale';
          else if (hoursAgo > 25) status = 'warning';
        }

        let sqlBackup;
        if (sqlResponse?.ok === false && sqlResponse?.error) {
          sqlBackup = {
            ok: false,
            message: sqlResponse.error.name === 'Timeout' ? 'Timeout' : sqlResponse.error.message,
            databases: [],
          };
        } else if (!sqlResponse.ok) {
          sqlBackup = {
            ok: false,
            message: `HTTP ${sqlResponse.status}`,
            databases: [],
          };
        } else {
          sqlBackup = await sqlResponse.json();
        }

        sqlBackup.health = getSqlBackupHealth(sqlBackup);
        return { ...base, ...data, status, sql_backup: sqlBackup };
      } catch (err) {
        return {
          ...base,
          error: err.name === 'AbortError' ? 'Timeout' : err.message,
          status: 'unreachable',
          sql_backup: {
            ok: false,
            message: err.name === 'AbortError' ? 'Timeout' : err.message,
            databases: [],
            health: { status: 'unavailable', needs_attention: true, last_success_at: null },
          },
        };
      }
    }));

    res.json({
      sites: results,
      sql_attention: results.some((site) => site.sql_backup?.health?.needs_attention),
    });
  });

  // GET /api/hub/hub-backup-status
  // Returns count and latest timestamp of backups stored on the hub (database/hub-backups/<site_id>/).
  router.get('/api/hub/hub-backup-status', requireAuth, requirePermission('can_access_hub_backups'), (req, res) => {
    try {
      const baseDir = path.join(process.cwd(), 'database', 'hub-backups');
      // Guard: hub_sites table may not exist on some installs
      let sites = [];
      try { sites = db.prepare('SELECT id, name FROM hub_sites').all(); } catch { /* table not ready */ }
      const results = sites.map((site) => {
        const dir = path.join(baseDir, site.id);
        try {
          const files = readdirSync(dir).filter((file) => file.endsWith('.db') || file.endsWith('.db.corrupt'));
          if (files.length === 0) return { site_id: site.id, hub_backup_count: 0, hub_last_backup: null, hub_last_size: null, integrity: 'unchecked' };
          const sorted = files
            .map((file) => {
              const stats = statSync(path.join(dir, file));
              return { file, mtime: stats.mtimeMs, size: stats.size };
            })
            .sort((a, b) => b.mtime - a.mtime);

          let integrity = 'unchecked';
          try {
            const integrityRow = db.prepare(`
              SELECT result
              FROM hub_backup_integrity
              WHERE site_id = ? AND filename = ?
              ORDER BY id DESC
              LIMIT 1
            `).get(site.id, sorted[0].file);
            if (integrityRow?.result) {
              integrity = integrityRow.result === 'ok' ? 'ok' : 'corrupt';
            }
          } catch (_) { /* table not ready */ }

          return {
            site_id: site.id,
            hub_backup_count: files.length,
            hub_last_backup: new Date(sorted[0].mtime).toISOString(),
            hub_last_size: sorted[0].size,
            hub_last_filename: sorted[0].file,
            integrity,
          };
        } catch {
          return { site_id: site.id, hub_backup_count: 0, hub_last_backup: null, hub_last_size: null, integrity: 'unchecked' };
        }
      });
      res.json({ sites: results });
    } catch (err) {
      console.error('[hub-backup-status] error:', err.message);
      res.json({ sites: [] });
    }
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

    if (!authedByToken) {
      const sessionUserId = req.session?.userId;
      const sessionUser = sessionUserId ? db.prepare(`SELECT * FROM "user" WHERE id = ?`).get(sessionUserId) : null;
      const canAccessBackups = sessionUser?.role === 'admin' || boolFromRow(sessionUser?.can_access_hub_backups, false);
      if (!canAccessBackups) {
        return res.status(403).json({ error: 'Permission denied' });
      }
    }

    // Narrow column list — UI listing only needs these fields
    const rawSites = db.prepare(
      'SELECT id, slug, name, url, last_seen, status, last_kpis FROM hub_sites'
    ).all();
    const mapped = rawSites.map((s) => ({
      site_id: s.id,
      id: s.id,
      slug: s.slug,
      name: s.name,
      url: s.url,
      last_seen: s.last_seen,
      status: s.status,
      last_kpis: s.last_kpis ? JSON.parse(s.last_kpis) : null,
    }));
    // Returns JSON array — compatible with both the UI and hub-pull-backups.ps1
    res.json(mapped);
  });

  // GET /api/hub/my-sites — returns only sites this Hub user is allowed to see
  router.get('/api/hub/my-sites', requireAuth, (req, res) => {
    const userEmail = req.currentUser?.email;
    if (!userEmail) return res.status(401).json({ error: 'Not authenticated' });

    // Admins see all sites (unless they have explicit restrictions set)
    const isAdmin = req.currentUser?.role === 'admin';

    let allowedSlugs = null;
    if (!isAdmin) {
      // Check if this user has any explicit site restrictions
      try {
        const rows = db.prepare(`SELECT site_slug FROM hub_user_allowed_sites WHERE email = ?`).all(userEmail);
        if (rows.length > 0) {
          allowedSlugs = rows.map(r => r.site_slug);
        }
        // If no rows returned, allowedSlugs stays null → no restrictions (show all)
      } catch { /* table may not exist */ }
    }

    let sites;
    try {
      // Narrow column list — UI listing only needs these fields
      const allSites = db.prepare(
        'SELECT id, slug, name, url, last_seen, status, last_kpis FROM hub_sites'
      ).all();
      if (allowedSlugs === null) {
        // No restrictions — user sees all sites
        sites = allSites;
      } else {
        sites = allSites.filter(s => allowedSlugs.includes(s.slug));
      }
    } catch {
      return res.status(500).json({ error: 'Failed to load sites' });
    }

    const mapped = sites.map((s) => ({
      site_id: s.id,
      id: s.id,
      slug: s.slug,
      name: s.name,
      url: s.url,
      last_seen: s.last_seen,
      status: s.status,
      last_kpis: s.last_kpis ? JSON.parse(s.last_kpis) : null,
    }));

    res.json(mapped);
  });

  // GET /api/hub/records
  router.get('/api/hub/records', requireAuth, (req, res) => {
    const { site_id, flag_color, search } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    let whereClause = 'WHERE 1=1';
    const params = [];
    if (site_id) { whereClause += ' AND site_id=?'; params.push(site_id); }
    if (flag_color) { whereClause += ' AND flag_color=?'; params.push(flag_color); }
    if (search) { whereClause += ' AND (customer_name LIKE ? OR customer_number LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

    const countRow = db.prepare(`SELECT COUNT(*) AS total FROM hub_records ${whereClause}`).get(...params);
    const rows = db.prepare(`
      SELECT * FROM hub_records
      ${whereClause}
      ORDER BY datetime(updated_date) DESC, rowid DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset).map(r => {
      // Parse JSON blob fields so frontend receives arrays, not raw strings
      try { r.unpaid_invoices = r.unpaid_invoices ? JSON.parse(r.unpaid_invoices) : []; } catch { r.unpaid_invoices = []; }
      try { r.receipts = r.receipts ? JSON.parse(r.receipts) : []; } catch { r.receipts = []; }
      return r;
    });
    res.json({
      count: rows.length,
      total: countRow?.total ?? rows.length,
      limit,
      offset,
      has_more: offset + rows.length < (countRow?.total ?? 0),
      records: rows.map(expandDataRecord),
    });
  });

  // GET /api/hub/kpis
  router.get('/api/hub/kpis', requireAuth, (req, res) => {
    const since = typeof req.query.since === 'string' && req.query.since.trim() ? req.query.since.trim() : null;

    // Filter sites by user permissions (same logic as /api/hub/my-sites)
    const userEmail = req.currentUser?.email;
    const isAdmin = req.currentUser?.role === 'admin';
    let allowedSlugs = null;
    if (!isAdmin && userEmail) {
      try {
        const rows = db.prepare(`SELECT site_slug FROM hub_user_allowed_sites WHERE email = ?`).all(userEmail);
        if (rows.length > 0) {
          allowedSlugs = rows.map(r => r.site_slug);
        }
      } catch {}
    }

    let allSites = [];
    // Narrow column list — KPI aggregator only needs these fields
    try { allSites = db.prepare('SELECT id, slug, name, status, last_seen FROM hub_sites').all(); } catch {}
    const sites = allowedSlugs === null
      ? allSites
      : allSites.filter(s => allowedSlugs.includes(s.slug));
    const totals = since
      ? db.prepare('SELECT flag_color, COUNT(*) as count FROM hub_records WHERE updated_date >= ? GROUP BY flag_color').all(since)
      : db.prepare('SELECT flag_color, COUNT(*) as count FROM hub_records GROUP BY flag_color').all();
    const totalRecords = since
      ? db.prepare('SELECT COUNT(*) as count FROM hub_records WHERE updated_date >= ?').get(since)
      : db.prepare('SELECT COUNT(*) as count FROM hub_records').get();

    const flagTotals = { none: 0, red: 0, orange: 0, green: 0 };
    for (const row of totals) {
      if (row.flag_color in flagTotals) flagTotals[row.flag_color] = row.count;
    }

    const perSite = sites.map(s => {
      // Live count from hub_records instead of stale last_kpis cache
      const siteTotal = since
        ? db.prepare('SELECT COUNT(*) as count FROM hub_records WHERE site_id = ? AND updated_date >= ?').get(s.id, since)
        : db.prepare('SELECT COUNT(*) as count FROM hub_records WHERE site_id = ?').get(s.id);
      const siteFlagRows = since
        ? db.prepare('SELECT flag_color, COUNT(*) as count FROM hub_records WHERE site_id = ? AND updated_date >= ? GROUP BY flag_color').all(s.id, since)
        : db.prepare('SELECT flag_color, COUNT(*) as count FROM hub_records WHERE site_id = ? GROUP BY flag_color').all(s.id);
      const siteFlags = { none: 0, red: 0, orange: 0, green: 0 };
      for (const row of siteFlagRows) {
        if (row.flag_color in siteFlags) siteFlags[row.flag_color] = row.count;
      }
      return {
        site_id: s.id,
        site_slug: s.slug,
        site_name: s.name,
        status: s.status,
        last_seen: s.last_seen,
        kpis: {
          total_records: siteTotal?.count || 0,
          records_by_flag: siteFlags,
        },
      };
    });

    res.json({
      total_records: totalRecords.count,
      records_by_flag: flagTotals,
      sites: perSite,
      since,
      generated_at: new Date().toISOString(),
    });
  });

  // GET /api/hub/trends — weekly/monthly record count + flag rate per site
  router.get('/api/hub/trends', requireAuth, requirePermission('can_access_hub_trends'), (req, res) => {
    const period = req.query.period === 'monthly' ? 'monthly' : 'weekly';
    const sinceParam = req.query.since ? String(req.query.since) : null;

    if (sinceParam && !/^\d{4}-\d{2}-\d{2}$/.test(sinceParam)) {
      return res.status(400).json({ error: 'since must be YYYY-MM-DD' });
    }

    const since = sinceParam || (() => {
      const d = new Date();
      if (period === 'monthly') {
        d.setMonth(d.getMonth() - 6);
      } else {
        d.setDate(d.getDate() - (12 * 7));
      }
      return d.toISOString().slice(0, 10);
    })();

    const bucketExpr = period === 'monthly'
      ? "strftime('%Y-%m', hr.updated_date)"
      : "strftime('%Y-W%W', hr.updated_date)";

    try {
      const rows = db.prepare(`
        SELECT
          ${bucketExpr} AS period,
          hr.site_id,
          COALESCE(hs.name, hr.site_id) AS site_name,
          COUNT(*) AS total_records,
          SUM(CASE WHEN hr.flag_color IS NOT NULL AND hr.flag_color NOT IN ('', 'none') THEN 1 ELSE 0 END) AS flagged_records
        FROM hub_records hr
        LEFT JOIN hub_sites hs ON hs.id = hr.site_id
        WHERE hr.updated_date >= ?
          AND ${bucketExpr} IS NOT NULL
        GROUP BY ${bucketExpr}, hr.site_id, hs.name
        ORDER BY ${bucketExpr} ASC, hr.site_id ASC
      `).all(since);

      res.json({
        period,
        since,
        data: rows.map((row) => ({
          period: row.period,
          site_id: row.site_id,
          site_name: row.site_name,
          total_records: row.total_records,
          flagged_records: row.flagged_records,
          flag_rate: row.total_records > 0
            ? Math.round((row.flagged_records / row.total_records) * 1000) / 10
            : 0,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/hub/inventory
  // GET /api/hub/bat-summary — cross-site BAT reconciliation rollup. Joins
  // hub_bat_summary with hub_sites for the friendly site name + URL, computes
  // grand totals across the network.
  router.get('/api/hub/bat-summary', requireAuth, (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT s.id AS site_id, s.name AS site_name, s.slug AS site_slug, s.url AS site_url, s.status AS site_status, s.last_seen,
               b.total_supplier, b.total_sage, b.total_variance,
               b.weeks_count, b.matched_count, b.mismatch_count, b.awaiting_count,
               b.missing_weeks_count,
               b.summary_year, b.last_paid_week, b.last_paid_year,
               b.last_bat_week, b.last_bat_year,
               b.missing_credit_notes_weeks, b.mismatch_weeks,
               b.total_exceptions, b.total_exception_amount,
               b.last_upload_at, b.synced_at, b.last_error
        FROM hub_sites s
        LEFT JOIN hub_bat_summary b ON b.site_id = s.id
        ORDER BY s.name
      `).all();

      // Parse JSON-stored week-number arrays back to JS arrays for the
      // frontend. Stored as TEXT because SQLite has no native array type;
      // null/empty → empty array so the UI doesn't have to special-case
      // older sites that haven't reported these fields yet.
      const parseWeeks = (raw) => {
        if (!raw) return [];
        try {
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
      };

      const sites = rows.map(r => ({
        site_id: r.site_id,
        site_name: r.site_name,
        site_slug: r.site_slug,
        site_url: r.site_url,
        site_status: r.site_status,
        last_seen: r.last_seen,
        total_supplier: r.total_supplier || 0,
        total_sage: r.total_sage || 0,
        total_variance: r.total_variance || 0,
        weeks_count: r.weeks_count || 0,
        matched_count: r.matched_count || 0,
        mismatch_count: r.mismatch_count || 0,
        awaiting_count: r.awaiting_count || 0,
        missing_weeks_count: r.missing_weeks_count || 0,
        summary_year: r.summary_year ?? null,
        last_paid_week: r.last_paid_week ?? null,
        last_paid_year: r.last_paid_year ?? null,
        last_bat_week: r.last_bat_week ?? null,
        last_bat_year: r.last_bat_year ?? null,
        missing_credit_notes_weeks: parseWeeks(r.missing_credit_notes_weeks),
        mismatch_weeks: parseWeeks(r.mismatch_weeks),
        total_exceptions: r.total_exceptions || 0,
        total_exception_amount: r.total_exception_amount || 0,
        last_upload_at: r.last_upload_at,
        synced_at: r.synced_at,
        last_error: r.last_error,
        has_data: !!r.synced_at && !r.last_error,
      }));

      const summary = {
        site_count: sites.length,
        sites_with_data: sites.filter(s => s.has_data).length,
        sites_with_errors: sites.filter(s => s.last_error).length,
        total_supplier: sites.reduce((s, x) => s + x.total_supplier, 0),
        total_sage: sites.reduce((s, x) => s + x.total_sage, 0),
        total_variance: sites.reduce((s, x) => s + x.total_variance, 0),
        total_weeks: sites.reduce((s, x) => s + x.weeks_count, 0),
        total_matched: sites.reduce((s, x) => s + x.matched_count, 0),
        total_mismatch: sites.reduce((s, x) => s + x.mismatch_count, 0),
        total_awaiting: sites.reduce((s, x) => s + x.awaiting_count, 0),
        total_missing_weeks: sites.reduce((s, x) => s + x.missing_weeks_count, 0),
        total_exceptions: sites.reduce((s, x) => s + x.total_exceptions, 0),
        total_exception_amount: sites.reduce((s, x) => s + x.total_exception_amount, 0),
      };

      res.json({ summary, sites, generated_at: new Date().toISOString() });
    } catch (err) {
      console.error('[hub/bat-summary] error:', err);
      res.status(500).json({ error: 'Failed to fetch BAT summary' });
    }
  });

  // POST /api/hub/bat-summary/refresh — triggers an immediate cross-site sync
  // (uses the existing syncAllSites function which now also pulls BAT summaries).
  router.post('/api/hub/bat-summary/refresh', requireAuth, requireAdmin, async (req, res) => {
    try {
      await syncAllSites();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

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
      res.json({ count: rows.length, records: rows.map(expandDataRecord) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/hub/customer-lookup — returns main record + sub-accounts from hub_records
  router.get('/api/hub/customer-lookup', requireAuth, (req, res) => {
    const { query, site_id } = req.query;
    if (!query || !site_id) return res.status(400).json({ error: 'query and site_id are required' });
    try {
      const q = String(query).trim();
      const record = db.prepare(`
        SELECT * FROM hub_records
        WHERE site_id = ? AND (TRIM(customer_number) = ? OR lower(customer_name) = lower(?))
        ORDER BY CASE WHEN TRIM(customer_number) = ? THEN 0 ELSE 1 END, id DESC
        LIMIT 1
      `).get(site_id, q, q, q);

      if (!record) return res.json({ record: null, subAccounts: [] });

      const parseBlobs = (r) => {
        try { r.unpaid_invoices = r.unpaid_invoices ? JSON.parse(r.unpaid_invoices) : []; } catch { r.unpaid_invoices = []; }
        try { r.receipts = r.receipts ? JSON.parse(r.receipts) : []; } catch { r.receipts = []; }
        return r;
      };

      const customerNumber = String(record.customer_number || '').trim();
      const isParent = /^\d+$/.test(customerNumber);
      let subAccounts = [];
      if (isParent) {
        // GLOB pattern `<parent>[!0-9]*` means: literal parent digits, then
        // exactly one non-digit char, then anything. This filters at SQLite
        // level instead of the previous LIKE-prefix + JS regex post-filter
        // pattern, which pulled every prefix-match (e.g. parent "100"
        // dragged out 1001, 1002, 1003 …) just to throw them away in JS
        // after parsing every JSON blob. GLOB-with-character-class does the
        // same job in one query without the parse-then-discard cost.
        // customerNumber is `^\d+$`-validated above so no GLOB-injection
        // risk, but we bind it as a parameter anyway.
        const prefixMatches = db.prepare(`
          SELECT * FROM hub_records
          WHERE site_id = ? AND TRIM(customer_number) GLOB ?
          ORDER BY customer_number ASC, id ASC
        `).all(site_id, `${customerNumber}[!0-9]*`);
        subAccounts = prefixMatches.map(r => expandDataRecord(parseBlobs(r)));
      }

      res.json({ record: expandDataRecord(parseBlobs(record)), subAccounts });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/hub/sync-log
  // Joins hub_sites so the UI gets the human-readable slug instead of the
  // opaque site_id, and aliases `error` → `error_message` to match what the
  // HubSyncLog page renders. Without this join + alias, every row in the
  // page showed an empty SITE column and "—" in NOTE — the actual errors
  // were captured in DB but invisible to the operator, which is exactly
  // why "the hub isn't syncing" went undiagnosed.
  router.get('/api/hub/sync-log', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const rows = db.prepare(`
      SELECT
        l.id,
        l.site_id,
        COALESCE(s.slug, l.site_id) AS site_slug,
        s.name AS site_name,
        l.started_at,
        l.completed_at,
        l.records_fetched,
        l.status,
        l.error,
        l.error AS error_message
      FROM hub_sync_log l
      LEFT JOIN hub_sites s ON s.id = l.site_id
      ORDER BY l.started_at DESC
      LIMIT ?
    `).all(limit);
    res.json(rows);
  });

  router.get('/api/hub/audit-log', requireAuth, requirePermission('can_access_hub_audit_log'), (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const rows = db.prepare(`
        SELECT *
        FROM hub_audit_log
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(limit);
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/hub/force-resync — clears sync history and hub_records, triggers full re-pull
  router.post('/api/hub/force-resync', requireAuth, requireAdmin, (req, res) => {
    try {
      db.prepare('DELETE FROM hub_sync_log').run();
      db.prepare('DELETE FROM hub_records').run();
      db.prepare('DELETE FROM hub_inventory').run();
      logHubAudit({
        action: 'force_resync',
        performedBy: req.currentUser?.email,
        target: 'all_sites',
      });
      logAudit({
        req, action: 'hub_force_resync_all', resourceType: 'system',
        resourceName: 'All hub sites',
        details: 'Cleared hub_records, hub_inventory, hub_sync_log; full pull triggered',
      });
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
      const site = db.prepare('SELECT slug, name FROM hub_sites WHERE id = ?').get(siteId);
      logHubAudit({
        action: 'force_resync',
        performedBy: req.currentUser?.email,
        target: site?.slug || siteId,
      });
      logAudit({
        req, action: 'hub_force_resync_site', resourceType: 'system',
        resourceId: siteId, resourceName: site?.name || site?.slug || siteId,
        details: `Cleared site data and triggered full pull for site ${siteId}`,
      });
      syncAllSites().catch(err => console.error("force-resync error:", err));
      res.status(202).json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/hub/site/:siteId — remove a site and all its data
  router.delete('/api/hub/site/:siteId', requireAuth, requireAdmin, (req, res) => {
    const { siteId } = req.params;
    try {
      const site = db.prepare('SELECT id, name, slug FROM hub_sites WHERE id = ?').get(siteId);
      if (!site) return res.status(404).json({ error: 'Site not found' });

      db.prepare('DELETE FROM hub_records WHERE site_id = ?').run(siteId);
      db.prepare('DELETE FROM hub_inventory WHERE site_id = ?').run(siteId);
      db.prepare('DELETE FROM hub_sync_log WHERE site_id = ?').run(siteId);
      db.prepare('DELETE FROM hub_sites WHERE id = ?').run(siteId);

      logHubAudit({
        action: 'delete_site',
        performedBy: req.currentUser?.email,
        target: site.slug || siteId,
        detail: `Removed site "${site.name}" (${siteId}) and all associated data`,
      });
      logAudit({
        req, action: 'hub_delete_site', resourceType: 'system',
        resourceId: siteId, resourceName: site.name,
        details: `Removed site "${site.name}" (${site.slug || siteId}) and all associated data`,
      });

      res.json({ ok: true, message: `Deleted site "${site.name}" and all its data` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/hub/dedupe — remove duplicate hub_records (same site_id + customer_number)
  router.post('/api/hub/dedupe', requireAuth, requireAdmin, (req, res) => {
    try {
      const dryRun = req.body?.dryRun !== false;

      const dupGroups = db.prepare(`
        SELECT site_id, TRIM(customer_number) AS customer_number, COUNT(*) AS cnt
        FROM hub_records
        WHERE TRIM(COALESCE(customer_number, '')) != ''
        GROUP BY site_id, TRIM(customer_number)
        HAVING COUNT(*) > 1
        ORDER BY cnt DESC
      `).all();

      const report = [];
      let totalRemoved = 0;

      const tx = db.transaction(() => {
        for (const group of dupGroups) {
          const rows = db.prepare(`
            SELECT site_id, record_id, customer_number, customer_name, flag_color, flag_reason, synced_at, updated_date
            FROM hub_records
            WHERE site_id = ? AND TRIM(customer_number) = ?
            ORDER BY
              CASE WHEN flag_color IS NOT NULL AND flag_color != 'none' AND flag_color != '' THEN 0 ELSE 1 END,
              CASE WHEN synced_at IS NULL THEN 1 ELSE 0 END,
              COALESCE(synced_at, updated_date, '') DESC,
              record_id DESC
          `).all(group.site_id, group.customer_number);

          const keeper = rows[0];
          const dupes = rows.slice(1);

          for (const dupe of dupes) {
            if (!dryRun) {
              db.prepare('DELETE FROM hub_records WHERE site_id = ? AND record_id = ?').run(dupe.site_id, dupe.record_id);
            }
          }

          totalRemoved += dupes.length;
          report.push({
            site_id: group.site_id,
            customer_number: group.customer_number,
            customer_name: keeper.customer_name,
            kept_record_id: keeper.record_id,
            removed_count: dupes.length,
          });
        }
      });

      tx();

      logHubAudit({
        action: 'dedupe_hub_records',
        performedBy: req.currentUser?.email,
        target: `${dupGroups.length} groups, ${totalRemoved} duplicates ${dryRun ? '(dry run)' : 'removed'}`,
      });
      logAudit({
        req, action: dryRun ? 'hub_dedupe_dryrun' : 'hub_dedupe', resourceType: 'system',
        resourceName: 'Hub customer deduplication',
        details: dryRun
          ? `Dry-run found ${dupGroups.length} duplicate group(s) with ${totalRemoved} extra row(s)`
          : `Removed ${totalRemoved} duplicate row(s) across ${dupGroups.length} group(s)`,
      });

      res.json({ ok: true, dryRun, groups: report.length, totalRemoved, report });
    } catch (err) {
      console.error('[hub] dedupe failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/hub/ping-status — latest ping result per site
  router.get('/api/hub/ping-status', requireAuth, requirePermission('can_access_hub_metrics'), (req, res) => {
    try {
      let rows = [];
      try {
        rows = db.prepare(`
          SELECT p.site_slug, p.online, p.latency_ms, p.timestamp
          FROM hub_site_ping p
          INNER JOIN (
            SELECT site_slug, MAX(id) AS max_id FROM hub_site_ping GROUP BY site_slug
          ) latest ON p.id = latest.max_id
        `).all();
      } catch (_) { /* table not yet created */ }
      res.json({ sites: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/hub/machine-health — aggregated machine health per site
  router.get('/api/hub/machine-health', requireAuth, requirePermission('can_access_hub_metrics'), async (req, res) => {
    const sites = db.prepare('SELECT id, slug, name, url, token FROM hub_sites').all();

    const results = await Promise.all(sites.map(async (site) => {
      const base = {
        site_id: site.id,
        site_slug: site.slug,
        site_name: site.name,
        url: site.url,
      };

      if (!site.url) {
        return {
          ...base,
          ok: false,
          message: 'No API URL configured',
          machine: { hostname: null, os_version: null, uptime_seconds: null, last_boot_at: null, local_ips: [] },
          cpu: { usage_percent: null, sample_seconds: 3, sampled: false },
          memory: { total_bytes: null, used_bytes: null, free_bytes: null, used_percent: null },
          disks: [],
          cardoso_service: { name: 'CardosoCigarettes', present: null, status: null, display_name: null, start_type: null },
          health: { status: 'unavailable', needs_attention: true, reasons: ['No API URL configured'] },
        };
      }

      try {
        const response = await fetch(`${site.url}/api/reporting/machine-health`, {
          headers: { 'x-reporting-token': site.token || '' },
          signal: AbortSignal.timeout(15000),
        });

        let machineHealth;
        if (!response.ok) {
          machineHealth = {
            ...base,
            ok: false,
            message: `HTTP ${response.status}`,
            machine: { hostname: null, os_version: null, uptime_seconds: null, last_boot_at: null, local_ips: [] },
            cpu: { usage_percent: null, sample_seconds: 3, sampled: false },
            memory: { total_bytes: null, used_bytes: null, free_bytes: null, used_percent: null },
            disks: [],
            cardoso_service: { name: 'CardosoCigarettes', present: null, status: null, display_name: null, start_type: null },
          };
        } else {
          machineHealth = await response.json();
        }

        machineHealth.site_id ||= site.id;
        machineHealth.site_slug ||= site.slug;
        machineHealth.site_name ||= site.name;
        machineHealth.app_version ||= null;
        machineHealth.url = site.url;
        machineHealth.health = getMachineHealthSummary(machineHealth);
        return machineHealth;
      } catch (err) {
        const message = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'Timeout' : err.message;
        return {
          ...base,
          ok: false,
          message,
          machine: { hostname: null, os_version: null, uptime_seconds: null, last_boot_at: null, local_ips: [] },
          cpu: { usage_percent: null, sample_seconds: 3, sampled: false },
          memory: { total_bytes: null, used_bytes: null, free_bytes: null, used_percent: null },
          disks: [],
          cardoso_service: { name: 'CardosoCigarettes', present: null, status: null, display_name: null, start_type: null },
          health: { status: 'unavailable', needs_attention: true, reasons: [message] },
        };
      }
    }));

    res.json({
      sites: results,
      attention: results.some((site) => site.health?.needs_attention),
    });
  });

  // POST /api/hub/sync
  router.post('/api/hub/sync', requireAuth, requireAdmin, (req, res) => {
    logAudit({
      req, action: 'hub_manual_sync', resourceType: 'system',
      resourceName: 'All hub sites',
      details: `Manual sync triggered for ${HUB_SITES.length} site(s): ${HUB_SITES.map(s => s.slug).join(', ').slice(0, 200)}`,
    });
    res.status(202).json({ message: 'Sync triggered', sites: HUB_SITES.map(s => s.slug) });
    syncAllSites().catch(err => console.error('[HUB] Manual sync error:', err));
  });

  // ==================== HUB: CENTRALISED USER MANAGEMENT ====================

  // GET /api/hub/users — list all users on this hub (admin only)
  router.get('/api/hub/users', requireAuth, requireAdmin, (req, res) => {
    try {
      const users = db.prepare(`
        SELECT id, email, full_name, role, is_active, hub_redirect,
               can_access_customer_search, can_access_customer_balances, can_access_collections, can_access_inventory, can_access_network_devices,
               can_access_hub_metrics, can_access_hub_backups, can_access_hub_trends, can_access_hub_audit_log,
               can_access_records, can_access_reports, can_access_connections, can_access_settings,
               can_manage_users, can_manage_rules, can_edit_records, can_flag_records, created_date
        FROM "user" ORDER BY role DESC, full_name ASC
      `).all();
      const sitesByEmail = {};
      let userSiteRows = [];
      try { userSiteRows = db.prepare(`SELECT email, site_slug, pushed_at FROM hub_user_sites`).all(); } catch (_) { /* table may not exist yet */ }
      userSiteRows.forEach(row => {
          if (!sitesByEmail[row.email]) sitesByEmail[row.email] = [];
          sitesByEmail[row.email].push({ slug: row.site_slug, pushed_at: row.pushed_at });
        });

      // hub_user_allowed_sites: which sites on the Hub this user is allowed to see
      const allowedByEmail = {};
      let allowedSiteRows = [];
      try { allowedSiteRows = db.prepare(`SELECT email, site_slug, assigned_at FROM hub_user_allowed_sites`).all(); } catch (_) { /* table may not exist yet */ }
      allowedSiteRows.forEach(row => {
          if (!allowedByEmail[row.email]) allowedByEmail[row.email] = [];
          allowedByEmail[row.email].push({ slug: row.site_slug, assigned_at: row.assigned_at });
        });

      res.json(users.map(u => ({
        ...u,
        is_active: boolFromRow(u.is_active, true),
        hub_redirect: boolFromRow(u.hub_redirect, false),
        can_access_customer_search: boolFromRow(u.can_access_customer_search, true),
        can_access_customer_balances: boolFromRow(u.can_access_customer_balances, true),
        can_access_collections: boolFromRow(u.can_access_collections, true),
        can_access_inventory: boolFromRow(u.can_access_inventory, true),
        can_access_network_devices: boolFromRow(u.can_access_network_devices, false),
        can_access_hub_metrics: boolFromRow(u.can_access_hub_metrics, false),
        can_access_hub_backups: boolFromRow(u.can_access_hub_backups, false),
        can_access_hub_trends: boolFromRow(u.can_access_hub_trends, false),
        can_access_hub_audit_log: boolFromRow(u.can_access_hub_audit_log, false),
        can_access_records: boolFromRow(u.can_access_records, false),
        can_access_reports: boolFromRow(u.can_access_reports, false),
        can_access_connections: boolFromRow(u.can_access_connections, false),
        can_access_settings: boolFromRow(u.can_access_settings, false),
        can_manage_users: boolFromRow(u.can_manage_users, false),
        can_manage_rules: boolFromRow(u.can_manage_rules, false),
        can_edit_records: boolFromRow(u.can_edit_records, true),
        can_flag_records: boolFromRow(u.can_flag_records, true),
        sites: sitesByEmail[u.email] || [],
        allowed_sites: allowedByEmail[u.email] || [],  // Hub-side restrictions: which sites this user can access on the Hub
      })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/hub/users/:id/allowed-sites — set which sites this Hub user can access on the Hub
  router.put('/api/hub/users/:id/allowed-sites', requireAuth, requireAdmin, (req, res) => {
    const userId = parseInt(req.params.id);
    const { site_slugs } = req.body; // array of site slugs this user is allowed to see
    if (!Array.isArray(site_slugs)) {
      return res.status(400).json({ error: 'site_slugs must be an array' });
    }

    const user = db.prepare(`SELECT * FROM "user" WHERE id = ?`).get(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    try {
      const deleteStmt = db.prepare(`DELETE FROM hub_user_allowed_sites WHERE email = ?`);
      const insertStmt = db.prepare(`INSERT INTO hub_user_allowed_sites (email, site_slug, assigned_at) VALUES (?, ?, datetime('now'))`);
      const txn = db.transaction(() => {
        deleteStmt.run(user.email);
        for (const slug of site_slugs) {
          insertStmt.run(user.email, slug);
        }
      });
      txn();

      logHubAudit({
        action: 'update_user_allowed_sites',
        performedBy: req.currentUser?.email,
        target: user.email,
        detail: JSON.stringify({ allowed_sites: site_slugs }),
      });
      logAudit({
        req, action: 'update_user_allowed_sites', resourceType: 'user',
        resourceId: user.id, resourceName: user.email,
        details: site_slugs.length === 0
          ? 'Cleared site access (user can see no sites)'
          : `Allowed ${site_slugs.length} site(s): ${site_slugs.slice(0, 8).join(', ')}${site_slugs.length > 8 ? ` (+${site_slugs.length - 8} more)` : ''}`,
      });

      res.json({ ok: true, allowed_sites: site_slugs });
    } catch (err) {
      console.error('[hub] update allowed_sites error:', err);
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
             can_access_customer_search, can_access_customer_balances, can_access_collections, can_access_inventory, can_access_network_devices,
             can_access_hub_metrics, can_access_hub_backups, can_access_hub_trends, can_access_hub_audit_log,
             can_access_records, can_access_reports, can_access_connections, can_access_settings,
             can_manage_users, can_manage_rules, can_edit_records, can_flag_records,
             password_hash, must_change_password
      FROM "user" WHERE id IN (${user_ids.map(() => '?').join(',')})
    `).all(...user_ids);

    if (usersToSync.length === 0) return res.status(404).json({ error: 'No matching users' });

    const targetSites = site_ids
      ? HUB_SITES.filter(s => site_ids.includes(s.id))
      : HUB_SITES;

    if (targetSites.length === 0) return res.status(400).json({ error: 'No target sites' });

    const results = await Promise.allSettled(targetSites.map(async (site) => {
      const url = `${site.url}/api/hub/receive-users`;
      try {
        const resp = await fetch(url, {
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
          throw new Error(`HTTP ${resp.status} — ${body || 'no body'}`);
        }
        return { site: site.name, ok: true };
      } catch (err) {
        // describeFetchError unwraps undici "fetch failed" → real cause + URL.
        // Re-throw with the readable form so summary.error below is useful.
        throw new Error(describeFetchError(err, url));
      }
    }));

    const summary = results.map((r, i) => ({
      site: targetSites[i].name,
      slug: targetSites[i].slug,
      ok: r.status === 'fulfilled',
      error: r.status === 'rejected' ? r.reason.message : null,
    }));

    // Record which users were successfully pushed to which sites
    const upsertSite = db.prepare(`
      INSERT INTO hub_user_sites (email, site_slug, pushed_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(email, site_slug) DO UPDATE SET pushed_at = excluded.pushed_at
    `);
    for (const res_row of summary.filter(s => s.ok)) {
      for (const u of usersToSync) {
        upsertSite.run(u.email, res_row.slug);
      }
      logHubAudit({
        action: 'push_users',
        performedBy: req.currentUser?.email,
        target: res_row.slug,
        detail: JSON.stringify(usersToSync.map((user) => user.email)),
      });
    }

    const allOk = summary.every(s => s.ok);
    const okCount = summary.filter(s => s.ok).length;
    const failCount = summary.length - okCount;
    logAudit({
      req, action: 'hub_push_users', resourceType: 'user',
      resourceName: `${usersToSync.length} user(s) → ${targetSites.length} site(s)`,
      details: `Pushed ${usersToSync.map(u => u.email).slice(0, 5).join(', ')}${usersToSync.length > 5 ? ` (+${usersToSync.length - 5} more)` : ''} to ${okCount}/${summary.length} site(s)${failCount ? `, failed ${failCount}` : ''}`,
      status: allOk ? 'success' : 'failure',
      changes: { users: usersToSync.map(u => u.email), sites: summary },
    });
    res.status(allOk ? 200 : 207).json({ results: summary });
  });

  router.post('/api/hub/clear-auto-flags', requireAuth, requireAdmin, (req, res) => {
    try {
      const result = db.prepare(`
        UPDATE hub_records
        SET flag_color = NULL,
            flag_reason = NULL,
            auto_flagged = 0
        WHERE auto_flagged = 1
      `).run();
      logHubAudit({
        action: 'clear_auto_flags',
        performedBy: req.currentUser?.email,
        target: 'all_sites',
        detail: String(result.changes),
      });
      logAudit({
        req, action: 'hub_clear_auto_flags', resourceType: 'system',
        resourceName: 'Hub auto-flags',
        details: `Cleared ${result.changes} auto-flagged record(s) hub-wide`,
      });
      res.json({ cleared: result.changes });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/hub/push-rules', requireAuth, requireAdmin, async (req, res) => {
    try {
      const rawSiteIds = Array.isArray(req.body?.site_ids) ? req.body.site_ids.filter(Boolean) : null;
      const rules = db.prepare(`
        SELECT rule_name, conditions, logic, flag_color, is_active, priority, created_by
        FROM autoflagrule
        ORDER BY priority DESC, id ASC
      `).all();

      const targetSites = rawSiteIds && rawSiteIds.length > 0
        ? HUB_SITES.filter((site) => rawSiteIds.includes(site.id))
        : HUB_SITES;

      if (targetSites.length === 0) {
        return res.status(400).json({ error: 'No target sites' });
      }

      const results = await Promise.all(targetSites.map(async (site) => {
        const url = `${site.url}/api/hub/receive-rules`;
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-hub-token': site.token,
            },
            body: JSON.stringify({ rules }),
            signal: AbortSignal.timeout(15000),
          });

          if (!response.ok) {
            const body = await response.text();
            throw new Error(`HTTP ${response.status} — ${body || 'no body'}`);
          }

          logHubAudit({
            action: 'push_rules',
            performedBy: req.currentUser?.email,
            target: site.slug || site.id,
            detail: String(rules.length),
          });

          return { site: site.name || site.slug || site.id, status: 'ok' };
        } catch (err) {
          // Frontend reads `result.error` first, then result.status — pass the
          // describeFetchError-shaped string in `error` so the toast is useful.
          return {
            site: site.name || site.slug || site.id,
            status: 'error',
            error: describeFetchError(err, url),
          };
        }
      }));

      const okCount = results.filter((result) => result.status === 'ok').length;
      const failCount = results.length - okCount;
      logAudit({
        req, action: 'hub_push_rules', resourceType: 'rule',
        resourceName: `${rules.length} rule(s) → ${results.length} site(s)`,
        details: `Pushed ${rules.length} rule(s) to ${okCount}/${results.length} site(s)${failCount ? `, failed ${failCount}` : ''}`,
        status: failCount === 0 ? 'success' : 'failure',
        changes: { rule_count: rules.length, sites: results },
      });
      res.status(results.every((result) => result.status === 'ok') ? 200 : 207).json({
        pushed: okCount,
        results,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/hub/receive-users is registered on ALL installs (hub + site).
  // See createReceiveUsersRouter() below — mounted separately in server.js.

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
  router.get('/api/hub/audit-log', (req, res) => res.json([]));
  router.get('/api/hub/trends', (req, res) => res.json({ period: 'weekly', since: null, data: [] }));
  router.get('/api/hub/network-devices', (req, res) => res.json({ devices: [], samples: [], sites: [] }));
  router.get('/api/hub/customer-lookup', (req, res) => res.json({ record: null, subAccounts: [] }));
  return router;
}

/**
 * createReceiveUsersRouter — ALWAYS mounted, on both hub and site installs.
 * Sites need this endpoint so the hub can push users to them.
 * Authenticated via X-Reporting-Token (site's own REPORTING_TOKEN env var).
 */
export function createReceiveUsersRouter() {
  const router = Router();

  router.post('/api/hub/receive-users', async (req, res) => {
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
          // Update role, permissions, status — never overwrite a local password the user
          // may have changed on-site. Exception: if hub user has must_change_password = 0
          // (they set a real password at the hub), sync that hash + clear the flag so they
          // can log in at the site with the same credentials without being forced to reset.
          const hubHasRealPassword = u.password_hash && u.must_change_password === 0;
          if (hubHasRealPassword) {
            db.prepare(`
              UPDATE "user" SET
                full_name = ?, role = ?, is_active = ?, hub_redirect = ?,
                can_access_customer_search = ?, can_access_customer_balances = ?, can_access_collections = ?, can_access_inventory = ?, can_access_network_devices = ?,
                can_access_hub_metrics = ?, can_access_hub_backups = ?, can_access_hub_trends = ?, can_access_hub_audit_log = ?,
                can_access_records = ?, can_access_reports = ?, can_access_connections = ?, can_access_settings = ?,
                can_manage_users = ?, can_manage_rules = ?, can_edit_records = ?, can_flag_records = ?,
                password_hash = ?, must_change_password = 0
              WHERE email = ?
            `).run(
              u.full_name || null,
              u.role || 'user',
              u.is_active ? 1 : 0,
              u.hub_redirect ? 1 : 0,
              u.can_access_customer_search !== false ? 1 : 0,
              u.can_access_customer_balances !== false ? 1 : 0,
              u.can_access_collections !== false ? 1 : 0,
              u.can_access_inventory !== false ? 1 : 0,
              u.can_access_network_devices ? 1 : 0,
              u.can_access_hub_metrics ? 1 : 0,
              u.can_access_hub_backups ? 1 : 0,
              u.can_access_hub_trends ? 1 : 0,
              u.can_access_hub_audit_log ? 1 : 0,
              u.can_access_records ? 1 : 0,
              u.can_access_reports ? 1 : 0,
              u.can_access_connections ? 1 : 0,
              u.can_access_settings ? 1 : 0,
              u.can_manage_users ? 1 : 0,
              u.can_manage_rules ? 1 : 0,
              u.can_edit_records ? 1 : 0,
              u.can_flag_records ? 1 : 0,
              u.password_hash,
              u.email
            );
          } else {
            db.prepare(`
              UPDATE "user" SET
                full_name = ?, role = ?, is_active = ?, hub_redirect = ?,
                can_access_customer_search = ?, can_access_customer_balances = ?, can_access_collections = ?, can_access_inventory = ?, can_access_network_devices = ?,
                can_access_hub_metrics = ?, can_access_hub_backups = ?, can_access_hub_trends = ?, can_access_hub_audit_log = ?,
                can_access_records = ?, can_access_reports = ?, can_access_connections = ?, can_access_settings = ?,
                can_manage_users = ?, can_manage_rules = ?, can_edit_records = ?, can_flag_records = ?
              WHERE email = ?
            `).run(
              u.full_name || null,
              u.role || 'user',
              u.is_active ? 1 : 0,
              u.hub_redirect ? 1 : 0,
              u.can_access_customer_search !== false ? 1 : 0,
              u.can_access_customer_balances !== false ? 1 : 0,
              u.can_access_collections !== false ? 1 : 0,
              u.can_access_inventory !== false ? 1 : 0,
              u.can_access_network_devices ? 1 : 0,
              u.can_access_hub_metrics ? 1 : 0,
              u.can_access_hub_backups ? 1 : 0,
              u.can_access_hub_trends ? 1 : 0,
              u.can_access_hub_audit_log ? 1 : 0,
              u.can_access_records ? 1 : 0,
              u.can_access_reports ? 1 : 0,
              u.can_access_connections ? 1 : 0,
              u.can_access_settings ? 1 : 0,
              u.can_manage_users ? 1 : 0,
              u.can_manage_rules ? 1 : 0,
              u.can_edit_records ? 1 : 0,
              u.can_flag_records ? 1 : 0,
              u.email
            );
          }
          updated++;
        } else {
          // New user — use the hub's password hash directly if available.
          // If hub set a custom password (must_change_password = 0), push it as-is.
          // If hub still has the default (must_change_password = 1), use the hub hash
          // so credentials match, but keep must_change_password = 1 to force reset.
          let passwordHash = u.password_hash;
          let mustChange = u.must_change_password ? 1 : 0;
          if (!passwordHash) {
            // Fallback: hub didn't send a hash (old hub version) — generate default
            const defaultPw = process.env.DEFAULT_USER_PASSWORD || `Cardoso@${new Date().getFullYear()}`;
            passwordHash = await bcrypt.hash(defaultPw, 12);
            mustChange = 1;
          }
          db.prepare(`
            INSERT INTO "user" (email, full_name, role, is_active, hub_redirect, must_change_password,
              can_access_customer_search, can_access_customer_balances, can_access_collections, can_access_inventory, can_access_network_devices,
              can_access_hub_metrics, can_access_hub_backups, can_access_hub_trends, can_access_hub_audit_log,
              can_access_records, can_access_reports, can_access_connections, can_access_settings,
              can_manage_users, can_manage_rules, can_edit_records, can_flag_records, password_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            u.email,
            u.full_name || null,
            u.role || 'user',
            u.is_active ? 1 : 0,
            u.hub_redirect ? 1 : 0,
            mustChange,
            u.can_access_customer_search !== false ? 1 : 0,
            u.can_access_customer_balances !== false ? 1 : 0,
            u.can_access_collections !== false ? 1 : 0,
            u.can_access_inventory !== false ? 1 : 0,
            u.can_access_network_devices ? 1 : 0,
            u.can_access_hub_metrics ? 1 : 0,
            u.can_access_hub_backups ? 1 : 0,
            u.can_access_hub_trends ? 1 : 0,
            u.can_access_hub_audit_log ? 1 : 0,
            u.can_access_records ? 1 : 0,
            u.can_access_reports ? 1 : 0,
            u.can_access_connections ? 1 : 0,
            u.can_access_settings ? 1 : 0,
            u.can_manage_users ? 1 : 0,
            u.can_manage_rules ? 1 : 0,
            u.can_edit_records ? 1 : 0,
            u.can_flag_records ? 1 : 0,
            passwordHash
          );
          created++;
        }
      } catch (err) {
        errors.push({ email: u.email, error: err.message });
      }
    }

    res.json({ created, updated, errors });
  });

  router.post('/api/hub/receive-rules', (req, res) => {
    const token = req.headers['x-hub-token'];
    const expectedToken = process.env.REPORTING_TOKEN;
    if (!expectedToken || token !== expectedToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { rules } = req.body;
    if (!Array.isArray(rules)) {
      return res.status(400).json({ error: 'rules array required' });
    }

    try {
      const replaceRules = db.transaction(() => {
        db.prepare('DELETE FROM autoflagrule').run();
        const insertRule = db.prepare(`
          INSERT INTO autoflagrule (rule_name, conditions, logic, flag_color, is_active, priority, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        for (const rule of rules) {
          insertRule.run(
            rule.rule_name || rule.name,
            typeof rule.conditions === 'string' ? rule.conditions : JSON.stringify(rule.conditions || []),
            rule.logic || 'AND',
            rule.flag_color || rule.color || 'red',
            rule.is_active ?? 1,
            rule.priority ?? 1,
            rule.created_by || null,
          );
        }
      });

      replaceRules();
      res.json({ received: rules.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
