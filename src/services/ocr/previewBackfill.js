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
      nextRows: db.prepare(`SELECT id, pdf_url, preview_path FROM bat_invoice_extractions WHERE ${where} ORDER BY id LIMIT ?`),
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

// Drop any cached pages from a prior (possibly partial) backfill of this row so
// a re-render can't leave orphan higher pages.
async function removeExisting(dir, id) {
  let files;
  try { files = await fsp.readdir(dir); }
  catch (e) { if (e.code !== 'ENOENT') console.warn('[previewBackfill.readdir]', e.message); return; }
  for (const { filename } of listPreviewPagesFromFiles(files, id)) {
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
  await removeExisting(dir, id);

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
      const jpeg = await sharp(img).resize({ width: PREVIEW_WIDTH }).jpeg({ quality: PREVIEW_QUALITY }).toBuffer();
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
  return rendered;
}

async function processRow(row) {
  let buffer;
  try {
    buffer = await downloadPdf(row.pdf_url);
  } catch (err) {
    // Mark attempted (0) so we don't re-download a dead URL on every re-run.
    try { stmts().mark.run(0, null, row.id); } catch { /* mark is best-effort */ }
    state.failed += 1;
    state.lastError = `#${row.id}: ${err.message}`;
    try { logError('bat.ocr.backfill_download', err, { extraction_id: row.id, pdf_url: row.pdf_url }); }
    catch { console.warn('[previewBackfill.download]', row.id, err.message); }
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
  try {
    // Pull in small batches; the WHERE clause shrinks as rows get marked, so
    // this naturally walks the whole set and is safe to resume.
    while (!state.stopRequested) {
      const rows = stmts().nextRows.all(25);
      if (rows.length === 0) break;
      for (const row of rows) {
        if (state.stopRequested) break;
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
