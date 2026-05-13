// Standalone child-process renderer for the OCR pipeline.
//
// Why this exists: pdfjs.page.render() + node-canvas periodically wedges
// inside native code on certain PDFs (banner-format, multi-page-merged,
// malformed). When that happens inside a worker_thread, worker.terminate()
// returns to the parent without actually reaping the wedged thread — the
// thread keeps holding a libcairo internal mutex / font cache lock, and
// every replacement worker we spawn wedges on its first render trying to
// acquire the same mutex. The only thing that recovers it is the OS
// reaping the whole Node process.
//
// Hosting the renderer in a SHORT-LIVED CHILD PROCESS lets the parent
// SIGKILL it on timeout. The OS releases everything the child held —
// libcairo state, font cache, file handles, memory. The parent process
// (and the worker_thread that spawned the child) keep running.
//
// Phase 2 of docs/plans/pdf-engine-migration.md will swap pdfjs+node-canvas
// for a Node-native engine (PDFium / poppler / mupdf-js) INSIDE this
// child. The parent-side spawn / SIGKILL / transport machinery in
// spawnRenderChild.js is unchanged by that swap.
//
// Protocol:
//   stdin:  PDF bytes (raw)
//   argv[2]: JSON parameters — { pageNum, requestedScale, maxWidth,
//                                maxHeight, maxPixels, minScale,
//                                jpegQuality }
//   stdout: JPEG bytes (raw) on success
//   stderr: ONE line of JSON on failure: { code, message, ...details }
//   exit:   0 on success, 1 on any failure

import { Buffer } from 'buffer';

// IDLE timeout (reset on each data event), not a wall-clock from start
// of read. A large valid PDF (up to OCR_MAX_PDF_MB on the worker side,
// default 25 MB) can legitimately take longer than a fixed 10s to
// transit a slow pipe / busy event loop, so a wall-clock timer
// classified a healthy transfer as STDIN_TIMEOUT and the child exited
// while data was still streaming. Idle-timeout fires only when no
// chunk has arrived for N ms — handles a stuck-from-the-start parent
// AND a parent that started transmitting then froze.
const STDIN_IDLE_TIMEOUT_MS = 10_000;

async function main() {
  // ── Parse args ────────────────────────────────────────────────────
  const paramsJson = process.argv[2];
  if (!paramsJson) {
    failStructured({ code: 'BAD_ARGS', message: 'missing JSON parameters argv[2]' });
  }
  let params;
  try {
    params = JSON.parse(paramsJson);
  } catch (e) {
    failStructured({ code: 'BAD_ARGS', message: `argv[2] is not valid JSON: ${e.message}` });
  }

  const {
    pageNum = 1,
    requestedScale = 2.0,
    maxWidth = 2400,
    maxHeight = 4000,
    maxPixels = 6_000_000,
    minScale = 0.3,
    jpegQuality = 0.85,
  } = params || {};

  // Validate every numeric arg so a bad parent doesn't propagate NaN
  // into pdfjs / node-canvas and cause an unrelated downstream crash.
  for (const [k, v] of Object.entries({ pageNum, requestedScale, maxWidth, maxHeight, maxPixels, minScale, jpegQuality })) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      failStructured({ code: 'BAD_ARGS', message: `parameter ${k} must be a positive finite number, got ${JSON.stringify(v)}` });
    }
  }

  // ── Read PDF bytes from stdin ─────────────────────────────────────
  const pdfBuffer = await readStdinWithIdleTimeout(STDIN_IDLE_TIMEOUT_MS);
  if (pdfBuffer.length === 0) {
    failStructured({ code: 'EMPTY_INPUT', message: 'no PDF bytes received on stdin' });
  }

  // ── Lazy-import the heavy renderer ────────────────────────────────
  // Imports are inside main() so that argv-validation failures don't
  // pay the pdfjs+node-canvas startup cost (~150ms each).
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('canvas');

  // ── Render ────────────────────────────────────────────────────────
  const pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
  let canvas = null;
  try {
    const page = await pdfDoc.getPage(pageNum);
    // Cap the chosen scale against ALL three limits (width, height,
    // total pixels). Width-only capping let tall A3 / banner-format
    // PODs through at 12+ MP, which is exactly what wedged production
    // — see PR #237 for the original investigation.
    const baseViewport = page.getViewport({ scale: 1.0 });
    const widthCap  = maxWidth  / baseViewport.width;
    const heightCap = maxHeight / baseViewport.height;
    const baseArea  = baseViewport.width * baseViewport.height;
    // Pixel area scales as scale², so the scale that lands at exactly
    // maxPixels is sqrt(maxPixels / baseArea).
    const pixelCap  = Math.sqrt(maxPixels / baseArea);
    const scale     = Math.min(requestedScale, widthCap, heightCap, pixelCap);

    // Refuse to render if the chosen scale would shrink the page below
    // the OCR-readable floor. Sending such a page into pdfjs+node-canvas
    // is strictly worse than refusing — the operator gets a loud,
    // structured reason instead of a 30s wall-clock kill.
    if (scale < minScale) {
      failStructured({
        code: 'PAGE_TOO_LARGE',
        message: `PDF page ${pageNum} is too large to render safely under the configured caps`,
        baseWidth: Math.round(baseViewport.width),
        baseHeight: Math.round(baseViewport.height),
        baseMegapixels: +(baseArea / 1_000_000).toFixed(2),
        maxWidth, maxHeight,
        maxMegapixels: +(maxPixels / 1_000_000).toFixed(2),
        scaleAttempted: +scale.toFixed(3),
        minScale,
        operatorAction: 'PDF is most likely a malformed or banner-format document. Inspect the URL. To accept very large pages anyway, raise OCR_MAX_RENDER_PIXELS in the site\'s .env.',
      });
    }

    const viewport = page.getViewport({ scale });
    canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    // JPEG over PNG — same reasoning as the previous in-worker render:
    // smaller payload, faster base64 encode, perceptually-lossless on
    // document scans at quality 0.85.
    const jpeg = canvas.toBuffer('image/jpeg', { quality: jpegQuality });

    await writeAll(process.stdout, jpeg);
    process.exit(0);
  } finally {
    // Explicit teardown — nudge node-canvas's native allocator to
    // release the backing pixel buffer before the process exits, so
    // a fast follow-up spawn doesn't trip transient pressure.
    try { if (canvas) { canvas.width = 0; canvas.height = 0; } } catch {}
    try { await pdfDoc.destroy(); } catch {}
  }
}

