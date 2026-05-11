/**
 * Hub-mode routes — extracted from server.js (US-010).
 *
 * Factory pattern: createHubRouter(deps) returns an Express router.
 * Also exports createNonHubFallbackRouter() for empty-response stubs.
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { readdirSync, statSync, createReadStream, existsSync } from 'fs';
import path from 'path';
import { boolFromRow, expandDataRecord } from '../helpers.js';
import { syncAllSites, syncSite, runHubBackupPull, pullBackupForSite, HUB_SITES } from '../services/hubEtl.js';
import { runConnectionImport } from '../services/syncEngine.js';
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
      `SELECT id, slug, name, url, last_seen, status, last_kpis,
              in_env, removed_from_env_at
       FROM hub_sites`
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
      // Orphan flag: row exists in hub_sites but its id is no longer
      // in HUB_SITES env. Schedulers don't refresh it; per-site action
      // endpoints refuse on it. Surfaced in the UI as a small pill so
      // operators can tell live tiles from frozen ones.
      is_orphan: s.in_env === 0,
      removed_from_env_at: s.removed_from_env_at || null,
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
    // Narrow column list — KPI aggregator only needs these fields,
    // plus the orphan flags so the dashboard tile can render the pill,
    // plus the three last_accpac_* columns so the tile's footer line
    // ("Accpac sync: <timestamp>") and error pill can render. Without
    // these the syncSite UPDATE in hubEtl.js stamps them in the DB
    // every cycle, but the kpis response strips them and the tile
    // shows "(not yet reported)" forever — see the "no silent
    // failures" memory rule for why this kind of plumbing miss is
    // load-bearing.
    //
    // Two-step SELECT to handle the v62 migration-gap window: if the
    // hub was bootstrapped between PR #198 (added the column refs in
    // code) and PR #228 (restored the migration), the DB has hub_sites
    // but is missing the three last_accpac_* columns. A single wide
    // SELECT throws SqliteError("no such column"), the existing bare
    // catch swallows it, and the kpis handler returns an EMPTY sites
    // list — operator sees no tiles at all instead of tiles missing
    // one footer line. v62's comment block (migrations.js:1817-1822)
    // documents the exact gate that produces this state. Detect the
    // schema first via pragma_table_info, then build the SELECT we
    // can actually execute. The accpac fields default to null in
    // the per-site object below when absent from the row.
    try {
      const cols = new Set(
        db.prepare(`SELECT name FROM pragma_table_info('hub_sites')`).all().map(r => r.name)
      );
      const hasAccpac = cols.has('last_accpac_synced_at') && cols.has('last_accpac_status') && cols.has('last_accpac_error');
      const accpacSelect = hasAccpac ? ', last_accpac_synced_at, last_accpac_status, last_accpac_error' : '';
      allSites = db.prepare(`
        SELECT id, slug, name, status, last_seen, in_env, removed_from_env_at${accpacSelect}
        FROM hub_sites
      `).all();
    } catch {}
    const sites = allowedSlugs === null
      ? allSites
      : allSites.filter(s => allowedSlugs.includes(s.slug));

    // ── KPI rollup (one query, in-JS pivot) ─────────────────────────────
    // Previously did 1 + 3 + (sites × 2) = up to 19 queries on an 8-site
    // hub for what is essentially a two-axis aggregation. Collapse to a
    // single GROUP BY (site_id, flag_color) and pivot in JS — the
    // dashboard fires this on every poll + every dateRange flip, so
    // shaving the per-call cost matters.
    const flagBreakdownRows = since
      ? db.prepare('SELECT site_id, flag_color, COUNT(*) as count FROM hub_records WHERE updated_date >= ? GROUP BY site_id, flag_color').all(since)
      : db.prepare('SELECT site_id, flag_color, COUNT(*) as count FROM hub_records GROUP BY site_id, flag_color').all();

    const flagTotals = { none: 0, red: 0, orange: 0, green: 0 };
    let totalRecordsCount = 0;
    const perSiteAgg = new Map(); // site_id → { total, flags }
    for (const row of flagBreakdownRows) {
      const count = row.count || 0;
      totalRecordsCount += count;
      if (row.flag_color in flagTotals) flagTotals[row.flag_color] += count;
      let agg = perSiteAgg.get(row.site_id);
      if (!agg) {
        agg = { total: 0, flags: { none: 0, red: 0, orange: 0, green: 0 } };
        perSiteAgg.set(row.site_id, agg);
      }
      agg.total += count;
      if (row.flag_color in agg.flags) agg.flags[row.flag_color] += count;
    }

    const perSite = sites.map(s => {
      const agg = perSiteAgg.get(s.id);
      return {
        site_id: s.id,
        site_slug: s.slug,
        site_name: s.name,
        status: s.status,
        last_seen: s.last_seen,
        // Orphan flag: row exists but its id is no longer in HUB_SITES.
        // Tile renders an "ORPHAN" pill; per-site action endpoints
        // refuse on it. Operator forgets via the admin section.
        is_orphan: s.in_env === 0,
        removed_from_env_at: s.removed_from_env_at || null,
        // Accpac freshness shown in the tile footer. The DB has the
        // values (syncSite stamps them on every kpis tick); we just
        // need to surface them so the frontend's
        // `site.last_accpac_synced_at` lookup is no longer undefined.
        last_accpac_synced_at: s.last_accpac_synced_at || null,
        last_accpac_status:    s.last_accpac_status    || null,
        last_accpac_error:     s.last_accpac_error     || null,
        kpis: {
          total_records: agg?.total || 0,
          records_by_flag: agg?.flags || { none: 0, red: 0, orange: 0, green: 0 },
        },
      };
    });

    res.json({
      total_records: totalRecordsCount,
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
        // GLOB pattern `<parent>[^0-9]*` means: literal parent digits, then
        // exactly one non-digit char, then anything. This filters at SQLite
        // level instead of the previous LIKE-prefix + JS regex post-filter
        // pattern, which pulled every prefix-match (e.g. parent "100"
        // dragged out 1001, 1002, 1003 …) just to throw them away in JS
        // after parsing every JSON blob.
        //
        // SQLite GLOB class-negation is `[^...]`, NOT `[!...]` (the
        // `[!...]` form is shell glob syntax). An earlier draft of this
        // change used `[!0-9]` which SQLite reads as the character class
        // "literal !, 0–9" — exactly inverting the intent. Verified
        // against better-sqlite3 with the parent test cases: `100`,
        // `100A`, `100-1` are matches; `1001`, `1002` are not. customerNumber
        // is `^\d+$`-validated above so no GLOB-injection risk, but bound
        // as a parameter anyway.
        const prefixMatches = db.prepare(`
          SELECT * FROM hub_records
          WHERE site_id = ? AND TRIM(customer_number) GLOB ?
          ORDER BY customer_number ASC, id ASC
        `).all(site_id, `${customerNumber}[^0-9]*`);
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
    // Orphan guard. force-resync wipes hub_sync_log + hub_records +
    // hub_inventory for the site, then queues a syncAllSites pull —
    // but syncAllSites iterates HUB_SITES (the env-derived list), so
    // for an orphan row the wipe runs and the pull silently skips.
    // Net effect: hub_records evaporate and never come back. Refuse
    // up front and tell the operator to use Forget instead.
    const orphanRow = db.prepare('SELECT in_env, name, slug FROM hub_sites WHERE id = ?').get(siteId);
    if (orphanRow && orphanRow.in_env === 0) {
      return res.status(409).json({
        error: `Site '${orphanRow.name || orphanRow.slug || siteId}' is no longer in HUB_SITES env (orphan). Re-add it to the env to reactivate, or use the Forget button to retire it permanently.`,
      });
    }
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

  // GET /api/hub/orphan-sites — list sites that have been removed from
  // HUB_SITES env (in_env = 0). Backs the admin "Orphan sites" section
  // in Settings. Includes hub_records / hub_inventory row counts so
  // the operator knows how much data the Forget cascade would remove.
  router.get('/api/hub/orphan-sites', requireAuth, requireAdmin, (req, res) => {
    try {
      const orphans = db.prepare(`
        SELECT id, slug, name, url, last_seen, removed_from_env_at
        FROM hub_sites
        WHERE in_env = 0
        ORDER BY removed_from_env_at DESC NULLS LAST, name ASC
      `).all();
      const enriched = orphans.map((o) => {
        const rec = db.prepare(`SELECT COUNT(*) AS n FROM hub_records WHERE site_id = ?`).get(o.id);
        const inv = (() => {
          try { return db.prepare(`SELECT COUNT(*) AS n FROM hub_inventory WHERE site_id = ?`).get(o.id); }
          catch { return { n: 0 }; }
        })();
        return {
          ...o,
          record_count: rec?.n || 0,
          inventory_count: inv?.n || 0,
        };
      });
      res.json({ orphans: enriched });
    } catch (err) {
      try { logError('hub.orphan_sites', err); } catch {}
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/hub/sites/:siteId/forget — admin-only, retires an
  // orphaned site permanently. Cascades to hub_records + hub_inventory
  // + hub_sync_log + hub_backup_integrity for that site. Refuses on
  // non-orphans (the only way a site loses orphan status is via
  // upsertSites putting it back, so refusing here protects against
  // accidental "Forget" on a site that was just temporarily out of
  // the env).
  router.delete('/api/hub/sites/:siteId/forget', requireAuth, requireAdmin, (req, res) => {
    const { siteId } = req.params;
    const row = db.prepare(`SELECT id, slug, name, in_env FROM hub_sites WHERE id = ?`).get(siteId);
    if (!row) return res.status(404).json({ error: `Site '${siteId}' not found` });
    if (row.in_env !== 0) {
      return res.status(409).json({
        error: `Site '${row.name || row.slug || siteId}' is still in HUB_SITES env. Forget is only allowed for orphan rows. Remove the site from HUB_SITES env first, then try again.`,
      });
    }

    let counts = {};
    try {
      const tx = db.transaction(() => {
        // Order matters only for audit clarity — there are no FK
        // constraints between these tables; the site_id columns are
        // indexed but not declared as FOREIGN KEYs.
        try { counts.records = db.prepare(`DELETE FROM hub_records WHERE site_id = ?`).run(siteId).changes; } catch { counts.records = 0; }
        try { counts.inventory = db.prepare(`DELETE FROM hub_inventory WHERE site_id = ?`).run(siteId).changes; } catch { counts.inventory = 0; }
        try { counts.sync_log = db.prepare(`DELETE FROM hub_sync_log WHERE site_id = ?`).run(siteId).changes; } catch { counts.sync_log = 0; }
        try { counts.backup_integrity = db.prepare(`DELETE FROM hub_backup_integrity WHERE site_id = ?`).run(siteId).changes; } catch { counts.backup_integrity = 0; }
        try { counts.bat_summary = db.prepare(`DELETE FROM hub_bat_summary WHERE site_id = ?`).run(siteId).changes; } catch { counts.bat_summary = 0; }
        counts.site = db.prepare(`DELETE FROM hub_sites WHERE id = ?`).run(siteId).changes;
      });
      tx();

      logHubAudit({
        action: 'forget_orphan_site',
        performedBy: req.currentUser?.email,
        target: row.slug || siteId,
        detail: JSON.stringify(counts),
      });
      logAudit({
        req, action: 'hub_forget_orphan_site', resourceType: 'system',
        resourceId: siteId, resourceName: row.name || row.slug || siteId,
        details: `Forgot orphan site — removed ${counts.site} hub_sites row, ${counts.records} hub_records, ${counts.inventory} hub_inventory, ${counts.sync_log} hub_sync_log, ${counts.backup_integrity} hub_backup_integrity, ${counts.bat_summary} hub_bat_summary`,
        changes: { counts },
      });

      res.json({ ok: true, counts });
    } catch (err) {
      try { logError('hub.forget_orphan_site', err, { site_id: siteId }); } catch {}
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

  // POST /api/hub/sites/:siteId/trigger-accpac-sync — admin-only.
  // Fans out a "refresh from Accpac now" request to a single site.
  // The hub forwards to the site's own /api/hub/trigger-accpac-sync
  // (registered on every install via createReceiveUsersRouter), which
  // calls runConnectionImport for every active non-BAT-only connection.
  //
  // Generous 5-minute timeout — a real Accpac pull on a slow site can
  // take a minute or two per connection, and this endpoint blocks
  // until every per-connection sync has settled. After it returns,
  // the hub-side syncSite scheduler will pick up the freshly-updated
  // datarecord on its next tick (every 5 min in hub mode), so the
  // dashboard shows the new last_accpac_synced_at within ~5 min.
  router.post('/api/hub/sites/:siteId/trigger-accpac-sync', requireAuth, requireAdmin, async (req, res) => {
    const { siteId } = req.params;
    const site = db.prepare(`SELECT id, slug, name, url, token FROM hub_sites WHERE id = ?`).get(siteId);
    if (!site) return res.status(404).json({ error: `Site '${siteId}' not found` });
    if (!site.url || !site.token) {
      return res.status(400).json({ error: `Site '${site.slug}' has no URL or token configured.` });
    }

    const url = `${site.url}/api/hub/trigger-accpac-sync`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Reporting-Token': site.token,
        },
        signal: AbortSignal.timeout(5 * 60 * 1000),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        const reason = body.error || `HTTP ${r.status}`;
        logAudit({
          req, action: 'hub_trigger_accpac_sync', resourceType: 'site',
          resourceId: site.id, resourceName: site.name || site.slug,
          details: `Trigger failed: ${reason}`, status: 'failure',
        });
        return res.status(r.status).json({ ok: false, error: reason, ...body });
      }
      logAudit({
        req, action: 'hub_trigger_accpac_sync', resourceType: 'site',
        resourceId: site.id, resourceName: site.name || site.slug,
        details: `${body.succeeded || 0}/${body.total || 0} connection(s) synced`,
        changes: { results: body.results },
      });

      // Site has finished its Accpac sync. The hub_sites row is still
      // stale at this point — `last_accpac_synced_at` won't update
      // until the next 5-min hub→site scheduler tick re-pulls the
      // site's KPIs. That made the manual button look ineffective:
      // operator clicks Sync, response says success, tile keeps the
      // old timestamp until the scheduler caught up minutes later.
      //
      // OPTIMISTIC UPDATE: if at least one connection on the site
      // synced successfully, we KNOW the site just set
      // databaseconnection.last_sync to NOW(). Stamp hub_sites here
      // directly instead of waiting for the chained syncSite to pull
      // the new value back. This is what fixes the long-standing
      // "sync from accpac works, but the time it synced does not"
      // operator complaint: previously the only way the hub tile got
      // the new timestamp was if the chained syncSite (below)
      // succeeded — and on a slow/flaky link the syncSite health
      // check times out at 10s even when the trigger forward (with
      // its 5-minute timeout) had succeeded. Result: the trigger
      // worked, the data flowed, but the tile stayed stale.
      //
      // We use the hub's own clock as the optimistic timestamp. It's
      // off from the site's actual UPDATE-time by network round-trip
      // + sync duration (typically 1-60s). The next scheduled
      // syncSite tick will overwrite this with the site's actual
      // databaseconnection.last_sync value via the kpis aggregation,
      // so any drift is bounded to one scheduler interval.
      //
      // status/error are derived from body.results to mirror the
      // site's own kpis aggregation contract: any connection in
      // 'error' makes site_accpac_status='error'. Initial version of
      // this fix unconditionally set status='ok' and cleared
      // last_accpac_error whenever okCount > 0, which on a partial
      // failure (e.g. 2 of 3 connections succeed, 1 fails) would
      // paint the tile green and hide the real error until the next
      // scheduled syncSite tick — exactly the timeout case where the
      // chained syncSite below tends NOT to land. Codex catch on
      // PR #238: derive the correct status here from the trigger
      // response itself, since body.results is already the complete
      // current state of every active + error connection.
      //
      // Gated on okCount > 0 — a trigger that returned 200 with zero
      // successful connections shouldn't advance the timestamp; that
      // would be a lie. (Status/error are derived even in the
      // okCount === 0 case below for the chained refresh logic.)
      const results = Array.isArray(body.results) ? body.results : [];
      const okCount = results.filter((r) => r?.ok).length;
      const failedResults = results.filter((r) => !r?.ok);
      if (okCount > 0) {
        // Build the error column from the failures, if any. Mirror
        // the site kpis aggregation: error message of the most-recent
        // failure, capped at 500 chars (same cap routes/reporting.js
        // applies). Prefix with the connection name so the tile shows
        // WHICH connection failed when there's mixed success.
        let optimisticStatus = 'ok';
        let optimisticError = null;
        if (failedResults.length > 0) {
          optimisticStatus = 'error';
          const first = failedResults[0];
          const namePrefix = first?.name ? `${first.name}: ` : '';
          const msg = String(first?.message || 'Sync failed');
          optimisticError = `${namePrefix}${msg}`.slice(0, 500);
        }
        try {
          db.prepare(`
            UPDATE hub_sites
            SET last_accpac_synced_at = ?,
                last_accpac_status    = ?,
                last_accpac_error     = ?
            WHERE id = ?
          `).run(new Date().toISOString(), optimisticStatus, optimisticError, site.id);
        } catch (updateErr) {
          // Don't fail the trigger response on a stamp-write error;
          // the actual sync already succeeded and the next scheduled
          // syncSite will eventually correct the displayed time. But
          // surface the failure so it's not silent if v62-style
          // schema drift bites again.
          try { logError('hub.trigger_accpac_sync.stamp', updateErr, { site_id: site.id }); } catch {}
        }
      }

      // Chain a syncSite call here so by the time we respond, the
      // hub has also pulled the freshly-updated records / inventory /
      // BAT summary. Wrapped in a try/catch — if the hub-pull fails
      // for some reason, the trigger itself still succeeded, the
      // optimistic timestamp above already landed, so we report
      // partial success rather than 502. The client's fetchAll then
      // sees the up-to-date row.
      //
      // Use the DB row directly — earlier this looked up the site in
      // HUB_SITES (the env-derived in-memory list), but the two can
      // drift: hub_sites is upserted from HUB_SITES on boot but stale
      // rows are never pruned, and a site-config change between boots
      // leaves the table with rows the env no longer knows about. The
      // trigger above already happily forwards to site.url, so the
      // refresh should trust the same row instead of silently skipping
      // when HUB_SITES.find() misses (which would leave the dashboard
      // freshness fields stale indefinitely).
      // Important: syncSite() does NOT throw on pull failures — it
      // catches internally, sets the hub_sites row to status='error',
      // and returns { error } in its result object. The earlier
      // try/catch-only check missed every soft failure, so the client
      // would receive hub_refresh_ok=true even when the chained pull
      // had silently failed and the dashboard would keep showing stale
      // last_accpac_* values until the next scheduler tick. Check both
      // the return value AND the catch (defence in depth — if a
      // future refactor makes syncSite throw, this still works).
      let hubPullOk = true;
      let hubPullError = null;
      try {
        const refreshResult = await syncSite(site);
        if (refreshResult?.error) {
          hubPullOk = false;
          hubPullError = String(refreshResult.error);
        }
      } catch (pullErr) {
        hubPullOk = false;
        hubPullError = pullErr?.message || String(pullErr);
        try { logError('hub.trigger_accpac_sync.refresh', pullErr, { site_id: site.id }); } catch {}
      }

      res.json({
        ...body,
        hub_refresh_ok: hubPullOk,
        hub_refresh_error: hubPullError,
      });
    } catch (err) {
      const friendly = describeFetchError(err, url);
      logError('hub.trigger_accpac_sync', err, { site_id: site.id, site_url: site.url, friendly });
      logAudit({
        req, action: 'hub_trigger_accpac_sync', resourceType: 'site',
        resourceId: site.id, resourceName: site.name || site.slug,
        details: friendly, status: 'failure',
      });
      res.status(502).json({ ok: false, error: friendly });
    }
  });

  // POST /api/hub/notify-backup-ready — site-token-authenticated.
  // Called by sites right after their Backup-Now button completes a
  // local snapshot, asking the hub to immediately pull the new file
  // instead of waiting for the next 03:00 cron tick. Without this,
  // the operator who clicks "Backup now" on a site sees the snapshot
  // appear locally but the hub mirror is up to ~24 hours stale until
  // the next scheduled pull.
  //
  // Auth: matches the inbound x-reporting-token against HUB_SITES[].token
  // (same auth model the hub itself uses outbound when pulling from
  // sites — every site→hub trust relationship is already encoded in
  // the HUB_SITES env). Token match identifies which site this came
  // from; we then run pullBackupForSite for that site only. Tokenless
  // or unknown-token requests return 401.
  //
  // Per-site: only pulls the calling site, not all sites. Avoids a
  // thundering-herd if multiple sites click Backup-Now simultaneously
  // (the bulk runHubBackupPull is still scheduled at 03:00 and is the
  // right place for "pull everyone").
  router.post('/api/hub/notify-backup-ready', async (req, res) => {
    const token = req.headers['x-reporting-token'];
    if (!token) return res.status(401).json({ error: 'Missing x-reporting-token header' });

    // Match against the in-env HUB_SITES list rather than hub_sites
    // table — the env list is the source of truth for "which sites
    // do we trust"; a tombstoned/orphaned hub_sites row should NOT
    // be able to authenticate a notify call.
    const matched = HUB_SITES.find((s) => s.token && s.token === token);
    if (!matched) {
      return res.status(401).json({ error: 'Unrecognised reporting token' });
    }

    try {
      // Look up the full site row from hub_sites — pullBackupForSite
      // wants id/url/token/name. Should always exist (HUB_SITES is
      // upserted into hub_sites at boot) but we tolerate an absent
      // row by reusing the env-supplied fields directly.
      const dbRow = db.prepare(`
        SELECT id, slug, name, url, token FROM hub_sites WHERE id = ?
      `).get(matched.id);
      const site = dbRow || {
        id: matched.id, slug: matched.slug, name: matched.name,
        url: matched.url, token: matched.token,
      };
      const result = await pullBackupForSite(site);
      res.json({
        ok: !!result?.ok,
        site_id: site.id,
        site_slug: site.slug,
        ...(result?.error ? { error: result.error } : {}),
        ...(result?.file ? { file: result.file } : {}),
        ...(result?.integrity ? { integrity: result.integrity } : {}),
      });
    } catch (err) {
      logError('hub.notify_backup_ready', err, { site_id: matched.id });
      res.status(500).json({ ok: false, error: err.message || 'pull failed' });
    }
  });

  // ========================================================================
  // RESTORE — hub-driven push of a previously-pulled snapshot back to a site
  // ========================================================================
  //
  // Three endpoints work together. Auth model mirrors the existing
  // backup-pull flow but reversed:
  //
  //   1. GET /api/hub/sites/:siteId/snapshots                  (admin)
  //      Lists snapshots the hub has on disk for one site. The
  //      operator picks one in the UI.
  //
  //   2. POST /api/hub/sites/:siteId/restore                   (admin + password)
  //      Operator-initiated. Body: { snapshot_filename, password,
  //      include_previews }. Hub:
  //        - validates password against the operator's user record
  //        - mints a one-shot restore token (random 32 bytes,
  //          5-min TTL) bound to siteId + snapshot_filename
  //        - POSTs to <site>/api/hub/restore with { snapshot_filename,
  //          hub_url, restore_token, include_previews }
  //        - returns the site's response to the operator
  //
  //   3. GET /api/hub/restore-fetch/:siteId/:filename          (one-shot token)
  //      Site downloads the snapshot file from this. Auth via
  //      x-restore-token header matched against the in-memory map
  //      minted in step 2. Token is consumed (deleted) on first use
  //      so a leaked token can't be replayed.
  //
  // Why a one-shot token instead of letting the site re-use its
  // x-reporting-token: keeping the snapshot-fetch URL operator-
  // gated means the site can't pull arbitrary snapshots whenever it
  // wants — only during an explicit restore window the operator
  // initiated. Also forces single-use semantics so the same token
  // can't accidentally fire two restores.
  const restoreTokens = new Map(); // token -> { siteId, fileBaseName, expiresAt }
  const RESTORE_TOKEN_TTL_MS = 5 * 60 * 1000;

  function mintRestoreToken(siteId, fileBaseName) {
    const token = crypto.randomBytes(32).toString('hex');
    restoreTokens.set(token, {
      siteId,
      fileBaseName,
      expiresAt: Date.now() + RESTORE_TOKEN_TTL_MS,
    });
    return token;
  }

  // Sweep expired tokens lazily on every check — keeps the map from
  // growing unbounded if a site never picks up its restore.
  function consumeRestoreToken(token, siteId, fileBaseName) {
    const entry = restoreTokens.get(token);
    if (!entry) return false;
    restoreTokens.delete(token); // one-shot: always consumed
    if (entry.expiresAt < Date.now()) return false;
    if (entry.siteId !== siteId) return false;
    if (entry.fileBaseName !== fileBaseName) return false;
    return true;
  }

  // Sweep stale tokens every minute. Bounded; map stays small.
  setInterval(() => {
    const now = Date.now();
    for (const [tok, entry] of restoreTokens.entries()) {
      if (entry.expiresAt < now) restoreTokens.delete(tok);
    }
  }, 60_000).unref();

  // Reject filenames that try to escape the per-site backup dir.
  // hub-backups/<siteId>/<file> is the only legal shape; '..' or
  // path separators in the filename are rejected.
  function isSafeBackupFilename(name) {
    if (typeof name !== 'string' || !name) return false;
    if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
    if (!/^[\w.\-+ ]+$/.test(name)) return false; // conservative whitelist
    return true;
  }

  // GET /api/hub/sites/:siteId/snapshots
  // Lists every .db snapshot the hub has on disk for this site,
  // with size + mtime + integrity (joined from hub_backup_integrity).
  // The matching bat-previews-*.zip for each snapshot timestamp is
  // included so the operator can see at a glance whether previews
  // are available for each snapshot.
  router.get('/api/hub/sites/:siteId/snapshots', requireAuth, requireAdmin, (req, res) => {
    const { siteId } = req.params;
    const site = db.prepare(`SELECT id, slug, name FROM hub_sites WHERE id = ?`).get(siteId);
    if (!site) return res.status(404).json({ error: `Site '${siteId}' not found` });

    const dir = path.join(process.cwd(), 'database', 'hub-backups', siteId);
    if (!existsSync(dir)) {
      return res.json({ site_id: site.id, site_name: site.name, snapshots: [] });
    }

    let allFiles = [];
    try {
      allFiles = readdirSync(dir);
    } catch (err) {
      return res.status(500).json({ error: `Cannot read backups dir: ${err.message}` });
    }

    // Pull every db file's metadata + previews-zip companion (if any).
    // Match on the timestamp suffix `-YYYY-MM-DD-HH-MM-SS` since the
    // .db and .zip share that part — see hubEtl.pullBackupForSite.
    const dbFiles = allFiles.filter((f) => f.endsWith('.db'));
    const previewZips = allFiles.filter((f) => f.startsWith('bat-previews-') && f.endsWith('.zip'));

    // Pre-load integrity statuses in one query keyed by filename, so
    // the snapshots list shows whether the hub already verified each.
    let integrityMap = new Map();
    try {
      const rows = db.prepare(`
        SELECT filename, result, MAX(created_at) AS last_check
        FROM hub_backup_integrity WHERE site_id = ? GROUP BY filename
      `).all(siteId);
      integrityMap = new Map(rows.map(r => [r.filename, r]));
    } catch {}

    const snapshots = dbFiles.map((dbFile) => {
      const fullDb = path.join(dir, dbFile);
      let dbStat = null;
      try { dbStat = statSync(fullDb); } catch {}
      // Match the timestamp suffix to find the companion previews zip.
      // .db filename: cardoso-<siteId>-YYYY-MM-DD-HH-MM-SS.db
      // zip filename: bat-previews-<siteId>-YYYY-MM-DD-HH-MM-SS.zip
      const tsMatch = dbFile.match(/-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})\.db$/);
      const ts = tsMatch ? tsMatch[1] : null;
      const previewsFile = ts ? previewZips.find((z) => z.includes(ts)) : null;
      let previewsStat = null;
      if (previewsFile) {
        try { previewsStat = statSync(path.join(dir, previewsFile)); } catch {}
      }
      const integrity = integrityMap.get(dbFile);
      return {
        filename: dbFile,
        size_bytes: dbStat?.size ?? null,
        mtime: dbStat ? new Date(dbStat.mtimeMs).toISOString() : null,
        integrity: integrity?.result || null,
        integrity_checked_at: integrity?.last_check || null,
        previews_filename: previewsFile || null,
        previews_size_bytes: previewsStat?.size ?? null,
      };
    }).sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));

    res.json({
      site_id: site.id,
      site_slug: site.slug,
      site_name: site.name,
      snapshots,
    });
  });

  // POST /api/hub/sites/:siteId/restore
  // Operator-initiated restore. Pushes a snapshot back to the named site.
  router.post('/api/hub/sites/:siteId/restore', requireAuth, requireAdmin, async (req, res) => {
    const { siteId } = req.params;
    const { snapshot_filename, password, include_previews } = req.body || {};

    if (!password) {
      return res.status(400).json({ error: 'Password is required to initiate a restore.' });
    }
    if (!isSafeBackupFilename(snapshot_filename)) {
      return res.status(400).json({ error: 'Invalid snapshot_filename.' });
    }

    const site = db.prepare(`SELECT id, slug, name, url, token FROM hub_sites WHERE id = ?`).get(siteId);
    if (!site) return res.status(404).json({ error: `Site '${siteId}' not found` });
    if (!site.url || !site.token) {
      return res.status(400).json({ error: `Site '${site.slug}' has no URL or token configured — cannot push a restore.` });
    }

    // Password check against the operator's user record.
    const user = db.prepare('SELECT * FROM "user" WHERE id = ?').get(req.currentUser.id);
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Unable to verify your password.' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password.' });

    // Validate the snapshot exists on hub disk.
    const snapDir = path.join(process.cwd(), 'database', 'hub-backups', siteId);
    const snapPath = path.join(snapDir, snapshot_filename);
    if (!existsSync(snapPath)) {
      return res.status(404).json({ error: `Snapshot '${snapshot_filename}' not found on hub.` });
    }

    // Find the matching previews zip (if include_previews is set).
    let previewsFilename = null;
    if (include_previews) {
      const tsMatch = snapshot_filename.match(/-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})\.db$/);
      if (tsMatch) {
        const ts = tsMatch[1];
        const candidate = readdirSync(snapDir).find((f) => f.startsWith('bat-previews-') && f.includes(ts) && f.endsWith('.zip'));
        if (candidate && existsSync(path.join(snapDir, candidate))) {
          previewsFilename = candidate;
        }
      }
    }

    // Mint one-shot tokens — one per file the site needs to pull.
    const dbToken = mintRestoreToken(siteId, snapshot_filename);
    const previewsToken = previewsFilename ? mintRestoreToken(siteId, previewsFilename) : null;
    const restoreId = crypto.randomBytes(8).toString('hex');

    // Determine the hub's URL the site will fetch from. Same env
    // the trigger-accpac flow uses: HUB_URL must match what the
    // site's REPORTING_TOKEN authenticates to. If unset, fall back
    // to req protocol+host (works when the operator browses to the
    // hub directly, but not behind a reverse proxy that strips
    // host info).
    const hubUrl = process.env.HUB_URL || `${req.protocol}://${req.get('host')}`;

    try {
      const restoreUrl = `${site.url}/api/hub/restore`;
      const r = await fetch(restoreUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Reporting-Token': site.token,
        },
        signal: AbortSignal.timeout(10 * 60 * 1000), // 10 min — restore can be slow on big sites
        body: JSON.stringify({
          restore_id: restoreId,
          hub_url: hubUrl.replace(/\/$/, ''),
          snapshot: {
            filename: snapshot_filename,
            token: dbToken,
          },
          previews: previewsToken
            ? { filename: previewsFilename, token: previewsToken }
            : null,
        }),
      });
      const body = await r.json().catch(() => ({}));

      logAudit({
        req,
        action: 'hub_push_restore',
        resourceType: 'site',
        resourceId: site.id,
        resourceName: site.name || site.slug,
        details:
          `Pushed snapshot ${snapshot_filename}` +
          (previewsFilename ? ` + previews ${previewsFilename}` : ' (no previews)') +
          ` to ${site.url}. Site response: ${r.status} ${body.message || body.error || ''}`,
        changes: {
          restore_id: restoreId,
          snapshot_filename,
          previews_filename: previewsFilename,
          site_response_status: r.status,
        },
        status: r.ok ? 'success' : 'failure',
      });

      if (!r.ok) {
        return res.status(r.status).json({ ok: false, error: body.error || `HTTP ${r.status}`, ...body });
      }
      res.json({ ok: true, restore_id: restoreId, ...body });
    } catch (err) {
      const friendly = describeFetchError(err, `${site.url}/api/hub/restore`);
      logError('hub.push_restore', err, { site_id: site.id, site_url: site.url, friendly });
      logAudit({
        req,
        action: 'hub_push_restore',
        resourceType: 'site',
        resourceId: site.id,
        resourceName: site.name || site.slug,
        details: `Failed to forward restore: ${friendly}`,
        status: 'failure',
      });
      res.status(502).json({ ok: false, error: friendly });
    }
  });

  // GET /api/hub/restore-fetch/:siteId/:filename
  // Site downloads a snapshot file from this. Auth via x-restore-token
  // header validated against the in-memory token map. One-shot.
  router.get('/api/hub/restore-fetch/:siteId/:filename', (req, res) => {
    const { siteId, filename } = req.params;
    const token = req.headers['x-restore-token'];

    if (!token) return res.status(401).json({ error: 'Missing x-restore-token header' });
    if (!isSafeBackupFilename(filename)) return res.status(400).json({ error: 'Invalid filename' });
    if (!consumeRestoreToken(token, siteId, filename)) {
      return res.status(401).json({ error: 'Invalid, expired, or already-consumed restore token' });
    }

    const filePath = path.join(process.cwd(), 'database', 'hub-backups', siteId, filename);
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Snapshot file not found on hub' });

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    const stream = createReadStream(filePath);
    stream.on('error', (err) => {
      console.error('[hub.restore-fetch] stream error:', err.message);
      try { res.destroy(err); } catch {}
    });
    stream.pipe(res);
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

  // POST /api/hub/trigger-accpac-sync — site-side. Hub posts here to
  // ask the site to refresh from Accpac/Sage. The site loops over its
  // active non-BAT-only connections and calls runConnectionImport for
  // each. Per-connection acquireSyncLock means firing this while a
  // scheduled sync is already running is a no-op for that connection,
  // not a double-pull.
  //
  // Auth: same X-Reporting-Token the hub uses for receive-users etc.
  // Response: { ok, results: [{ connection_id, name, ok, message }] }
  // Returns once every per-connection sync has settled (success or
  // error). Hub-side this is wrapped with a generous timeout because
  // a real Accpac pull can take 10s-2min depending on table size.
  router.post('/api/hub/trigger-accpac-sync', async (req, res) => {
    const token = req.headers['x-reporting-token'];
    const expectedToken = process.env.REPORTING_TOKEN;
    if (!expectedToken || token !== expectedToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let conns;
    try {
      conns = db.prepare(`
        SELECT id, name FROM databaseconnection
        WHERE status IN ('active', 'error') AND COALESCE(is_bat_only, 0) = 0
        ORDER BY id
      `).all();
    } catch (err) {
      return res.status(500).json({ error: `Failed to read connections: ${err.message}` });
    }

    if (conns.length === 0) {
      return res.status(400).json({
        error: 'No active non-BAT-only connections configured on this site.',
        ok: false, results: [],
      });
    }

    const results = [];
    for (const c of conns) {
      try {
        const r = await runConnectionImport(c.id);
        results.push({
          connection_id: c.id,
          name: c.name,
          ok: r?.success !== false,
          message: r?.message || `Imported ${r?.imported ?? 0} record(s)`,
          imported: r?.imported ?? null,
        });
      } catch (err) {
        // runConnectionImport throws on hard failures. The error has
        // already been persisted to databaseconnection.last_error and
        // syncrun (with a describeSqlError-shaped message via #192's
        // audit). Surface it back to the hub so the operator sees the
        // same string the System Log will show.
        results.push({
          connection_id: c.id,
          name: c.name,
          ok: false,
          message: err.message || 'Sync failed',
        });
      }
    }

    const okCount = results.filter(r => r.ok).length;
    res.json({
      ok: okCount > 0,
      total: results.length,
      succeeded: okCount,
      failed: results.length - okCount,
      results,
    });
  });

  // POST /api/hub/restore — site-side. Hub posts here to push a
  // restore. The site:
  //   1. Validates inbound x-reporting-token
  //   2. Downloads the snapshot DB (and optional previews zip) from
  //      the hub using the one-shot tokens the hub provided
  //   3. Schedules apply-restore.ps1 via Task Scheduler so the swap
  //      survives the service stop (same pattern as the auto-update
  //      flow — see launchViaTaskScheduler in routes/system.js for
  //      the full reasoning on why detached child-process spawning
  //      isn't enough on Windows under NSSM)
  //   4. Returns immediately — the operator on the hub watches the
  //      site's tile go offline briefly then come back at the
  //      restored state. Detailed result lands in the site's
  //      .last-restore-status.json which the in-app status endpoint
  //      surfaces.
  router.post('/api/hub/restore', async (req, res) => {
    const token = req.headers['x-reporting-token'];
    const expectedToken = process.env.REPORTING_TOKEN;
    if (!expectedToken || token !== expectedToken) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { restore_id, hub_url, snapshot, previews } = req.body || {};
    if (!restore_id || !hub_url || !snapshot?.filename || !snapshot?.token) {
      return res.status(400).json({ error: 'Missing restore_id, hub_url, or snapshot {filename, token}' });
    }

    const fsModule = await import('fs');
    const pathModule = await import('path');
    const streamModule = await import('stream');
    const { pipeline } = streamModule.promises || (await import('stream/promises'));

    const appDir = process.env.APP_DIR || 'C:\\Cardoso Customer App';
    const stagingDir = pathModule.join(appDir, '.restore-staging', restore_id);
    fsModule.mkdirSync(stagingDir, { recursive: true });

    const downloadFile = async (urlPath, oneShotToken, destPath) => {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 10 * 60 * 1000); // 10 min — multi-GB DB possible
      try {
        const r = await fetch(`${hub_url}${urlPath}`, {
          headers: { 'x-restore-token': oneShotToken },
          signal: ctrl.signal,
        });
        clearTimeout(timeout);
        if (!r.ok) {
          const body = await r.text().catch(() => '');
          throw new Error(`HTTP ${r.status} from hub on ${urlPath}: ${body.slice(0, 300)}`);
        }
        const ws = fsModule.createWriteStream(destPath);
        const { Readable } = streamModule;
        await pipeline(Readable.fromWeb(r.body), ws);
      } finally {
        clearTimeout(timeout);
      }
    };

    let dbStaging = null;
    let previewsStaging = null;
    try {
      // Download DB snapshot
      dbStaging = pathModule.join(stagingDir, snapshot.filename);
      const siteId = process.env.SITE_ID || 'site';
      await downloadFile(
        `/api/hub/restore-fetch/${encodeURIComponent(siteId)}/${encodeURIComponent(snapshot.filename)}`,
        snapshot.token,
        dbStaging,
      );

      // Optional previews zip
      if (previews?.filename && previews?.token) {
        previewsStaging = pathModule.join(stagingDir, previews.filename);
        await downloadFile(
          `/api/hub/restore-fetch/${encodeURIComponent(siteId)}/${encodeURIComponent(previews.filename)}`,
          previews.token,
          previewsStaging,
        );
      }
    } catch (err) {
      // Clean up staging on download failure — don't leave orphaned
      // partial files on disk.
      try { fsModule.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
      return res.status(502).json({
        ok: false,
        error: `Failed to download restore artifacts from hub: ${err.message}`,
      });
    }

    // Hand off to apply-restore.ps1 via Task Scheduler. The script
    // stops the service, swaps files, runs integrity check, restarts
    // the service, and writes a status marker for the next boot to
    // pick up. We DON'T await it — the script runs detached and we'd
    // be killed mid-flight when the service stops.
    if (process.platform !== 'win32') {
      try { fsModule.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
      return res.status(400).json({
        ok: false,
        error: 'Restore is only supported on Windows site installs (apply-restore.ps1 is PowerShell).',
      });
    }

    const applyScript = pathModule.join(appDir, 'scripts', 'apply-restore.ps1');
    if (!fsModule.existsSync(applyScript)) {
      try { fsModule.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
      return res.status(500).json({
        ok: false,
        error: `Restore script missing at ${applyScript} — site needs to upgrade to a release that ships the restore mechanism.`,
      });
    }

    // Build the PowerShell argument string. Quote each value for
    // PowerShell so paths with spaces survive re-parsing (same
    // pattern apply-app-update.ps1 invocation uses).
    const psArgsList = [
      ['-StagingDir', stagingDir],
      ['-SnapshotDbPath', dbStaging],
      ['-AppDir', appDir],
      ['-RestoreId', restore_id],
    ];
    if (previewsStaging) {
      psArgsList.push(['-SnapshotPreviewsZipPath', previewsStaging]);
    }
    const psArgs = psArgsList
      .map(([k, v]) => `${k} '${String(v).replace(/'/g, "''")}'`)
      .join(' ');
    const wrapper = `& '${applyScript.replace(/'/g, "''")}' ${psArgs}`;

    // Schedule it. Reuses launchViaTaskScheduler from routes/system.js
    // — same one the auto-updater uses. Lazy-import to avoid a circular
    // routes↔routes dependency at module load.
    try {
      const { launchViaTaskScheduler } = await import('./system.js');
      const taskName = `CardosoRestore-${restore_id}`;
      await launchViaTaskScheduler(taskName, wrapper);
    } catch (err) {
      try { fsModule.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
      try { logError('site.restore.task_scheduler', err, { restore_id }); } catch {}
      return res.status(500).json({
        ok: false,
        error: `Failed to schedule apply-restore task: ${err.message}`,
      });
    }

    res.json({
      ok: true,
      restore_id,
      message: 'Restore scheduled. Site service will stop, swap files, and restart. Watch the site tile go offline briefly then come back.',
      staging_dir: stagingDir,
      snapshot_filename: snapshot.filename,
      previews_filename: previews?.filename || null,
    });
  });

  return router;
}
