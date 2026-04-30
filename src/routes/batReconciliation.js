/**
 * BAT Supplier Reconciliation routes.
 *
 * All endpoints are gated with requireAdmin while the module is in testing.
 * To open to non-admins later, swap requireAdmin → requirePermission('can_access_reconciliation')
 * and add the corresponding feature_permissions row + UI toggle.
 */
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import db from '../db/index.js';
import { logAudit } from '../lib/audit.js';
import {
  parseSupplierSpreadsheet,
  querySageCreditNotes,
  querySagePostedInvoices,
  querySagePaidWeeks,
  querySageWeekTotals,
  createReconciliation,
  storeSageCreditNotes,
  backfillOrderAmounts,
  parseCardosoSpreadsheet,
  storeCardosoInvoices,
  getCardosoInvoices,
  matchCardosoToSupplier,
  getReconciliation,
  listReconciliations,
  runInvoiceExtraction,
  getExtractionProgress,
  getDashboardData,
  manualSetInvoice,
  retryNotFound,
  resetSagePool,
  getCachedSageWeekTotals,
  getSageCacheMeta,
  refreshSageWeekTotalsCache,
  generateCardosoInvoicesFromSage,
  cancelCardosoInvoiceGeneration,
  getCardosoGenerateStatus,
  replicateSupplierIntoCardoso,
  isOcrPaused,
  setOcrPaused,
  resumeExtractionWorker,
  extractionEvents,
} from '../services/batReconciliation.js';

const uploadsDir = path.join(process.cwd(), 'uploads', 'bat');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.xlsx', '.xls'].includes(ext)) cb(null, true);
    else cb(new Error('Only .xlsx and .xls files are accepted'));
  },
});

