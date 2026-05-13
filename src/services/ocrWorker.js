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
import { findInvoiceNumber, HARDCODED_POISON_INVOICES } from './bat/findInvoiceNumber.js';

const { previewDir } = workerData || {};

// Per-network-call timeout. Without this, a hung S3/CDN connection or a
// stalled OCR-engine response would await forever inside the worker — the
// parent's PDF_TIMEOUT (120s) is supposed to back it up, but it relies on
// the worker eventually responding to the postMessage round-trip and a few
// edge cases (worker terminate races) have left lanes hung at 9+ minutes.
// These per-call abort signals are the real fix; the parent timeout stays
// as a backstop.
// All timeout errors emitted in this worker are tagged with a structured
// code so downstream lifecycle decisions (self-terminate, lane recycle,
// classification) don't depend on regex-matching the message text. The
// human-readable message is preserved for logs.
function makeTimeoutError(stage, timeoutMs) {
  const err = new Error(`Timeout after ${timeoutMs}ms in stage: ${stage}`);
  err.code = 'OCR_TIMEOUT';
  err.stage = stage;
  err.timeoutMs = timeoutMs;
  return err;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 30_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(makeTimeoutError('fetch', timeoutMs)), timeoutMs);
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
    const t = setTimeout(() => reject(makeTimeoutError(label, timeoutMs)), timeoutMs);
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

// ── Per-engine rate-limit cooldown ──────────────────────────────────────────
//
// When an engine returns a rate-limit response (HTTP 429 from any engine
// or ocr.space's E552 inner code), park it for ENGINE_COOLDOWN_MS. The
// cascade skips a cooled engine before calling it, emitting an info-level
// engine_error so the operator sees the skip in System Log.
//
// Why this matters: today's production trace showed the cascade firing
// ocr.space/e3 against every row even after E552 came back, burning the
// per-engine 60 s timeout × 12 cascade slots × every row. Result: rows
// blew extract_total (90 s), workers self-terminated, lanes retired.
// One engine being rate-limited shouldn't kill the run for every other
// row; cooldown breaks that cascade.
//
// Per-worker state — with 4 lanes, each worker independently learns the
// cooldown within a few rows. The staggering is fine because the cooldown
// is short relative to a recon run.
const ENGINE_COOLDOWN_MS = 60_000;
const _engineCooldowns = new Map(); // engineName → expiresAtMs

function isEngineCool(name) {
  const expiresAt = _engineCooldowns.get(name);
  if (!expiresAt) return false;
  if (Date.now() < expiresAt) return true;
  _engineCooldowns.delete(name);
  return false;
}
function markEngineCooldown(name) {
  _engineCooldowns.set(name, Date.now() + ENGINE_COOLDOWN_MS);
}
function isRateLimitError(err) {
  const msg = String(err?.message || '');
  return /HTTP 429|E552|rate.?limit/i.test(msg);
}

let _tesseract = null;
let _sharp = null;
let _pdfjs = null;
// _canvas removed: rendering moved out-of-process to renderPdfChild.js.
// pdfjs is still loaded HERE for the text-layer fast-path (page.getTextContent),
// which doesn't wedge in native code the way page.render() does.

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
  // Disable libvips's operation cache. The default holds up to 50 MB of
  // cached intermediate buffers across sharp calls. For OCR pipelines
  // the cache hit ratio is negligible (each page is unique) so the cache
  // is mostly a memory sink that contributes to the leak signature seen
  // in `bat.ocr.memory` metrics. The lane-level recycle in
  // batReconciliation.js still runs as the primary defence; this just
  // removes one source of growth.
  try { _sharp.cache(false); } catch {}
  return _sharp;
}

async function getPdfjs() {
  if (_pdfjs) return _pdfjs;
  _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return _pdfjs;
}

// ── PDF render ───────────────────────────────────────────────────────────────

