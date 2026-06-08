import { Router } from 'express';
import fs from 'fs';
import {
  buildCommissionReport,
  getCommissionSettings,
  updateCommissionSettings,
  DEFAULT_COMMISSION_SALES_SQL,
  DEFAULT_COMMISSION_RECEIPTS_SQL,
  DEFAULT_COMMISSION_UNPAID_SQL,
} from '../services/commission.js';
import {
  listCommissionArchives,
  getCommissionArchive,
  latestClosedCommissionPeriod,
} from '../services/commission/commissionArchive.js';
import { generateAndArchiveCommissionPeriod } from '../services/commission/commissionScheduler.js';
import { logAudit } from '../lib/audit.js';
import { logError } from '../lib/errorLog.js';
import db from '../db/index.js';

/**
 * Minimal admin-supplied SQL guardrails. Refuses DML/DDL keywords and
 * requires each declared `@param` to appear at least once. Catches the
 * "operator pasted just an INSERT statement by mistake" class of bug at
 * save time rather than at report-build time.
 *
 * @param {string} sql
 * @param {{ expectedParams: string[] }} opts
 * @returns {string | null}  error message, or null when OK
 */
function validateOverrideSql(sql, { expectedParams }) {
  if (sql === null || sql === undefined) return null;
  const s = String(sql).trim();
  if (s.length === 0) return null; // empty = clear back to default
  // Allowlist on starting verb — must be SELECT or WITH.
  if (!/^(\s*--[^\n]*\n)*\s*(SELECT|WITH)\b/i.test(s)) {
    return 'must start with SELECT or WITH (read-only)';
  }
  // Blocklist mutations + dangerous Sage extensions.
  const banned = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|EXEC|EXECUTE|MERGE|GRANT|REVOKE|CREATE)\b/i;
  if (banned.test(s)) return 'contains a forbidden write/DDL keyword';
  // Param-presence check: every declared @param must appear in the SQL.
  for (const p of expectedParams) {
    const re = new RegExp(`@${p}\\b`, 'i');
    if (!re.test(s)) return `must reference @${p} for the date / vat parameter binding`;
  }
  // Length cap so a runaway override can't poison error_log on bind failure.
  if (s.length > 20_000) return 'too long (max 20,000 chars)';
  return null;
}

