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

// Trained data ships with the app under vendor/tessdata/. We point
// tesseract.js at that directory instead of letting it download from
// tessdata.projectnaptha.com on first use — the app must work fully
// offline (firewalled sites, no internet, etc.). cacheMethod='none'
// stops it writing its own cache copy somewhere in os.tmpdir().
const TESSDATA_DIR = path.resolve(import.meta.dirname, '..', '..', 'vendor', 'tessdata');

async function getTesseract() {
  if (_tesseract) return _tesseract;
  const { createWorker } = await import('tesseract.js');

  // Verify trained data is present before init. If we just call createWorker
  // and the file's missing, tesseract.js silently falls back to its CDN URL
  // and the operator sees a 30s "tesseract_init timeout" that looks like a
  // network problem. Loud-fail with a clear cause instead.
  const trainedDataPath = path.join(TESSDATA_DIR, 'eng.traineddata.gz');
  try {
    await fsp.access(trainedDataPath);
  } catch {
    throw new Error(
      `Tesseract trained data missing at ${trainedDataPath}. ` +
      'The app ships this file with each release for offline OCR; reinstall the app to restore it.',
    );
  }

  // 30s init cap. With a local langPath this completes in ~1s — kept as a
  // backstop in case sharp/pdfjs native init wedges (AV interference, etc.).
  _tesseract = await withTimeout(
    createWorker('eng', 1, {
      langPath: TESSDATA_DIR,
      cacheMethod: 'none',
    }),
    30_000,
    'tesseract_init',
  );
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
  // Send the API key as a header instead of a query string. Earlier the
  // call was `...?key=${apiKey}` which leaks the credential into anything
  // that captures full URLs along the path (proxy access logs, Tailscale
  // flow records, ntopng, error stacks that include the request URL).
  // `X-Goog-API-Key` is the documented header form for the same auth.
  const res = await fetchWithTimeout('https://vision.googleapis.com/v1/images:annotate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-API-Key': apiKey,
    },
    body: JSON.stringify(body),
  }, 45_000);
  if (!res.ok) {
    const err = await res.text();
    // Cap response-body inclusion tighter (was 200 chars). Google's error
    // payloads echo the request shape but not the API key — still, keep
    // it as small as possible while still being diagnostically useful.
    throw new Error(`Google Vision HTTP ${res.status}: ${err.substring(0, 120)}`);
  }
  const data = await res.json();
  // Top-level error envelope. Returned with HTTP 200 when the request itself
  // was OK but the API rejected it for project-level reasons (key restricted,
  // Vision API not enabled, billing off). Without this check we silently
  // returned '' for every row and the cascade walked all the way down to
  // ocr.space → Tesseract on every PDF.
  if (data.error) {
    throw new Error(`Google Vision rejected: ${data.error.message || JSON.stringify(data.error).slice(0, 200)}`);
  }
  // Per-request error envelope. Vision API returns HTTP 200 with
  // `{ responses: [{ error: { code, message } }] }` for issues like quota
  // exceeded on this specific call, image too large, image format unsupported.
  // Same silent-empty-string trap if not surfaced.
  const perReqError = data.responses?.[0]?.error;
  if (perReqError) {
    throw new Error(`Google Vision per-request error: ${perReqError.message || JSON.stringify(perReqError).slice(0, 200)}`);
  }
  if (!Array.isArray(data.responses)) {
    throw new Error(`Google Vision unexpected response shape: ${JSON.stringify(data).slice(0, 200)}`);
  }
  const annotation = data.responses[0]?.fullTextAnnotation;
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

