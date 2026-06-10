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
import { checkReconciliationIntegrity } from '../services/bat/integrity.js';
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
  getReconciliationMeta,
  listReconciliations,
  runInvoiceExtraction,
  getExtractionProgress,
  getDashboardData,
  manualSetInvoice,
  retryNotFound,
  resetUnsuccessfulExtractions,
  countUnsuccessfulExtractions,
  resetAllExtractionsForRecon,
  resetUnsuccessfulExtractionsForRecon,
  resetDuplicateExtractionsForRecon,
  countExtractionsForRecon,
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
  markWeekZero,
  unmarkWeekZero,
} from '../services/batReconciliation.js';
import { processSupplierUpload } from '../services/bat/uploadProcessor.js';

const uploadsDir = path.join(process.cwd(), 'uploads', 'bat');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const UPLOAD_MAX_FILE_BYTES = 50 * 1024 * 1024;       // 50 MB / file
const UPLOAD_MAX_BATCH_FILES = 50;                    // per batch request
const UPLOAD_ALLOWED_EXTENSIONS = new Set(['.xlsx', '.xls']);

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: UPLOAD_MAX_FILE_BYTES, files: UPLOAD_MAX_BATCH_FILES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // Silent-skip via cb(null, false) instead of cb(new Error(...)).
    // Throwing in the filter aborts the WHOLE request (multer errors
    // out at the middleware layer, the route's per-file loop never
    // runs), which on a batch upload means one stray .pdf in a 50-
    // file backfill tanks the other 49. Silent-skip drops only the
    // offender; the route handler then notices req.files came back
    // empty (or missing the wrong-extension file) and reports
    // accordingly. The single-file route below also handles the
    // resulting empty-file case with a clear message.
    if (UPLOAD_ALLOWED_EXTENSIONS.has(ext)) cb(null, true);
    else cb(null, false);
  },
});

// Wrap multer's middleware so failures it surfaces (LIMIT_FILE_SIZE,
// LIMIT_FILE_COUNT, generic upload errors) become a structured 400
// response rather than the default "next(err)" which propagates to
// the global error handler as an opaque 500. Without this wrapper,
// multer-level failures bypass the batch route's per-file try/catch
// and the operator gets a useless "Internal Server Error" toast for
// what's a recoverable input problem.
//
// The shape carries a top-level `error` so the existing client
// chunk-failure path (which already maps !r.ok responses to per-file
// error rows) renders the right thing in the batch modal. For the
// single-upload route, the same response is fine — the client there
// also uses the `error` field for its toast.
function uploadMiddlewareWithErrorCapture(multerHandler) {
  return (req, res, next) => {
    multerHandler(req, res, (err) => {
      if (!err) {
        next();
        return;
      }
      let message;
      if (err.code === 'LIMIT_FILE_SIZE') {
        message = `One or more files exceed the ${Math.round(UPLOAD_MAX_FILE_BYTES / 1024 / 1024)} MB upload limit`;
      } else if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        message = `Too many files in this batch (max ${UPLOAD_MAX_BATCH_FILES} per request)`;
      } else {
        message = err.message || 'Upload failed';
      }
      console.error(`[bat] upload middleware rejected request: ${err.code || 'no-code'} — ${message}`);
      res.status(400).json({ error: message, code: err.code || 'UPLOAD_ERROR' });
    });
  };
}

