// Background multi-page preview renderer.
//
// The OCR worker only ever rasterises page 1 (inside the strict 90s per-row
// budget). When a POD has more than one page, the worker stashes the
// already-downloaded PDF to disk (uploads/bat-pdf-cache/<id>.pdf) and the BAT
// run enqueues a job here. This queue renders pages 2..N from that LOCAL copy
// — so there is no re-download of the (auth'd, possibly-expiring) POD URL — and
// it runs OUTSIDE the OCR time budget, so a 50-page POD can't starve detection.
//
// It lives in the MAIN process but does the CPU-heavy rasterising in the same
// short-lived child processes the OCR path uses (renderPdfInChild), so the
// event loop is never blocked. Jobs run ONE AT A TIME: the OCR lanes already
// spawn render children, and we don't want the background pass competing for
// CPU with live extraction.
//
// Naming + back-compat live in previewPages.js (single source of truth).

import path from 'path';
import { promises as fsp } from 'fs';
import { renderPdfInChild } from './spawnRenderChild.js';
import { previewFileName } from './previewPages.js';
import { logError } from '../../lib/errorLog.js';

// Match the OCR worker's page-1 preview encoding so every page looks the same.
const PREVIEW_WIDTH = 1200;
const PREVIEW_QUALITY = 70;

// Per-page render scale — previews are for human viewing, not OCR, so this is
// lower than the OCR render scale. The child clamps it against its own pixel
// caps regardless.
const PREVIEW_SCALE = 2.0;