// Read all of stdin into a Buffer with an IDLE timeout that resets
// every time a chunk arrives. Without resetting, a 25 MB PDF on a slow
// pipe (busy event loop, antivirus on the parent side, etc.) gets
// classified as STDIN_TIMEOUT mid-transfer and the child exits while
// data is still streaming — even though nothing is wrong. The reset
// lets a healthy-but-slow transfer take as long as it needs while
// still catching the genuine "parent opened the pipe but stopped
// writing" failure within `ms` of the stall.
async function readStdinWithIdleTimeout(ms) {
  const chunks = [];
  let idleTimer;
  try {
    await new Promise((resolve, reject) => {
      const armIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => reject(new Error(`stdin idle for ${ms}ms with no new chunks (parent stopped writing?)`)),
          ms,
        );
      };
      armIdleTimer(); // start the clock — covers "parent never writes at all"
      process.stdin.on('data', (c) => {
        chunks.push(c);
        armIdleTimer(); // reset on every chunk
      });
      process.stdin.once('end', resolve);
      process.stdin.once('error', reject);
    });
  } catch (e) {
    failStructured({ code: 'STDIN_TIMEOUT', message: e.message });
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
  return Buffer.concat(chunks);
}

// Write a buffer to stdout in full. process.stdout.write is async on
// pipes; without awaiting drain we can race the child's process.exit
// and ship a truncated payload to the parent.
function writeAll(stream, buf) {
  return new Promise((resolve, reject) => {
    const ok = stream.write(buf, (err) => err ? reject(err) : resolve());
    if (!ok) stream.once('drain', resolve);
  });
}

// Emit a structured error on stderr (single JSON line) and exit non-zero.
// The parent's spawnRenderChild.js parses the LAST JSON-shaped line in
// stderr and surfaces .code / .message / details as fields on a thrown
// Error — keeps the contract structured instead of grep-on-message.
function failStructured(obj) {
  try {
    process.stderr.write(JSON.stringify(obj) + '\n');
  } catch { /* if stderr is broken too there is nothing useful to do */ }
  process.exit(1);
}

// Top-level catch so an uncaught reject (e.g. pdfjs throws on a malformed
// PDF) lands as a structured error instead of an opaque "exit code 1".
main().catch((err) => {
  failStructured({
    code: err && err.code ? String(err.code) : 'RENDER_FAILED',
    message: err && err.message ? String(err.message) : String(err),
    stack: err && err.stack ? String(err.stack).slice(0, 2000) : undefined,
  });
});