// Rendering now runs inside a SHORT-LIVED CHILD PROCESS via
// renderPdfInChild → renderPdfChild.js, which uses PDFium
// (@hyzyla/pdfium, WASM) instead of pdfjs+node-canvas. node-canvas
// is no longer a dependency; pdfjs stays here ONLY for the
// text-layer fast-path (getTextContent), which has no canvas
// involvement and was never affected by the wedge / ImageBitmap
// issues that drove Phase 1 + 2 of the migration. See
// docs/plans/pdf-engine-migration.md for the full story.
// Cap the rendered raster width so a single PDF page can't consume
// hundreds of MB of native memory. Buffer size is width × height × 4
// bytes (RGBA); at 6000×8000 that's 192MB *uncompressed*, and
// node-canvas keeps the full bitmap allocated until toBuffer returns.
// On the production hub we observed RSS 2.8GB after 5 rows on a queue
// of large-format POD PDFs, with the lane-recycle watchdog losing the
// race to the next render.
//
// Env override for sites with a different OCR-quality / memory tradeoff.
// 2400px is comfortably inside Google Vision's recommended input range
// (1024–2400) and gives Tesseract enough resolution for invoice-number
// text, while bounding raw RGBA at ~2400 × 3400 × 4 = 32 MB per page.
//
// Defensive parse: parseInt('', 10) and parseInt('not-a-number', 10) both
// return NaN, and Math.max(800, NaN) is NaN — that NaN propagates into
// page.getViewport({ scale: NaN }) and createCanvas(NaN, NaN), failing
// the render stage on every PDF. So we validate the parse before
// clamping and fall back to the default for missing/malformed values.
const DEFAULT_MAX_RENDER_WIDTH = 2400;
const MIN_RENDER_WIDTH = 800;
const _envMaxRenderWidth = parseInt(process.env.OCR_MAX_RENDER_WIDTH ?? '', 10);
const MAX_RENDER_WIDTH = Number.isFinite(_envMaxRenderWidth) && _envMaxRenderWidth > 0
  ? Math.max(MIN_RENDER_WIDTH, _envMaxRenderWidth)
  : DEFAULT_MAX_RENDER_WIDTH;

// Total raster pixels cap. Width-only capping was insufficient — a tall
// A3 POD at 2400px wide is still ~12 MP, and that's enough to wedge
// node-canvas on production hubs even after PR #230. Cap total area too
// so the chosen scale steps down for tall pages, not just wide ones.
// Buffer = pixels × 4 bytes (RGBA), so 6 MP ≈ 24 MB peak per render.
const DEFAULT_MAX_RENDER_PIXELS = 6_000_000;
const MIN_RENDER_PIXELS = 800 * 800;
const _envMaxRenderPixels = parseInt(process.env.OCR_MAX_RENDER_PIXELS ?? '', 10);
const MAX_RENDER_PIXELS = Number.isFinite(_envMaxRenderPixels) && _envMaxRenderPixels > 0
  ? Math.max(MIN_RENDER_PIXELS, _envMaxRenderPixels)
  : DEFAULT_MAX_RENDER_PIXELS;

// Height cap separate from width — A4 portrait at the width cap is ~3400px
// tall, but multi-page-merged or banner-format PDFs run 8000+px at the
// same width.
const DEFAULT_MAX_RENDER_HEIGHT = 4000;
const MIN_RENDER_HEIGHT = 800;
const _envMaxRenderHeight = parseInt(process.env.OCR_MAX_RENDER_HEIGHT ?? '', 10);
const MAX_RENDER_HEIGHT = Number.isFinite(_envMaxRenderHeight) && _envMaxRenderHeight > 0
  ? Math.max(MIN_RENDER_HEIGHT, _envMaxRenderHeight)
  : DEFAULT_MAX_RENDER_HEIGHT;

// Floor scale below which we refuse to render. A render at scale < 0.3
// makes invoice numbers unreadable, so handing the page to pdfjs at that
// scale is strictly worse than refusing — the operator at least sees a
// loud reason in the System Log instead of waiting 2 minutes for the
// inevitable parent-side PDF_TIMEOUT.
const MIN_RENDER_SCALE = 0.3;

