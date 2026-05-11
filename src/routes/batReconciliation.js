/**
 * BAT Supplier Reconciliation routes.
 *
 * Gated by `can_access_reconciliation`. Admins always pass (requirePermission
 * short-circuits on role==='admin'); non-admins need the toggle on in their
 * User Permissions row. The matching UI toggle lives in UserPermissionsModal.
 */
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import db from '../db/index.js';
import { logAudit } from '../lib/audit.js';
import { isoYear as toIsoYear, currentIsoWeek } from '../lib/isoWeek.js';
import { parseSupplierSpreadsheet, parseCardosoSpreadsheet, SpreadsheetValidationError } from '../services/bat/parser.js';
import {
  querySageCreditNotes,
  querySagePaidWeeks,
  querySageWeekTotals,
  createReconciliation,
  storeSageCreditNotes,
  replaceSageCreditNotes,
  backfillOrderAmounts,
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
  resetUnsuccessfulExtractions,
  countUnsuccessfulExtractions,
  resetSagePool,
  getCachedSageWeekTotals,
  getLastPaidSageWeek,
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
  getSageHealth,
  getOcrSnapshot,
  getOcrCounters,
  getRecentBatReconciliations,
  clearOcrHalt,
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

export function createBatReconciliationRouter({ requireAuth, requireAdmin, requirePermission }) {
  const router = Router();

  // Default gate: any user with can_access_reconciliation. Admins pass
  // unconditionally. A handful of admin-only endpoints below (settings
  // mutation, OCR pause, Sage refresh, etc.) layer requireAdmin on top.
  const gate = [requireAuth, requirePermission('can_access_reconciliation')];

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
      // parseSupplierSpreadsheet now throws SpreadsheetValidationError with
      // a list of human-readable reasons when the file is structurally
      // unusable (missing sheets, no ODR rows, no PODs, unparseable filename
      // week, etc.). We catch and 400 it back so NOTHING gets persisted —
      // the operator gets the full list in a modal and can fix + retry.
      // Previously bad spreadsheets would sometimes create an empty recon
      // with zero PODs that polluted the dashboard.
      const parsed = parseSupplierSpreadsheet(req.file.path, req.file.originalname);

      // Year fallback chain: parser-detected → request body → ISO year of
      // current date. ISO year (not calendar year) so a late-Dec upload
      // for a W1 file doesn't get filed under the previous year.
      const year = parsed.year || parseInt(req.body.year, 10) || toIsoYear(new Date());
      if (parsed.year) console.log(`[bat] Year detected from spreadsheet: ${parsed.year}`);
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
      // Use replaceSageCreditNotes for atomicity even though there's
      // nothing to delete on a freshly-created recon (the DELETE is a
      // cheap no-op). One helper across all three call sites prevents
      // drift if the refresh shape changes again.
      try {
        const creditNotes = await querySageCreditNotes(parsed.weekNumber, year);
        replaceSageCreditNotes(reconId, creditNotes);
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
      // Validation failures (documented spreadsheet defects) → 400 with
      // the structured list so the UI can render each reason as a
      // separate bullet. Anything else is a server-side bug → 500.
      if (err instanceof SpreadsheetValidationError) {
        return res.status(400).json({
          error: 'Spreadsheet rejected',
          reasons: err.reasons,
          fileName: err.fileName,
        });
      }
      res.status(500).json({ error: err.message || 'Failed to process spreadsheet' });
    } finally {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
  });

  router.get('/api/bat/sage-credit-notes', ...gate, async (req, res) => {
    const week = parseInt(req.query.week, 10);
    // Fallback to ISO year so Dec 29-31 queries default to the correct
    // year for the W1 they're inside, not the calendar year they're in.
    const year = parseInt(req.query.year, 10) || toIsoYear(new Date());
    if (!week || week < 1 || week > 53) {
      return res.status(400).json({ error: 'Valid week number required (1-53)' });
    }
    try {
      const creditNotes = await querySageCreditNotes(week, year);
      res.json({ week, year, count: creditNotes.length, creditNotes });
    } catch (err) {
      console.error('[bat] Sage credit notes query failed:', err.message);
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

    // SSE only ships the cheap progress payload — never the full
    // recon. The previous version fell through to getReconciliation()
    // (a 4-query + O(n) two-pass build) on every emit when no
    // worker progress was active, then JSON-stringified the entire
    // recon (creditNotes + every extraction row + computed stats) to
    // every connected listener. With 4 listeners × ~4 emits/sec/recon
    // that was ~16 full-recon hydrations/sec at 200+-row recons, all
    // synchronously on the main thread. Operators saw it as the page
    // hanging during OCR and JPEG previews stalling behind it.
    //
    // The frontend already polls /api/bat/reconciliation/:id (the
    // dedicated GET handler) on its own cadence for the heavy payload.
    // Keep SSE laser-focused on what only it can do: push the live
    // worker progress.
    const send = () => {
      const progress = getExtractionProgress(id);
      // Worker isn't running and there's no progress to ship — emit
      // a minimal "running: false" so the client knows to stop
      // polling SSE for this recon. Cheap COUNT-only query, no
      // recon hydration.
      const payload = progress ?? { running: false };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // Cap concurrent SSE listeners per recon. Without this, every browser tab
    // opened against the same recon — including zombie connections that
    // didn't fire `req.on('close')` cleanly on tab teardown — adds another
    // listener that the worker has to fan out to on every progress emit.
    // After enough sessions the main thread spent so much time running the
    // per-listener send() (which does sync SQLite reads + a response write)
    // that other requests stalled hard enough to hit Chrome's 6-per-origin
    // connection limit. We close the OLDEST listener so the operator's
    // current tab always wins; the closed tab will fall back to its
    // adaptive-polling loop transparently.
    const SSE_MAX_PER_RECON = 4;
    const channel = `update:${id}`;
    if (extractionEvents.listenerCount(channel) >= SSE_MAX_PER_RECON) {
      const oldest = extractionEvents.listeners(channel)[0];
      if (oldest) {
        extractionEvents.off(channel, oldest);
        try { oldest.__sseRes?.end(); } catch {}
      }
    }

    // Initial snapshot, then push on every worker emit.
    send();
    const onUpdate = () => send();
    onUpdate.__sseRes = res; // eviction hook above uses this to end the response
    extractionEvents.on(channel, onUpdate);

    // Heartbeat every 25 s so proxies / load balancers don't kill the connection.
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25_000);

    // Belt-and-suspenders cap. `req.on('close')` fires on a normal TCP teardown,
    // but a half-open connection (NAT silently dropping state, laptop suspended,
    // etc.) can leave the heartbeat firing indefinitely against a dead socket.
    // Cap at 30 minutes so the worst-case leak is bounded — the client will
    // reconnect on next page interaction.
    const hardCap = setTimeout(() => {
      clearInterval(heartbeat);
      extractionEvents.off(channel, onUpdate);
      try { res.end(); } catch {}
    }, 30 * 60 * 1000);

    req.on('close', () => {
      clearTimeout(hardCap);
      clearInterval(heartbeat);
      extractionEvents.off(channel, onUpdate);
    });
  });

  router.post('/api/bat/retry-extraction', ...gate, (req, res) => {
    const { reconciliationId } = req.body;
    if (!reconciliationId) return res.status(400).json({ error: 'reconciliationId required' });
    const recon = getReconciliation(reconciliationId);
    if (!recon) return res.status(404).json({ error: 'Reconciliation not found' });
    const result = retryNotFound(reconciliationId);
    logAudit({
      req, action: 'bat_retry_extraction', resourceType: 'system',
      resourceId: reconciliationId,
      resourceName: `Week ${recon.week_number}/${recon.year}`,
      details: result?.message || `Re-running OCR with Google Vision on ${result?.requeued ?? 0} not-found extraction(s)`,
    });
    res.json(result);
  });

  router.patch('/api/bat/extraction/:id', ...gate, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { invoiceNumber } = req.body;
    if (!invoiceNumber) return res.status(400).json({ error: 'invoiceNumber required' });
    // Snapshot the previous OCR result so the audit row shows what the
    // human override changed. Aliased to invoice_number so the audit
    // payload below reads naturally; the schema column is extracted_invoice.
    let previous = null;
    try {
      previous = db.prepare(`
        SELECT id, extracted_invoice AS invoice_number, store_name, extraction_status, reconciliation_id
        FROM bat_invoice_extractions WHERE id = ?
      `).get(id);
    } catch { /* fall through; previous stays null and we still try the override */ }
    if (!previous) return res.status(404).json({ error: 'Extraction not found' });
    try {
      const reconId = manualSetInvoice(id, invoiceNumber.trim().toUpperCase());
      const recon = getReconciliation(reconId);
      logAudit({
        req, action: 'bat_manual_invoice_override', resourceType: 'system',
        resourceId: id,
        resourceName: previous?.store_name || `Extraction ${id}`,
        details: `Week ${recon?.week_number}/${recon?.year}: invoice "${previous?.invoice_number ?? '∅'}" → "${invoiceNumber.trim().toUpperCase()}" (was ${previous?.extraction_status || 'unknown'})`,
        changes: {
          before: { invoice_number: previous?.invoice_number, status: previous?.extraction_status },
          after:  { invoice_number: invoiceNumber.trim().toUpperCase(), status: 'manual' },
        },
      });
      res.json({ ok: true, reconciliation: recon });
    } catch (err) {
      console.error('[bat] Manual invoice set failed:', err.message);
      logAudit({
        req, action: 'bat_manual_invoice_override', resourceType: 'system',
        resourceId: id,
        resourceName: previous?.store_name || `Extraction ${id}`,
        details: err.message, status: 'failure',
      });
      res.status(500).json({ error: err.message });
    }
  });

  // Per-recon last-refresh timestamps for the auto Sage pull below. Throttles
  // re-pulls so the adaptive polling loop (5–15s tick during OCR) doesn't
  // fire a Sage round-trip on every tick. Cleared on process restart, which
  // is the cheap retry mechanism.
  const lastCreditNotesPullAt = new Map(); // reconId -> ms timestamp
  const CREDIT_NOTES_PULL_THROTTLE_MS = 60_000;
  // De-dupes concurrent Sage auto-pulls for the same recon. Without this, a
  // polling tick that overlaps with a fresh loadReconciliation (or the user
  // hammering refresh) fired N parallel querySageCreditNotes calls — each one
  // hitting the MSSQL pool, each one tying up an Express request slot for
  // 1–5s. With clicks-across-recons triggering individual Sage queries
  // anyway this isn't a full fix for "rapid clicks hang the UI" (different
  // recons still hit Sage independently), but it eliminates the same-recon
  // pile-up that was the most reliable repro.
  const inFlightCreditNotes = new Map(); // reconId -> Promise<creditNotes|null>

  router.get('/api/bat/reconciliation/:id', ...gate, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    let recon = getReconciliation(id);
    if (!recon) return res.status(404).json({ error: 'Reconciliation not found' });

    // Auto-refresh per-recon Sage credit-note detail when the recon screen
    // is opened. Throttled per-recon (60s) and de-duped across overlapping
    // requests for the same recon.
    const now = Date.now();
    const lastPull = lastCreditNotesPullAt.get(id) || 0;
    const empty = !recon.creditNotes || recon.creditNotes.length === 0;
    const hasSageData = (recon.sage_total || 0) > 0;
    if (hasSageData && (empty || now - lastPull >= CREDIT_NOTES_PULL_THROTTLE_MS)) {
      let pending = inFlightCreditNotes.get(id);
      if (!pending) {
        lastCreditNotesPullAt.set(id, now);
        pending = (async () => {
          try {
            return await querySageCreditNotes(recon.week_number, recon.year);
          } catch (err) {
            console.error(`[bat] Auto credit-note pull failed for recon ${id}:`, err.message);
            return null;
          }
        })().finally(() => inFlightCreditNotes.delete(id));
        inFlightCreditNotes.set(id, pending);
      }
      const creditNotes = await pending;
      if (creditNotes) {
        // Atomic refresh — DELETE + insert + sage_error clear in one
        // transaction so a concurrent reader can't observe the
        // half-applied state (empty credit notes + stale totals).
        // See replaceSageCreditNotes in the service for why.
        replaceSageCreditNotes(id, creditNotes);
        recon = getReconciliation(id);
      }
    }

    res.json(recon);
  });

  // Clear the per-recon last_error AND reset status away from 'error'.
  // Used by the toast "Dismiss" button so an operator can acknowledge a
  // stale error after manual investigation (e.g. they ran a fresh
  // extraction outside the standard workflow).
  //
  // Two columns drive the operator-visible "error" badge:
  //   - last_error / last_error_at — written by recordReconciliationError
  //   - status                     — set to 'error' when an OCR run ends
  //                                  with rows still pending or auto-halts
  //
  // The original endpoint only cleared last_error/last_error_at, leaving
  // status='error' in place — operator clicked Dismiss in the toast, the
  // toast went away, but the badge in the recon picker / OCR Operations
  // recents stayed red because the badge reads from status. Operator
  // (correctly) reported "dismiss didn't work". Now we also flip status
  // back into a meaningful state:
  //   - 'completed' if every extraction is no longer 'pending'
  //   - 'pending'   if any extractions are still pending (operator will
  //                 normally re-trigger Extract after dismissing)
  //
  // Historical error entries in error_log / System Log are untouched —
  // the audit trail is preserved indefinitely; this just clears the
  // current-state signal.
  router.post('/api/bat/reconciliation/:id/dismiss-error', ...gate, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    try {
      const pendingRow = db.prepare(
        "SELECT COUNT(*) AS n FROM bat_invoice_extractions WHERE reconciliation_id = ? AND extraction_status = 'pending'"
      ).get(id);
      const newStatus = (pendingRow?.n || 0) > 0 ? 'pending' : 'completed';
      const info = db.prepare(
        "UPDATE bat_reconciliations SET last_error = NULL, last_error_at = NULL, status = ? WHERE id = ?"
      ).run(newStatus, id);
      logAudit({
        req, action: 'bat_dismiss_recon_error', resourceType: 'system',
        resourceId: id, resourceName: `Reconciliation ${id}`,
        details: info.changes
          ? `Cleared last_error and set status='${newStatus}' (${pendingRow?.n || 0} extractions still pending)`
          : 'Reconciliation not found or already clear',
      });
      res.json({ ok: true, cleared: info.changes, status: newStatus, pending: pendingRow?.n || 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/bat/reconciliations', ...gate, (req, res) => {
    const t0 = Date.now();
    const reconciliations = listReconciliations();
    console.log(`[bat-perf] /api/bat/reconciliations: ${Date.now() - t0}ms (${reconciliations.length} rows)`);
    res.json({ count: reconciliations.length, reconciliations });
  });

  router.get('/api/bat/dashboard', ...gate, (req, res) => {
    const t0 = Date.now();
    // year=YYYY filters every aggregate (BAT total, Sage total, PODs,
    // matched, exceptions). year=all (or omitted) returns all-time numbers.
    const data = getDashboardData(req.query.year);
    console.log(`[bat-perf] /api/bat/dashboard year=${req.query.year || 'all'}: ${Date.now() - t0}ms`);
    res.json(data);
  });

  router.get('/api/bat/week-status', ...gate, async (req, res) => {
    const __t0 = Date.now();
    res.on('finish', () => console.log(`[bat-perf] /api/bat/week-status: ${Date.now() - __t0}ms`));
    // Current ISO 8601 week — routed through src/lib/isoWeek.js so this
    // endpoint and the Hub/site UI's "current week" tile always agree.
    // Calendar year and ISO year disagree on Dec 29-31 of years where
    // Jan 1 is Mon-Wed (e.g. Dec 31 2025 is W1 of ISO year 2026).
    const { year: isoYear, week: currentWeek } = currentIsoWeek();

    // Read Sage week totals from the LOCAL CACHE (refreshed by the scheduler /
    // manual button). Dashboard never blocks on a live Sage query.
    const sageWeekTotals = getCachedSageWeekTotals();
    const cacheMeta = getSageCacheMeta();
    const sageError = cacheMeta.last_status === 'error' ? cacheMeta.last_error : null;
    // SHARED helper — same source the hub-export endpoint uses, so the
    // site's own UI tile and the hub's per-site tile cannot diverge for
    // this value. See getLastPaidSageWeek's docstring for why this exists
    // as a helper instead of being inlined as a SELECT here.
    const lastPaid = getLastPaidSageWeek();
    const lastWeekPaid = lastPaid?.week_number ?? null;
    const lastWeekPaidYear = lastPaid?.year ?? null;

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
    try {
      const result = await refreshSageWeekTotalsCache();
      res.json(result);
    } catch (err) {
      // Express 5 would auto-propagate this to the global error handler,
      // but keeping an explicit local catch returns a more useful message
      // to the operator and avoids the generic 500 path.
      console.error('[bat] refresh-sage-cache failed:', err.message);
      res.status(500).json({ error: err.message || 'Sage cache refresh failed' });
    }
  });

  // GET /api/bat/sage-health — Sage MSSQL connectivity status. Polled by
  // the admin layout every 60s to drive the "Sage unreachable" banner.
  // Open to all permission holders; reading the banner is fine for any
  // BAT user, but the data is non-sensitive (just connectivity state).
  router.get('/api/bat/sage-health', ...gate, (req, res) => {
    res.json(getSageHealth());
  });

  // OCR pause/resume — Settings → Reconciliation toggle
  router.get('/api/bat/ocr-status', ...gate, (req, res) => {
    const pendingRow = db.prepare(
      "SELECT COUNT(*) AS c FROM bat_invoice_extractions WHERE extraction_status = 'pending'"
    ).get();
    res.json({ paused: isOcrPaused(), pending: pendingRow?.c || 0 });
  });

  // Counts how many extractions across ALL reconciliations are not_found / failed
  // — drives the confirmation message before re-queueing.
  router.get('/api/bat/reset-pending-count', ...gate, (req, res) => {
    res.json({ count: countUnsuccessfulExtractions() });
  });

  // Flips every not_found / failed extraction back to 'pending'. Successful
  // ('found') rows are left alone so we don't redo OCR work that already
  // matched. After this call the OCR worker (when next started or resumed)
  // will re-process the re-queued rows.
  router.post('/api/bat/reset-pending', ...gate, (req, res) => {
    try {
      const result = resetUnsuccessfulExtractions();
      logAudit({
        req, action: 'bat_reset_pending', resourceType: 'system',
        resourceName: 'OCR retry queue',
        details: `Reset ${result.reset} not_found/failed extraction(s) back to pending`,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Admin-only: global toggle that affects every operator using the module.
  router.post('/api/bat/ocr-pause', ...gate, requireAdmin, (req, res) => {
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

  // ── Operations OCR tab — admin-only fleet-wide OCR introspection ─────────
  // Snapshot, counters, recent-runs, clear-halt. Distinct from the BAT page
  // routes (which are scoped per-reconciliation). Polled by OcrPanel.jsx
  // every ~2s — keep them cheap (single-table SELECTs, no joins to large
  // tables, no expensive aggregations beyond what the schema indexes back).

  router.get('/api/bat/ocr-snapshot', ...gate, requireAdmin, (req, res) => {
    try {
      res.json(getOcrSnapshot());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/bat/ocr-counters', ...gate, requireAdmin, (req, res) => {
    const windowHours = parseInt(req.query.window, 10) || 1;
    try {
      res.json(getOcrCounters({ windowHours }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/api/bat/ocr-recent-runs', ...gate, requireAdmin, (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 20;
    try {
      res.json({ rows: getRecentBatReconciliations(limit) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Operator action: clear the regex auto-halt + resume worker. Audited so
  // the chain "halt fired → operator inspected text_preview → cleared and
  // resumed" stays reconstructable from System Log + Audit Log.
  router.post('/api/bat/ocr-clear-halt', ...gate, requireAdmin, (req, res) => {
    const reconId = parseInt(req.body?.reconciliation_id, 10) || null;
    try {
      const result = clearOcrHalt({ reconId });
      logAudit({
        req,
        action: 'ocr_clear_halt',
        resourceType: 'system',
        resourceName: 'OCR halt',
        details: `Cleared regex auto-halt${reconId ? ` for recon ${reconId}` : ''}${result.resumed ? ' (worker resumed)' : ''}`,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/bat/reconciliation/:id/refresh-sage', ...gate, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const recon = getReconciliation(id);
    if (!recon) return res.status(404).json({ error: 'Reconciliation not found' });
    try {
      const creditNotes = await querySageCreditNotes(recon.week_number, recon.year);
      // Atomic refresh — see replaceSageCreditNotes. Replaces three
      // separate statements (DELETE, insert-via-storeSageCreditNotes,
      // sage_error clear) with one transaction. If anything inside
      // throws, the recon stays at its pre-refresh state instead of
      // dropping to empty-credit-notes-with-stale-totals.
      replaceSageCreditNotes(id, creditNotes);
      const updated = getReconciliation(id);
      logAudit({
        req, action: 'bat_refresh_sage', resourceType: 'system',
        resourceId: id,
        resourceName: `Week ${recon.week_number}/${recon.year}`,
        details: `Re-pulled Sage credit notes for week ${recon.week_number}/${recon.year}: ${creditNotes.length} note(s)`,
      });
      res.json({ ok: true, reconciliation: updated });
    } catch (err) {
      console.error('[bat] Sage refresh failed:', err.message);
      db.prepare('UPDATE bat_reconciliations SET sage_error = ? WHERE id = ?')
        .run(String(err.message).slice(0, 500), id);
      logAudit({
        req, action: 'bat_refresh_sage', resourceType: 'system',
        resourceId: id,
        resourceName: `Week ${recon.week_number}/${recon.year}`,
        details: err.message, status: 'failure',
      });
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
      logAudit({
        req, action: 'bat_cardoso_generate', resourceType: 'system',
        resourceName: `Cardoso invoices ${fromDate} → ${toDate}`,
        details: `Generated ${result?.inserted ?? 0} invoice(s) from Sage; mode=${mode || 'default'}, TG1=${tg1Rate || '-'}, TG2=${tg2Rate || '-'}`,
        changes: { fromDate, toDate, mode, tg1Rate, tg2Rate, inserted: result?.inserted, skipped: result?.skipped },
      });
      res.json(result);
    } catch (err) {
      console.error('[bat] Cardoso generate failed:', err.message);
      logAudit({
        req, action: 'bat_cardoso_generate', resourceType: 'system',
        resourceName: `Cardoso invoices ${fromDate} → ${toDate}`,
        details: err.message, status: 'failure',
      });
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
      logAudit({
        req, action: 'bat_replicate_supplier', resourceType: 'system',
        resourceName: 'Cardoso invoices ↤ supplier extractions',
        details: `Replicated supplier values onto ${result?.updated ?? 0} Cardoso row(s); ${result?.skipped ?? 0} skipped (already overwritten); password-confirmed by ${req.currentUser.email}`,
        changes: result,
      });
      res.json({ ...result, matching: matching ? matching.stats : null });
    } catch (err) {
      console.error('[bat] Replicate supplier failed:', err.message);
      logAudit({
        req, action: 'bat_replicate_supplier', resourceType: 'system',
        resourceName: 'Cardoso invoices ↤ supplier extractions',
        details: err.message, status: 'failure',
      });
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
      logAudit({
        req, action: 'bat_cardoso_upload', resourceType: 'system',
        resourceName: req.file.originalname,
        details: `Uploaded ${invoices.length} Cardoso invoice(s); duplicateMode=${duplicateMode}; ${storeResult?.inserted ?? 0} inserted, ${storeResult?.updated ?? 0} updated, ${storeResult?.skipped ?? 0} skipped`,
        changes: { duplicateMode, total: invoices.length, ...storeResult },
      });
      res.json({ ok: true, cardosoCount: invoices.length, ...storeResult, matching: matchResult });
    } catch (err) {
      console.error('[bat] Cardoso upload failed:', err.message);
      logAudit({
        req, action: 'bat_cardoso_upload', resourceType: 'system',
        resourceName: req.file?.originalname || 'unknown',
        details: err.message, status: 'failure',
      });
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

  // Admin-only: global VAT %, TG rates, sage_connection_id, etc.
  router.put('/api/bat/settings', ...gate, requireAdmin, (req, res) => {
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
