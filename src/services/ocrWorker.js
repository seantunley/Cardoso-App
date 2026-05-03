// OCR worker thread — runs the entire PDF→invoice extraction pipeline off the
// main Node thread so an in-progress OCR run doesn't block API requests.
//
// Why this exists: pdfjs page rendering, sharp image processing, and Tesseract
// recognition are all CPU-bound. Running them on the main thread (with an OCR
// concurrency of 4) caused the API event loop to stall whenever a recon was
// being extracted — page navigation, login, dashboards all froze.
//
// Communication protocol (all messages have a numeric `id` for correlation):
//   Main → worker:
//     { type: 'extract', id, payload: { pdfUrl, extractionId, googleVisionKey, ocrSpaceKey } }
//     { type: 'shutdown' }
//   Worker → main:
//     { type: 'ready' }                            — sent once after init
//     { type: 'result', id, ok: true, result }     — extraction succeeded
//     { type: 'result', id, ok: false, error }     — extraction threw
//
// The worker holds one long-lived Tesseract worker. If recognition throws and
// poisons the worker, we terminate it and the main thread (which sees the
// failure on its next call) will recreate the whole lane.

import { parentPort, workerData } from 'worker_threads';
import { promises as fsp } from 'fs';
import path from 'path';
import { Buffer } from 'buffer';

const { previewDir } = workerData || {};

// Per-network-call timeout. Without this, a hung S3/CDN connection or a
// stalled OCR-engine response would await forever inside the worker — the
// parent's PDF_TIMEOUT (120s) is supposed to back it up, but it relies on
// the worker eventually responding to the postMessage round-trip and a few
// edge cases (worker terminate races) have left lanes hung at 9+ minutes.
// These per-call abort signals are the real fix; the parent timeout stays
// as a backstop.
async function fetchWithTimeout(url, opts = {}, timeoutMs = 30_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Generic timeout wrapper. Used to bound any promise that could hang at
// the worker boundary — Tesseract trained-data download, native-binary
// initialisation, individual OCR-engine calls, and the top-level extract
// itself. The label flows into the rejection message so the operator
// sees exactly which stage is wedged.
function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Timeout after ${timeoutMs}ms in stage: ${label}`)),
      timeoutMs,
    );
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// Fire a per-stage progress message back to the parent. The parent uses
// these to populate `currentlyProcessing[].stage`, which the UI's
// ExtractionProgress component renders inline so an operator can see
// which row is on which step in real time. Best-effort: a postMessage
// failure here is non-fatal — extraction continues.
function emitProgress(id, stage) {
  try { parentPort.postMessage({ type: 'progress', id, stage }); } catch {}
}

let _tesseract = null;
let _sharp = null;
let _pdfjs = null;
let _canvas = null;

async function getTesseract() {
  if (_tesseract) return _tesseract;
  const { createWorker } = await import('tesseract.js');
  // 30s hard cap on Tesseract init. createWorker('eng') silently downloads
  // ~10MB of trained data from tessdata.projectnaptha.com on first use.
  // On a firewalled / AV-blocked / corporate-proxy site this hangs forever;
  // a clear timeout error here lets the operator see exactly what's wrong.
  _tesseract = await withTimeout(createWorker('eng'), 30_000, 'tesseract_init');
  return _tesseract;
}

async function getSharp() {
  if (_sharp) return _sharp;
  _sharp = (await import('sharp')).default;
  return _sharp;
}

async function getPdfjs() {
  if (_pdfjs) return _pdfjs;
  _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return _pdfjs;
}

async function getCanvas() {
  if (_canvas) return _canvas;
  _canvas = await import('canvas');
  return _canvas;
}

// ── PDF render ───────────────────────────────────────────────────────────────

// pdfjs-dist is PINNED to 4.8.69 in package.json. DO NOT BUMP without
// migrating off node-canvas first.
//
// pdfjs 4.10+ switched its image pipeline to browser-only APIs
// (createImageBitmap, OffscreenCanvas.transferToImageBitmap). When pdfjs
// then calls ctx.drawImage(imgData.bitmap, 0, 0), node-canvas rejects the
// ImageBitmap with "Image or Canvas expected" — node-canvas only accepts
// its own Image / Canvas types. The result is every PDF that needs image
// rendering fails to OCR.
//
// 4.8.69 is the last pdfjs version that uses node-canvas-compatible
// image objects. It works reliably with this code path.
//
// Long-term plan: migrate to a Node-native PDF engine (pdfium-binary or
// poppler) that doesn't depend on browser APIs. See docs/plans/pdf-engine-migration.md
// for scope. Until that lands, this pin is load-bearing.
async function pdfPageToImage(buffer, pageNum, scale = 3.0) {
  const pdfjsLib = await getPdfjs();
  const { createCanvas } = await getCanvas();

  const pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(viewport.width, viewport.height);
  const context = canvas.getContext('2d');
  await page.render({ canvasContext: context, viewport }).promise;
  await pdfDoc.destroy();

  return canvas.toBuffer('image/png');
}

// ── OCR engines ──────────────────────────────────────────────────────────────

async function ocrViaGoogleVision(imageBuffer, apiKey) {
  if (!apiKey) throw new Error('GOOGLE_VISION_KEY not set');
  const base64 = imageBuffer.toString('base64');
  const body = {
    requests: [{
      image: { content: base64 },
      features: [{ type: 'TEXT_DETECTION', maxResults: 1 }],
    }],
  };
  const res = await fetchWithTimeout(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 45_000);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google Vision HTTP ${res.status}: ${err.substring(0, 200)}`);
  }
  const data = await res.json();
  const annotation = data.responses?.[0]?.fullTextAnnotation;
  return annotation?.text || '';
}

