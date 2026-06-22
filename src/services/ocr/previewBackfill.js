// One-time preview backfill for PODs that were OCR'd before multi-page previews
// existed. Those rows only have page 1 (or, for old text-layer hits, no preview
// at all). This downloads each PDF ONCE, renders ALL pages, caches them, and
// marks the row — WITHOUT re-running OCR, so the already-detected invoice number
// is never touched.
//
// Built for production scale (~thousands of rows hitting SharePoint):
//   - Operator-controlled: start()/stop(), never auto-runs.
//   - Sequential + throttled (OCR_BACKFILL_DELAY_MS between rows) so it doesn't
//     hammer the POD host or starve the box of CPU.
//   - Resumable + idempotent: "needs backfill" = preview_pages IS NULL. Each
//     processed row gets preview_pages set (>=1 rendered, or 0 attempted-but-
//     failed), so a re-run continues where it left off and never re-hammers a
//     dead URL. A restart stops the run; the operator restarts it.
//   - No silent failures: every skipped/failed row is logged.

import path from 'path';
import { promises as fsp } from 'fs';
import db from '../../db/index.js';
import { logError } from '../../lib/errorLog.js';
import { downloadPdf } from './pdfFetch.js';
import { renderPdfInChild } from './spawnRenderChild.js';
import { previewFileName, listPreviewPagesFromFiles } from './previewPages.js';