// Safety ceiling on pages per document — astronomically high for a real POD,
// purely a backstop against a malformed PDF that reports a runaway page count.
const MAX_PAGES = (() => {
  const n = parseInt(process.env.OCR_PREVIEW_MAX_PAGES ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 500;
})();

const previewDir = () => path.join(process.cwd(), 'uploads', 'bat-previews');
const cacheDir = () => path.join(process.cwd(), 'uploads', 'bat-pdf-cache');

// Path of the cached PDF for an extraction. Exported so the route can report
// whether a row's extra pages are still being rendered (the file's presence is
// the "in progress" signal — it's deleted when the job finishes).
export function cachedPdfPath(extractionId) {
  return path.join(cacheDir(), `${extractionId}.pdf`);
}

let _sharp = null;
async function getSharp() {
  if (!_sharp) _sharp = (await import('sharp')).default;
  return _sharp;
}

const _queued = new Set(); // dedupe ids already queued or in flight
const _pending = []; // FIFO of extraction ids
let _running = false;

/**
 * Enqueue a row's extra-page render. Idempotent: a row already queued or
 * in flight is ignored. Returns immediately; rendering happens in the
 * background.
 * @param {number|string} extractionId
 */
export function enqueuePreviewRender(extractionId) {
  const id = Number(extractionId);
  if (!Number.isInteger(id) || id < 1) return;
  if (_queued.has(id)) return;
  _queued.add(id);
  _pending.push(id);
  if (!_running) {
    _running = true;
    // setImmediate so enqueue never blocks the caller (the BAT result handler).
    setImmediate(() => { drain().catch((e) => console.error('[previewRenderQueue.drain]', e.message)); });
  }
}

async function drain() {
  try {
    while (_pending.length) {
      const id = _pending.shift();
      let replaced = false;
      try {
        replaced = await renderJob(id);
      } catch (e) {
        try { logError('bat.ocr.preview_render', e, { extraction_id: id }); }
        catch { console.error('[previewRenderQueue]', id, e.message); }
      } finally {
        _queued.delete(id);
      }
      // The cached PDF was swapped for a newer generation mid-render; its own
      // enqueue was deduped while this job held the id, so re-enqueue now that
      // the id is free again.
      if (replaced) enqueuePreviewRender(id);
    }
  } finally {
    _running = false;
    // A job enqueued between the while-check and here would otherwise sit
    // until the next enqueue; re-kick if anything slipped in.
    if (_pending.length) {
      _running = true;
      setImmediate(() => { drain().catch((e) => console.error('[previewRenderQueue.drain]', e.message)); });
    }
  }
}

// Returns true when the cached PDF was replaced by a newer generation mid-render
// (so the caller should re-enqueue it); false otherwise.
async function renderJob(extractionId) {
  const pdfPath = cachedPdfPath(extractionId);
  let buffer;
  let readStat;
  try {
    // Capture the exact file version we render from. A reset/re-run can replace
    // this cached PDF with a NEW generation's PDF while we're mid-render; we must
    // not delete that newer file at cleanup, and we must let it be re-rendered.
    readStat = await fsp.stat(pdfPath);
    buffer = await fsp.readFile(pdfPath);
  } catch (e) {
    if (e.code === 'ENOENT') return false; // nothing cached (already done / never multi-page)
    throw e;
  }

  const sharp = await getSharp();
  const dir = previewDir();
  await fsp.mkdir(dir, { recursive: true });

  // Render pages 2..N until the renderer says the page is out of range (or the
  // safety cap). Page 1 was already written by the OCR worker, so we start at 2.
  // Looping on PAGE_OUT_OF_RANGE means we don't need the page count threaded in
  // — which also makes crash-recovery (recoverPendingPreviewRenders) trivial.
  for (let p = 2; p <= MAX_PAGES; p++) {
    let img;
    try {
      img = await renderPdfInChild(buffer, { pageNum: p, requestedScale: PREVIEW_SCALE });
    } catch (err) {
      if (err?.code === 'PAGE_OUT_OF_RANGE') break; // past the last page — done
      // A single page failing (e.g. PAGE_TOO_LARGE on one banner-format page)
      // must not abort the rest — log it and keep going.
      try { logError('bat.ocr.preview_page', err, { extraction_id: extractionId, page: p }); }
      catch { console.warn('[previewRenderQueue.page]', extractionId, p, err.message); }
      continue;
    }
    try {
      // Orientation: only rotate a page that renders LANDSCAPE (wider than tall)
      // — a portrait POD scanned sideways — 90° clockwise upright. Pages already
      // portrait are left as rendered (a blanket rotate turned those sideways).
      // Same heuristic as preparePreview (page 1) + the backfill so every page
      // matches. Rotate before resize so the width cap lands on the final shape.
      const meta = await sharp(img).metadata();
      let pipe = sharp(img);
      if (meta.width && meta.height && meta.width > meta.height) pipe = pipe.rotate(90);
      const jpeg = await pipe.resize({ width: PREVIEW_WIDTH }).jpeg({ quality: PREVIEW_QUALITY }).toBuffer();
      const full = path.join(dir, previewFileName(extractionId, p));
      // Atomic write (sibling .tmp + rename) — same reason as the worker's
      // page 1: the daily backup hardlinks each preview, so the source inode
      // must never be mutated in place.
      const tmp = `${full}.tmp`;
      await fsp.writeFile(tmp, jpeg);
      await fsp.rename(tmp, full);
    } catch (err) {
      try { logError('bat.ocr.preview_page_save', err, { extraction_id: extractionId, page: p }); }
      catch { console.warn('[previewRenderQueue.save]', extractionId, p, err.message); }
    }
  }

  // Done (or as far as we could get). Only drop the cached PDF if it is STILL
  // the exact version we rendered from. If a reset/re-run replaced it with a
  // newer generation mid-render, leave that file in place and tell the caller to
  // re-render it — the dedupe set blocked the new generation's own enqueue while
  // this job held the id. mtime+size is a sufficient generation fingerprint.
  try {
    const nowStat = await fsp.stat(pdfPath);
    if (nowStat.mtimeMs === readStat.mtimeMs && nowStat.size === readStat.size) {
      await fsp.unlink(pdfPath);
      return false;
    }
    return true; // replaced by a newer generation → needs a fresh render
  } catch (e) {
    if (e.code === 'ENOENT') return false; // already gone — nothing to clean up
    console.warn('[previewRenderQueue.cleanup]', extractionId, e.message);
    return false;
  }
}

/**
 * On startup, re-enqueue any cached PDFs left behind by a crash/restart so
 * their extra pages still get rendered. Safe to call once at boot.
 */
export async function recoverPendingPreviewRenders() {
  let files;
  try {
    files = await fsp.readdir(cacheDir());
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[previewRenderQueue.recover]', e.message);
    return;
  }
  let n = 0;
  for (const f of files) {
    const m = /^(\d+)\.pdf$/.exec(f);
    if (m) { enqueuePreviewRender(parseInt(m[1], 10)); n++; }
  }
  if (n > 0) console.log(`[previewRenderQueue] recovered ${n} pending preview render(s) after restart`);
}