async function ocrViaOcrSpaceEngine(imageBuffer, engine = '2', apiKey, retries = 1) {
  if (!apiKey) throw new Error('OCR_SPACE_KEY not set — configure in BAT settings or env');
  const base64 = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const formData = new URLSearchParams();
    formData.append('base64Image', base64);
    formData.append('language', 'eng');
    formData.append('isOverlayRequired', 'false');
    formData.append('OCREngine', engine);
    formData.append('scale', 'true');
    formData.append('isTable', 'true');
    formData.append('detectOrientation', 'true');

    const res = await fetchWithTimeout('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { apikey: apiKey },
      body: formData,
    }, 60_000);

    if (!res.ok) {
      const body = await res.text();
      const tier = res.status === 413 || res.status === 403;
      const err = new Error(`ocr.space HTTP ${res.status}: ${body.substring(0, 200)}`);
      if (tier) err.tierError = true;
      throw err;
    }
    const data = await res.json();
    if (data.IsErroredOnProcessing) {
      const errMsg = Array.isArray(data.ErrorMessage) ? data.ErrorMessage.join('; ') : (data.ErrorMessage || 'unknown');
      if (errMsg.includes('E101') && attempt < retries) {
        await new Promise(r => setTimeout(r, 8000));
        continue;
      }
      const err = new Error(`ocr.space error: ${errMsg}`);
      if (/E556|E102|E103|too large|Plan|quota|limit/i.test(errMsg)) err.tierError = true;
      throw err;
    }
    return (data.ParsedResults || []).map(r => r.ParsedText || '').join('\n');
  }
}

// ── Invoice number extraction (regex pipeline) ───────────────────────────────

function findInvoiceNumber(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/[|]/g, 'I')
    .replace(/[oO](?=\d{3,})/g, '0')
    .replace(/[lI](?=N\d)/g, 'I')
    .replace(/\*/g, '')
    .replace(/[{}[\]()]/g, '')
    .replace(/[—–-]{2,}/g, ' ');

  const longMatch = cleaned.match(/\b(18\d{8,9})\b/);
  if (longMatch) return 'IN' + longMatch[1].substring(2);

  const inLongMatch = cleaned.match(/\bIN\s*(\d{8,9})\b/i);
  if (inLongMatch) {
    let digits = inLongMatch[1];
    if (digits.length === 8) digits = '0' + digits;
    return `IN${digits}`;
  }

  const partialPatterns = [
    /\b\d?0{2,3}(422\d{3,6})\b/,
    /(?:INVOIC|NVOIC|VOICE)[E]?\s*[#:.]?\s*\d{0,5}(422\d{3})\b/i,
  ];
  for (const p of partialPatterns) {
    const m = cleaned.match(p);
    if (m) {
      const full = 'IN000' + m[1];
      if (full.length >= 12 && full.length <= 14) return full;
    }
  }

  const inPatterns = [
    /\bIN\s*(\d{4,7})\b/i,
    /\bINV\s*(\d{4,7})\b/i,
    /[IL1]\s*N\s*(\d{4,7})\b/,
    /IN[^a-zA-Z\n\d]{0,3}(\d{4,7})\b/,
  ];
  for (const pattern of inPatterns) {
    const match = cleaned.match(pattern);
    if (match) return `IN${match[1]}`;
  }

  const standaloneMatch = cleaned.match(/\b(55\d{4,7})\b/);
  if (standaloneMatch) return `IN${standaloneMatch[1]}`;

  return null;
}