export function createCommissionRouter({ requireAuth, requireAdmin, requirePermission }) {
  const router = Router();
  const reportGuard = [requireAuth, requirePermission('can_access_commission', 'can_access_monthly_reports')];
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

  router.get('/api/commission/settings', ...reportGuard, (req, res) => {
    try {
      const settings = getCommissionSettings();
      const isAdmin = req.currentUser?.role === 'admin';
      // Non-admins shouldn't see the override SQL or the defaults — the
      // SQL view is the admin-only "advanced" surface (same gate as
      // JTI's queryOverride). Strip the SQL fields on the way out.
      if (!isAdmin) {
        const { sales_query_override, receipts_query_override, unpaid_query_override, ...rest } = settings;
        return res.json({ ...rest });
      }
      const effectiveSalesSql = (settings.sales_query_override || '').trim().length > 0
        ? settings.sales_query_override
        : DEFAULT_COMMISSION_SALES_SQL;
      const effectiveReceiptsSql = (settings.receipts_query_override || '').trim().length > 0
        ? settings.receipts_query_override
        : DEFAULT_COMMISSION_RECEIPTS_SQL;
      const effectiveUnpaidSql = (settings.unpaid_query_override || '').trim().length > 0
        ? settings.unpaid_query_override
        : DEFAULT_COMMISSION_UNPAID_SQL;
      res.json({
        ...settings,
        defaultSalesSql: DEFAULT_COMMISSION_SALES_SQL,
        defaultReceiptsSql: DEFAULT_COMMISSION_RECEIPTS_SQL,
        defaultUnpaidSql: DEFAULT_COMMISSION_UNPAID_SQL,
        effectiveSalesSql,
        effectiveReceiptsSql,
        effectiveUnpaidSql,
      });
    } catch (err) {
      logError('commission.settings.get', err);
      res.status(500).json({ error: 'Failed to load commission settings' });
    }
  });

  router.put('/api/commission/settings', ...settingsGuard, (req, res) => {
    const body = req.body || {};
    const { sweets_rate, cigtob_rate, reference_rate, vat_rate,
            sales_query_override, receipts_query_override, unpaid_query_override } = body;
    const isAdmin = req.currentUser?.role === 'admin';

    // Admin gate for the SQL override fields. Settings-permission
    // operators can still adjust rates from the same endpoint without
    // being blocked — only the SQL fields are restricted.
    if ((sales_query_override !== undefined || receipts_query_override !== undefined || unpaid_query_override !== undefined) && !isAdmin) {
      return res.status(403).json({
        error: 'Editing the commission report SQL is restricted to admin users.',
      });
    }

    // Validate each provided rate. A field can be omitted (sparse PUT) —
    // but if present it must be numeric.
    const checked = {};
    for (const [key, val] of [
      ['sweets_rate', sweets_rate], ['cigtob_rate', cigtob_rate],
      ['reference_rate', reference_rate], ['vat_rate', vat_rate],
    ]) {
      if (val === undefined) continue;
      const n = Number(val);
      if (!Number.isFinite(n)) {
        return res.status(400).json({ error: `${key} must be numeric (decimal, e.g. 0.015 for 1.5%)` });
      }
      checked[key] = n;
    }

    // Validate SQL overrides — empty / undefined = clear / no change.
    if (sales_query_override !== undefined) {
      const issue = validateOverrideSql(sales_query_override, { expectedParams: ['from', 'to'] });
      if (issue) return res.status(400).json({ error: `Sales query: ${issue}` });
      checked.sales_query_override = sales_query_override;
    }
    if (receipts_query_override !== undefined) {
      const issue = validateOverrideSql(receipts_query_override, { expectedParams: ['from', 'to', 'vat'] });
      if (issue) return res.status(400).json({ error: `Receipts query: ${issue}` });
      checked.receipts_query_override = receipts_query_override;
    }
    if (unpaid_query_override !== undefined) {
      const issue = validateOverrideSql(unpaid_query_override, { expectedParams: ['from', 'to'] });
      if (issue) return res.status(400).json({ error: `Unpaid query: ${issue}` });
      checked.unpaid_query_override = unpaid_query_override;
    }

    try {
      const before = getCommissionSettings();
      const updated = updateCommissionSettings({ ...checked, userId: req.currentUser?.id });
      const sqlChanged =
        (sales_query_override    !== undefined && before.sales_query_override    !== updated.sales_query_override) ||
        (receipts_query_override !== undefined && before.receipts_query_override !== updated.receipts_query_override) ||
        (unpaid_query_override   !== undefined && before.unpaid_query_override   !== updated.unpaid_query_override);
      logAudit({
        req,
        action: 'commission.settings_update',
        resourceType: 'commission_settings',
        resourceId: 1,
        details:
          `sweets=${(updated.sweets_rate * 100).toFixed(3)}% cigtob=${(updated.cigtob_rate * 100).toFixed(3)}% ref=${(updated.reference_rate * 100).toFixed(3)}% vat=${(updated.vat_rate * 100).toFixed(3)}%`
          + (sqlChanged ? ` · SQL override changed by ${req.currentUser?.email || 'unknown'}` : ''),
      });
      res.json(updated);
    } catch (err) {
      logError('commission.settings.update', err, checked);
      res.status(500).json({ error: 'Failed to update commission settings' });
    }
  });

  // ── Archives ───────────────────────────────────────────────────────────
  // Site-side archive panel for the Sales Commission page. Mirrors the
  // JTI archive endpoints (src/routes/jti.js). The PDF + JSON snapshot
  // were produced by either the monthly cron (24th of each month) or an
  // operator-triggered "Run now" call below.
  router.get('/api/commission/archives', ...reportGuard, (req, res) => {
    try {
      const limitRaw = Number(req.query?.limit);
      const limit = Number.isInteger(limitRaw) && limitRaw > 0 && limitRaw <= 240 ? limitRaw : 60;
      const archives = listCommissionArchives({ db, limit });
      res.json({ ok: true, archives, limit });
    } catch (err) {
      logError('commission.archives.list', err);
      res.status(500).json({ error: `Failed to list commission archives: ${err.message}` });
    }
  });

  router.get('/api/commission/archives/:id/download', ...reportGuard, (req, res) => {
    const id = Number(req.params?.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid archive id' });
    }
    let row;
    try { row = getCommissionArchive({ db, id }); }
    catch (err) {
      logError('commission.archives.get', err, { id });
      return res.status(500).json({ error: `Failed to read archive #${id}: ${err.message}` });
    }
    if (!row) return res.status(404).json({ error: `Commission archive #${id} not found` });
    if (!fs.existsSync(row.file_path)) {
      console.error(`[commission.archive] #${id} (${row.filename}) missing on disk at ${row.file_path}`);
      logAudit({
        req, action: 'commission_archive_download', resourceType: 'commission_archive', resourceId: id,
        resourceName: row.filename,
        details: `Archive #${id} requested but file missing`, status: 'failure',
      });
      return res.status(410).json({ error: `Commission archive #${id} record exists but file missing on disk` });
    }
    logAudit({
      req, action: 'commission_archive_download', resourceType: 'commission_archive', resourceId: id,
      resourceName: row.filename,
      details: `Downloaded commission archive #${id} (${row.period_year}-${String(row.period_month).padStart(2, '0')}, source=${row.source})`,
    });
    const buffer = fs.readFileSync(row.file_path);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${row.filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('X-Commission-Archive-Id', String(id));
    res.setHeader('X-Commission-Archive-Sha256', row.sha256);
    res.end(buffer);
  });

  // POST /api/commission/archives/run-now — admin-only trigger to
  // generate + archive the latest CLOSED commission period on demand.
  // Targets latestClosedCommissionPeriod (not the in-progress current
  // month) so an early run can't archive a partial report and then make
  // the real 24th-of-month cron skip it. Uses the same code path as the
  // monthly cron; the unique partial index on (period_year, period_month)
  // WHERE source='scheduled' prevents a duplicate scheduled row. Surfaces
  // status ({archived, skipped, failed}) so the UI can toast the outcome.
  router.post('/api/commission/archives/run-now', requireAuth, requireAdmin, requirePermission('can_access_commission', 'can_access_monthly_reports'), async (req, res) => {
    const period = latestClosedCommissionPeriod(new Date());
    const tag = `${period.year}-${String(period.month).padStart(2, '0')}`;
    try {
      const result = await generateAndArchiveCommissionPeriod({
        db,
        year: period.year,
        month: period.month,
      });
      const ok = result.status !== 'failed';
      logAudit({
        req, action: 'commission_archive_run_now', resourceType: 'commission_archive',
        resourceName: tag,
        details: result.status === 'archived'
          ? `Generated commission archive #${result.archiveId} for ${tag} (${period.fromDate} → ${period.toDate})`
          : result.status === 'failed'
            ? `Run-now failed for ${tag}: ${result.reason}`
            : `Run-now skipped for ${tag}: ${result.reason}`,
        status: ok ? 'success' : 'failure',
      });
      if (!ok) {
        return res.status(503).json({ ok: false, period, ...result, error: `Commission generation failed: ${result.reason}` });
      }
      res.json({ ok: true, period, ...result });
    } catch (err) {
      logError('commission.archives.run_now', err, { year: period.year, month: period.month });
      res.status(500).json({ error: `Run-now failed: ${err.message}` });
    }
  });

  return router;
}
