/**
 * Hub-mode routes — extracted from server.js (US-010).
 *
 * Factory pattern: createHubRouter(deps) returns an Express router.
 * Also exports createNonHubFallbackRouter() for empty-response stubs.
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { readdirSync, statSync, fstatSync, createReadStream, existsSync } from 'fs';
import path from 'path';
import { resolveSiteBackupDir, siteBackupDirName } from '../hub/siteBackupDir.js';
import { boolFromRow, expandDataRecord } from '../helpers.js';
import { syncAllSites, syncSite, runHubBackupPull, pullBackupForSite, HUB_SITES } from '../services/hubEtl.js';
import { runConnectionImport } from '../services/syncEngine.js';
import { getHubStorageRuntime } from '../hub/storage/runtime.js';
import { logError } from '../lib/errorLog.js';
import { safeTokenEqual } from '../lib/safeEqual.js';
import { logAudit } from '../lib/audit.js';
import { describeFetchError } from '../lib/errorDescribe.js';
import { getSqlBackupHealth, getMachineHealthSummary } from '../services/hub/hubHealth.js';
import { pagination, clampInt } from '../lib/httpParams.js';
import { backupHeavyRateLimiter } from '../middleware/rateLimit.js';
import multer from 'multer';
import {
  receiveJtiArchive,
  listHubJtiArchives,
  getHubJtiArchive,
} from '../services/hub/jtiHubReceive.js';
import {
  listArchiveGroups,
  streamArchiveBundle,
} from '../services/hub/jtiHubBundle.js';
import { streamCommissionArchiveBundle } from '../services/hub/commissionHubBundle.js';
import {
  receiveCommissionArchive,
  listHubCommissionArchives,
  getHubCommissionArchive,
} from '../services/hub/commissionHubReceive.js';
import fs from 'fs';

const { sqliteDb: db, repository: hubRepository } = getHubStorageRuntime();

export function createHubRouter({ requireAuth, requireAdmin, requirePermission }) {
  const router = Router();

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
    } catch (e) { console.warn('[hub.setting_upsert]', { key }, e.message); }
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
      logAudit({
        req, action: 'hub_backup_pull', resourceType: 'system',
        resourceId: site.id, resourceName: site.name || site.slug || site.id,
        details: `Pulled backup from site "${site.name || site.slug || site.id}" (${buf.length} bytes)`,
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

        // Prefer the site's artifact-based health verdict when present (sites
        // running the trustworthy-health build return `health`). It catches a
        // fresh-but-0-byte backup and a fresh-but-verify_failed backup, which
        // age-of-newest-file alone reports as 'ok'. Map onto the hub UI's
        // existing status vocabulary; fall back to age for older sites that
        // don't yet return `health`. (`data.health` flows through via ...data.)
        let status = 'ok';
        if (data.health && data.health.status) {
          if (data.health.reason === 'no_backups') status = 'never';
          else if (data.health.status === 'critical') status = 'stale';
          else if (data.health.status === 'warn') status = 'warning';
          else status = 'ok';
        } else if (!data.last_backup) {
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
      try { sites = db.prepare('SELECT id, slug, name FROM hub_sites').all(); } catch { /* table not ready */ }
      const results = sites.map((site) => {
        const dir = resolveSiteBackupDir(baseDir, site);
        try {
          const files = readdirSync(dir).filter((file) => file.endsWith('.db') || file.endsWith('.db.corrupt'));
          if (files.length === 0) return { site_id: site.id, site_name: site.name || null, hub_backup_count: 0, hub_last_backup: null, hub_last_size: null, integrity: 'unchecked' };
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
            site_name: site.name || null,
            hub_backup_count: files.length,
            hub_last_backup: new Date(sorted[0].mtime).toISOString(),
            hub_last_size: sorted[0].size,
            hub_last_filename: sorted[0].file,
            integrity,
          };
        } catch {
          return { site_id: site.id, site_name: site.name || null, hub_backup_count: 0, hub_last_backup: null, hub_last_size: null, integrity: 'unchecked' };
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
    const authedByToken = expectedToken && safeTokenEqual(tokenHeader, expectedToken);
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

    // Narrow column list — UI listing only needs these fields.
    // Token-authed callers (hub-pull-backups.ps1) bypass user-scoping;
    // session callers get filtered to their allowed sites.
    const filter = authedByToken ? { sql: '', params: [] } : siteFilterSql(req, res, 'id');
    const rawSites = db.prepare(
      `SELECT id, slug, name, url, last_seen, status, last_kpis,
              in_env, removed_from_env_at
       FROM hub_sites
       WHERE 1=1${filter.sql}`
    ).all(...filter.params);
    const mapped = rawSites.map((s) => ({
      site_id: s.id,
      id: s.id,
      slug: s.slug,
      name: s.name,
      // Canonical hub-backups folder name, so the legacy hub-pull-backups.ps1
      // task writes to the SAME readable <name>-<id> folder the Node pull uses
      // (otherwise it would keep writing the bare <id> folder and those
      // snapshots would be invisible to the read paths once canonical exists).
      backup_dir: siteBackupDirName(s),
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

    let sites;
    try {
      const filter = siteFilterSql(req, res, 'id');
      sites = db.prepare(
        `SELECT id, slug, name, url, last_seen, status, last_kpis
         FROM hub_sites
         WHERE 1=1${filter.sql}`
      ).all(...filter.params);
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
  router.get('/api/hub/records', requireAuth, requireAllowedSite('site_id'), (req, res) => {
    const { site_id, flag_color, search } = req.query;
    const { limit, offset } = pagination(req, { defaultLimit: 100, maxLimit: 500 });
    let whereClause = 'WHERE 1=1';
    const params = [];
    if (site_id) { whereClause += ' AND site_id=?'; params.push(site_id); }
    if (flag_color) { whereClause += ' AND flag_color=?'; params.push(flag_color); }
    if (search) { whereClause += ' AND (customer_name LIKE ? OR customer_number LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    // Apply user allow-list. Stacks with the explicit ?site_id filter
    // when both are present; the middleware above already 403'd if the
    // requested site is outside the allow-list.
    const allowFilter = siteFilterSql(req, res, 'site_id');
    whereClause += allowFilter.sql;
    params.push(...allowFilter.params);

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
    const sitesFilter = siteFilterSql(req, res, 'id');
    try {
      const cols = new Set(
        db.prepare(`SELECT name FROM pragma_table_info('hub_sites')`).all().map(r => r.name)
      );
      const hasAccpac = cols.has('last_accpac_synced_at') && cols.has('last_accpac_status') && cols.has('last_accpac_error');
      const accpacSelect = hasAccpac ? ', last_accpac_synced_at, last_accpac_status, last_accpac_error' : '';
      allSites = db.prepare(`
        SELECT id, slug, name, status, last_seen, in_env, removed_from_env_at${accpacSelect}
        FROM hub_sites
        WHERE 1=1${sitesFilter.sql}
      `).all(...sitesFilter.params);
    } catch (e) { console.warn('[hub.dashboard.sites_query]', e.message); }
    const sites = allSites;

    // ── KPI rollup (one query, in-JS pivot) ─────────────────────────────
    // Previously did 1 + 3 + (sites × 2) = up to 19 queries on an 8-site
    // hub for what is essentially a two-axis aggregation. Collapse to a
    // single GROUP BY (site_id, flag_color) and pivot in JS — the
    // dashboard fires this on every poll + every dateRange flip, so
    // shaving the per-call cost matters.
    //
    // Filter applied in SQL too — without it the headline totals
    // (total_records, records_by_flag) would still aggregate every
    // site's records before the per-site filter trimmed the visible
    // set, leaking the all-sites total into a restricted user's
    // dashboard headline.
    const recordsFilter = siteFilterSql(req, res, 'site_id');
    const flagBreakdownRows = since
      ? db.prepare(`SELECT site_id, flag_color, COUNT(*) as count FROM hub_records WHERE updated_date >= ?${recordsFilter.sql} GROUP BY site_id, flag_color`).all(since, ...recordsFilter.params)
      : db.prepare(`SELECT site_id, flag_color, COUNT(*) as count FROM hub_records WHERE 1=1${recordsFilter.sql} GROUP BY site_id, flag_color`).all(...recordsFilter.params);

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

    // Optional explicit single-site filter (the operator-facing
    // dropdown on /trends). Stacks with the allow-list sql below.
    const siteIdFilter = req.query.site_id ? String(req.query.site_id) : null;

    try {
      const filter = siteFilterSql(req, res, 'hr.site_id');
      const extraWhere = siteIdFilter ? ' AND hr.site_id = ?' : '';
      const extraParams = siteIdFilter ? [siteIdFilter] : [];
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
          AND ${bucketExpr} IS NOT NULL${filter.sql}${extraWhere}
        GROUP BY ${bucketExpr}, hr.site_id, hs.name
        ORDER BY ${bucketExpr} ASC, hr.site_id ASC
      `).all(since, ...filter.params, ...extraParams);

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

  // GET /api/hub/trends/inventory — monthly inventory trends per site.
  // Two parallel signals over time, both sourced from hub_inventory_sales
  // (the per-period rollup the site sync builds):
  //   - total_qty_sold: units shipped per month per site
  //   - total_revenue:  revenue per month per site
  // Weekly bucketing isn't supported — hub_inventory_sales only carries
  // YYYY-MM granularity (the site ETL aggregates into months at write
  // time), so we always return monthly regardless of the query param.
  router.get('/api/hub/trends/inventory', requireAuth, requirePermission('can_access_hub_trends'), (req, res) => {
    // Return one row per (year, month) summed across sites on a shared
    // Jan-Dec axis so the operator can spot seasonal patterns and growth.
    // We deliberately enumerate every calendar year that has data — no
    // rolling 3-year window. Years don't fall off as time passes; the
    // per-year toggle chips in the UI let the operator narrow the
    // comparison to whatever subset they care about today.
    const siteIdFilter = req.query.site_id ? String(req.query.site_id) : null;

    try {
      const filter = siteFilterSql(req, res, 'his.site_id');
      const extraWhere = siteIdFilter ? ' AND his.site_id = ?' : '';
      const extraParams = siteIdFilter ? [siteIdFilter] : [];
      const rows = db.prepare(`
        SELECT
          CAST(substr(his.period, 1, 4) AS INTEGER) AS year,
          CAST(substr(his.period, 6, 2) AS INTEGER) AS month,
          SUM(his.qty_sold)                       AS total_qty_sold,
          SUM(his.revenue)                        AS total_revenue,
          SUM(his.order_count)                    AS total_orders,
          COUNT(DISTINCT his.item_number)         AS distinct_items
        FROM hub_inventory_sales his
        WHERE his.period IS NOT NULL${filter.sql}${extraWhere}
        GROUP BY substr(his.period, 1, 4), substr(his.period, 6, 2)
        ORDER BY year ASC, month ASC
      `).all(...filter.params, ...extraParams);

      // year_list = every year present in the data (ascending). Stays
      // accurate as new periods land — no manual maintenance required.
      const yearSet = new Set(rows.map((r) => r.year));
      const yearList = [...yearSet].sort((a, b) => a - b);

      res.json({
        period: 'monthly',
        year_list: yearList,
        data: rows.map((row) => ({
          year: row.year,
          month: row.month,
          total_qty_sold: Number(row.total_qty_sold) || 0,
          total_revenue: Number(row.total_revenue) || 0,
          total_orders: Number(row.total_orders) || 0,
          distinct_items: Number(row.distinct_items) || 0,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/hub/trends/inventory/seasonal — top-10 items per South African
  // season, aggregated across every year present in hub_inventory_sales.
  //
  // SA seasons (https://uni24.co.za/the-four-seasons-in-south-africa-summer-autumn-winter-and-spring/):
  //   Summer: Dec, Jan, Feb
  //   Autumn: Mar, Apr, May
  //   Winter: Jun, Jul, Aug
  //   Spring: Sep, Oct, Nov
  //
  // Pulls the substring '01'..'12' off `period` (stored YYYY-MM) and maps
  // it to a season label. Aggregate is global by default; ?site_id=... or
  // the operator's allowed-sites scope narrows it.
  router.get('/api/hub/trends/inventory/seasonal', requireAuth, requirePermission('can_access_hub_trends'), (req, res) => {
    const siteIdFilter = req.query.site_id ? String(req.query.site_id) : null;
    try {
      const filter = siteFilterSql(req, res, 'his.site_id');
      const extraWhere = siteIdFilter ? ' AND his.site_id = ?' : '';
      const extraParams = siteIdFilter ? [siteIdFilter] : [];
      const seasonalCase = `
        CASE substr(his.period, 6, 2)
          WHEN '12' THEN 'Summer' WHEN '01' THEN 'Summer' WHEN '02' THEN 'Summer'
          WHEN '03' THEN 'Autumn' WHEN '04' THEN 'Autumn' WHEN '05' THEN 'Autumn'
          WHEN '06' THEN 'Winter' WHEN '07' THEN 'Winter' WHEN '08' THEN 'Winter'
          WHEN '09' THEN 'Spring' WHEN '10' THEN 'Spring' WHEN '11' THEN 'Spring'
        END`;
      const rows = db.prepare(`
        WITH seasonal AS (
          SELECT
            ${seasonalCase} AS season,
            his.item_number AS item_number,
            SUM(his.qty_sold)    AS qty_sold,
            SUM(his.revenue)     AS revenue,
            SUM(his.order_count) AS orders,
            COUNT(DISTINCT his.period) AS months_seen
          FROM hub_inventory_sales his
          WHERE his.period IS NOT NULL${filter.sql}${extraWhere}
          GROUP BY season, his.item_number
        ),
        ranked AS (
          SELECT s.*,
                 ROW_NUMBER() OVER (PARTITION BY s.season ORDER BY s.qty_sold DESC) AS rn
          FROM seasonal s
          WHERE s.season IS NOT NULL
        )
        SELECT r.season, r.rn AS rank, r.item_number,
               r.qty_sold, r.revenue, r.orders, r.months_seen,
               ir.item_description, ir.commodity
        FROM ranked r
        LEFT JOIN (
          SELECT item_number,
                 item_description,
                 commodity,
                 ROW_NUMBER() OVER (PARTITION BY item_number ORDER BY synced_at DESC) AS rn
          FROM hub_inventory
        ) ir ON ir.item_number = r.item_number AND ir.rn = 1
        WHERE r.rn <= 10
        ORDER BY
          CASE r.season WHEN 'Summer' THEN 1 WHEN 'Autumn' THEN 2 WHEN 'Winter' THEN 3 WHEN 'Spring' THEN 4 END,
          r.rn
      `).all(...filter.params, ...extraParams);

      // Bucket by season for the UI: client gets a tidy
      // { Summer: [...10 rows], Autumn: [...10], Winter: [...10], Spring: [...10] }.
      const buckets = { Summer: [], Autumn: [], Winter: [], Spring: [] };
      for (const row of rows) {
        if (!buckets[row.season]) continue;
        buckets[row.season].push({
          rank: row.rank,
          item_number: row.item_number,
          item_description: row.item_description || null,
          commodity: row.commodity || null,
          qty_sold: Number(row.qty_sold) || 0,
          revenue: Number(row.revenue) || 0,
          orders: Number(row.orders) || 0,
          months_seen: Number(row.months_seen) || 0,
        });
      }

      res.json({
        seasons: ['Summer', 'Autumn', 'Winter', 'Spring'],
        months: {
          Summer: ['Dec', 'Jan', 'Feb'],
          Autumn: ['Mar', 'Apr', 'May'],
          Winter: ['Jun', 'Jul', 'Aug'],
          Spring: ['Sep', 'Oct', 'Nov'],
        },
        data: buckets,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/hub/trends/inventory/revenue-by-commodity — revenue + qty per
  // (period, commodity) for the "sales mix" view. Commodity is joined off
  // hub_inventory (current snapshot per site/item — latest synced_at row).
  router.get('/api/hub/trends/inventory/revenue-by-commodity', requireAuth, requirePermission('can_access_hub_trends'), (req, res) => {
    const siteIdFilter = req.query.site_id ? String(req.query.site_id) : null;
    try {
      const sFilter = siteFilterSql(req, res, 'his.site_id');
      const sExtraWhere = siteIdFilter ? ' AND his.site_id = ?' : '';
      const extraParams = siteIdFilter ? [siteIdFilter] : [];
      const rows = db.prepare(`
        SELECT his.period AS period,
               COALESCE(NULLIF(TRIM(ir.commodity), ''), '(uncategorised)') AS commodity,
               SUM(his.revenue)  AS revenue,
               SUM(his.qty_sold) AS qty
        FROM hub_inventory_sales his
        LEFT JOIN (
          SELECT site_id, item_number, commodity,
                 ROW_NUMBER() OVER (PARTITION BY site_id, item_number ORDER BY synced_at DESC) AS rn
          FROM hub_inventory
        ) ir ON ir.site_id = his.site_id AND ir.item_number = his.item_number AND ir.rn = 1
        WHERE his.period IS NOT NULL${sFilter.sql}${sExtraWhere}
        GROUP BY his.period, commodity
        ORDER BY his.period ASC, commodity ASC
      `).all(...sFilter.params, ...extraParams);

      const commodityList = [...new Set(rows.map(r => r.commodity))].sort();
      res.json({
        commodity_list: commodityList,
        data: rows.map(r => ({
          period: r.period,
          commodity: r.commodity,
          revenue: Number(r.revenue) || 0,
          qty: Number(r.qty) || 0,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/hub/trends/inventory/dead-stock — for each of the last 24
  // months, count items in hub_inventory whose most-recent sale period
  // (ever) is older than the month minus 3 (i.e. no movement in the
  // trailing quarter). dead_value = sum of inventory_value for those.
  //
  // Restricted to SKUs with CURRENT inventory_value > 0 so the count
  // and value lines move together — without this filter the value line
  // sits at zero for early months because SKUs that went dead long
  // ago have since been wound down to zero stock today.
  //
  // Note: we don't have historical inventory snapshots, so the SKU set
  // is fixed at "today's hub_inventory." The trend is the count of those
  // SKUs that would have been considered dead at each past month.
  router.get('/api/hub/trends/inventory/dead-stock', requireAuth, requirePermission('can_access_hub_trends'), (req, res) => {
    const siteIdFilter = req.query.site_id ? String(req.query.site_id) : null;
    try {
      const sFilter = siteFilterSql(req, res, 'his.site_id');
      const iFilter = siteFilterSql(req, res, 'hi.site_id');
      const sExtraWhere = siteIdFilter ? ' AND his.site_id = ?' : '';
      const iExtraWhere = siteIdFilter ? ' AND hi.site_id = ?' : '';
      const extraParams = siteIdFilter ? [siteIdFilter] : [];

      const itemRows = db.prepare(`
        WITH last_sale AS (
          SELECT his.site_id, his.item_number, MAX(his.period) AS last_period
          FROM hub_inventory_sales his
          WHERE his.period IS NOT NULL${sFilter.sql}${sExtraWhere}
          GROUP BY his.site_id, his.item_number
        )
        SELECT hi.site_id, hi.item_number,
               COALESCE(CAST(REPLACE(REPLACE(hi.inventory_value, ',', ''), ' ', '') AS REAL), 0) AS inv_value,
               ls.last_period
        FROM hub_inventory hi
        LEFT JOIN last_sale ls ON ls.site_id = hi.site_id AND ls.item_number = hi.item_number
        WHERE COALESCE(CAST(REPLACE(REPLACE(hi.inventory_value, ',', ''), ' ', '') AS REAL), 0) > 0${iFilter.sql}${iExtraWhere}
      `).all(...sFilter.params, ...extraParams, ...iFilter.params, ...extraParams);

      // Generate 24 trailing months (oldest first).
      const months = [];
      const now = new Date();
      for (let i = 23; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
      }

      const data = months.map(m => {
        const [yy, mm] = m.split('-').map(Number);
        const t = new Date(yy, mm - 1 - 3, 1);
        const threshold = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
        let count = 0;
        let value = 0;
        for (const r of itemRows) {
          if (!r.last_period || r.last_period < threshold) {
            count++;
            value += r.inv_value || 0;
          }
        }
        return { month: m, dead_count: count, dead_value: value };
      });

      res.json({
        total_skus: itemRows.length,
        threshold_months: 3,
        data,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/hub/trends/inventory/top-movers — top 10 SKUs by lifetime
  // revenue, with last-12-months vs prior-12-months qty + revenue and
  // % delta for each. Window endpoints computed in JS so the SQL stays
  // portable.
  router.get('/api/hub/trends/inventory/top-movers', requireAuth, requirePermission('can_access_hub_trends'), (req, res) => {
    const siteIdFilter = req.query.site_id ? String(req.query.site_id) : null;
    try {
      const sFilter = siteFilterSql(req, res, 'his.site_id');
      const iFilter = siteFilterSql(req, res, 'hi.site_id');
      const sExtraWhere = siteIdFilter ? ' AND his.site_id = ?' : '';
      const iExtraWhere = siteIdFilter ? ' AND hi.site_id = ?' : '';
      const extraParams = siteIdFilter ? [siteIdFilter] : [];

      const now = new Date();
      const twelve = new Date(now.getFullYear(), now.getMonth() - 12, 1);
      const twentyfour = new Date(now.getFullYear(), now.getMonth() - 24, 1);
      const twelveStr = `${twelve.getFullYear()}-${String(twelve.getMonth() + 1).padStart(2, '0')}`;
      const twentyfourStr = `${twentyfour.getFullYear()}-${String(twentyfour.getMonth() + 1).padStart(2, '0')}`;

      const rows = db.prepare(`
        WITH agg AS (
          SELECT his.item_number,
                 SUM(his.revenue)     AS total_revenue,
                 SUM(his.qty_sold)    AS total_qty,
                 SUM(his.order_count) AS total_orders,
                 SUM(CASE WHEN his.period >= ? THEN his.qty_sold ELSE 0 END) AS this_year_qty,
                 SUM(CASE WHEN his.period >= ? THEN his.revenue  ELSE 0 END) AS this_year_revenue,
                 SUM(CASE WHEN his.period >= ? AND his.period < ? THEN his.qty_sold ELSE 0 END) AS prior_year_qty,
                 SUM(CASE WHEN his.period >= ? AND his.period < ? THEN his.revenue  ELSE 0 END) AS prior_year_revenue
          FROM hub_inventory_sales his
          WHERE his.period IS NOT NULL${sFilter.sql}${sExtraWhere}
          GROUP BY his.item_number
        ),
        ranked AS (
          SELECT a.*, ROW_NUMBER() OVER (ORDER BY a.total_revenue DESC) AS rn
          FROM agg a
        )
        SELECT r.rn AS rank, r.item_number,
               r.total_revenue, r.total_qty, r.total_orders,
               r.this_year_qty, r.this_year_revenue,
               r.prior_year_qty, r.prior_year_revenue,
               ir.item_description, ir.commodity
        FROM ranked r
        LEFT JOIN (
          SELECT hi.item_number, hi.item_description, hi.commodity,
                 ROW_NUMBER() OVER (PARTITION BY hi.item_number ORDER BY hi.synced_at DESC) AS rn
          FROM hub_inventory hi
          WHERE 1=1${iFilter.sql}${iExtraWhere}
        ) ir ON ir.item_number = r.item_number AND ir.rn = 1
        WHERE r.rn <= 10
        ORDER BY r.rn ASC
      `).all(
        twelveStr, twelveStr, twentyfourStr, twelveStr, twentyfourStr, twelveStr,
        ...sFilter.params, ...extraParams,
        ...iFilter.params, ...extraParams,
      );

      res.json({
        this_year_from: twelveStr,
        prior_year_from: twentyfourStr,
        data: rows.map(r => {
          const tyQ = Number(r.this_year_qty) || 0;
          const pyQ = Number(r.prior_year_qty) || 0;
          const tyR = Number(r.this_year_revenue) || 0;
          const pyR = Number(r.prior_year_revenue) || 0;
          return {
            rank: r.rank,
            item_number: r.item_number,
            item_description: r.item_description || null,
            commodity: r.commodity || null,
            total_revenue: Number(r.total_revenue) || 0,
            total_qty: Number(r.total_qty) || 0,
            total_orders: Number(r.total_orders) || 0,
            this_year_qty: tyQ,
            this_year_revenue: tyR,
            prior_year_qty: pyQ,
            prior_year_revenue: pyR,
            qty_delta_pct: pyQ > 0 ? Math.round(((tyQ - pyQ) / pyQ) * 1000) / 10 : null,
            revenue_delta_pct: pyR > 0 ? Math.round(((tyR - pyR) / pyR) * 1000) / 10 : null,
          };
        }),
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
      const filter = siteFilterSql(req, res, 's.id');
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
        WHERE 1=1${filter.sql}
        ORDER BY s.name
      `).all(...filter.params);

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

  // GET /api/hub/inventory — paginated. Default 1000 / max 5000 to match the
  // shape of the Inventory page (operator typically loads a single site
  // at a time; full-table scans were shipping 80K+ rows on 8-site hubs
  // and JSON-parsing every one through expandDataRecord).
  router.get('/api/hub/inventory', requireAuth, requireAllowedSite('site_id'), (req, res) => {
    const { site_id, search, commodity } = req.query;
    const { limit, offset } = pagination(req, { defaultLimit: 1000, maxLimit: 5000 });
    let whereClause = 'WHERE 1=1';
    const params = [];
    if (site_id) { whereClause += ' AND hi.site_id=?'; params.push(site_id); }
    if (search) { whereClause += ' AND (hi.item_number LIKE ? OR hi.item_description LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
    if (commodity) { whereClause += ' AND CAST(commodity AS TEXT)=?'; params.push(commodity); }
    const allowFilter = siteFilterSql(req, res, 'hi.site_id');
    whereClause += allowFilter.sql;
    params.push(...allowFilter.params);
    try {
      const countRow = db.prepare(`SELECT COUNT(*) AS total FROM hub_inventory hi ${whereClause}`).get(...params);
      const rows = db.prepare(`
        SELECT hi.*, COALESCE(s.name, hi.site_id) AS site_name
        FROM hub_inventory hi
        LEFT JOIN hub_sites s ON s.id = hi.site_id
        ${whereClause}
        ORDER BY hi.item_number ASC
        LIMIT ? OFFSET ?
      `).all(...params, limit, offset);
      res.json({
        total: countRow?.total || 0,
        count: rows.length,
        limit,
        offset,
        records: rows.map(expandDataRecord),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/hub/customer-lookup — returns main record + sub-accounts from hub_records
  router.get('/api/hub/customer-lookup', requireAuth, requireAllowedSite('site_id'), (req, res) => {
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
    const limit = clampInt(req.query.limit, { default: 50, min: 1, max: 200 });
    const filter = siteFilterSql(req, res, 'l.site_id');
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
      WHERE 1=1${filter.sql}
      ORDER BY l.started_at DESC
      LIMIT ?
    `).all(...filter.params, limit);
    res.json(rows);
  });

  // POST /api/hub/force-resync — clears sync history and hub_records, triggers full re-pull
  router.post('/api/hub/force-resync', requireAuth, requireAdmin, (req, res) => {
    try {
      db.prepare('DELETE FROM hub_sync_log').run();
      db.prepare('DELETE FROM hub_records').run();
      db.prepare('DELETE FROM hub_inventory').run();
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
      try { logError('hub.orphan_sites', err); } catch (e) { console.error('[hub.recon_orphan_cleanup]', { op: 'orphan_sites_list' }, e.message); }
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
        // hub_bat_exceptions is keyed by site_id and the weekly report falls back
        // to x.site_id when the hub_sites row is gone, so leftover rows would
        // resurface as stale site-id data after the site is forgotten.
        try { counts.bat_exceptions = db.prepare(`DELETE FROM hub_bat_exceptions WHERE site_id = ?`).run(siteId).changes; } catch { counts.bat_exceptions = 0; }
        counts.site = db.prepare(`DELETE FROM hub_sites WHERE id = ?`).run(siteId).changes;
      });
      tx();

      logAudit({
        req, action: 'hub_forget_orphan_site', resourceType: 'system',
        resourceId: siteId, resourceName: row.name || row.slug || siteId,
        details: `Forgot orphan site — removed ${counts.site} hub_sites row, ${counts.records} hub_records, ${counts.inventory} hub_inventory, ${counts.sync_log} hub_sync_log, ${counts.backup_integrity} hub_backup_integrity, ${counts.bat_summary} hub_bat_summary, ${counts.bat_exceptions} hub_bat_exceptions`,
        changes: { counts },
      });

      res.json({ ok: true, counts });
    } catch (err) {
      try { logError('hub.forget_orphan_site', err, { site_id: siteId }); } catch (e) { console.error('[hub.recon_orphan_cleanup]', { siteId }, e.message); }
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
      // Keyed by site_id; the weekly report falls back to x.site_id when the
      // hub_sites row is gone, so leftover rows would resurface as stale data.
      try { db.prepare('DELETE FROM hub_bat_exceptions WHERE site_id = ?').run(siteId); } catch { /* table may pre-date the v105 migration */ }
      db.prepare('DELETE FROM hub_sites WHERE id = ?').run(siteId);

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
        const filter = siteFilterSql(req, res, 'p.site_slug', 'slug');
        rows = db.prepare(`
          SELECT p.site_slug, p.online, p.latency_ms, p.timestamp
          FROM hub_site_ping p
          INNER JOIN (
            SELECT site_slug, MAX(id) AS max_id FROM hub_site_ping GROUP BY site_slug
          ) latest ON p.id = latest.max_id
          WHERE 1=1${filter.sql}
        `).all(...filter.params);
      } catch (_) { /* table not yet created */ }
      res.json({ sites: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/hub/machine-health — aggregated machine health per site
  router.get('/api/hub/machine-health', requireAuth, requirePermission('can_access_hub_metrics'), async (req, res) => {
    const filter = siteFilterSql(req, res, 'id');
    const sites = db.prepare(
      `SELECT id, slug, name, url, token FROM hub_sites WHERE 1=1${filter.sql}`
    ).all(...filter.params);

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
               can_access_customer_search, can_access_customer_balances, can_access_collections, can_access_inventory, can_access_inventory_movement, can_access_network_devices,
               can_access_hub_metrics, can_access_hub_backups, can_access_hub_trends,
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
        can_access_inventory_movement: boolFromRow(u.can_access_inventory_movement, false),
        can_access_network_devices: boolFromRow(u.can_access_network_devices, false),
        can_access_hub_metrics: boolFromRow(u.can_access_hub_metrics, false),
        can_access_hub_backups: boolFromRow(u.can_access_hub_backups, false),
        can_access_hub_trends: boolFromRow(u.can_access_hub_trends, false),
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
      const insertStmt = db.prepare(`INSERT INTO hub_user_allowed_sites (email, site_slug, assigned_at) VALUES (?, ?, now_local())`);
      const txn = db.transaction(() => {
        deleteStmt.run(user.email);
        for (const slug of site_slugs) {
          insertStmt.run(user.email, slug);
        }
      });
      txn();

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
             can_access_customer_search, can_access_customer_balances, can_access_collections, can_access_inventory, can_access_inventory_movement, can_access_network_devices,
             can_access_price_list, can_access_stock_receipt_expiry, can_access_creditors, can_access_commission, can_access_monthly_reports,
             can_access_hub_metrics, can_access_hub_backups, can_access_hub_trends,
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
      VALUES (?, ?, now_local())
      ON CONFLICT(email, site_slug) DO UPDATE SET pushed_at = excluded.pushed_at
    `);
    for (const res_row of summary.filter(s => s.ok)) {
      for (const u of usersToSync) {
        upsertSite.run(u.email, res_row.slug);
      }
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
          try { logError('hub.trigger_accpac_sync.stamp', updateErr, { site_id: site.id }); } catch (e) { console.error('[hub.sync_site]', { siteId: site.id, phase: 'stamp_log' }, e.message); }
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
        try { logError('hub.trigger_accpac_sync.refresh', pullErr, { site_id: site.id }); } catch (e) { console.error('[hub.sync_site]', { siteId: site.id, phase: 'refresh_log' }, e.message); }
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
  // JTI archive intake — site pushes a finished monthly .xlsx + metadata
  // ========================================================================
  //
  // Auth: per-site x-reporting-token (matched against HUB_SITES env list,
  // same way notify-backup-ready does it above). Multipart body with the
  // file under field name 'file' + metadata as form fields. Dedup is
  // enforced on (site_id, sha256), so push retries / pull-fallback hits
  // are idempotent (200 with the existing hub_archive_id).
  //
  // Multer config: accept exactly ONE .xlsx up to 25 MB. The site never
  // produces files larger than ~500 KB in normal operation; the cap is
  // a safety net against runaway uploads, not a real expected size.
  const jtiUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 30 },
  });

  // Auth FIRST, multer second. If we mounted multer.single('file') as
  // the first middleware, an unauthenticated caller could still POST a
  // 25 MB body and have it fully buffered into memory before we got to
  // the token check — a trivial DoS path. With this gate in front, an
  // unknown / missing token returns 401 immediately and the body is
  // discarded by Express without ever being parsed.
  function requireJtiSiteToken(req, res, next) {
    const token = req.headers['x-reporting-token'];
    if (!token) return res.status(401).json({ error: 'Missing x-reporting-token header' });
    const matched = HUB_SITES.find((s) => s.token && s.token === token);
    if (!matched) return res.status(401).json({ error: 'Unrecognised reporting token' });
    req._jtiSite = matched;
    next();
  }

  router.post('/api/hub/receive-jti-archive', requireJtiSiteToken, jtiUpload.single('file'), async (req, res) => {
    const matched = req._jtiSite;

    if (!req.file) {
      return res.status(400).json({ error: 'Missing file part — POST as multipart/form-data with field name "file"' });
    }

    const f = req.body || {};
    try {
      const result = receiveJtiArchive({
        db,
        archive: {
          siteId: matched.id,    // trust the token-mapped id, NOT req.body.site_id
          siteArchiveId: f.site_archive_id ? Number(f.site_archive_id) : undefined,
          buffer: req.file.buffer,
          filename: req.file.originalname || f.filename || 'jti-export.xlsx',
          periodYear: Number(f.period_year),
          periodMonth: Number(f.period_month),
          generatedAt: f.generated_at,
          generatedBy: f.generated_by || null,
          source: f.source,
          rowCount: Number(f.row_count),
          declaredSha256: f.sha256,
          declaredByteSize: f.byte_size != null ? Number(f.byte_size) : undefined,
          townCity: f.town_city || null,
          region: f.region || null,
          country: f.country || null,
          siteLabel: f.site_label || null,
          receivedVia: 'push',
        },
      });

      if (result.deduped) {
        console.log(`[hub-jti] dedup hit for site=${matched.id} sha256=${result.row.sha256.slice(0, 12)}… (existing hub id ${result.row.id})`);
      } else {
        console.log(`[hub-jti] received from site=${matched.id} ${f.period_year}-${String(f.period_month).padStart(2, '0')} (${result.row.byte_size} bytes, ${result.row.row_count} rows) → hub id ${result.row.id}`);
      }

      res.json({
        ok: true,
        deduped: result.deduped,
        hubArchiveId: result.row.id,
        siteId: matched.id,
        sha256: result.row.sha256,
      });
    } catch (err) {
      // Validation errors (sha mismatch, bad period, etc.) → 400.
      // Anything else → 500. The site's push retry will handle 5xx
      // automatically; 4xx means the site sent something nonsensical
      // and retrying won't help.
      const isValidationError = err instanceof TypeError || err instanceof RangeError;
      const status = isValidationError ? 400 : 500;
      console.error(`[hub-jti] receive failed for site=${matched.id}: ${err.message}`);
      try { logError('hub.jti_receive', err, { site_id: matched.id, status }); } catch (e) { console.error('[hub.jti_receive]', { siteId: matched.id, status }, e.message); }
      res.status(status).json({ ok: false, error: err.message });
    }
  });

  // GET /api/hub/jti/archives — list across all sites (latest first)
  // OR per-site if ?site_id=... given. UI renders this as a table on
  // the hub-side JTI dashboard.
  router.get('/api/hub/jti/archives', requireAuth, requirePermission('can_access_jti'), (req, res) => {
    try {
      const siteId = typeof req.query?.site_id === 'string' && req.query.site_id.length > 0
        ? req.query.site_id : null;
      const limitRaw = Number(req.query?.limit);
      const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 60;
      const archives = listHubJtiArchives({ db, siteId, limit });
      res.json({ ok: true, archives, limit });
    } catch (err) {
      console.error('[hub-jti] list failed:', err.message);
      res.status(500).json({ error: `Failed to list hub JTI archives: ${err.message}` });
    }
  });

  // GET /api/hub/jti/archives/:id/download — stream a previously-
  // received .xlsx back to the operator. Audited.
  router.get('/api/hub/jti/archives/:id/download', requireAuth, requirePermission('can_access_jti'), (req, res) => {
    const id = Number(req.params?.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid hub archive id' });
    }
    const row = getHubJtiArchive({ db, id });
    if (!row) return res.status(404).json({ error: `Hub JTI archive #${id} not found` });
    // Enforce the site allow-list — a restricted user must not download another
    // site's archive by guessing its id. 404 (not 403) so we don't leak that
    // the archive exists for a site they can't see. (Mirrors the commission
    // download guard; JTI had been missing it.)
    const allowedIds = getAllowedSiteIds(req, res);
    if (allowedIds !== null && !(allowedIds.has(row.site_id) || allowedIds.has(Number(row.site_id)) || allowedIds.has(String(row.site_id)))) {
      return res.status(404).json({ error: `Hub JTI archive #${id} not found` });
    }
    if (!fs.existsSync(row.file_path)) {
      console.error(`[hub-jti] archive #${id} (${row.filename}) missing on disk at ${row.file_path}`);
      logAudit({
        req, action: 'hub_jti_archive_download', resourceType: 'system', resourceName: row.filename,
        details: `Hub archive #${id} requested but file missing`, status: 'failure',
      });
      return res.status(410).json({ error: `Hub JTI archive #${id} record exists but file missing on disk` });
    }
    logAudit({
      req, action: 'hub_jti_archive_download', resourceType: 'system', resourceName: row.filename,
      details: `Downloaded hub JTI archive #${id} (site=${row.site_id}, ${row.period_year}-${String(row.period_month).padStart(2, '0')})`,
    });
    const buffer = fs.readFileSync(row.file_path);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('X-Hub-JTI-Archive-Id', String(id));
    res.setHeader('X-JTI-Archive-Sha256', row.sha256);
    res.end(buffer);
  });

  // GET /api/hub/jti/archive-groups
  // Group hub_jti_archive rows by (period_year, period_month) with a
  // completeness check against HUB_SITES. The UI uses this to render
  // the "X/N sites reported — missing A, B, C" header per period and
  // unlock the bundle download when complete.
  router.get('/api/hub/jti/archive-groups', requireAuth, requirePermission('can_access_jti'), (req, res) => {
    try {
      const limitRaw = Number(req.query?.limit);
      const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 240 ? limitRaw : 60;
      const groups = listArchiveGroups({ db, sites: HUB_SITES, limit });
      // Surface the expected-sites list too so the UI can render
      // friendly names (id → name) without a second roundtrip.
      const expected_sites = (HUB_SITES || []).map((s) => ({
        id: s.id, name: s.name || s.slug || s.id,
      }));
      res.json({ ok: true, groups, expected_sites, limit });
    } catch (err) {
      console.error('[hub-jti] groups failed:', err.message);
      res.status(500).json({ error: `Failed to list hub JTI archive groups: ${err.message}` });
    }
  });

  // GET /api/hub/jti/archive-groups/:year/:month/download
  // Stream a ZIP containing every expected site's archive for the
  // period. 409 if not all sites have reported yet (with the missing
  // list embedded in the response so the operator can chase them).
  // 410 if a recorded archive's file is missing on disk.
  router.get('/api/hub/jti/archive-groups/:year/:month/download', requireAuth, requirePermission('can_access_jti'), (req, res) => {
    const year = Number(req.params?.year);
    const month = Number(req.params?.month);
    if (!Number.isInteger(year) || !Number.isInteger(month)) {
      return res.status(400).json({ error: 'Invalid year/month — must be integers' });
    }
    // Restrict the bundle to the sites this user is allowed to see, so a
    // restricted user can't pull every branch's archive for the period in one
    // ZIP. (Mirrors the commission bundle; JTI had been streaming HUB_SITES.)
    const allowedIds = getAllowedSiteIds(req, res);
    const siteAllowed = (sid) => allowedIds === null || allowedIds.has(sid) || allowedIds.has(Number(sid)) || allowedIds.has(String(sid));
    const sites = (HUB_SITES || []).filter((s) => siteAllowed(s.id));

    const outcome = streamArchiveBundle({
      db, sites,
      periodYear: year, periodMonth: month,
      res,
      onError: (err) => {
        try { logError('hub.jti_bundle', err, { period_year: year, period_month: month }); } catch (e) { console.error('[hub.jti_bundle]', { period_year: year, period_month: month }, e.message); }
        try {
          logAudit({
            req, action: 'hub_jti_bundle_download', resourceType: 'system',
            resourceName: `JTI bundle ${year}-${String(month).padStart(2, '0')}`,
            details: `Bundle stream failed: ${err.message}`, status: 'failure',
          });
        } catch (auditErr) { console.warn('[hub.jti_bundle.audit_failure]', { year, month }, auditErr.message); }
      },
    });

    if (outcome.ok) {
      // Headers + stream were started by streamArchiveBundle; only the
      // audit is ours to write here.
      try {
        logAudit({
          req, action: 'hub_jti_bundle_download', resourceType: 'system',
          resourceName: outcome.filename,
          details: `Downloaded JTI bundle for ${year}-${String(month).padStart(2, '0')} — ${outcome.archives.length} sites: ${outcome.archives.map((a) => a.site_id).join(', ')}`,
        });
      } catch (e) { console.warn('[hub.jti_bundle.audit_success]', { year, month }, e.message); }
      return; // response is streaming; do not write further status/body
    }

    const statusCode =
      outcome.code === 'BAD_PERIOD'   ? 400 :
      outcome.code === 'FILE_MISSING' ? 410 :
      outcome.code === 'PERIOD_EMPTY' ? 404 :
      outcome.code === 'INCOMPLETE'   ? 409 :
      500;
    try {
      logAudit({
        req, action: 'hub_jti_bundle_download', resourceType: 'system',
        resourceName: `JTI bundle ${year}-${String(month).padStart(2, '0')}`,
        details: `Bundle refused (${outcome.code}): ${outcome.message}`,
        status: 'failure',
      });
    } catch (e) { console.warn('[hub.jti_bundle.audit_refused]', { year, month, code: outcome.code }, e.message); }
    res.status(statusCode).json({
      ok: false,
      code: outcome.code,
      error: outcome.message,
      ...(outcome.missing_site_ids != null ? { missing_site_ids: outcome.missing_site_ids } : {}),
      ...(outcome.received_count   != null ? { received_count:   outcome.received_count   } : {}),
      ...(outcome.expected_count   != null ? { expected_count:   outcome.expected_count   } : {}),
    });
  });

  // ========================================================================
  // Commission archive intake — site pushes a finished monthly .pdf + metadata
  // ========================================================================
  //
  // Same shape as the JTI receive endpoint above. Token-auth via
  // requireJtiSiteToken (same HUB_SITES list — a site has one reporting
  // token covering both JTI + commission rather than two separate
  // secrets). PDFs are larger than the JTI xlsx export, so this multer
  // instance caps at 20 MB rather than 25 — still well above realistic
  // payload size for the report (~50 KB typical) but appropriate for the
  // expected medium.
  const commissionUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 30 },
  });

  router.post('/api/hub/receive-commission-archive', requireJtiSiteToken, commissionUpload.single('file'), async (req, res) => {
    const matched = req._jtiSite;

    if (!req.file) {
      return res.status(400).json({ error: 'Missing file part — POST as multipart/form-data with field name "file"' });
    }

    const f = req.body || {};
    try {
      const result = receiveCommissionArchive({
        db,
        archive: {
          siteId: matched.id,    // trust the token-mapped id, NOT req.body.site_id
          siteArchiveId: f.site_archive_id ? Number(f.site_archive_id) : undefined,
          buffer: req.file.buffer,
          filename: req.file.originalname || f.filename || 'commission.pdf',
          periodYear: Number(f.period_year),
          periodMonth: Number(f.period_month),
          periodFrom: f.period_from,
          periodTo: f.period_to,
          generatedAt: f.generated_at,
          generatedBy: f.generated_by || null,
          source: f.source,
          declaredSha256: f.sha256,
          declaredByteSize: f.byte_size != null ? Number(f.byte_size) : undefined,
          reportJson: f.report_json,
          siteLabel: f.site_label || null,
          receivedVia: 'push',
        },
      });

      if (result.deduped) {
        console.log(`[hub-commission] dedup hit for site=${matched.id} sha256=${result.row.sha256.slice(0, 12)}… (existing hub id ${result.row.id})`);
      } else {
        console.log(`[hub-commission] received from site=${matched.id} ${f.period_year}-${String(f.period_month).padStart(2, '0')} (${result.row.byte_size} bytes) → hub id ${result.row.id}`);
      }

      res.json({
        ok: true,
        deduped: result.deduped,
        hubArchiveId: result.row.id,
        siteId: matched.id,
        sha256: result.row.sha256,
      });
    } catch (err) {
      // Validation errors (sha mismatch, bad period, etc.) → 400.
      // Anything else → 500. The site's push retry handles 5xx
      // automatically; 4xx means the site sent something nonsensical.
      const isValidationError = err instanceof TypeError || err instanceof RangeError;
      const status = isValidationError ? 400 : 500;
      console.error(`[hub-commission] receive failed for site=${matched.id}: ${err.message}`);
      try { logError('hub.commission_receive', err, { site_id: matched.id, status }); } catch (e) { console.error('[hub.commission_receive]', { siteId: matched.id, status }, e.message); }
      res.status(status).json({ ok: false, error: err.message });
    }
  });

  // GET /api/hub/commission/archives — list across all sites (latest first)
  // OR per-site if ?site_id=... given.
  router.get('/api/hub/commission/archives', requireAuth, requirePermission('can_access_monthly_reports'), requireAllowedSite('site_id'), (req, res) => {
    try {
      const siteId = typeof req.query?.site_id === 'string' && req.query.site_id.length > 0
        ? req.query.site_id : null;
      const limitRaw = Number(req.query?.limit);
      const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 500 ? limitRaw : 60;
      // Scope to the user's allowed sites — the service returns every site's
      // archives (incl. report_json), so filter both the list and the expected-
      // sites the UI shows. requireAllowedSite already rejects a disallowed
      // explicit ?site_id.
      const allowedIds = getAllowedSiteIds(req, res);
      const siteAllowed = (sid) => allowedIds === null || allowedIds.has(sid) || allowedIds.has(Number(sid)) || allowedIds.has(String(sid));
      let archives = listHubCommissionArchives({ db, siteId, limit });
      if (allowedIds !== null) archives = archives.filter((a) => siteAllowed(a.site_id));
      const expected_sites = (HUB_SITES || [])
        .filter((s) => siteAllowed(s.id))
        .map((s) => ({ id: s.id, name: s.name || s.slug || s.id }));
      res.json({ ok: true, archives, expected_sites, limit });
    } catch (err) {
      console.error('[hub-commission] list failed:', err.message);
      try { logError('hub.commission_list', err); } catch (e) { console.error('[hub.commission_list]', e.message); }
      res.status(500).json({ error: `Failed to list hub commission archives: ${err.message}` });
    }
  });

  // GET /api/hub/commission/archives/:id/download — stream a previously-
  // received .pdf back to the operator. Audited.
  router.get('/api/hub/commission/archives/:id/download', requireAuth, requirePermission('can_access_monthly_reports'), (req, res) => {
    const id = Number(req.params?.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid hub archive id' });
    }
    const row = getHubCommissionArchive({ db, id });
    if (!row) return res.status(404).json({ error: `Hub commission archive #${id} not found` });
    // Enforce the site allow-list — a restricted user must not download another
    // site's archive by guessing its id. 404 (not 403) so we don't leak that
    // the archive exists for a site they can't see.
    const allowedIds = getAllowedSiteIds(req, res);
    if (allowedIds !== null && !(allowedIds.has(row.site_id) || allowedIds.has(Number(row.site_id)) || allowedIds.has(String(row.site_id)))) {
      return res.status(404).json({ error: `Hub commission archive #${id} not found` });
    }
    if (!fs.existsSync(row.file_path)) {
      console.error(`[hub-commission] archive #${id} (${row.filename}) missing on disk at ${row.file_path}`);
      logAudit({
        req, action: 'hub_commission_archive_download', resourceType: 'system', resourceName: row.filename,
        details: `Hub archive #${id} requested but file missing`, status: 'failure',
      });
      return res.status(410).json({ error: `Hub commission archive #${id} record exists but file missing on disk` });
    }
    logAudit({
      req, action: 'hub_commission_archive_download', resourceType: 'system', resourceName: row.filename,
      details: `Downloaded hub commission archive #${id} (site=${row.site_id}, ${row.period_year}-${String(row.period_month).padStart(2, '0')})`,
    });
    const buffer = fs.readFileSync(row.file_path);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('X-Hub-Commission-Archive-Id', String(id));
    res.setHeader('X-Commission-Archive-Sha256', row.sha256);
    res.end(buffer);
  });

  // GET /api/hub/commission/archive-groups/:year/:month/download
  // Stream a single ZIP of every site's commission PDF for the period —
  // the "download all sites for the month" bundle (cf. the JTI bundle).
  // Scoped to the user's allowed sites; lenient on completeness (bundles
  // whatever has been received, with the missing set reported for audit).
  router.get('/api/hub/commission/archive-groups/:year/:month/download', requireAuth, requirePermission('can_access_monthly_reports'), (req, res) => {
    const year = Number(req.params?.year);
    const month = Number(req.params?.month);
    if (!Number.isInteger(year) || !Number.isInteger(month)) {
      return res.status(400).json({ error: 'Invalid year/month — must be integers' });
    }
    // Restrict the bundle to the sites this user is allowed to see.
    const allowedIds = getAllowedSiteIds(req, res);
    const siteAllowed = (sid) => allowedIds === null || allowedIds.has(sid) || allowedIds.has(Number(sid)) || allowedIds.has(String(sid));
    const sites = (HUB_SITES || []).filter((s) => siteAllowed(s.id));

    const outcome = streamCommissionArchiveBundle({
      db, sites, periodYear: year, periodMonth: month, res,
      onError: (err) => {
        try { logError('hub.commission_bundle', err, { period_year: year, period_month: month }); } catch (e) { console.error('[hub.commission_bundle]', { year, month }, e.message); }
        try {
          logAudit({
            req, action: 'hub_commission_bundle_download', resourceType: 'system',
            resourceName: `Commission bundle ${year}-${String(month).padStart(2, '0')}`,
            details: `Bundle stream failed: ${err.message}`, status: 'failure',
          });
        } catch (auditErr) { console.warn('[hub.commission_bundle.audit_failure]', { year, month }, auditErr.message); }
      },
    });

    if (outcome.ok) {
      try {
        logAudit({
          req, action: 'hub_commission_bundle_download', resourceType: 'system',
          resourceName: outcome.filename,
          details: `Downloaded commission bundle for ${year}-${String(month).padStart(2, '0')} — ${outcome.archives.length} site(s): ${outcome.archives.map((a) => a.site_id).join(', ')}${outcome.missing_site_ids?.length ? ` (missing: ${outcome.missing_site_ids.join(', ')})` : ''}`,
        });
      } catch (e) { console.warn('[hub.commission_bundle.audit_success]', { year, month }, e.message); }
      return; // response is streaming
    }

    const statusCode =
      outcome.code === 'BAD_PERIOD'   ? 400 :
      outcome.code === 'FILE_MISSING' ? 410 :
      outcome.code === 'PERIOD_EMPTY' ? 404 :
      500;
    try {
      logAudit({
        req, action: 'hub_commission_bundle_download', resourceType: 'system',
        resourceName: `Commission bundle ${year}-${String(month).padStart(2, '0')}`,
        details: `Bundle refused (${outcome.code}): ${outcome.message}`, status: 'failure',
      });
    } catch (e) { console.warn('[hub.commission_bundle.audit_refused]', { year, month, code: outcome.code }, e.message); }
    res.status(statusCode).json({
      ok: false,
      code: outcome.code,
      error: outcome.message,
      ...(outcome.missing_site_ids != null ? { missing_site_ids: outcome.missing_site_ids } : {}),
      ...(outcome.received_count   != null ? { received_count:   outcome.received_count   } : {}),
      ...(outcome.expected_count   != null ? { expected_count:   outcome.expected_count   } : {}),
    });
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

  // ──────────────────────────────────────────────────────────────────
  // Per-user site allow-list — central enforcement.
  //
  // hub_user_allowed_sites maps (email → site_slug). Semantics:
  //   - no rows for this email   → unrestricted (legacy default — preserved
  //                                 so existing users without a configured
  //                                 allow-list keep their pre-PR-#344
  //                                 behaviour, AND so a sysadmin doesn't
  //                                 accidentally lock themselves out by
  //                                 clearing their own list)
  //   - ≥1 row for this email    → restricted to the listed site_slugs only
  //
  // Role does NOT short-circuit. An admin who explicitly sets an allow-list
  // for themselves gets scoped to those sites. The previous design had an
  // isAdmin → unrestricted bypass; that turned out to violate operator
  // expectations (Sean set 4 sites for an admin user expecting it to
  // gate; nothing changed).
  //
  // Any handler that returns site-keyed data should call siteFilterSql()
  // and append `${sql}` to its WHERE clause with the returned `params`.
  // Per-site endpoints (`:siteId` in URL or `?site_id` in query) should
  // wrap with requireAllowedSite('siteId') / requireAllowedSite('site_id').
  //
  // Result is cached in res.locals so repeated calls inside one handler
  // don't re-query the allow-list / hub_sites.
  // ──────────────────────────────────────────────────────────────────

  function getAllowedSiteSlugs(req, res) {
    if (res?.locals && 'allowedSiteSlugs' in res.locals) return res.locals.allowedSiteSlugs;

    let result = null; // null = unrestricted; Set<slug> = explicit allow-list
    const userEmail = req.currentUser?.email;

    if (userEmail) {
      try {
        const slugs = db.prepare(
          `SELECT site_slug FROM hub_user_allowed_sites WHERE email = ?`
        ).all(userEmail).map((r) => r.site_slug);
        if (slugs.length > 0) result = new Set(slugs);
      } catch { /* table missing on fresh installs — treat as unrestricted */ }
    }

    if (res?.locals) res.locals.allowedSiteSlugs = result;
    return result;
  }

  function getAllowedSiteIds(req, res) {
    if (res?.locals && 'allowedSiteIds' in res.locals) return res.locals.allowedSiteIds;

    let result = null;
    const slugs = getAllowedSiteSlugs(req, res);
    if (slugs !== null) {
      // Translate slugs → ids. If a slug no longer matches any
      // hub_sites row (operator removed the site), the user is
      // legitimately denied — Set stays small/empty.
      const slugList = [...slugs];
      const placeholders = slugList.map(() => '?').join(',') || "''";
      try {
        const ids = db.prepare(
          `SELECT id FROM hub_sites WHERE slug IN (${placeholders})`
        ).all(...slugList).map((r) => r.id);
        result = new Set(ids);
      } catch { result = new Set(); }
    }

    if (res?.locals) res.locals.allowedSiteIds = result;
    return result;
  }

  // SQL fragment for AND clauses. Returns { sql: '', params: [] } when
  // unrestricted, ` AND <col> IN (?,?,...)` + params otherwise. Using
  // `1=0` for zero-size set is intentional: a non-admin whose allowed
  // slugs no longer match any hub_sites row should see nothing, not
  // everything. `mode` selects whether <col> is a site_id (default) or
  // a site_slug column.
  function siteFilterSql(req, res, columnName = 'site_id', mode = 'id') {
    const allowed = mode === 'slug'
      ? getAllowedSiteSlugs(req, res)
      : getAllowedSiteIds(req, res);
    if (allowed === null) return { sql: '', params: [] };
    if (allowed.size === 0) return { sql: ' AND 1=0', params: [] };
    const list = [...allowed];
    const placeholders = list.map(() => '?').join(',');
    return { sql: ` AND ${columnName} IN (${placeholders})`, params: list };
  }

  // Middleware for endpoints with a single site_id in URL or query.
  // 403s if the requested site isn't in the user's allow-list. Pass
  // through if the request doesn't specify a site_id (let the handler
  // do whatever it does — typically a list endpoint).
  function requireAllowedSite(siteIdKey = 'siteId') {
    return (req, res, next) => {
      const allowed = getAllowedSiteIds(req, res);
      if (allowed === null) return next();
      const id = req.params?.[siteIdKey] ?? req.query?.[siteIdKey];
      if (!id) return next();
      if (!allowed.has(String(id))) {
        return res.status(403).json({ error: 'You do not have access to this site.' });
      }
      next();
    };
  }

  // Reject filenames that try to escape the per-site backup dir.
  // hub-backups/<siteId>/<file> is the only legal shape; '..' or
  // path separators in the filename are rejected.
  function isSafeBackupFilename(name) {
    if (typeof name !== 'string' || !name) return false;
    if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
    if (!/^[\w.\-+ ]+$/.test(name)) return false; // conservative whitelist
    return true;
  }

  // Reject siteIds that could escape hub-backups/. Without this, raw
  // req.params.siteId interpolates into path.join — on Express versions
  // that decode %2F a crafted siteId could read sibling directories.
  function isSafeSiteId(name) {
    if (typeof name !== 'string' || !name) return false;
    return /^[a-zA-Z0-9_-]{1,64}$/.test(name);
  }

  // Strip control characters and cap length. Used on every user-supplied
  // value before it lands in a log row.
  function sanitizeForLog(value, max = 200) {
    return String(value ?? '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, max);
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

    const dir = resolveSiteBackupDir(path.join(process.cwd(), 'database', 'hub-backups'), site);
    if (!existsSync(dir)) {
      return res.json({ site_id: site.id, site_name: site.name, snapshots: [] });
    }

    let allFiles = [];
    try {
      allFiles = readdirSync(dir);
    } catch (err) {
      return res.status(500).json({ error: `Cannot read backups dir: ${err.message}` });
    }

    // Pull every db file's metadata + companion files (if any). Match
    // on the timestamp suffix `-YYYY-MM-DD-HH-MM-SS` since the .db and
    // each companion share that part — see hubEtl.pullBackupForSite.
    const dbFiles = allFiles.filter((f) => f.endsWith('.db'));
    const previewZips = allFiles.filter((f) => f.startsWith('bat-previews-') && f.endsWith('.zip'));
    const jtiArchiveZips = allFiles.filter((f) => f.startsWith('jti-archive-') && f.endsWith('.zip'));
    const batArchiveZips = allFiles.filter((f) => f.startsWith('bat-archive-') && f.endsWith('.zip'));
    const envFiles = allFiles.filter((f) => f.startsWith('config-') && f.endsWith('.env'));

    // Pre-load integrity statuses in one query keyed by filename, so
    // the snapshots list shows whether the hub already verified each.
    let integrityMap = new Map();
    try {
      const rows = db.prepare(`
        SELECT filename, result, MAX(created_at) AS last_check
        FROM hub_backup_integrity WHERE site_id = ? GROUP BY filename
      `).all(siteId);
      integrityMap = new Map(rows.map(r => [r.filename, r]));
    } catch (e) { console.warn('[hub.snapshots.integrity_query]', { siteId }, e.message); }

    const snapshots = dbFiles.map((dbFile) => {
      const fullDb = path.join(dir, dbFile);
      let dbStat = null;
      try { dbStat = statSync(fullDb); } catch (e) { if (e.code !== 'ENOENT') console.warn('[hub.snapshots.db_stat]', { fullDb }, e.message); }
      // Match the timestamp suffix to find the companion previews zip.
      // .db filename: cardoso-<siteId>-YYYY-MM-DD-HH-MM-SS.db
      // zip filename: bat-previews-<siteId>-YYYY-MM-DD-HH-MM-SS.zip
      const tsMatch = dbFile.match(/-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})\.db$/);
      const ts = tsMatch ? tsMatch[1] : null;
      const sizeOf = (f) => {
        if (!f) return null;
        try { return statSync(path.join(dir, f)).size; } catch { return null; }
      };
      // Anchored match on `-<ts><suffix>` instead of substring `.includes(ts)`
      // — guards against a hypothetical filename like
      // `bat-previews-<id>-2026-05-13-02-00-00-PARTIAL.zip` over-matching.
      const previewsFile   = ts ? previewZips.find((z)     => z.endsWith(`-${ts}.zip`)) : null;
      const jtiArchiveFile = ts ? jtiArchiveZips.find((z)  => z.endsWith(`-${ts}.zip`)) : null;
      const batArchiveFile = ts ? batArchiveZips.find((z)  => z.endsWith(`-${ts}.zip`)) : null;
      const envFile        = ts ? envFiles.find((e)        => e.endsWith(`-${ts}.env`)) : null;
      const integrity = integrityMap.get(dbFile);
      return {
        filename: dbFile,
        size_bytes: dbStat?.size ?? null,
        mtime: dbStat ? new Date(dbStat.mtimeMs).toISOString() : null,
        integrity: integrity?.result || null,
        integrity_checked_at: integrity?.last_check || null,
        previews_filename: previewsFile || null,
        previews_size_bytes: sizeOf(previewsFile),
        jti_archive_filename: jtiArchiveFile || null,
        jti_archive_size_bytes: sizeOf(jtiArchiveFile),
        bat_archive_filename: batArchiveFile || null,
        bat_archive_size_bytes: sizeOf(batArchiveFile),
        env_filename: envFile || null,
        env_size_bytes: sizeOf(envFile),
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
    const {
      snapshot_filename,
      password,
      include_previews,
      include_jti_archive,
      include_bat_archive,
      include_env,
    } = req.body || {};

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
    const snapDir = resolveSiteBackupDir(path.join(process.cwd(), 'database', 'hub-backups'), site);
    const snapPath = path.join(snapDir, snapshot_filename);
    if (!existsSync(snapPath)) {
      return res.status(404).json({ error: `Snapshot '${snapshot_filename}' not found on hub.` });
    }

    // Find each companion artifact by timestamp match. Each is opt-in
    // via the matching include_* flag — operator may want a partial
    // restore (e.g. DB only, leave the archives alone) when fixing
    // corruption rather than recovering a lost site.
    const tsMatch = snapshot_filename.match(/-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})\.db$/);
    const ts = tsMatch ? tsMatch[1] : null;
    const findCompanion = (prefix, ext) => {
      if (!ts) return null;
      // Anchored on `-<ts><ext>` so a partial-download leftover named e.g.
      // `bat-previews-<id>-<ts>-PARTIAL.zip` doesn't satisfy the match.
      const tail = `-${ts}${ext}`;
      const candidate = readdirSync(snapDir).find(
        (f) => f.startsWith(prefix) && f.endsWith(tail)
      );
      return candidate && existsSync(path.join(snapDir, candidate)) ? candidate : null;
    };

    const previewsFilename   = include_previews    ? findCompanion('bat-previews-', '.zip') : null;
    const jtiArchiveFilename = include_jti_archive ? findCompanion('jti-archive-',  '.zip') : null;
    const batArchiveFilename = include_bat_archive ? findCompanion('bat-archive-',  '.zip') : null;
    const envFilename        = include_env         ? findCompanion('config-',       '.env') : null;

    // Mint one-shot tokens — one per file the site needs to pull.
    const dbToken          = mintRestoreToken(siteId, snapshot_filename);
    const previewsToken    = previewsFilename   ? mintRestoreToken(siteId, previewsFilename)   : null;
    const jtiArchiveToken  = jtiArchiveFilename ? mintRestoreToken(siteId, jtiArchiveFilename) : null;
    const batArchiveToken  = batArchiveFilename ? mintRestoreToken(siteId, batArchiveFilename) : null;
    const envToken         = envFilename        ? mintRestoreToken(siteId, envFilename)        : null;
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
          jti_archive: jtiArchiveToken
            ? { filename: jtiArchiveFilename, token: jtiArchiveToken }
            : null,
          bat_archive: batArchiveToken
            ? { filename: batArchiveFilename, token: batArchiveToken }
            : null,
          env: envToken
            ? { filename: envFilename, token: envToken }
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
          ` + previews=${previewsFilename || 'none'}` +
          ` + jti_archive=${jtiArchiveFilename || 'none'}` +
          ` + bat_archive=${batArchiveFilename || 'none'}` +
          ` + env=${envFilename || 'none'}` +
          ` to ${site.url}. Site response: ${r.status} ${body.message || body.error || ''}`,
        changes: {
          restore_id: restoreId,
          snapshot_filename,
          previews_filename: previewsFilename,
          jti_archive_filename: jtiArchiveFilename,
          bat_archive_filename: batArchiveFilename,
          env_filename: envFilename,
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
    if (!isSafeSiteId(siteId)) return res.status(400).json({ error: 'Invalid siteId' });
    if (!consumeRestoreToken(token, siteId, filename)) {
      return res.status(401).json({ error: 'Invalid, expired, or already-consumed restore token' });
    }

    // Resolve the readable `<name>-<id>` folder (or legacy `<id>`); the token is
    // keyed by siteId but the files live in the resolved per-site dir.
    const fetchSite = db.prepare('SELECT id, name, slug FROM hub_sites WHERE id = ?').get(siteId) || { id: siteId };
    const filePath = path.join(resolveSiteBackupDir(path.join(process.cwd(), 'database', 'hub-backups'), fetchSite), filename);
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Snapshot file not found on hub' });

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    const stream = createReadStream(filePath);
    stream.on('error', (err) => {
      console.error('[hub.restore-fetch] stream error:', err.message);
      try { res.destroy(err); } catch (e) { console.warn('[hub.restore_fetch.res_destroy]', e.message); }
    });
    stream.pipe(res);
  });

  // POST /api/hub/receive-users is registered on ALL installs (hub + site).
  // See createReceiveUsersRouter() below — mounted separately in server.js.

  // ──────────────────────────────────────────────────────────────────
  // Disaster recovery — self-service "restore a lost site from Hub"
  //
  // Endpoints under /api/hub/dr/* exist so a fresh-install site (no
  // session, no REPORTING_TOKEN paired with the Hub yet) can pull
  // backups using only Hub admin credentials supplied in the request
  // body. The wizard on the new site posts the operator's Hub email +
  // password directly. This is the deliberate auth model — a fresh
  // install has no other way to authenticate to the Hub.
  //
  // Permission gate: same as the Hub-UI restore button — admin role
  // plus can_access_hub_backups. Audit-logged on every attempt
  // (success and failure) so credential-stuffing shows up in the
  // System Log immediately.
  // ──────────────────────────────────────────────────────────────────

  // Shared bcrypt-validate helper. Returns the user row on success,
  // null on failure. Logs failures to error_log.
  async function validateHubAdminCreds(email, password, req) {
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return null;
    }
    const user = db.prepare('SELECT * FROM "user" WHERE email = ? AND is_active = 1').get(email);
    if (!user || !user.password_hash) {
      try {
        logError('hub.dr.auth_failed', new Error(`Unknown or inactive Hub user '${email}'`), {
          email_attempted: sanitizeForLog(email),
          ip: sanitizeForLog(req?.ip, 64),
        }, 'warn');
      } catch {} // eslint-disable-line no-empty -- logError wrapper; auth_failed warn is best-effort
      return null;
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      try {
        logError('hub.dr.auth_failed', new Error(`Bad password for Hub user '${email}'`), {
          email_attempted: sanitizeForLog(email),
          ip: sanitizeForLog(req?.ip, 64),
        }, 'warn');
      } catch {} // eslint-disable-line no-empty -- logError wrapper; auth_failed warn is best-effort
      return null;
    }
    if (user.role !== 'admin') return null;
    if (!boolFromRow(user.can_access_hub_backups, false)) return null;
    return user;
  }

  // POST /api/hub/dr/list-sites
  // Body: { email, password }
  // Returns: { sites: [{ id, slug, name, snapshots: [...same shape as
  //   /api/hub/sites/:siteId/snapshots...] }] }
  //
  // Powers the wizard's "pick a site" + "pick a snapshot" steps in
  // one call so the operator doesn't see a flicker of empty state.
  router.post('/api/hub/dr/list-sites', backupHeavyRateLimiter, async (req, res) => {
    const { email, password } = req.body || {};
    const user = await validateHubAdminCreds(email, password, req);
    if (!user) {
      return res.status(401).json({ error: 'Invalid Hub credentials or user lacks can_access_hub_backups.' });
    }

    const sites = db.prepare(`SELECT id, slug, name, url FROM hub_sites ORDER BY name`).all();
    const result = sites.map((site) => {
      const dir = resolveSiteBackupDir(path.join(process.cwd(), 'database', 'hub-backups'), site);
      if (!existsSync(dir)) return { ...site, snapshots: [] };

      let allFiles = [];
      try { allFiles = readdirSync(dir); } catch { return { ...site, snapshots: [] }; }

      const dbFiles = allFiles.filter((f) => f.endsWith('.db'));
      const previewZips = allFiles.filter((f) => f.startsWith('bat-previews-') && f.endsWith('.zip'));
      const jtiArchiveZips = allFiles.filter((f) => f.startsWith('jti-archive-') && f.endsWith('.zip'));
      const batArchiveZips = allFiles.filter((f) => f.startsWith('bat-archive-') && f.endsWith('.zip'));
      const envFiles = allFiles.filter((f) => f.startsWith('config-') && f.endsWith('.env'));

      const snapshots = dbFiles.map((dbFile) => {
        const fullDb = path.join(dir, dbFile);
        let dbStat = null;
        try { dbStat = statSync(fullDb); } catch (e) { if (e.code !== 'ENOENT') console.warn('[hub.dr.list_snapshots.db_stat]', { fullDb }, e.message); }
        const tsMatch = dbFile.match(/-(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})\.db$/);
        const ts = tsMatch ? tsMatch[1] : null;
        const findCompanion = (list) => (ts ? list.find((f) => f.includes(ts)) : null) || null;
        const sizeOf = (f) => {
          if (!f) return null;
          try { return statSync(path.join(dir, f)).size; } catch { return null; }
        };
        return {
          filename: dbFile,
          size_bytes: dbStat?.size ?? null,
          mtime: dbStat ? new Date(dbStat.mtimeMs).toISOString() : null,
          previews_filename: findCompanion(previewZips),
          previews_size_bytes: sizeOf(findCompanion(previewZips)),
          jti_archive_filename: findCompanion(jtiArchiveZips),
          jti_archive_size_bytes: sizeOf(findCompanion(jtiArchiveZips)),
          bat_archive_filename: findCompanion(batArchiveZips),
          bat_archive_size_bytes: sizeOf(findCompanion(batArchiveZips)),
          env_filename: findCompanion(envFiles),
          env_size_bytes: sizeOf(findCompanion(envFiles)),
        };
      }).sort((a, b) => (b.mtime || '').localeCompare(a.mtime || ''));

      return { ...site, snapshots };
    });

    try {
      logAudit({
        req,
        action: 'hub_dr_list_sites',
        resourceType: 'system',
        resourceId: 'hub',
        resourceName: 'disaster-recovery',
        details: `Listed ${result.length} site(s) with ${result.reduce((n, s) => n + s.snapshots.length, 0)} total snapshots`,
        status: 'success',
        userOverride: { email: user.email, full_name: user.full_name },
      });
    } catch (e) { console.warn('[hub.dr.list_sites.audit]', e.message); }

    res.json({ sites: result });
  });

  // POST /api/hub/dr/snapshot-meta/:siteId/:filename
  // Body: { email, password }
  // Returns metadata pulled from inside the snapshot DB itself —
  // counts of customers / reconciliations / users / audit entries +
  // last activity timestamp + integrity verdict. Helps the operator
  // confirm they've picked the right snapshot before kicking off a
  // multi-GB download.
  router.post('/api/hub/dr/snapshot-meta/:siteId/:filename', backupHeavyRateLimiter, async (req, res) => {
    const { email, password } = req.body || {};
    const user = await validateHubAdminCreds(email, password, req);
    if (!user) return res.status(401).json({ error: 'Invalid Hub credentials.' });

    const { siteId, filename } = req.params;
    if (!isSafeSiteId(siteId)) return res.status(400).json({ error: 'Invalid siteId.' });
    if (!isSafeBackupFilename(filename) || !filename.endsWith('.db')) {
      return res.status(400).json({ error: 'Invalid filename.' });
    }
    const metaSite = db.prepare('SELECT id, name, slug FROM hub_sites WHERE id = ?').get(siteId) || { id: siteId };
    const snapPath = path.join(resolveSiteBackupDir(path.join(process.cwd(), 'database', 'hub-backups'), metaSite), filename);
    if (!existsSync(snapPath)) {
      return res.status(404).json({ error: 'Snapshot not found on hub.' });
    }

    let Database;
    try {
      Database = (await import('better-sqlite3')).default;
    } catch (err) {
      return res.status(500).json({ error: `better-sqlite3 not available: ${err.message}` });
    }

    let snap;
    try {
      snap = new Database(snapPath, { readonly: true, fileMustExist: true });
    } catch (err) {
      return res.status(500).json({ error: `Cannot open snapshot: ${err.message}` });
    }

    try {
      // Per-table counts wrapped individually — a missing table on a
      // particularly old snapshot returns null rather than 500-ing the
      // whole metadata fetch.
      const safeCount = (sql) => {
        try { return snap.prepare(sql).get()?.c ?? null; } catch { return null; }
      };
      const safeMax = (sql) => {
        try { return snap.prepare(sql).get()?.m ?? null; } catch { return null; }
      };

      // Integrity verdict comes from the cached hub_backup_integrity
      // row written by the daily backup pull — NOT from running
      // PRAGMA integrity_check inline. better-sqlite3 is synchronous;
      // PRAGMA integrity_check on a multi-GB snapshot blocks the Hub's
      // event loop for minutes, freezing every other request and any
      // scheduled cron during that window. The cached verdict is
      // typically <24h old (the Hub re-checks on every pull) which is
      // fine for "should the operator pick this snapshot" decision.
      let integrity = 'unknown';
      try {
        const cached = db.prepare(`
          SELECT result FROM hub_backup_integrity
          WHERE site_id = ? AND filename = ?
          ORDER BY created_at DESC LIMIT 1
        `).get(siteId, filename);
        if (cached?.result === 'ok') integrity = 'ok';
        else if (cached?.result) integrity = 'corrupt';
      } catch { /* fall through with 'unknown' */ }

      res.json({
        filename,
        integrity,
        counts: {
          users: safeCount('SELECT COUNT(*) AS c FROM "user"'),
          admins: safeCount(`SELECT COUNT(*) AS c FROM "user" WHERE role = 'admin'`),
          customers: safeCount('SELECT COUNT(*) AS c FROM datarecord'),
          reconciliations: safeCount('SELECT COUNT(*) AS c FROM bat_reconciliations'),
          extractions: safeCount('SELECT COUNT(*) AS c FROM bat_invoice_extractions'),
          audit_entries: safeCount('SELECT COUNT(*) AS c FROM auditlog'),
        },
        last_activity: {
          audit: safeMax('SELECT MAX(created_at) AS m FROM auditlog'),
          reconciliation: safeMax('SELECT MAX(created_at) AS m FROM bat_reconciliations'),
          extraction: safeMax('SELECT MAX(created_at) AS m FROM bat_invoice_extractions'),
        },
      });
    } finally {
      try { snap.close(); } catch (e) { console.warn('[hub.dr.snapshot_meta.close]', e.message); }
    }
  });

  // POST /api/hub/dr/fetch/:siteId/:filename
  // Body: { email, password }
  // Streams the requested artifact (.db / .env / .zip) from the hub's
  // hub-backups/<siteId>/ directory. Same path-safety + audit + size
  // accounting as the existing /api/hub/restore-fetch but auth is
  // creds-in-body rather than one-shot token (since the calling site
  // has no token yet). Each fetch is its own audit row.
  router.post('/api/hub/dr/fetch/:siteId/:filename', backupHeavyRateLimiter, async (req, res) => {
    const { email, password } = req.body || {};
    const user = await validateHubAdminCreds(email, password, req);
    if (!user) return res.status(401).json({ error: 'Invalid Hub credentials.' });

    const { siteId, filename } = req.params;
    if (!isSafeSiteId(siteId)) return res.status(400).json({ error: 'Invalid siteId.' });
    if (!isSafeBackupFilename(filename)) {
      return res.status(400).json({ error: 'Invalid filename.' });
    }
    const drSite = db.prepare('SELECT id, name, slug FROM hub_sites WHERE id = ?').get(siteId) || { id: siteId };
    const filePath = path.join(resolveSiteBackupDir(path.join(process.cwd(), 'database', 'hub-backups'), drSite), filename);
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on hub.' });
    }

    let bytesStreamed = 0;
    let auditWritten = false;
    const writeAudit = (status, extra = {}) => {
      if (auditWritten) return; auditWritten = true;
      try {
        logAudit({
          req,
          action: 'hub_dr_fetch',
          resourceType: 'system',
          resourceId: siteId,
          resourceName: filename,
          details: `bytes=${bytesStreamed}` + (extra.error ? `, error=${sanitizeForLog(extra.error)}` : ''),
          status,
          userOverride: { email: user.email, full_name: user.full_name },
        });
      } catch (e) { console.warn('[hub.dr.fetch.audit]', { siteId, filename, status }, e.message); }
    };
    res.on('finish', () => writeAudit('success'));
    res.on('close', () => { if (!res.writableFinished) writeAudit('failure'); });

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    // Open the read stream FIRST, then derive Content-Length from
    // fstat(stream.fd). Doing statSync(filePath) before opening leaves
    // a window where a concurrent backup-pull cycle could rotate the
    // file underneath us — Content-Length would advertise the old size
    // while the bytes streamed reflect the new file. fstat on the
    // already-open FD pins to the file we're actually streaming.
    const stream = createReadStream(filePath);
    stream.on('open', (fd) => {
      try {
        const size = fstatSync(fd).size;
        if (!res.headersSent) res.setHeader('Content-Length', String(size));
      } catch { /* fall through; client gets chunked transfer */ }
    });
    stream.on('data', (chunk) => { bytesStreamed += chunk.length; });
    stream.on('error', (err) => {
      console.error('[hub.dr.fetch] stream error:', err.message);
      try { logError('hub.dr.fetch', err, { siteId, filename }); } catch {} // eslint-disable-line no-empty -- logError wrapper; failure already mirrored to audit log
      writeAudit('failure', { error: err.message });
      try { res.destroy(err); } catch (e) { console.warn('[hub.dr.fetch.res_destroy]', { siteId, filename }, e.message); }
    });
    stream.pipe(res);
  });

  // PATCH /api/hub/dr/site-url/:siteId
  // Body: { email, password, new_url }
  // Updates hub_sites.url for the given site. Called by the wizard on
  // the new machine after a successful restore so the Hub knows where
  // to push future restores / backup-pull requests. Same auth as the
  // other DR endpoints. Validates new_url is a non-empty http(s) URL.
  router.patch('/api/hub/dr/site-url/:siteId', backupHeavyRateLimiter, async (req, res) => {
    const { email, password, new_url } = req.body || {};
    const user = await validateHubAdminCreds(email, password, req);
    if (!user) return res.status(401).json({ error: 'Invalid Hub credentials.' });

    const { siteId } = req.params;
    if (!isSafeSiteId(siteId)) return res.status(400).json({ error: 'Invalid siteId.' });
    if (typeof new_url !== 'string' || !/^https?:\/\/.+/i.test(new_url)) {
      return res.status(400).json({ error: 'new_url must be an http(s):// URL.' });
    }

    const site = db.prepare(`SELECT id, name, url FROM hub_sites WHERE id = ?`).get(siteId);
    if (!site) return res.status(404).json({ error: 'Site not found on hub.' });

    const oldUrl = site.url || null;
    db.prepare(`UPDATE hub_sites SET url = ? WHERE id = ?`).run(new_url, siteId);

    try {
      logAudit({
        req,
        action: 'hub_dr_site_url_updated',
        resourceType: 'site',
        resourceId: site.id,
        resourceName: site.name,
        details: `Site URL updated by DR wizard: ${oldUrl || '(unset)'} → ${new_url}`,
        changes: { old_url: oldUrl, new_url },
        status: 'success',
        userOverride: { email: user.email, full_name: user.full_name },
      });
    } catch (e) { console.warn('[hub.dr.site_url_update.audit]', { siteId: site.id }, e.message); }

    res.json({ ok: true, site_id: site.id, old_url: oldUrl, new_url });
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
    if (!expectedToken || !safeTokenEqual(token, expectedToken)) {
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
                can_access_customer_search = ?, can_access_customer_balances = ?, can_access_collections = ?, can_access_inventory = ?, can_access_inventory_movement = ?, can_access_network_devices = ?,
                can_access_price_list = ?, can_access_stock_receipt_expiry = ?, can_access_creditors = ?, can_access_commission = ?, can_access_monthly_reports = ?,
                can_access_hub_metrics = ?, can_access_hub_backups = ?, can_access_hub_trends = ?,
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
              u.can_access_inventory_movement ? 1 : 0,
              u.can_access_network_devices ? 1 : 0,
              u.can_access_price_list ? 1 : 0,
              u.can_access_stock_receipt_expiry ? 1 : 0,
              u.can_access_creditors ? 1 : 0,
              u.can_access_commission ? 1 : 0,
              u.can_access_monthly_reports ? 1 : 0,
              u.can_access_hub_metrics ? 1 : 0,
              u.can_access_hub_backups ? 1 : 0,
              u.can_access_hub_trends ? 1 : 0,
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
                can_access_customer_search = ?, can_access_customer_balances = ?, can_access_collections = ?, can_access_inventory = ?, can_access_inventory_movement = ?, can_access_network_devices = ?,
                can_access_price_list = ?, can_access_stock_receipt_expiry = ?, can_access_creditors = ?, can_access_commission = ?, can_access_monthly_reports = ?,
                can_access_hub_metrics = ?, can_access_hub_backups = ?, can_access_hub_trends = ?,
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
              u.can_access_inventory_movement ? 1 : 0,
              u.can_access_network_devices ? 1 : 0,
              u.can_access_price_list ? 1 : 0,
              u.can_access_stock_receipt_expiry ? 1 : 0,
              u.can_access_creditors ? 1 : 0,
              u.can_access_commission ? 1 : 0,
              u.can_access_monthly_reports ? 1 : 0,
              u.can_access_hub_metrics ? 1 : 0,
              u.can_access_hub_backups ? 1 : 0,
              u.can_access_hub_trends ? 1 : 0,
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
              can_access_customer_search, can_access_customer_balances, can_access_collections, can_access_inventory, can_access_inventory_movement, can_access_network_devices,
              can_access_price_list, can_access_stock_receipt_expiry, can_access_creditors, can_access_commission, can_access_monthly_reports,
              can_access_hub_metrics, can_access_hub_backups, can_access_hub_trends,
              can_access_records, can_access_reports, can_access_connections, can_access_settings,
              can_manage_users, can_manage_rules, can_edit_records, can_flag_records, password_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            u.can_access_inventory_movement ? 1 : 0,
            u.can_access_network_devices ? 1 : 0,
            u.can_access_price_list ? 1 : 0,
            u.can_access_stock_receipt_expiry ? 1 : 0,
            u.can_access_creditors ? 1 : 0,
            u.can_access_commission ? 1 : 0,
            u.can_access_monthly_reports ? 1 : 0,
            u.can_access_hub_metrics ? 1 : 0,
            u.can_access_hub_backups ? 1 : 0,
            u.can_access_hub_trends ? 1 : 0,
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
    if (!expectedToken || !safeTokenEqual(token, expectedToken)) {
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
    if (!expectedToken || !safeTokenEqual(token, expectedToken)) {
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
    if (!expectedToken || !safeTokenEqual(token, expectedToken)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const {
      restore_id,
      hub_url,
      snapshot,
      previews,
      jti_archive,
      bat_archive,
      env,
    } = req.body || {};
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
    let jtiArchiveStaging = null;
    let batArchiveStaging = null;
    let envStaging = null;
    try {
      // Download DB snapshot
      dbStaging = pathModule.join(stagingDir, snapshot.filename);
      const siteId = process.env.SITE_ID || 'site';
      await downloadFile(
        `/api/hub/restore-fetch/${encodeURIComponent(siteId)}/${encodeURIComponent(snapshot.filename)}`,
        snapshot.token,
        dbStaging,
      );

      // Each companion is independent — if the hub didn't include one
      // (operator unchecked the box, or the file wasn't on hub disk)
      // the field will be null and we skip it. Failures on companions
      // bubble up the same as the DB; the apply script handles missing
      // optional artifacts gracefully.
      const optionalCompanions = [
        { label: 'previews',    spec: previews,    nameRef: (p) => { previewsStaging = p; } },
        { label: 'jti_archive', spec: jti_archive, nameRef: (p) => { jtiArchiveStaging = p; } },
        { label: 'bat_archive', spec: bat_archive, nameRef: (p) => { batArchiveStaging = p; } },
        { label: 'env',         spec: env,         nameRef: (p) => { envStaging = p; } },
      ];
      for (const { label, spec, nameRef } of optionalCompanions) {
        if (!spec?.filename || !spec?.token) continue;
        const destPath = pathModule.join(stagingDir, spec.filename);
        try {
          await downloadFile(
            `/api/hub/restore-fetch/${encodeURIComponent(siteId)}/${encodeURIComponent(spec.filename)}`,
            spec.token,
            destPath,
          );
          nameRef(destPath);
        } catch (companionErr) {
          // Re-throw with the label prefixed so the operator knows WHICH
          // artifact failed instead of seeing a bare "HTTP 502" with no
          // context. Caller catch below cleans up staging.
          throw new Error(`${label}: ${companionErr.message}`);
        }
      }
    } catch (err) {
      // Clean up staging on download failure — don't leave orphaned
      // partial files on disk.
      try { fsModule.rmSync(stagingDir, { recursive: true, force: true }); } catch (cleanupErr) { console.warn('[site.restore.staging_cleanup_after_download_fail]', { stagingDir }, cleanupErr.message); }
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
      try { fsModule.rmSync(stagingDir, { recursive: true, force: true }); } catch (e) { console.warn('[site.restore.staging_cleanup_non_windows]', { stagingDir }, e.message); }
      return res.status(400).json({
        ok: false,
        error: 'Restore is only supported on Windows site installs (apply-restore.ps1 is PowerShell).',
      });
    }

    const applyScript = pathModule.join(appDir, 'scripts', 'apply-restore.ps1');
    if (!fsModule.existsSync(applyScript)) {
      try { fsModule.rmSync(stagingDir, { recursive: true, force: true }); } catch (e) { console.warn('[site.restore.staging_cleanup_no_script]', { stagingDir, applyScript }, e.message); }
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
    if (previewsStaging)   { psArgsList.push(['-SnapshotPreviewsZipPath',   previewsStaging]);   }
    if (jtiArchiveStaging) { psArgsList.push(['-SnapshotJtiArchiveZipPath', jtiArchiveStaging]); }
    if (batArchiveStaging) { psArgsList.push(['-SnapshotBatArchiveZipPath', batArchiveStaging]); }
    if (envStaging)        { psArgsList.push(['-SnapshotEnvPath',           envStaging]);        }
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
      try { fsModule.rmSync(stagingDir, { recursive: true, force: true }); } catch (cleanupErr) { console.warn('[site.restore.staging_cleanup_after_task_fail]', { stagingDir }, cleanupErr.message); }
      try { logError('site.restore.task_scheduler', err, { restore_id }); } catch {} // eslint-disable-line no-empty -- logError wrapper; we still return 500 below
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
      jti_archive_filename: jti_archive?.filename || null,
      bat_archive_filename: bat_archive?.filename || null,
      env_filename: env?.filename || null,
    });
  });


  return router;
}
