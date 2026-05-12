// Standalone child-process renderer for the OCR pipeline.
//
// Phase 2 of docs/plans/pdf-engine-migration.md: this file now uses
// PDFium (@hyzyla/pdfium, WASM-backed) instead of pdfjs+node-canvas
// for rasterising PDF pages. PDFium is the same renderer Chrome uses
// for embedded PDFs — Node-native, no browser-API dependency, no
// libcairo / node-canvas native-mutex wedge risk.
//
// Phase 1 (process isolation) still applies: this whole script runs
// in a SHORT-LIVED CHILD PROCESS, parent-side wall-clock timeout
// backed by SIGTERM → grace → SIGKILL. PDFium is far less likely to
// wedge than pdfjs+node-canvas, but native code is native code; the
// SIGKILL machinery in spawnRenderChild.js stays in place as the
// safety net.
//
// Why PDFium / sharp specifically:
//   - pdfium ships pre-built WASM via npm; no native compilation,
//     no Windows-installer surgery, no toolchain on the operator's
//     box. (We have an immutable installer; we can't ask sites to
//     `npm rebuild` after every release.)
//   - PDFium renders to an RGBA bitmap. sharp (already a dep,
//     downstream OCR rotates / resizes via sharp anyway) converts
//     RGBA → JPEG with quality control. No new tools.
//   - We previously paid ~150ms node-canvas init per render; pdfium
//     init is similar (~200ms WASM cold start). Per-PDF cost is
//     essentially identical.
//
// Protocol (UNCHANGED from Phase 1):
//   stdin:  PDF bytes (raw)
//   argv[2]: JSON parameters
//   stdout: JPEG bytes (raw) on success
//   stderr: ONE line of JSON on failure
//   exit:   0 on success, 1 on any failure

import { Buffer } from 'buffer';

// IDLE timeout (reset on each data event) — see Phase 1 commit
// 9d59b90 for the wall-clock-from-start regression this avoids.
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
    // 0.95 (was 0.85). The Phase 1 default of 0.85 was inherited from
    // canvas.toBuffer's "perceptually lossless on documents" guidance,
    // but Phase 2 round-2 testing on real PODs showed digit edges
    // (especially 9 vs 8, 9 vs 5) were bleeding under the heavier
    // compression — engines misread digits that were visually correct
    // on the underlying bitmap. 0.95 keeps payload growth tiny (~30%)
    // and removes the OCR-visible artefacting.
    jpegQuality = 0.95,
  } = params || {};

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

  // ── Lazy-load the heavy renderer ──────────────────────────────────
  // Imports are inside main() so argv-validation failures don't pay
  // the WASM startup cost. PDFium is CJS-only; createRequire reaches
  // through ESM cleanly. sharp is pure-default-export and imports
  // fine via the usual ESM path.
  const { createRequire } = await import('node:module');
  const requireCjs = createRequire(import.meta.url);
  const { PDFiumLibrary } = requireCjs('@hyzyla/pdfium');
  const sharp = (await import('sharp')).default;
  // sharp's libvips operation cache holds up to 50 MB of intermediate
  // buffers — for our one-shot per-process render that's just sunk
  // memory. Disable.
  try { sharp.cache(false); } catch {}

  // ── Render via PDFium ─────────────────────────────────────────────
  let lib;
  let doc;
  try {
    lib = await PDFiumLibrary.init();
    doc = await lib.loadDocument(pdfBuffer);

    // PDFium uses 0-based page indices; the caller passes 1-based.
    const pageIndex = pageNum - 1;
    if (pageIndex < 0 || pageIndex >= doc.getPageCount()) {
      failStructured({
        code: 'PAGE_OUT_OF_RANGE',
        message: `PDF has ${doc.getPageCount()} page(s); pageNum ${pageNum} is out of range`,
      });
    }
    const page = doc.getPage(pageIndex);

    // Compute the actual scale by capping against ALL three limits
    // (width, height, total pixels). Same algorithm as the Phase 1
    // pdfjs version.
    //
    // PDFium API gotchas, both burned us in the first attempt:
    //   - page.getSize(opts) REQUIRES opts.scale (throws "Cannot
    //     destructure property 'scale'..." if missing).
    //   - The unscaled dims come back as originalWidth / originalHeight,
    //     not width / height (those are the scaled values).
    // Use getOriginalSize() — the dedicated unscaled accessor that
    // doesn't take renderOptions. It returns
    // { originalWidth, originalHeight }.
    const base = page.getOriginalSize();
    const baseW = base.originalWidth;
    const baseH = base.originalHeight;
    const baseArea = baseW * baseH;
    const widthCap  = maxWidth  / baseW;
    const heightCap = maxHeight / baseH;
    // Pixel area scales as scale², so the scale that lands at exactly
    // maxPixels is sqrt(maxPixels / baseArea).
    const pixelCap  = Math.sqrt(maxPixels / baseArea);
    const scale     = Math.min(requestedScale, widthCap, heightCap, pixelCap);

    if (scale < minScale) {
      failStructured({
        code: 'PAGE_TOO_LARGE',
        message: `PDF page ${pageNum} is too large to render safely under the configured caps`,
        baseWidth: Math.round(baseW),
        baseHeight: Math.round(baseH),
        baseMegapixels: +(baseArea / 1_000_000).toFixed(2),
        maxWidth, maxHeight,
        maxMegapixels: +(maxPixels / 1_000_000).toFixed(2),
        scaleAttempted: +scale.toFixed(3),
        minScale,
        operatorAction: 'PDF is most likely a malformed or banner-format document. Inspect the URL. To accept very large pages anyway, raise OCR_MAX_RENDER_PIXELS in the site\'s .env.',
      });
    }

    // PDFium's render returns a raw RGBA bitmap (Uint8Array of
    // length width*height*4). Pipe it through sharp to encode JPEG.
    // 'bitmap' render mode is the lowest-overhead path — anything
    // else would have sharp+pdfium fighting over the same data.
    const bitmap = await page.render({ scale, render: 'bitmap' });
    const jpeg = await sharp(bitmap.data, {
      raw: { width: bitmap.width, height: bitmap.height, channels: 4 },
    })
      .jpeg({ quality: Math.round(jpegQuality * 100) })
      .toBuffer();

    await writeAll(process.stdout, jpeg);
    process.exit(0);
  } finally {
    // Explicit destroy — PDFium holds WASM memory; the OS reaps it
    // on process exit anyway, but tidiness helps if anything in the
    // pipeline shifts to long-lived workers later.
    try { if (doc) doc.destroy(); } catch {}
    try { if (lib) lib.destroy(); } catch {}
  }
}

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
      armIdleTimer();
      process.stdin.on('data', (c) => {
        chunks.push(c);
        armIdleTimer();
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

function writeAll(stream, buf) {
  return new Promise((resolve, reject) => {
    const ok = stream.write(buf, (err) => err ? reject(err) : resolve());
    if (!ok) stream.once('drain', resolve);
  });
}

function failStructured(obj) {
  try {
    process.stderr.write(JSON.stringify(obj) + '\n');
  } catch {}
  process.exit(1);
}

main().catch((err) => {
  failStructured({
    code: err && err.code ? String(err.code) : 'RENDER_FAILED',
    message: err && err.message ? String(err.message) : String(err),
    stack: err && err.stack ? String(err.stack).slice(0, 2000) : undefined,
  });
});
