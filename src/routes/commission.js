import { Router } from 'express';
import fs from 'fs';
import {
  buildCommissionReport,
  getCommissionSettings,
  updateCommissionSettings,
} from '../services/commission.js';
import {
  listCommissionArchives,
  getCommissionArchive,
  commissionPeriodForRun,
} from '../services/commission/commissionArchive.js';
import { generateAndArchiveCommissionPeriod } from '../services/commission/commissionScheduler.js';
import { logAudit } from '../lib/audit.js';
import { logError } from '../lib/errorLog.js';
import db from '../db/index.js';

export function createCommissionRouter({ requireAuth, requireAdmin, requirePermission }) {
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
    const { sweets_rate, cigtob_rate, reference_rate, vat_rate } = req.body || {};
    // Parsing here rather than at the service so the route can return a
    // clean 400 instead of letting the service throw a generic 500.
    const parsed = {
      sweets_rate: Number(sweets_rate),
      cigtob_rate: Number(cigtob_rate),
      reference_rate: Number(reference_rate),
      vat_rate: Number(vat_rate),
    };
    if (![parsed.sweets_rate, parsed.cigtob_rate, parsed.reference_rate, parsed.vat_rate].every(Number.isFinite)) {
      return res.status(400).json({ error: 'All rates must be numeric (decimal, e.g. 0.015 for 1.5%)' });
    }
    try {
      const updated = updateCommissionSettings({ ...parsed, userId: req.currentUser?.id });
      logAudit({
        req,
        action: 'commission.settings_update',
        resourceType: 'commission_settings',
        resourceId: 1,
        details: `sweets=${(updated.sweets_rate * 100).toFixed(3)}% cigtob=${(updated.cigtob_rate * 100).toFixed(3)}% ref=${(updated.reference_rate * 100).toFixed(3)}% vat=${(updated.vat_rate * 100).toFixed(3)}%`,
      });
      res.json(updated);
    } catch (err) {
      logError('commission.settings.update', err, parsed);
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
  // generate + archive the current commission period on demand. Uses
  // the same code path as the monthly cron; the unique partial index
  // on (period_year, period_month) WHERE source='scheduled' prevents a
  // second scheduled row from being written if today's cron already
  // ran. The route surfaces the resulting status ({archived,skipped})
  // so the UI can refresh the list and toast the outcome.
  router.post('/api/commission/archives/run-now', requireAuth, requireAdmin, requirePermission('can_access_commission'), async (req, res) => {
    const period = commissionPeriodForRun(new Date());
    try {
      const result = await generateAndArchiveCommissionPeriod({
        db,
        year: period.year,
        month: period.month,
      });
      logAudit({
        req, action: 'commission_archive_run_now', resourceType: 'commission_archive',
        resourceName: `${period.year}-${String(period.month).padStart(2, '0')}`,
        details: result.status === 'archived'
          ? `Generated commission archive #${result.archiveId} for ${period.year}-${String(period.month).padStart(2, '0')} (${period.fromDate} → ${period.toDate})`
          : `Run-now skipped for ${period.year}-${String(period.month).padStart(2, '0')}: ${result.reason}`,
        status: result.status === 'archived' ? 'success' : 'success',
      });
      res.json({ ok: true, period, ...result });
    } catch (err) {
      logError('commission.archives.run_now', err, { year: period.year, month: period.month });
      res.status(500).json({ error: `Run-now failed: ${err.message}` });
    }
  });

  return router;
}