// Wall-clock cap the PARENT (this worker thread) enforces on the
// render-child process. Same envelope as the previous in-worker timeout,
// but actually enforceable now: the parent process is on the safe side
// of any native wedge, so its setTimeout can always fire.
// Floor is 1000ms — operators in incident-response sometimes
// intentionally set a 1s kill window to drop a stuck batch fast.
// `>=`, not `>`: the previous strict-> let exactly 1000 silently
// fall back to the 30s default, which made the documented floor
// behave unpredictably (set 1000, get 30000).
const DEFAULT_RENDER_CHILD_TIMEOUT_MS = 30_000;
const RENDER_CHILD_TIMEOUT_FLOOR_MS = 1000;
const _envRenderChildTimeoutMs = parseInt(process.env.OCR_RENDER_CHILD_TIMEOUT_MS ?? '', 10);
const RENDER_CHILD_TIMEOUT_MS = Number.isFinite(_envRenderChildTimeoutMs) && _envRenderChildTimeoutMs >= RENDER_CHILD_TIMEOUT_FLOOR_MS
  ? _envRenderChildTimeoutMs
  : DEFAULT_RENDER_CHILD_TIMEOUT_MS;

// pdfPageToImage now hosts pdfjs+node-canvas in a short-lived child
// process. The render either completes within the wall-clock timeout
// or the parent SIGKILLs it — a wedge inside native code can't take
// down this worker thread, and a wedge can't accumulate libcairo state
// across renders because each render gets a fresh process. See
// docs/plans/pdf-engine-migration.md (Phase 1) for the architectural
// rationale and src/services/ocr/spawnRenderChild.js for the wrapper.
async function pdfPageToImage(buffer, pageNum, requestedScale = 2.0) {
  const { renderPdfInChild } = await import('./ocr/spawnRenderChild.js');
  return renderPdfInChild(buffer, {
    pageNum,
    requestedScale,
    maxWidth: MAX_RENDER_WIDTH,
    maxHeight: MAX_RENDER_HEIGHT,
    maxPixels: MAX_RENDER_PIXELS,
    minScale: MIN_RENDER_SCALE,
    timeoutMs: RENDER_CHILD_TIMEOUT_MS,
  });
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

// findInvoiceNumber (and the regex pipeline) lives in ./bat/findInvoiceNumber.js.
// Both this worker and batReconciliation.js import from there so the
// patterns can never drift apart again. Don't re-define here.

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
  // Allow http: and https: only — reject ftp:, file:, gopher:, etc.
  // The original 2026.5.2 cut required https: only, but the BAT supplier
  // hosts PODs over plain HTTP. The HTTPS-only check rejected every
  // legitimate row in production, so OCR was completely dead until
  // operators applied a manual PowerShell patch on the install.
  // The private-IP guard below remains the primary SSRF defence —
  // protocol scheme alone doesn't tell us anything about the target.
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, reason: `protocol_unsupported (${u.protocol})` };
  }
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

// Default cap raised from 25 to 100 MB. The original 25 MB ceiling
// was set by #207 against the typical POD-scan size (~2 MB) but real
// BAT PODs can exceed 25 MB on high-resolution multi-page scans —
// extraction id=280 was 39.6 MB and got rejected. 100 MB is well
// above any legitimate POD while still protecting against the
// original attack shapes (hostile CDN streaming forever, 50 MB
// HTML error pages, etc.). Operators can tighten via env if they
// know their PODs run smaller.
const _MAX_PDF_BYTES = (() => {
  const n = parseInt(process.env.OCR_MAX_PDF_MB || '100', 10);
  if (!Number.isFinite(n) || n < 1) return 100 * 1024 * 1024;
  return n * 1024 * 1024;
})();