export function createBatReconciliationRouter({ requireAuth, requireAdmin }) {
  const router = Router();

  // Gate everything behind admin while testing
  const gate = [requireAuth, requireAdmin];

  // Serve preview JPEGs (lightweight rendered page images)
  const previewDir = path.join(process.cwd(), 'uploads', 'bat-previews');
  router.get('/api/bat/preview/:filename', ...gate, (req, res) => {
    const filename = path.basename(req.params.filename);
    const filePath = path.join(previewDir, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Preview not found' });
    res.type('image/jpeg').sendFile(filePath);
  });

  // POST /api/bat/upload — Upload + parse supplier spreadsheet
  router.post('/api/bat/upload', ...gate, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
      const parsed = parseSupplierSpreadsheet(req.file.path, req.file.originalname);

      if (!parsed.weekNumber) {
        return res.status(400).json({ error: 'Could not detect week number from filename. Expected format: Week_XX_...' });
      }

      const year = parsed.year || parseInt(req.body.year, 10) || new Date().getFullYear();
      if (parsed.year) console.log(`[bat] Year detected from order numbers: ${parsed.year}`);
      const reconId = createReconciliation({
        weekNumber: parsed.weekNumber,
        year,
        filename: req.file.originalname,
        fees: parsed.fees,
        podUrls: parsed.podUrls,
        userId: req.currentUser.id,
      });

      // Auto-query Sage for credit notes — non-blocking on failure but the error is persisted
      // so the UI shows it instead of silently displaying zero credit notes.
      try {
        const creditNotes = await querySageCreditNotes(parsed.weekNumber);
        storeSageCreditNotes(reconId, creditNotes);
        db.prepare('UPDATE bat_reconciliations SET sage_error = NULL WHERE id = ?').run(reconId);
      } catch (sageErr) {
        console.error('[bat] Sage query failed:', sageErr.message);
        db.prepare('UPDATE bat_reconciliations SET sage_error = ? WHERE id = ?')
          .run(String(sageErr.message).slice(0, 500), reconId);
      }

      // Backfill amounts onto previous weeks' extractions that had no amount
      const backfilled = backfillOrderAmounts(parsed.orderAmounts);

      const reconciliation = getReconciliation(reconId);
      logAudit({
        req, action: 'bat_upload', resourceType: 'system',
        resourceId: reconId,
        resourceName: `Week ${parsed.weekNumber}/${year}`,
        details: `Filename: ${req.file.originalname}; PODs: ${parsed.podUrls?.length || 0}; backfilled: ${backfilled}`,
        changes: { fees: parsed.fees, week_number: parsed.weekNumber, year },
      });
      res.json({ ok: true, reconciliation, backfilled });
    } catch (err) {
      console.error('[bat] Upload failed:', err.message);
      logAudit({
        req, action: 'bat_upload', resourceType: 'system',
        resourceName: req.file?.originalname || 'unknown',
        details: err.message, status: 'failure',
      });
      res.status(500).json({ error: err.message || 'Failed to process spreadsheet' });
    } finally {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
  });

  router.get('/api/bat/sage-credit-notes', ...gate, async (req, res) => {
    const week = parseInt(req.query.week, 10);
    if (!week || week < 1 || week > 53) {
      return res.status(400).json({ error: 'Valid week number required (1-53)' });
    }
    try {
      const creditNotes = await querySageCreditNotes(week);
      res.json({ week, count: creditNotes.length, creditNotes });
    } catch (err) {
      console.error('[bat] Sage credit notes query failed:', err.message);
      res.status(500).json({ error: 'Failed to query Sage 300: ' + err.message });
    }
  });

  router.get('/api/bat/sage-invoices', ...gate, async (req, res) => {
    try {
      const invoices = await querySagePostedInvoices();
      res.json({ count: invoices.length, invoices });
    } catch (err) {
      console.error('[bat] Sage invoices query failed:', err.message);
      res.status(500).json({ error: 'Failed to query Sage 300: ' + err.message });
    }
  });

  router.post('/api/bat/extract-invoices', ...gate, async (req, res) => {
    const { reconciliationId } = req.body;
    if (!reconciliationId) return res.status(400).json({ error: 'reconciliationId required' });

    const recon = getReconciliation(reconciliationId);
    if (!recon) return res.status(404).json({ error: 'Reconciliation not found' });

    try {
      const result = await runInvoiceExtraction(reconciliationId);
      logAudit({
        req, action: 'bat_extract_invoices', resourceType: 'system',
        resourceId: reconciliationId,
        resourceName: `Week ${recon.week_number}/${recon.year}`,
        details: result.message || `Triggered extraction for ${result.total || 0} invoice(s)`,
      });
      res.json(result);
    } catch (err) {
      console.error('[bat] Extraction trigger failed:', err.message);
      logAudit({
        req, action: 'bat_extract_invoices', resourceType: 'system',
        resourceId: reconciliationId,
        resourceName: `Week ${recon.week_number}/${recon.year}`,
        details: err.message, status: 'failure',
      });
      res.status(err.status || 500).json({ error: err.message, code: err.code });
    }
  });

  router.get('/api/bat/extraction-status/:id', ...gate, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const progress = getExtractionProgress(id);
    if (!progress) {
      const recon = getReconciliation(id);
      if (!recon) return res.status(404).json({ error: 'Reconciliation not found' });
      res.json({ running: false, ...recon.extractionStats });
    } else {
      res.json(progress);
    }
  });

  // SSE stream of extraction status — replaces 5 s polling. Frontend opens an
  // EventSource and falls back to the polling endpoint above on connection error.
  router.get('/api/bat/extraction-status-stream/:id', ...gate, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).end();
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const send = () => {
      const progress = getExtractionProgress(id);
      let payload;
      if (progress) {
        payload = progress;
      } else {
        const recon = getReconciliation(id);
        if (!recon) { res.write(`event: error\ndata: ${JSON.stringify({ error: 'Reconciliation not found' })}\n\n`); return; }
        payload = { running: false, ...recon.extractionStats };
      }
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // Initial snapshot, then push on every worker emit.
    send();
    const onUpdate = () => send();
    extractionEvents.on(`update:${id}`, onUpdate);

    // Heartbeat every 25 s so proxies / load balancers don't kill the connection.
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      extractionEvents.off(`update:${id}`, onUpdate);
    });
  });

  router.post('/api/bat/retry-extraction', ...gate, (req, res) => {
    const { reconciliationId } = req.body;
    if (!reconciliationId) return res.status(400).json({ error: 'reconciliationId required' });
    const recon = getReconciliation(reconciliationId);
    if (!recon) return res.status(404).json({ error: 'Reconciliation not found' });
    const result = retryNotFound(reconciliationId);
    res.json(result);
  });

  router.patch('/api/bat/extraction/:id', ...gate, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { invoiceNumber } = req.body;
    if (!invoiceNumber) return res.status(400).json({ error: 'invoiceNumber required' });
    try {
      const reconId = manualSetInvoice(id, invoiceNumber.trim().toUpperCase());
      const recon = getReconciliation(reconId);
      res.json({ ok: true, reconciliation: recon });
    } catch (err) {
      console.error('[bat] Manual invoice set failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/bat/reconciliation/:id', ...gate, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const recon = getReconciliation(id);
    if (!recon) return res.status(404).json({ error: 'Reconciliation not found' });
    res.json(recon);
  });

  router.get('/api/bat/reconciliations', ...gate, (req, res) => {
    const t0 = Date.now();
    const reconciliations = listReconciliations();
    console.log(`[bat-perf] /api/bat/reconciliations: ${Date.now() - t0}ms (${reconciliations.length} rows)`);
    res.json({ count: reconciliations.length, reconciliations });
  });

  router.get('/api/bat/dashboard', ...gate, (req, res) => {
    const t0 = Date.now();
    const data = getDashboardData();
    console.log(`[bat-perf] /api/bat/dashboard: ${Date.now() - t0}ms`);
    res.json(data);
  });

  router.get('/api/bat/week-status', ...gate, async (req, res) => {
    const __t0 = Date.now();
    res.on('finish', () => console.log(`[bat-perf] /api/bat/week-status: ${Date.now() - __t0}ms`));
    // Current ISO 8601 calendar week. Naive dayOfYear/7 is wrong: it rolls over
    // on dayOfYear multiples of 7, regardless of which weekday Jan 1 fell on.
    // ISO weeks run Mon–Sun, and W1 is the week containing the first Thursday.
    const now = new Date();
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const dayNum = d.getUTCDay() || 7; // Sun = 0 → 7
    d.setUTCDate(d.getUTCDate() + 4 - dayNum); // shift to that week's Thursday
    const isoYear = d.getUTCFullYear(); // ISO year of the current week (≠ calendar year on Jan 1–3 / Dec 29–31 in some years)
    const yearStart = new Date(Date.UTC(isoYear, 0, 1));
    const currentWeek = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);

    // Read Sage week totals from the LOCAL CACHE (refreshed by the scheduler /
    // manual button). Dashboard never blocks on a live Sage query.
    const sageWeekTotals = getCachedSageWeekTotals();
    const cacheMeta = getSageCacheMeta();
    const sageError = cacheMeta.last_status === 'error' ? cacheMeta.last_error : null;
    let lastWeekPaid = null;
    let lastWeekPaidYear = null;
    if (sageWeekTotals.length > 0) {
      const latest = sageWeekTotals.slice().sort((a, b) =>
        a.year !== b.year ? b.year - a.year : b.week_number - a.week_number
      )[0];
      lastWeekPaid = latest.week_number;
      lastWeekPaidYear = latest.year;
    }

    const sagePaidWeeks = sageWeekTotals.map(w => w.week_number);
    // Missing weeks are scoped to the CURRENT ISO YEAR only, and only up to
    // currentWeek - 2 (a 2-week buffer for Sage processing lag). ISO year — not
    // calendar year — so e.g. Jan 1 2027 (a Friday) correctly belongs to W53/2026.
    const currentYear = isoYear;
    const paidThisYear = new Set(sageWeekTotals.filter(w => w.year === currentYear).map(w => w.week_number));
    const missingCutoff = Math.max(0, currentWeek - 2);
    const missingWeeks = [];
    for (let w = 1; w <= missingCutoff; w++) {
      if (!paidThisYear.has(w)) missingWeeks.push(w);
    }

    // Supplier per-week totals (from already-uploaded reconciliations)
    const supplierRows = db.prepare(`
      SELECT year, week_number, supplier_delivery, supplier_discount, supplier_pricing
      FROM bat_reconciliations
    `).all();

    // Merge into one comparison list keyed by (year, week_number)
    const merged = new Map();
    const keyOf = (y, w) => `${y}/${w}`;
    for (const s of supplierRows) {
      merged.set(keyOf(s.year, s.week_number), {
        year: s.year,
        week_number: s.week_number,
        supplier_delivery: s.supplier_delivery || 0,
        supplier_discount: s.supplier_discount || 0,
        supplier_pricing:  s.supplier_pricing  || 0,
        sage_delivery: 0, sage_discount: 0, sage_pricing: 0, sage_total: 0, batch_count: 0,
        sage_present: false,
      });
    }
    for (const t of sageWeekTotals) {
      const k = keyOf(t.year, t.week_number);
      const row = merged.get(k) || {
        year: t.year, week_number: t.week_number,
        supplier_delivery: 0, supplier_discount: 0, supplier_pricing: 0,
      };
      row.sage_delivery = t.delivery;
      row.sage_discount = t.discount;
      row.sage_pricing  = t.pricing;
      row.sage_total    = t.total;
      row.batch_count   = t.batch_count;
      row.sage_present  = true;
      merged.set(k, row);
    }
    const weekComparison = [...merged.values()].sort((a, b) =>
      a.year !== b.year ? a.year - b.year : a.week_number - b.week_number
    );

    res.json({
      currentWeek, lastWeekPaid, lastWeekPaidYear,
      sagePaidWeeks, sageWeekTotals, weekComparison, missingWeeks, sageError,
      cacheRefreshedAt: cacheMeta.last_refreshed_at || null,
      cacheChangeSummary: cacheMeta.last_change_summary ? JSON.parse(cacheMeta.last_change_summary) : null,
    });
  });

  // POST /api/bat/refresh-sage-cache — manual instant refresh used by the UI button
  router.post('/api/bat/refresh-sage-cache', ...gate, async (req, res) => {
    const result = await refreshSageWeekTotalsCache();
    res.json(result);
  });

  // OCR pause/resume — Settings → Reconciliation toggle
  router.get('/api/bat/ocr-status', ...gate, (req, res) => {
    const pendingRow = db.prepare(
      "SELECT COUNT(*) AS c FROM bat_invoice_extractions WHERE extraction_status = 'pending'"
    ).get();
    res.json({ paused: isOcrPaused(), pending: pendingRow?.c || 0 });
  });

  router.post('/api/bat/ocr-pause', ...gate, (req, res) => {
    const paused = !!req.body?.paused;
    const wasPaused = isOcrPaused();
    setOcrPaused(paused);
    let resumed = false;
    if (!paused) {
      // Kick off the worker for any leftover pending extractions
      try { resumeExtractionWorker(); resumed = true; } catch {}
    }
    if (wasPaused !== paused) {
      logAudit({
        req, action: paused ? 'ocr_pause' : 'ocr_resume', resourceType: 'system',
        resourceName: 'OCR worker',
        details: paused ? 'OCR worker paused' : `OCR worker resumed${resumed ? ' (worker started)' : ''}`,
      });
    }
    res.json({ paused: isOcrPaused(), resumed });
  });

  router.post('/api/bat/reconciliation/:id/refresh-sage', ...gate, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const recon = getReconciliation(id);
    if (!recon) return res.status(404).json({ error: 'Reconciliation not found' });
    try {
      const creditNotes = await querySageCreditNotes(recon.week_number);
      db.prepare('DELETE FROM bat_sage_credit_notes WHERE reconciliation_id = ?').run(id);
      storeSageCreditNotes(id, creditNotes);
      db.prepare('UPDATE bat_reconciliations SET sage_error = NULL WHERE id = ?').run(id);
      const updated = getReconciliation(id);
      res.json({ ok: true, reconciliation: updated });
    } catch (err) {
      console.error('[bat] Sage refresh failed:', err.message);
      db.prepare('UPDATE bat_reconciliations SET sage_error = ? WHERE id = ?')
        .run(String(err.message).slice(0, 500), id);
      res.status(500).json({ error: 'Failed to refresh Sage data: ' + err.message });
    }
  });

  // POST /api/bat/cardoso-invoices/generate — pull Cardoso invoices straight from Sage
  // Replaces the Crystal Report → Excel macro → upload pipeline.
  router.post('/api/bat/cardoso-invoices/generate', ...gate, async (req, res) => {
    const { fromDate, toDate, mode, tg1Rate, tg2Rate } = req.body || {};
    if (!fromDate || !toDate) {
      return res.status(400).json({ error: 'fromDate and toDate required (YYYY-MM-DD)' });
    }
    try {
      const result = await generateCardosoInvoicesFromSage({ fromDate, toDate, mode, tg1Rate, tg2Rate });
      res.json(result);
    } catch (err) {
      console.error('[bat] Cardoso generate failed:', err.message);
      res.status(500).json({ error: err.message || 'Generation failed' });
    }
  });

  // POST /api/bat/cardoso-invoices/cancel-generate — abort the in-flight generation
  router.post('/api/bat/cardoso-invoices/cancel-generate', ...gate, (req, res) => {
    res.json(cancelCardosoInvoiceGeneration());
  });

  router.get('/api/bat/cardoso-invoices/generate-status', ...gate, (req, res) => {
    res.json(getCardosoGenerateStatus());
  });

  // POST /api/bat/cardoso-invoices/replicate-supplier
  // Destructive-ish: re-auths via the current admin's password before running,
  // even though session is already valid. For every cardoso row that hasn't
  // been overwritten yet, copy the matching supplier extraction's
  // pricing/discount onto it (del_fee preserved). Idempotent.
  router.post('/api/bat/cardoso-invoices/replicate-supplier', ...gate, async (req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Admin password required' });
    try {
      const me = db.prepare('SELECT password_hash FROM "user" WHERE id = ?').get(req.currentUser.id);
      const ok = me?.password_hash ? await bcrypt.compare(password, me.password_hash) : false;
      if (!ok) return res.status(401).json({ error: 'Incorrect password' });

      const result = replicateSupplierIntoCardoso();
      // Auto-rerun the match so the dashboard reflects the new values
      let matching = null;
      try { matching = matchCardosoToSupplier(null); } catch {}
      res.json({ ...result, matching: matching ? matching.stats : null });
    } catch (err) {
      console.error('[bat] Replicate supplier failed:', err.message);
      res.status(500).json({ error: err.message || 'Replicate failed' });
    }
  });

  router.get('/api/bat/cardoso-invoices/overwrite-stats', ...gate, (req, res) => {
    try {
      const total = db.prepare('SELECT COUNT(*) c FROM bat_cardoso_invoices').get().c;
      const overwritten = db.prepare("SELECT COUNT(*) c FROM bat_cardoso_invoices WHERE c_overwritten = 1").get().c;
      res.json({ total, overwritten, remaining: total - overwritten });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Cardoso Invoice Upload & Matching (global — across all weeks) ──
  router.post('/api/bat/cardoso-upload', ...gate, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    try {
      const duplicateMode = req.body.duplicateMode || 'skip'; // 'skip' or 'overwrite'
      const invoices = parseCardosoSpreadsheet(req.file.path);
      const storeResult = storeCardosoInvoices(null, invoices, req.file.originalname, duplicateMode);
      const matchResult = matchCardosoToSupplier(null);
      res.json({ ok: true, cardosoCount: invoices.length, ...storeResult, matching: matchResult });
    } catch (err) {
      console.error('[bat] Cardoso upload failed:', err.message);
      res.status(500).json({ error: err.message });
    } finally {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
  });

  router.get('/api/bat/cardoso-match', ...gate, (req, res) => {
    const cardosoInvoices = getCardosoInvoices(null);
    if (cardosoInvoices.length === 0) return res.json({ matching: null, cardosoCount: 0 });
    const matchResult = matchCardosoToSupplier(null);
    res.json({ matching: matchResult, cardosoCount: cardosoInvoices.length });
  });

  // ── BAT Settings (API keys etc.) ──
  // Module-level cache: avoid hitting DB on every poll. 30s TTL; PUT invalidates.
  const _batSettingsCache = new Map(); // key 'all' -> { value, expiresAt }
  const BAT_SETTINGS_TTL_MS = 30_000;

  router.get('/api/bat/settings', ...gate, (req, res) => {
    const now = Date.now();
    const cached = _batSettingsCache.get('all');
    if (cached && cached.expiresAt > now) {
      return res.json(cached.value);
    }
    const rows = db.prepare('SELECT key, value FROM bat_settings').all();
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    _batSettingsCache.set('all', { value: settings, expiresAt: now + BAT_SETTINGS_TTL_MS });
    res.json(settings);
  });

  router.put('/api/bat/settings', ...gate, (req, res) => {
    const before = Object.fromEntries(
      db.prepare('SELECT key, value FROM bat_settings WHERE key IN (' + Object.keys(req.body || {}).map(() => '?').join(',') + ')')
        .all(...Object.keys(req.body || {})).map(r => [r.key, r.value])
    );
    const upsert = db.prepare('INSERT INTO bat_settings (key, value, updated_at) VALUES (?, ?, datetime(\'now\')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');
    const tx = db.transaction((entries) => {
      for (const [k, v] of entries) upsert.run(k, v);
    });
    tx(Object.entries(req.body));
    // Invalidate cache so next GET sees fresh values
    _batSettingsCache.clear();
    // If the Sage connection pick changed, drop the cached pool so it reopens with new config
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'sage_connection_id')) {
      resetSagePool().catch(() => {});
    }
    // Redact API keys before auditing, and only audit keys that ACTUALLY changed.
    const redact = (k, v) => /key|secret|token|password/i.test(k) ? '[redacted]' : v;
    const realBefore = {};
    const realAfter  = {};
    for (const k of Object.keys(req.body || {})) {
      if (String(before[k] ?? '') !== String((req.body || {})[k] ?? '')) {
        realBefore[k] = redact(k, before[k]);
        realAfter[k]  = redact(k, (req.body || {})[k]);
      }
    }
    if (Object.keys(realAfter).length > 0) {
      logAudit({
        req, action: 'update_bat_settings', resourceType: 'system',
        resourceName: 'BAT reconciliation settings',
        // Auto-summarised in details — e.g. "Sage Connection Id: 1 → 2; Tg1 Rate: 0.0009 → 0.001"
        changes: { before: realBefore, after: realAfter },
      });
    }
    res.json({ ok: true });
  });

  // GET /api/bat/sage-connection — reports which Sage connection is currently active
  router.get('/api/bat/sage-connection', ...gate, (req, res) => {
    const settingRow = db.prepare(`SELECT value FROM bat_settings WHERE key = 'sage_connection_id'`).get();
    const pickedId = settingRow?.value ? parseInt(settingRow.value, 10) : null;
    let conn = null;
    if (pickedId) conn = db.prepare(`SELECT id, name, host, database_name, status FROM databaseconnection WHERE id = ?`).get(pickedId);
    if (!conn) conn = db.prepare(`SELECT id, name, host, database_name, status FROM databaseconnection WHERE status = 'active' AND LOWER(name) LIKE '%sage%' ORDER BY id LIMIT 1`).get();
    const candidates = db.prepare(`SELECT id, name, host, database_name, status FROM databaseconnection ORDER BY id`).all();
    res.json({ active: conn || null, picked_setting: pickedId, candidates });
  });

  return router;
}