const uploadSingle = uploadMiddlewareWithErrorCapture(upload.single('file'));
const uploadBatch = uploadMiddlewareWithErrorCapture(upload.array('files', UPLOAD_MAX_BATCH_FILES));

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

  // Per-file processing flow shared with the batch endpoint, see
  // src/services/bat/uploadProcessor.js. The route handler stays
  // responsible for: auth, audit logging, multer file lifecycle
  // (unlinkSync), and HTTP response shaping.
  const processorDeps = {
    db,
    parseSupplierSpreadsheet,
    createReconciliation,
    querySageCreditNotes,
    replaceSageCreditNotes,
    backfillOrderAmounts,
    getReconciliation,
    toIsoYear,
  };

  // POST /api/bat/upload — Upload + parse a single supplier spreadsheet
  router.post('/api/bat/upload', ...gate, uploadSingle, async (req, res) => {
    if (!req.file) {
      // fileFilter silent-skips non-.xlsx/.xls (so batch uploads
      // don't tank on one wrong extension). For the single-upload
      // route, that means we get here with no req.file when the
      // uploaded file had the wrong extension — make the message
      // actionable rather than the generic "No file uploaded".
      return res.status(400).json({ error: 'No file uploaded — only .xlsx and .xls files are accepted' });
    }

    try {
      const result = await processSupplierUpload({
        file: req.file,
        fallbackYear: parseInt(req.body.year, 10) || null,
        userId: req.currentUser.id,
        ...processorDeps,
      });
      logAudit({
        req, action: 'bat_upload', resourceType: 'system',
        resourceId: result.reconciliation.id,
        resourceName: `Week ${result.weekNumber}/${result.year}`,
        details: `Filename: ${req.file.originalname}; PODs: ${result.podCount}; backfilled: ${result.backfilled}`,
        changes: { fees: result.fees, week_number: result.weekNumber, year: result.year },
      });
      res.json({ ok: true, reconciliation: result.reconciliation, backfilled: result.backfilled });
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
      try { fs.unlinkSync(req.file.path); } catch (e) { console.warn('[batReconciliation.upload_spreadsheet.cleanup]', { path: req.file.path }, e.message); }
    }
  });

  // POST /api/bat/upload-batch — Upload + parse N supplier spreadsheets
  // in one go. Each file becomes its own recon (different week_number);
  // per-file try/catch so one bad sheet doesn't tank the rest of the
  // batch. Designed for backfilling historical weeks (drop W5/6/7/8 in
  // a single drag).
  //
  // Response shape:
  //   {
  //     ok: true,
  //     results: [
  //       { filename, status: 'success',  reconciliation, weekNumber, year, backfilled },
  //       { filename, status: 'rejected', reasons: [...] },
  //       { filename, status: 'error',    error: '...' },
  //     ]
  //   }
  // Always 200 — the per-file status field carries pass/fail.
  router.post('/api/bat/upload-batch', ...gate, uploadBatch, async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) {
      // Either nothing was sent OR fileFilter silent-skipped every
      // entry as a non-.xlsx/.xls. Either way, nothing to process.
      return res.status(400).json({ error: 'No files uploaded — only .xlsx and .xls files are accepted' });
    }

    const fallbackYear = parseInt(req.body.year, 10) || null;
    const results = [];

    // Sequential — the SQLite write path serialises anyway, and
    // sequential keeps results ordered so the UI modal lists files
    // in upload order.
    for (const file of files) {
      try {
        const result = await processSupplierUpload({
          file,
          fallbackYear,
          userId: req.currentUser.id,
          ...processorDeps,
        });
        logAudit({
          req, action: 'bat_upload', resourceType: 'system',
          resourceId: result.reconciliation.id,
          resourceName: `Week ${result.weekNumber}/${result.year}`,
          details: `Batch upload — Filename: ${file.originalname}; PODs: ${result.podCount}; backfilled: ${result.backfilled}`,
          changes: { fees: result.fees, week_number: result.weekNumber, year: result.year, batch: true },
        });
        // Lightweight per-row payload only. The full reconciliation
        // object (extractions[] + creditNotes[]) can run to tens of KB
        // per recon — multiply by a 50-file batch and the response
        // gets large for content the modal never renders. The modal
        // only needs filename/status/week/year/backfilled; the optional
        // auto-navigate path uses reconciliationId to fetch the full
        // object when the operator actually clicks through.
        results.push({
          filename: file.originalname,
          status: 'success',
          reconciliationId: result.reconciliation.id,
          weekNumber: result.weekNumber,
          year: result.year,
          backfilled: result.backfilled,
        });
      } catch (err) {
        console.error(`[bat] Batch upload — file ${file.originalname} failed:`, err.message);
        logAudit({
          req, action: 'bat_upload', resourceType: 'system',
          resourceName: file.originalname,
          details: `Batch upload — ${err.message}`, status: 'failure',
        });
        if (err instanceof SpreadsheetValidationError) {
          results.push({
            filename: file.originalname,
            status: 'rejected',
            reasons: err.reasons,
          });
        } else {
          results.push({
            filename: file.originalname,
            status: 'error',
            error: err.message || 'Failed to process spreadsheet',
          });
        }
      } finally {
        try { fs.unlinkSync(file.path); } catch (e) { console.warn('[batReconciliation.upload_batch.cleanup]', { path: file.path }, e.message); }
      }
    }

    res.json({ ok: true, results });
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
        try { oldest.__sseRes?.end(); } catch (e) { console.warn('[batReconciliation.extraction_sse.evict_oldest]', { channel }, e.message); }
      }
    }

    // Initial snapshot, then push on every worker emit.
    send();
    const onUpdate = () => send();
    onUpdate.__sseRes = res; // eviction hook above uses this to end the response
    extractionEvents.on(channel, onUpdate);

    // Heartbeat every 25 s so proxies / load balancers don't kill the connection.
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) { console.warn('[batReconciliation.extraction_sse.heartbeat]', { channel }, e.message); } }, 25_000);

    // Belt-and-suspenders cap. `req.on('close')` fires on a normal TCP teardown,
    // but a half-open connection (NAT silently dropping state, laptop suspended,
    // etc.) can leave the heartbeat firing indefinitely against a dead socket.
    // Cap at 30 minutes so the worst-case leak is bounded — the client will
    // reconnect on next page interaction.
    const hardCap = setTimeout(() => {
      clearInterval(heartbeat);
      extractionEvents.off(channel, onUpdate);
      try { res.end(); } catch (e) { console.warn('[batReconciliation.extraction_sse.hardcap_end]', { channel }, e.message); }
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

  // Dashboard-wide integrity report. Runs every per-recon invariant
  // (see services/bat/integrity.js) across every non-marked-zero
  // reconciliation and returns one row per recon plus an aggregate
  // summary. Operator uses this when negotiating with BAT to point at
  // exactly which week reconciles and which doesn't. Read-only, no
  // writes — same checker the per-recon banner runs at load time.
  router.get('/api/bat/integrity-report', ...gate, (req, res) => {
    const __t0 = Date.now();
    res.on('finish', () => console.log(`[bat-perf] /api/bat/integrity-report: ${Date.now() - __t0}ms`));
    try {
      // listReconciliations returns the per-week tile shape. We only
      // need (id, week_number, year, marked_zero) for the integrity
      // sweep — pull a minimal list to keep this cheap on installs
      // with many recons.
      const recons = db.prepare(
        'SELECT id, week_number, year, marked_zero FROM bat_reconciliations ORDER BY year DESC, week_number DESC'
      ).all();
      const rows = recons.map(r => {
        const integrity = checkReconciliationIntegrity({ db, reconId: r.id });
        const failed = integrity.checks.filter(c => !c.passed && !c.skipped);
        const skipped = integrity.checks.filter(c => c.skipped);
        return {
          id: r.id,
          year: r.year,
          week_number: r.week_number,
          marked_zero: !!r.marked_zero,
          passed: integrity.passed,
          failed_count: failed.length,
          skipped_count: skipped.length,
          overview_orders_stored: integrity.overviewStored,
          failed_check_ids: failed.map(c => c.id),
          checks: integrity.checks,
        };
      });
      const summary = {
        total: rows.length,
        passing: rows.filter(r => r.passed && !r.marked_zero).length,
        failing: rows.filter(r => !r.passed).length,
        marked_zero: rows.filter(r => r.marked_zero).length,
        needs_reupload: rows.filter(r => !r.marked_zero && r.overview_orders_stored === 0).length,
      };
      res.json({ summary, recons: rows });
    } catch (err) {
      console.error('[bat] integrity-report failed:', err.message);
      res.status(500).json({ error: err.message });
    }
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

  // Prune orphan extractions — bat_invoice_extractions rows whose order_number is
  // NOT in this recon's bat_overview_orders (the integrity I5 failure). These are
  // stale rows from a prior upload: the Overview re-upload only clean-slates
  // bat_overview_orders, never the extractions, so re-uploading can't clear them.
  // Admin-only + audited. The orphans are returned so the UI can confirm exactly
  // what was removed; the caller re-fetches the recon to refresh the banner.
  router.post('/api/bat/reconciliation/:id/prune-orphan-extractions', ...gate, requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    try {
      // Every extraction whose order_number isn't in the recon's CURRENT Overview
      // pivot. CAUTION: on a multi-branch recon (e.g. Welkom + JHB in the same
      // week) the latest upload REPLACES bat_overview_orders, but extraction rows
      // from the other branch are intentionally retained with their OCR/manual
      // corrections — so they legitimately show as orphans here and must NOT be
      // deleted.
      const orphans = db.prepare(`
        SELECT e.id, e.order_number, e.order_amount, e.pdf_url, e.extraction_status
        FROM bat_invoice_extractions e
        WHERE e.reconciliation_id = ?
          AND e.order_number IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM bat_overview_orders o
            WHERE o.reconciliation_id = e.reconciliation_id AND o.order_number = e.order_number
          )
      `).all(id);

      // Only prune TRULY STALE rows: no successful OCR extraction
      // (extraction_status != 'found') AND no amount of any sign. A retained
      // branch row carries a real OCR amount ('found') or a manually-set
      // order_amount, so it is kept — never deleted by this tool.
      const hasAmount = (o) => o.order_amount != null && Number(o.order_amount) !== 0;
      const isStale = (o) => o.extraction_status !== 'found' && !hasAmount(o);
      const stale = orphans.filter(isStale);
      const retained = orphans.filter((o) => !isStale(o));

      if (stale.length === 0) {
        return res.json({ ok: true, pruned: 0, stale: [], retained });
      }

      const ids = stale.map((o) => o.id);
      const placeholders = ids.map(() => '?').join(',');
      const info = db.prepare(`DELETE FROM bat_invoice_extractions WHERE id IN (${placeholders})`).run(...ids);

      logAudit({
        req, action: 'bat_prune_orphan_extractions', resourceType: 'system',
        resourceId: id, resourceName: `Reconciliation ${id}`,
        details: `Pruned ${info.changes} STALE orphan extraction(s) (no OCR/manual amount, not in Overview pivot): ${stale.map((o) => `${o.order_number}#${o.id}`).join('; ')}. Retained ${retained.length} orphan(s) with OCR/manual data (likely another branch's upload).`,
      });

      res.json({ ok: true, pruned: info.changes, stale, retained });
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
    // Missing weeks are scoped to the CURRENT ISO YEAR only, and run up
    // through currentWeek - 1 (i.e. every fully-elapsed week of the
    // current year). The current week itself is excluded because it
    // isn't done yet — Sage credit notes for the in-progress week
    // legitimately don't exist. ISO year — not calendar year — so e.g.
    // Jan 1 2027 (a Friday) correctly belongs to W53/2026. The hub's
    // /api/reporting/bat-summary mirrors this exact logic so the
    // operator sees the same week list whether they're on the site UI
    // or the hub per-site tile.
    //
    // Coverage = paid by Sage OR marked zero by an operator. A
    // genuinely-zero week (no deliveries, no fees) has no Sage credit
    // notes by definition, so without the marked-zero union it would
    // sit in missing-weeks forever. The marked_zero recon row is
    // synthetic — see services/batReconciliation.markWeekZero.
    const currentYear = isoYear;
    const paidThisYear = new Set(sageWeekTotals.filter(w => w.year === currentYear).map(w => w.week_number));
    const markedZeroThisYear = new Set(
      db.prepare(
        `SELECT week_number FROM bat_reconciliations WHERE year = ? AND marked_zero = 1`
      ).all(currentYear).map(r => r.week_number)
    );
    const coveredThisYear = new Set([...paidThisYear, ...markedZeroThisYear]);
    const missingCutoff = Math.max(0, currentWeek - 1);
    const missingWeeks = [];
    for (let w = 1; w <= missingCutoff; w++) {
      if (!coveredThisYear.has(w)) missingWeeks.push(w);
    }

    // Supplier per-week totals (from already-uploaded reconciliations)
    const supplierRows = db.prepare(`
      SELECT id, year, week_number, supplier_delivery, supplier_discount, supplier_pricing,
             marked_zero, marked_zero_by, marked_zero_at, marked_zero_note
      FROM bat_reconciliations
    `).all();

    // Latest week with a real uploaded reconciliation (excluding the
    // synthetic marked_zero rows). Surfaced as a dashboard tile so the
    // operator can see at a glance how current their supplier file is.
    const latestRecon = db.prepare(`
      SELECT year, week_number
      FROM bat_reconciliations
      WHERE COALESCE(marked_zero, 0) = 0
      ORDER BY year DESC, week_number DESC
      LIMIT 1
    `).get();
    const latestReconWeek = latestRecon?.week_number ?? null;
    const latestReconYear = latestRecon?.year ?? null;

    // Merge into one comparison list keyed by (year, week_number)
    const merged = new Map();
    const keyOf = (y, w) => `${y}/${w}`;
    for (const s of supplierRows) {
      merged.set(keyOf(s.year, s.week_number), {
        recon_id: s.id,
        year: s.year,
        week_number: s.week_number,
        supplier_delivery: s.supplier_delivery || 0,
        supplier_discount: s.supplier_discount || 0,
        supplier_pricing:  s.supplier_pricing  || 0,
        sage_delivery: 0, sage_discount: 0, sage_pricing: 0, sage_total: 0, batch_count: 0,
        sage_present: false,
        marked_zero: !!s.marked_zero,
        marked_zero_by: s.marked_zero_by || null,
        marked_zero_at: s.marked_zero_at || null,
        marked_zero_note: s.marked_zero_note || null,
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
      latestReconWeek, latestReconYear,
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

  // ── Per-recon reset (Reset ALL / failed+not_found / duplicates only) ─────
  //
  // Drives the three-button reset block on the recon page AND the per-recon
  // reset section in Settings. The counts endpoint feeds the confirmation
  // dialog so the operator sees what they're about to wipe BEFORE clicking.

  router.get('/api/bat/reconciliations/:id/reset-counts', ...gate, (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid reconciliation id' });
    }
    // Existence-only check — getReconciliationMeta is one row, no joins.
    // The full getReconciliation() loads every extraction + credit note +
    // cross-recon duplicate stats; heavy work the modal preview doesn't
    // need on every open.
    if (!getReconciliationMeta(id)) {
      return res.status(404).json({ error: 'Reconciliation not found' });
    }
    try {
      res.json(countExtractionsForRecon(id));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Mark-week-zero ─────────────────────────────────────────────
  //
  // For weeks that genuinely had no deliveries / no charges / no
  // fees: the supplier's recon spreadsheet has an empty Delivery POD
  // sheet, which the upload parser rejects (correctly — an empty POD
  // sheet is usually an upload mistake, not a real zero week). Without
  // a way to record "this week was actually zero" the missing-credit-
  // notes list shows the week forever even though Sage has nothing to
  // pay (no credit notes are produced for a zero week).
  //
  // POST /api/bat/reconciliations/mark-zero { year, week_number, note? }
  // → creates a synthetic recon row with all supplier totals = 0 and
  //   marked_zero = 1. The week then counts as "covered" in the
  //   missing-weeks calculation. Reversible via the unmark endpoint.
  router.post('/api/bat/reconciliations/mark-zero', ...gate, (req, res) => {
    const weekNumber = Number.parseInt(req.body?.week_number, 10);
    const year = Number.parseInt(req.body?.year, 10);
    const note = typeof req.body?.note === 'string' ? req.body.note : null;
    if (!Number.isFinite(weekNumber) || weekNumber < 1 || weekNumber > 53) {
      return res.status(400).json({ error: 'week_number must be 1..53' });
    }
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ error: 'year must be a 4-digit year' });
    }
    try {
      const id = markWeekZero({
        weekNumber, year, note,
        userEmail: req.currentUser?.email || 'unknown',
      });
      logAudit({
        req,
        action: 'bat_recon_marked_zero',
        resourceType: 'reconciliation',
        resourceId: id,
        resourceName: `W${weekNumber}/${year}`,
        details: `Marked week ${weekNumber} of ${year} as zero${note ? ` — note: ${note.slice(0, 200)}` : ''}`,
      });
      res.json({ ok: true, id, week_number: weekNumber, year });
    } catch (err) {
      const status = err.code === 'EXISTS' ? 409 : 500;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });

  router.post('/api/bat/reconciliations/:id/unmark-zero', ...gate, (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid reconciliation id' });
    }
    try {
      const { week_number, year } = unmarkWeekZero({
        id, userEmail: req.currentUser?.email || 'unknown',
      });
      logAudit({
        req,
        action: 'bat_recon_unmarked_zero',
        resourceType: 'reconciliation',
        resourceId: id,
        resourceName: `W${week_number}/${year}`,
        details: `Unmarked week ${week_number} of ${year} (was previously marked zero)`,
      });
      res.json({ ok: true, week_number, year });
    } catch (err) {
      const status =
        err.code === 'NOT_FOUND' ? 404 :
        err.code === 'NOT_MARKED_ZERO' ? 409 : 500;
      res.status(status).json({ error: err.message, code: err.code });
    }
  });

  router.post('/api/bat/reconciliations/:id/reset', ...gate, (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid reconciliation id' });
    }
    // Existence + week/year only — same lightweight lookup the
    // reset-counts endpoint uses, for the same reason. The reset
    // handler doesn't need the extractions/creditNotes/dup-stats
    // payload that getReconciliation eagerly builds.
    const recon = getReconciliationMeta(id);
    if (!recon) return res.status(404).json({ error: 'Reconciliation not found' });
    const scope = req.body?.scope;
    const reconLabel = `Week ${recon.week_number}/${recon.year}`;

    // Race guard — reviewer-flagged: without this, a reset fired while
    // the OCR worker is mid-flight on this recon would set rows back to
    // pending/null but the in-flight workers would then finish and write
    // OLD results back by id. Net effect: the recon ends up partially
    // re-reset immediately after the green toast, defeating the "full
    // wipe and reprocess" intent. Two signals together: workerRunning &&
    // workerReconId === id (the worker is targeting THIS recon), and
    // any currentlyProcessing row whose reconciliation_id matches (a
    // row is actively in flight). getExtractionProgress already
    // aggregates both.
    //
    // Operator path on 409: pause OCR (Settings → OCR worker → Pause),
    // wait for in-flight rows to drain, click Reset, then resume OCR
    // and click Extract.
    const progress = getExtractionProgress(id);
    if (progress && (progress.running || (progress.in_flight && progress.in_flight.length > 0))) {
      const inFlightCount = progress.in_flight?.length || 0;
      return res.status(409).json({
        error:
          `OCR is currently processing ${reconLabel} (${inFlightCount} row${inFlightCount === 1 ? '' : 's'} in flight). ` +
          `A reset right now would race with the workers — they would finish their current rows and write old results back ` +
          `into rows we just wiped. Pause OCR (Settings → OCR worker → Pause), wait for the in-flight rows to drain, then retry the reset.`,
        running: !!progress.running,
        in_flight: inFlightCount,
      });
    }
    try {
      let result;
      let action;
      let details;
      switch (scope) {
        case 'all':
          result = resetAllExtractionsForRecon(id);
          action = 'bat_reset_recon_all';
          details = `Reset ALL ${result.reset} extraction(s) in ${reconLabel} back to pending (incl. found + manual edits)`;
          break;
        case 'unsuccessful':
          result = resetUnsuccessfulExtractionsForRecon(id);
          action = 'bat_reset_recon_unsuccessful';
          details = `Reset ${result.reset} not_found/failed extraction(s) in ${reconLabel} back to pending`;
          break;
        case 'duplicates':
          result = resetDuplicateExtractionsForRecon(id);
          action = 'bat_reset_recon_duplicates';
          details = `Reset ${result.reset} duplicate extraction(s) in ${reconLabel} (${result.duplicateInvoices} dup invoice value(s))`;
          break;
        default:
          return res.status(400).json({
            error: "scope must be one of: 'all', 'unsuccessful', 'duplicates'",
          });
      }
      logAudit({
        req, action, resourceType: 'system',
        resourceId: id, resourceName: reconLabel,
        details,
      });
      res.json({ ...result, scope });
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
      try { resumeExtractionWorker(); resumed = true; } catch (e) { console.warn('[batReconciliation.ocr_pause.resume_worker]', e.message); }
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
      try { matching = matchCardosoToSupplier(null); } catch (e) { console.warn('[batReconciliation.replicate_supplier.rerun_match]', e.message); }
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
  router.post('/api/bat/cardoso-upload', ...gate, uploadSingle, async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded — only .xlsx and .xls files are accepted' });
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
      try { fs.unlinkSync(req.file.path); } catch (e) { console.warn('[batReconciliation.cardoso_upload.cleanup]', { path: req.file.path }, e.message); }
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