async function extractInvoiceFromPdf(pdfUrl, extractionId, googleVisionKey, ocrSpaceKey, msgId, inDigitLength = 9, excludeSet = null) {
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
    return { invoice: null, previewPath: null, source: 'invalid_pdf' };
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
            const invoice = findInvoiceNumber(pageText, inDigitLength, excludeSet);
            if (invoice) return { invoice };
          }
        }
        return null;
      } finally {
        try { await pdfDoc.destroy(); } catch {}
      }
    })(), 20_000, 'pdf_text');
    if (result?.invoice) {
      // pdf_text-layer hit (no rasterisation, no OCR engine). Recorded
      // with source='pdf_text' so audit / forensics can distinguish
      // text-layer matches from OCR-cascade matches — the former is
      // ~free and ~always correct; the latter is OCR'd text and worth
      // a human glance.
      return { invoice: result.invoice, previewPath: null, source: 'pdf_text', engine: 'pdfjs', angle: 0 };
    }
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

  // Step 2: render to image. The render now runs in a SHORT-LIVED CHILD
  // PROCESS (see src/services/ocr/spawnRenderChild.js); the wrapper
  // enforces a wall-clock timeout (default 30s, env OCR_RENDER_CHILD_TIMEOUT_MS)
  // backed by SIGTERM → grace → SIGKILL. The previous outer
  // `withTimeout(...,30_000)` is now removed — it was both redundant
  // with the child wrapper's bounded completion AND actively harmful:
  // any value above 30s set via OCR_RENDER_CHILD_TIMEOUT_MS would be
  // silently ignored because the outer 30s fired first, and the child
  // would keep running orphaned (the outer rejection didn't kill it).
  // The child-process wrapper is now the single source of truth for
  // render-stage timeouts.
  emitProgress(msgId, 'render');
  let imageBuffer;
  try {
    // Bumped from 1.5/2.0 → 2.0/3.0 alongside Phase 2's PDFium swap.
    // Round-2 of OCR regression testing on real PODs showed digit-level
    // misreads (the cascade engine was confidently picking the wrong
    // digit on borderline-resolution renders). More pixels per page =
    // more signal for digit recognition. The per-page caps in
    // renderPdfChild (maxWidth / maxHeight / maxPixels) clamp this back
    // down for banner-format / multi-page-merged PDFs, so the bump is
    // additive only — pages that were already against the cap don't
    // get any larger.
    imageBuffer = await pdfPageToImage(buffer, 1, isLarge ? 2.0 : 3.0);
  } catch (err) {
    // The child-process wrapper rejects with structured codes:
    //   - 'RENDER_TIMEOUT'      → wall-clock kill fired (SIGKILL after grace).
    //                             The wedge can't have leaked back into this
    //                             thread because the OS reaped the child.
    //   - 'PAGE_TOO_LARGE'      → preflight reject (page exceeds the configured
    //                             pixel / width / height caps). Operator-readable.
    //   - 'CHILD_FAILED'        → child exited non-zero without a structured stderr
    //                             line (rare; usually a pdfjs internal throw on a
    //                             malformed PDF).
    //   - 'CHILD_SPAWN_FAILED'  → couldn't even start the child process. Indicates
    //                             a Node binary / packaging issue, not a PDF issue.
    //   - 'BAD_INPUT'           → empty / non-Buffer arrived at the wrapper.
    // The pre-Phase-1 'OCR_TIMEOUT' from the old in-worker withTimeout is
    // gone — that classifier branch is kept for back-compat only and won't
    // fire under the new code path.
    const code = err?.code || 'render_failed';
    const isTimeout       = code === 'RENDER_TIMEOUT' || err?.code === 'OCR_TIMEOUT';
    const isPreflight     = code === 'PAGE_TOO_LARGE' || String(err?.message || '').startsWith('PDF page ');
    const isSpawnFailure  = code === 'CHILD_SPAWN_FAILED';
    let detail;
    if (isPreflight) {
      detail = err.message; // already operator-readable
    } else if (isTimeout) {
      detail =
        `Render child wall-clock killed after ${err.timeoutMs || 30000}ms. ` +
        `The OS SIGKILL'd the wedged renderer; this worker thread is unaffected. ` +
        `If this URL keeps wedging, it has been added to the per-run skip list to stop ` +
        `it grinding the rest of the queue. Operator action: download the PDF URL ` +
        `manually and inspect it (banner-format, multi-page-merged, or scans with very ` +
        `large embedded images are the usual culprits). To allow slower-but-valid PDFs ` +
        `more time, raise OCR_RENDER_CHILD_TIMEOUT_MS in the site's .env.`;
    } else if (isSpawnFailure) {
      detail =
        `Could not spawn the render child process: ${err?.message || String(err)}. ` +
        `This is a packaging / Node-binary issue, NOT a PDF issue. Check that ` +
        `the app's bundled node.exe exists and is runnable.`;
    } else {
      detail = `Underlying error (${code}): ${err?.message || String(err)}`;
    }
    return {
      invoice: null,
      previewPath: null,
      source: 'render_failed',
      error: `Render of PDF page 1 failed in the OCR worker. URL: ${pdfUrl}. ${detail}`,
    };
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
  //
  // Per-PDF jpeg memo keyed by (angle, width, quality). The sharp
  // pipeline is eager (decode → rotate → resize → encode) and engines
  // with identical preprocessing — e.g. ocr.space/e1 and ocr.space/e2
  // both use width=2000 quality=80 — would otherwise rebuild the same
  // JPEG twice. Cache the Promise so a second caller awaits the same
  // in-flight work instead of starting a duplicate pipeline.
  // Tesseract has its own (greyscale/threshold) pipeline so it stays
  // outside the cache.
  const jpegCache = new Map();
  const cachedJpeg = (angle, width, quality) => {
    const key = `${angle}|${width}|${quality}`;
    let p = jpegCache.get(key);
    if (!p) {
      p = sharp(imageBuffer).rotate(angle).resize({ width }).jpeg({ quality }).toBuffer();
      jpegCache.set(key, p);
    }
    return p;
  };

  const ocrEngines = [];
  if (googleVisionKey) {
    ocrEngines.push({
      name: 'GoogleVision',
      run: async (angle) => {
        const jpeg = await cachedJpeg(angle, 2400, 85);
        return await ocrViaGoogleVision(jpeg, googleVisionKey);
      },
    });
  }
  ocrEngines.push(
    { name: 'ocr.space/e1', run: async (angle) => {
      const jpeg = await cachedJpeg(angle, 2000, 80);
      return await ocrViaOcrSpaceEngine(jpeg, '1', ocrSpaceKey);
    }},
    { name: 'ocr.space/e3', run: async (angle) => {
      const jpeg = await cachedJpeg(angle, 2000, 85);
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
      // Same preprocessing as ocr.space/e1 (width 2000, quality 80) —
      // cached promise reused, sharp not invoked twice.
      const jpeg = await cachedJpeg(angle, 2000, 80);
      return await ocrViaOcrSpaceEngine(jpeg, '2', ocrSpaceKey);
    }},
  );

  let tierError = null;
  // Track whether ANY engine in this row's cascade returned readable
  // text that simply didn't match the invoice regex. Drives the source
  // value at the bottom — distinguishes "regex problem" from "engines
  // are all down". A row where every engine errored / returned <20
  // chars / was rate-limited yields source='all_engines_failed' so
  // the parent's regex-streak circuit breaker doesn't count it (those
  // are healthy retry candidates, not regex misses).
  let sawReadableText = false;
  for (const engine of ocrEngines) {
    // Per-engine cooldown — when this engine returned a rate-limit
    // response (HTTP 429 / ocr.space E552) on a recent row, skip it for
    // the remainder of the cooldown window. Stops the cascade burning
    // extract_total budget on an engine that's actively rate-limiting,
    // and emits an info-level engine_failed so the operator can see
    // why the engine was skipped.
    if (isEngineCool(engine.name)) {
      try {
        parentPort.postMessage({
          type: 'engine_error',
          id: msgId,
          engine: engine.name,
          angle: 0,
          stage: `engine:${engine.name}@cooldown`,
          message: `Skipped — rate-limit cooldown active (until ${new Date(_engineCooldowns.get(engine.name)).toISOString()})`,
          tierError: false,
          cooldown: true,
        });
      } catch {}
      continue;
    }
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
        // Mark that this row got at least one engine's worth of readable
        // text — so when the cascade exits without a match, we can tell
        // the parent it was a regex miss (not an all-engines-down miss).
        sawReadableText = true;
        const invoice = findInvoiceNumber(text, inDigitLength, excludeSet);
        if (invoice) {
          // OCR-cascade hit. Engine + angle let the operator audit
          // "which path produced this number" — useful when a row's
          // invoice is later disputed in BAT reconciliation.
          return { invoice, previewPath, source: 'ocr_cascade', engine: engine.name, angle };
        }
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
        // Rate-limited? Park the engine so the next row skips it before
        // burning another 60s wedge. Catches both HTTP 429 (most engines)
        // and ocr.space's E552 inner code.
        const rateLimited = isRateLimitError(err);
        if (rateLimited) markEngineCooldown(engine.name);
        try {
          parentPort.postMessage({
            type: 'engine_error',
            id: msgId,
            engine: engine.name,
            angle,
            stage: stageLabel,
            message: String(err?.message || err).slice(0, 500),
            tierError: !!err?.tierError,
            rateLimited,
          });
        } catch {}
        if (err.tierError && !tierError) tierError = `${engine.name}: ${err.message}`;
        // If Tesseract crashed mid-run, surface so the main thread can rebuild this lane.
        if (engine.name.startsWith('Tesseract') && _tesseract) {
          try { await _tesseract.terminate().catch(() => {}); } catch {}
          _tesseract = null;
        }
        // After marking cooldown, no point trying angle 90 of the same
        // engine immediately — break out to the next engine.
        if (rateLimited) break;
      }
    }
  }

  // Two distinct exit states:
  //
  //   cascade_exhausted   — at least one engine returned readable text
  //                         (≥20 chars) but findInvoiceNumber couldn't
  //                         pull an invoice out. THIS is the regex-
  //                         mismatch signal the parent's circuit
  //                         breaker watches for.
  //
  //   all_engines_failed  — no engine got past the readable-text bar.
  //                         Could be every engine throwing (network /
  //                         API tier / rate limit), short_text from
  //                         every engine, or all-cooldown skips.
  //                         These rows are healthy retry candidates;
  //                         the parent's regex-streak counter does
  //                         NOT increment on them.
  return {
    invoice: null,
    previewPath,
    source: sawReadableText ? 'cascade_exhausted' : 'all_engines_failed',
    error: tierError,
  };
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
      // Build the exclude set: parent-supplied dynamic blacklist (numbers
      // that have already been extracted from N+ PODs in this recon)
      // unioned with the hard-coded artefact list. The parent re-computes
      // the dynamic part per row, so each extract call gets a fresh view.
      const excludeSet = new Set(HARDCODED_POISON_INVOICES);
      if (Array.isArray(payload.excludeInvoices)) {
        for (const inv of payload.excludeInvoices) excludeSet.add(inv);
      }
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
          excludeSet,
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
      // Pass the structured code/stage through the postMessage so the
      // parent can classify without parsing message text. Worker_threads
      // serialise plain objects, not Error instances, so we copy the
      // enumerable fields explicitly.
      parentPort.postMessage({
        type: 'result', id, ok: false,
        error: {
          message: err.message,
          stack: err.stack,
          code: err.code,
          stage: err.stage,
          timeoutMs: err.timeoutMs,
          tierError: !!err.tierError,
        },
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
      //
      // Switched from regex-matching the error message to a structured
      // err.code check. The previous form
      //   /Timeout in stage:|extract_total|tesseract_init|engine:/.test(msg)
      // would silently disable self-termination if a future code change
      // reworded any of those four substrings — and the worker would
      // then hang on to native memory across calls.
      if (err?.code === 'OCR_TIMEOUT') {
        setImmediate(() => process.exit(1));
      }
    }
  }
});

parentPort.postMessage({ type: 'ready' });