const PREVIEW_WIDTH = 1200;
const PREVIEW_QUALITY = 70;
const PREVIEW_SCALE = 2.0;
const MAX_PAGES = (() => {
  const n = parseInt(process.env.OCR_PREVIEW_MAX_PAGES ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 500;
})();
const DELAY_MS = (() => {
  const n = parseInt(process.env.OCR_BACKFILL_DELAY_MS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 300;
})();
// POD downloads run on the MAIN thread here (unlike OCR, which downloads inside
// its worker), so they compete with the event loop and a single 60s shot was
// timing out ("operation aborted") on slow SharePoint/Azure blobs. Retry
// transient failures with linear backoff; both are env-tunable.
const DOWNLOAD_TIMEOUT_MS = (() => {
  const n = parseInt(process.env.OCR_BACKFILL_DOWNLOAD_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(n) && n >= 1000 ? n : 90_000;
})();
const DOWNLOAD_ATTEMPTS = (() => {
  const n = parseInt(process.env.OCR_BACKFILL_DOWNLOAD_ATTEMPTS ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 3;
})();
const DOWNLOAD_RETRY_BASE_MS = 1500;

const previewDir = () => path.join(process.cwd(), 'uploads', 'bat-previews');

let _sharp = null;
async function getSharp() {
  if (!_sharp) _sharp = (await import('sharp')).default;
  return _sharp;
}

// Statements are prepared lazily — the preview_pages column only exists after
// migration v108 has run, which happens at startup before any request.
let _stmts = null;
function stmts() {
  if (!_stmts) {
    // "Needs backfill" = an OCR-processed row (not still pending) that has a PDF
    // and no rendered-page count yet.
    const where = "pdf_url IS NOT NULL AND preview_pages IS NULL AND COALESCE(extraction_status,'') <> 'pending'";
    _stmts = {
      count: db.prepare(`SELECT COUNT(*) AS n FROM bat_invoice_extractions WHERE ${where}`),
      // id-cursor paging: a transient-fail row is deliberately left
      // preview_pages IS NULL so a LATER run retries it, but it must not be
      // re-pulled within THIS run (which would loop forever). `id > ?` walks
      // strictly forward.
      nextRows: db.prepare(`SELECT id, pdf_url, preview_path FROM bat_invoice_extractions WHERE ${where} AND id > ? ORDER BY id LIMIT ?`),
      mark: db.prepare('UPDATE bat_invoice_extractions SET preview_pages = ?, preview_path = COALESCE(preview_path, ?) WHERE id = ?'),
    };
  }
  return _stmts;
}

const state = {
  running: false,
  stopRequested: false,
  startedAt: null,
  totalAtStart: 0,
  processed: 0,
  failed: 0,
  currentId: null,
  lastError: null,
};

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// After a SUCCESSFUL (re-)render, drop any stale higher pages left by a prior,
// longer backfill of this row (e.g. it produced 5 pages then, only 3 now) so no
// orphan pages linger. Runs AFTER rendering and only for pages beyond what we
// just produced — so page 1 (rewritten in place atomically) and pages 2..N we
// just wrote are kept, and a FAILED render never deletes the row's existing
// preview (the bug this replaces: removeExisting() used to wipe everything up
// front, so a render that then failed stranded the row with no preview).
async function removeStalePages(dir, id, keepThrough) {
  let files;
  try { files = await fsp.readdir(dir); }
  catch (e) { if (e.code !== 'ENOENT') console.warn('[previewBackfill.readdir]', e.message); return; }
  for (const { page, filename } of listPreviewPagesFromFiles(files, id)) {
    if (page <= keepThrough) continue; // keep the pages we just rendered
    try { await fsp.unlink(path.join(dir, filename)); }
    catch (e) { if (e.code !== 'ENOENT') console.warn('[previewBackfill.unlink]', { filename }, e.message); }
  }
}

// Render pages 1..N from the in-memory PDF, cache one JPEG each. Returns the
// count rendered. Loops until the renderer reports the page is out of range.
async function renderAllPages(buffer, id) {
  const sharp = await getSharp();
  const dir = previewDir();
  await fsp.mkdir(dir, { recursive: true });
  // NOTE: do NOT delete existing previews up front. Each page is written
  // atomically (tmp+rename), so page 1 (<id>.jpg) is replaced in place only when
  // its render succeeds; stale higher pages from a prior partial backfill are
  // pruned AFTER a successful render (below). Deleting first and then failing
  // would strand a row that already had a working preview.

  let rendered = 0;
  for (let p = 1; p <= MAX_PAGES; p++) {
    let img;
    try {
      img = await renderPdfInChild(buffer, { pageNum: p, requestedScale: PREVIEW_SCALE });
    } catch (err) {
      if (err?.code === 'PAGE_OUT_OF_RANGE') break; // no more pages
      // A single bad page (e.g. PAGE_TOO_LARGE) shouldn't abort the row.
      try { logError('bat.ocr.backfill_page', err, { extraction_id: id, page: p }); }
      catch { console.warn('[previewBackfill.page]', id, p, err.message); }
      continue;
    }
    try {
      // Orientation: only rotate a page that renders LANDSCAPE (wider than tall)
      // — a portrait POD scanned sideways — 90° clockwise upright. Pages already
      // portrait are left as rendered (a blanket rotate turned those sideways).
      // Same heuristic as the OCR-worker page-1 + render-queue pipelines. Rotate
      // before resize so the width cap lands on the final orientation.
      const meta = await sharp(img).metadata();
      let pipe = sharp(img);
      if (meta.width && meta.height && meta.width > meta.height) pipe = pipe.rotate(90);
      const jpeg = await pipe.resize({ width: PREVIEW_WIDTH }).jpeg({ quality: PREVIEW_QUALITY }).toBuffer();
      const full = path.join(dir, previewFileName(id, p));
      const tmp = `${full}.tmp`;
      await fsp.writeFile(tmp, jpeg);
      await fsp.rename(tmp, full);
      rendered = p;
    } catch (err) {
      try { logError('bat.ocr.backfill_page_save', err, { extraction_id: id, page: p }); }
      catch { console.warn('[previewBackfill.save]', id, p, err.message); }
    }
  }
  // Prune stale higher pages ONLY on success — never on a 0-page render, so a
  // row that fails to render keeps whatever preview it already had.
  if (rendered >= 1) await removeStalePages(dir, id, rendered);
  return rendered;
}

// Permanent failures won't recover — a rejected URL, a non-PDF body, or a 4xx
// that means the document is genuinely gone/forbidden (403/404/410, etc.).
// Everything else is transient and worth retrying: timeouts/aborts, network
// drops, 5xx, AND throttling responses (429 Too Many Requests, 408 Request
// Timeout, 425 Too Early) — the bulk SharePoint/Azure backfill WILL get
// throttled, and treating that as permanent would mark whole weeks skipped.
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429]);
function isPermanentDownloadError(err) {
  if (err?.code === 'URL_REJECTED' || err?.code === 'INVALID_PDF') return true;
  if (err?.code === 'HTTP_ERROR' && err.status >= 400 && err.status < 500) {
    return !TRANSIENT_HTTP_STATUSES.has(err.status);
  }
  return false;
}

async function downloadWithRetry(url, id) {
  let lastErr;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      return await downloadPdf(url, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
    } catch (err) {
      lastErr = err;
      if (isPermanentDownloadError(err)) throw err; // a dead URL won't heal
      if (attempt < DOWNLOAD_ATTEMPTS) {
        console.warn(`[previewBackfill.download] #${id} attempt ${attempt}/${DOWNLOAD_ATTEMPTS} failed (${err.message}) — retrying`);
        await sleep(DOWNLOAD_RETRY_BASE_MS * attempt);
      }
    }
  }
  throw lastErr;
}

async function processRow(row) {
  let buffer;
  try {
    buffer = await downloadWithRetry(row.pdf_url, row.id);
  } catch (err) {
    state.failed += 1;
    state.lastError = `#${row.id}: ${err.message}`;
    const permanent = isPermanentDownloadError(err);
    try { logError('bat.ocr.backfill_download', err, { extraction_id: row.id, pdf_url: row.pdf_url, permanent }); }
    catch { console.warn('[previewBackfill.download]', row.id, err.message); }
    // Permanent (dead URL / not a PDF): mark 0 so we never re-hammer it.
    // Transient (timeout/network, retries exhausted): leave preview_pages NULL so
    // a LATER backfill run retries it — drain's id-cursor stops it looping now.
    if (permanent) {
      try { stmts().mark.run(0, null, row.id); } catch { /* mark is best-effort */ }
    }
    return;
  }

  let rendered = 0;
  try {
    rendered = await renderAllPages(buffer, row.id);
  } catch (err) {
    try { stmts().mark.run(0, null, row.id); } catch { /* best effort */ }
    state.failed += 1;
    state.lastError = `#${row.id}: render ${err.message}`;
    try { logError('bat.ocr.backfill_render', err, { extraction_id: row.id }); }
    catch { console.warn('[previewBackfill.render]', row.id, err.message); }
    return;
  }

  // Stamp the count and, for old text-layer rows that never had one, the page-1
  // preview_path (COALESCE keeps any existing value).
  const page1Path = `/api/bat/preview/${previewFileName(row.id, 1)}`;
  try { stmts().mark.run(rendered, page1Path, row.id); }
  catch (err) {
    try { logError('bat.ocr.backfill_mark', err, { extraction_id: row.id }); }
    catch { console.warn('[previewBackfill.mark]', row.id, err.message); }
  }
  if (rendered >= 1) state.processed += 1;
  else { state.failed += 1; state.lastError = `#${row.id}: 0 pages rendered`; }
}

async function drain() {
  // Walk strictly forward by id. Rows that succeed or permanently fail get
  // marked (drop out of the WHERE set); rows that fail transiently stay NULL for
  // a later run, and the cursor ensures we don't re-pull them this run.
  let cursor = 0;
  try {
    while (!state.stopRequested) {
      const rows = stmts().nextRows.all(cursor, 25);
      if (rows.length === 0) break;
      for (const row of rows) {
        if (state.stopRequested) break;
        cursor = row.id; // advance past this row regardless of outcome
        state.currentId = row.id;
        await processRow(row);
        if (DELAY_MS > 0) await sleep(DELAY_MS);
      }
    }
  } catch (err) {
    state.lastError = err.message;
    try { logError('bat.ocr.backfill_loop', err, {}); } catch { console.error('[previewBackfill.loop]', err.message); }
  } finally {
    state.running = false;
    state.stopRequested = false;
    state.currentId = null;
    console.log(`[previewBackfill] stopped — processed ${state.processed}, failed ${state.failed}`);
  }
}

export function startPreviewBackfill() {
  if (state.running) return status();
  state.running = true;
  state.stopRequested = false;
  state.processed = 0;
  state.failed = 0;
  state.lastError = null;
  try { state.totalAtStart = stmts().count.get().n; } catch { state.totalAtStart = 0; }
  // startedAt is informational only; Date.now() is fine in app code.
  state.startedAt = Date.now();
  console.log(`[previewBackfill] started — ${state.totalAtStart} row(s) need previews (delay ${DELAY_MS}ms)`);
  setImmediate(() => { drain().catch((e) => console.error('[previewBackfill.drain]', e.message)); });
  return status();
}

export function stopPreviewBackfill() {
  if (state.running) state.stopRequested = true;
  return status();
}

export function status() {
  let remaining = null;
  try { remaining = stmts().count.get().n; } catch { remaining = null; }
  return {
    running: state.running,
    startedAt: state.startedAt,
    totalAtStart: state.totalAtStart,
    processed: state.processed,
    failed: state.failed,
    remaining,
    currentId: state.currentId,
    lastError: state.lastError,
    delayMs: DELAY_MS,
  };
}