function findInvoiceNumber(text, inDigitLength = 9) {
  if (!text) return null;
  const cleaned = text
    .replace(/[|]/g, 'I')
    .replace(/[oO](?=\d{3,})/g, '0')
    .replace(/[lI](?=N\d)/g, 'I')
    .replace(/\*/g, '')
    .replace(/[{}[\]()]/g, '')
    .replace(/[—–-]{2,}/g, ' ');

  // Long-form numeric invoice (legacy "18000xxxxxx" format and the new
  // "1800042xxxxx" 11-12 digit form). Without the wider {8,10} range the
  // 10-digit-after-IN format that BAT rolled out recently was never
  // matched, every row hit no_regex_match, and the cascade walked the
  // whole engine list before timing out at extract_total.
  const longMatch = cleaned.match(/\b(18\d{8,10})\b/);
  if (longMatch) return 'IN' + longMatch[1].substring(2);

  // IN-prefixed long. Range widened from {8,9} to {8,10} for the
  // post-rollover 10-digit form. Padding to the per-site canonical length
  // (`inDigitLength`, default 9): a one-short read is treated as a
  // dropped-zero OCR error and padded; an at-or-above-length read is
  // returned as-is. Sites whose canonical IN format is 8 digits set
  // inDigitLength=8 so an 8-digit read isn't padded to 9.
  const inLongMatch = cleaned.match(/\bIN\s*(\d{8,10})\b/i);
  if (inLongMatch) {
    let digits = inLongMatch[1];
    if (digits.length < inDigitLength) digits = '0'.repeat(inDigitLength - digits.length) + digits;
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
      // Length range covers BAT's two known invoice formats:
      //   IN<9 digits>  → 11 chars (e.g. IN000422238 — pre-rollover)
      //   IN<10 digits> → 12 chars (e.g. IN0004225236 — post-rollover)
      // Pre-fix the lower bound was 12, which silently dropped every
      // 9-digit invoice the partial pattern caught — those rows then
      // fell all the way through the cascade to extract_total. Operator
      // sent us a real ENGEN KABOKWENI POD where GV correctly returned
      // "WNVOICE NO\n000422238" and we ignored it because IN000422238
      // is 11 chars. Now accepts 11-14.
      if (full.length >= 11 && full.length <= 14) return full;
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

// ── pdfUrl validation (defense in depth) ─────────────────────────────────────
//
// pdfUrl is supplied by the parent process, derived from BAT supplier
// spreadsheets. Suppliers host invoices on public CDN/SharePoint —
// nothing legitimate should ever resolve to a private/loopback/Tailscale
// range. Without a guard here, a tampered spreadsheet entry could turn
// the OCR pipeline into an SSRF probe of the internal LAN.
//
// Layered defence:
//   1. Require https:// — no http: PDF URLs from any real supplier.
//   2. Reject literal-IP hosts in private/loopback/link-local/Tailscale ranges.
//   3. Optional hostname allowlist (env OCR_PDF_ALLOWED_HOSTS=cdn.example.com,*.foo.com).
//      When set, the URL must match one entry.
//
// Residual risk: DNS rebinding (attacker-controlled domain resolving to a
// private IP). The hostname allowlist mitigates this in practice — an
// attacker domain isn't on the list. Stronger defence (custom dispatcher
// that re-checks resolved IP) is deferred until a supplier shape forces it.
const _PRIVATE_IPV4 = [
  /^127\./,                             // loopback
  /^10\./,                              // RFC1918
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,     // RFC1918
  /^192\.168\./,                        // RFC1918
  /^169\.254\./,                        // link-local
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // Tailscale CGNAT 100.64.0.0/10
  /^0\./,                               // 0.0.0.0/8 (unspecified)
];
const _PRIVATE_IPV6_PREFIXES = ['::1', 'fc', 'fd', 'fe80']; // loopback, ULA, link-local

function _isPrivateOrLoopbackHost(hostname) {
  // Node's URL parser KEEPS brackets around IPv6 literals in .hostname
  // (e.g. `new URL('https://[::1]/').hostname === '[::1]'`). Strip them
  // before any comparison or the prefix tests below silently pass.
  let lower = hostname.toLowerCase();
  if (lower.startsWith('[') && lower.endsWith(']')) lower = lower.slice(1, -1);
  if (lower === 'localhost') return true;
  if (lower === '::1') return true;
  // IPv4 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(lower)) {
    return _PRIVATE_IPV4.some(re => re.test(lower));
  }
  // IPv6 literal — match by prefix
  if (lower.includes(':')) {
    return _PRIVATE_IPV6_PREFIXES.some(p => lower.startsWith(p));
  }
  return false;
}

function _hostMatchesAllowEntry(host, entry) {
  const h = host.toLowerCase();
  const e = entry.toLowerCase();
  if (e.startsWith('*.')) {
    const suffix = e.slice(1); // ".example.com"
    return h.endsWith(suffix) && h !== suffix.slice(1);
  }
  return h === e;
}

function isAllowedPdfUrl(pdfUrl, allowedHostsEnv) {
  let u;
  try { u = new URL(pdfUrl); } catch { return { ok: false, reason: 'malformed_url' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: `protocol_not_https (${u.protocol})` };
  if (_isPrivateOrLoopbackHost(u.hostname)) return { ok: false, reason: `host_in_private_range (${u.hostname})` };
  const allowed = (allowedHostsEnv || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.length > 0) {
    const matches = allowed.some(entry => _hostMatchesAllowEntry(u.hostname, entry));
    if (!matches) return { ok: false, reason: `host_not_in_allowlist (${u.hostname})` };
  }
  return { ok: true };
}

// ── Bounded streamed download ────────────────────────────────────────────────
//
// Replaces `await response.arrayBuffer()`. Two reasons:
//   1. Content-Length header (when present) lets us reject early without
//      consuming the body.
//   2. Streaming with a running byte ceiling protects against missing or
//      lying content-length — a misbehaving CDN that streams forever, or a
//      200-OK HTML error page that's 50MB, would otherwise buffer the whole
//      thing into memory before any sanity check fires.
async function fetchBoundedBuffer(response, maxBytes) {
  const reportedLen = parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(reportedLen) && reportedLen > maxBytes) {
    throw new Error(`PDF size ${reportedLen} exceeds limit ${maxBytes}`);
  }
  if (!response.body) {
    // Fallback for environments where streaming isn't available.
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`PDF size ${buf.length} exceeds limit ${maxBytes}`);
    return buf;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new Error(`PDF size exceeds limit ${maxBytes} (cancelled at ${total} bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c)));
}

// ── Main extraction entry point ──────────────────────────────────────────────

const _MAX_PDF_BYTES = (() => {
  const n = parseInt(process.env.OCR_MAX_PDF_MB || '25', 10);
  if (!Number.isFinite(n) || n < 1) return 25 * 1024 * 1024;
  return n * 1024 * 1024;
})();

async function extractInvoiceFromPdf(pdfUrl, extractionId, googleVisionKey, ocrSpaceKey, msgId, inDigitLength = 9) {
  // SSRF guard — see isAllowedPdfUrl above.
  const urlCheck = isAllowedPdfUrl(pdfUrl, process.env.OCR_PDF_ALLOWED_HOSTS);
  if (!urlCheck.ok) {
    throw new Error(`PDF URL rejected: ${urlCheck.reason}`);
  }

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
  const buffer = await fetchBoundedBuffer(response, _MAX_PDF_BYTES);

  if (buffer.length < 100 || !buffer.subarray(0, 5).toString().startsWith('%PDF')) {
    return { invoice: null, previewPath: null };
  }

  const isLarge = buffer.length > 2 * 1024 * 1024;

  // Step 1: pdfjs text layer (no OCR needed). 20s hard cap — corrupt /
  // encrypted PDFs can hang in pdfjs.getDocument(). On error we forward
  // the message to the parent so the operator sees `bat.ocr.pdf_text_failed`
  // rather than a silent fall-through to image render.
  emitProgress(msgId, 'pdf_text');
  try {
    const result = await withTimeout((async () => {
      const pdfjsLib = await getPdfjs();
      const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
      loadingTask.onUnsupportedFeature = () => {};
      const pdfDoc = await loadingTask.promise;
      try {
        for (let p = 1; p <= Math.min(pdfDoc.numPages, 3); p++) {
          const page = await pdfDoc.getPage(p);
          const textContent = await page.getTextContent();
          const pageText = textContent.items.map(item => item.str).join(' ');
          if (pageText.trim()) {
            const invoice = findInvoiceNumber(pageText, inDigitLength);
            if (invoice) return { invoice };
          }
        }
        return null;
      } finally {
        try { await pdfDoc.destroy(); } catch {}
      }
    })(), 20_000, 'pdf_text');
    if (result?.invoice) return { invoice: result.invoice, previewPath: null };
  } catch (err) {
    // Forward to parent — visible in System Log, doesn't abort the row
    // (we still try image render below).
    try {
      parentPort.postMessage({
        type: 'engine_error',
        id: msgId,
        engine: 'pdf_text',
        angle: 0,
        stage: 'pdf_text',
        message: String(err?.message || err).slice(0, 500),
        tierError: false,
      });
    } catch {}
  }

  // Step 2: render to image. 30s hard cap — pdfjs + node-canvas can hang
  // forever on a malformed PDF (the page.render Promise never resolves).
  // Without this cap, render hangs ate ~90s of the per-row budget on every
  // bad PDF and the row only ever surfaced as a generic 'extract_total'
  // timeout with no stage attribution.
  emitProgress(msgId, 'render');
  let imageBuffer;
  try {
    imageBuffer = await withTimeout(pdfPageToImage(buffer, 1, isLarge ? 1.5 : 2.0), 30_000, 'render');
  } catch (err) {
    return { invoice: null, previewPath: null, error: `Render failed: ${err.message}` };
  }

  const sharp = await getSharp();

  // Save preview JPEG (best-effort — never aborts the row, but failures
  // are now logged. Without this, a permission-denied or disk-full on
  // previewDir broke every preview thumbnail and the operator thought
  // it was a UI bug rather than a filesystem one).
  emitProgress(msgId, 'preview_save');
  let previewPath = null;
  try {
    const previewJpeg = await sharp(imageBuffer).resize({ width: 1200 }).jpeg({ quality: 70 }).toBuffer();
    const filename = `${extractionId}.jpg`;
    const fullPath = path.join(previewDir, filename);
    await fsp.writeFile(fullPath, previewJpeg);
    previewPath = `/api/bat/preview/${filename}`;
  } catch (err) {
    try {
      parentPort.postMessage({
        type: 'engine_error',
        id: msgId,
        engine: 'preview_save',
        angle: 0,
        stage: 'preview_save',
        message: String(err?.message || err).slice(0, 500),
        tierError: false,
      });
    } catch {}
  }

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
        // Two silent fall-throughs that bit us hard in production: the
        // engine returned text but it was either too short to be useful
        // OR the invoice-number regex didn't match. Both used to silently
        // `continue` to the next engine with no log entry — so a row that
        // walked all 12 engine slots without a single throw and then hit
        // extract_total looked like "everything is broken" instead of
        // "GV+ocr.space+Tesseract all returned text but findInvoiceNumber
        // didn't recognise the format". Now both cases emit
        // bat.ocr.engine_no_match so the operator can see the actual text
        // each engine returned.
        if (!text || text.trim().length < 20) {
          try {
            parentPort.postMessage({
              type: 'engine_no_match',
              id: msgId,
              engine: engine.name,
              angle,
              stage: stageLabel,
              reason: 'short_text',
              text_length: (text || '').length,
              text_preview: (text || '').slice(0, 1000),
            });
          } catch {}
          continue;
        }
        const invoice = findInvoiceNumber(text, inDigitLength);
        if (invoice) return { invoice, previewPath };
        // Text was returned but findInvoiceNumber couldn't parse an invoice
        // number out of it. This is the most-likely cause of "everything
        // times out at extract_total" on a site where OCR is configured
        // correctly: GV reads the page fine, but the page formatting is
        // unfamiliar to the regex and the cascade walks every engine
        // without finding a match.
        try {
          parentPort.postMessage({
            type: 'engine_no_match',
            id: msgId,
            engine: engine.name,
            angle,
            stage: stageLabel,
            reason: 'no_regex_match',
            text_length: text.length,
            // Bumped from 300 → 1500 so the operator can see whether the
            // invoice number is actually anywhere in the engine's output.
            // Without enough context "no_regex_match" was indistinguishable
            // from "engine missed the invoice region of the page entirely".
            text_preview: text.slice(0, 1500),
          });
        } catch {}
      } catch (err) {
        // Surface per-engine failures to the parent for System Log
        // attribution. Without this, a misconfigured Google Vision (key
        // valid but Vision API not enabled, IP-restricted, billing off,
        // etc.) was indistinguishable from "GV ran fine, just no text" —
        // the cascade silently moved to ocr.space and the operator never
        // saw why. The parent translates these into bat.ocr.engine_failed
        // System Log entries.
        try {
          parentPort.postMessage({
            type: 'engine_error',
            id: msgId,
            engine: engine.name,
            angle,
            stage: stageLabel,
            message: String(err?.message || err).slice(0, 500),
            tierError: !!err?.tierError,
          });
        } catch {}
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
          payload.inDigitLength,
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
      // Self-terminate after any timeout-class error.
      //
      // Why: Node's worker_threads can't preempt synchronous native code.
      // When extract_total / per-engine / tesseract_init timeouts fire,
      // the await rejects but the underlying Tesseract.recognize / sharp
      // / canvas call is still occupying the worker's V8 thread. The
      // worker postMessages the error back to the parent and looks
      // "free" from the JS side, but the next 'extract' message can't
      // be processed until the native code naturally completes. Memory
      // stays held, the worker thread stays busy, the queue effectively
      // stops moving — exactly the "timeout → workers stuck → only a
      // restart frees them" pattern operators have been hitting.
      //
      // process.exit kills the worker thread cleanly. The parent's
      // OcrLane.exit handler fires, failAll wakes any pending slot, the
      // catch in runLane sees lane.worker.dead and recreates the lane
      // with a fresh worker. Memory freed, native handles released,
      // queue keeps moving.
      //
      // setImmediate gives postMessage above a tick to flush before we
      // exit, so the parent reliably gets the result message.
      const msg = String(err?.message || '');
      const isTimeoutKind =
        /Timeout in stage:|extract_total|tesseract_init|engine:/.test(msg);
      if (isTimeoutKind) {
        setImmediate(() => process.exit(1));
      }
    }
  }
});

parentPort.postMessage({ type: 'ready' });