// ── Main extraction entry point ──────────────────────────────────────────────

async function extractInvoiceFromPdf(pdfUrl, extractionId, googleVisionKey, ocrSpaceKey, msgId) {
  // Download — strict timeout. PODs are typically <2MB and live on
  // Microsoft 365 / SharePoint. A stuck connection here used to wedge a
  // whole lane until the parent's 120s backstop fired.
  emitProgress(msgId, 'download');
  let response;
  try {
    response = await fetchWithTimeout(pdfUrl, {}, 60_000);
  } catch (err) {
    throw new Error(`Download failed: ${err.message}`);
  }
  if (!response.ok) throw new Error(`Failed to download PDF: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length < 100 || !buffer.subarray(0, 5).toString().startsWith('%PDF')) {
    return { invoice: null, previewPath: null };
  }

  const isLarge = buffer.length > 2 * 1024 * 1024;

  // Step 1: pdfjs text layer (no OCR needed)
  emitProgress(msgId, 'pdf_text');
  try {
    const pdfjsLib = await getPdfjs();
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
    loadingTask.onUnsupportedFeature = () => {};
    const pdfDoc = await loadingTask.promise;
    for (let p = 1; p <= Math.min(pdfDoc.numPages, 3); p++) {
      const page = await pdfDoc.getPage(p);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(item => item.str).join(' ');
      if (pageText.trim()) {
        const invoice = findInvoiceNumber(pageText);
        if (invoice) {
          await pdfDoc.destroy();
          return { invoice, previewPath: null };
        }
      }
    }
    await pdfDoc.destroy();
  } catch { /* fall through to image render */ }

  // Step 2: render to image
  emitProgress(msgId, 'render');
  let imageBuffer;
  try {
    imageBuffer = await pdfPageToImage(buffer, 1, isLarge ? 1.5 : 2.0);
  } catch (err) {
    return { invoice: null, previewPath: null, error: `Render failed: ${err.message}` };
  }

  const sharp = await getSharp();

  // Save preview JPEG (async — does NOT block the loop)
  emitProgress(msgId, 'preview_save');
  let previewPath = null;
  try {
    const previewJpeg = await sharp(imageBuffer).resize({ width: 1200 }).jpeg({ quality: 70 }).toBuffer();
    const filename = `${extractionId}.jpg`;
    const fullPath = path.join(previewDir, filename);
    await fsp.writeFile(fullPath, previewJpeg);
    previewPath = `/api/bat/preview/${filename}`;
  } catch { /* preview save is best-effort */ }

  // Step 3: multi-engine OCR pipeline
  const ocrEngines = [];
  if (googleVisionKey) {
    ocrEngines.push({
      name: 'GoogleVision',
      run: async (angle) => {
        const jpeg = await sharp(imageBuffer).rotate(angle).resize({ width: 2400 }).jpeg({ quality: 85 }).toBuffer();
        return await ocrViaGoogleVision(jpeg, googleVisionKey);
      },
    });
  }
  ocrEngines.push(
    { name: 'ocr.space/e1', run: async (angle) => {
      const jpeg = await sharp(imageBuffer).rotate(angle).resize({ width: 2000 }).jpeg({ quality: 80 }).toBuffer();
      return await ocrViaOcrSpaceEngine(jpeg, '1', ocrSpaceKey);
    }},
    { name: 'ocr.space/e3', run: async (angle) => {
      const jpeg = await sharp(imageBuffer).rotate(angle).resize({ width: 2000 }).jpeg({ quality: 85 }).toBuffer();
      return await ocrViaOcrSpaceEngine(jpeg, '3', ocrSpaceKey);
    }},
    { name: 'Tesseract', run: async (angle) => {
      const tess = await getTesseract();
      const processed = await sharp(imageBuffer)
        .rotate(angle).greyscale().normalise().sharpen({ sigma: 2 }).threshold(140).png().toBuffer();
      const { data: { text } } = await tess.recognize(processed);
      return text;
    }},
    { name: 'Tesseract-noThresh', run: async (angle) => {
      const tess = await getTesseract();
      const processed = await sharp(imageBuffer)
        .rotate(angle).greyscale().normalise().sharpen({ sigma: 3 }).png().toBuffer();
      const { data: { text } } = await tess.recognize(processed);
      return text;
    }},
    { name: 'ocr.space/e2', run: async (angle) => {
      const jpeg = await sharp(imageBuffer).rotate(angle).resize({ width: 2000 }).jpeg({ quality: 80 }).toBuffer();
      return await ocrViaOcrSpaceEngine(jpeg, '2', ocrSpaceKey);
    }},
  );

  let tierError = null;
  for (const engine of ocrEngines) {
    for (const angle of [0, 90]) {
      // Stage label includes engine + rotation so the operator can see e.g.
      // "engine:Tesseract@90" in the UI when an OCR call is the slow one.
      const stageLabel = `engine:${engine.name}@${angle}`;
      emitProgress(msgId, stageLabel);
      try {
        // Per-engine 60s deadline. Tesseract.recognize, Google Vision and
        // ocr.space all have failure modes where the underlying call sits
        // forever (mostly network). The parent-side 120s PDF_TIMEOUT was
        // historically the only backstop, but it doesn't tell us *which*
        // engine wedged. Per-engine timeout makes the failure
        // attributable.
        const text = await withTimeout(engine.run(angle), 60_000, stageLabel);
        if (!text || text.trim().length < 20) continue;
        const invoice = findInvoiceNumber(text);
        if (invoice) return { invoice, previewPath };
      } catch (err) {
        if (err.tierError && !tierError) tierError = `${engine.name}: ${err.message}`;
        // If Tesseract crashed mid-run, surface so the main thread can rebuild this lane.
        if (engine.name.startsWith('Tesseract') && _tesseract) {
          try { await _tesseract.terminate().catch(() => {}); } catch {}
          _tesseract = null;
        }
      }
    }
  }

  return { invoice: null, previewPath, error: tierError };
}

// ── Message dispatch ─────────────────────────────────────────────────────────

parentPort.on('message', async (msg) => {
  if (!msg) return;
  if (msg.type === 'shutdown') {
    try { if (_tesseract) await _tesseract.terminate().catch(() => {}); } catch {}
    process.exit(0);
  }
  if (msg.type === 'extract') {
    const { id, payload } = msg;
    try {
      // Top-level 90s deadline. Even if every per-stage timeout fires
      // sequentially you can't exceed ~90s of real work for a single
      // PDF on a healthy site (download <60s, pdfjs text <5s, render
      // <10s, first engine <60s, but we short-circuit on first match).
      // 90s is the operator-visible "row time-out" — if a row is taking
      // longer, something is broken in the environment, and that fact
      // should reach the parent loud rather than hang for minutes.
      const result = await withTimeout(
        extractInvoiceFromPdf(
          payload.pdfUrl,
          payload.extractionId,
          payload.googleVisionKey,
          payload.ocrSpaceKey,
          id,
        ),
        90_000,
        'extract_total',
      );
      emitProgress(id, 'done');
      parentPort.postMessage({ type: 'result', id, ok: true, result });
    } catch (err) {
      // Surface the failing stage to the parent — emit a final progress
      // message before the result so the parent's `currentlyProcessing`
      // entry shows the failed stage on the way out.
      emitProgress(id, 'failed');
      parentPort.postMessage({
        type: 'result', id, ok: false,
        error: { message: err.message, stack: err.stack, tierError: !!err.tierError },
      });
    }
  }
});

parentPort.postMessage({ type: 'ready' });
