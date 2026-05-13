# PDF Engine Migration

**Status: Phase 1 + Phase 2 SHIPPED.** Renderer is now PDFium
(@hyzyla/pdfium), node-canvas removed, pdfjs unpinned (still in use
for the text-layer fast-path only). The CI guard that enforced the
4.8.69 pin has been deleted. The narrative below is preserved as the
record of what motivated the work and the staging that got it done.

---

## Why this exists

Two problems point at the same architectural choice:

1. **The pin.** `pdfjs-dist` is pinned to **exactly `4.8.69`** in
   `package.json`. Bumping it breaks the BAT OCR pipeline because pdfjs
   4.10 switched its image rendering pipeline to browser-only Web APIs
   (`createImageBitmap`, `OffscreenCanvas.transferToImageBitmap`). When
   pdfjs runs under Node and internally calls
   `ctx.drawImage(imgData.bitmap, 0, 0)`, `node-canvas` rejects the
   `ImageBitmap` argument — it doesn't bridge the ImageBitmap web API.
   pdfjs treats Node as a second-class environment and is only going to
   drift further over time. The CI guard in
   `.github/workflows/build-windows.yml` fails the build if anything
   bumps pdfjs-dist off `4.8.69`.

2. **The wedge.** `pdfjs.page.render()` plus `node-canvas` periodically
   wedges the worker thread synchronously inside native code on certain
   PDFs (banner-format, multi-page-merged, malformed). The parent-side
   `PDF_TIMEOUT` (120s) fires, the URL is blacklisted, the worker is
   "terminated" — but `worker.terminate()` on a thread wedged inside an
   uninterruptible native syscall returns immediately to the parent
   without actually reaping the thread. The thread keeps holding a
   libcairo internal mutex / font cache lock, and every replacement
   worker we spawn wedges on its first render trying to acquire the
   same mutex. The only thing that recovers it is the OS reaping the
   whole Node process — i.e. an `nssm restart`. RSS doesn't climb
   because the leak is in **handles**, not memory, so
   `OCR_HARD_EXIT_RSS_MB` never fires.

This work is staged in two phases. Phase 1 isolates the renderer so the
OS can reap a wedged render with `SIGKILL` and the rest of the app
keeps moving. Phase 2 replaces pdfjs+node-canvas with a Node-native
engine so wedges happen less often AND so the pdfjs pin can be removed.

---

## Phase 1 — Process isolation (under fire, ~1 day)

**Goal**: a render that wedges inside native code can no longer take down
the OCR pipeline. The OS reaps it; the rest of the app keeps moving.

**Why this first**: the doc's own constraint is "don't do the engine
swap under fire." We're under fire. Phase 1 ships the recovery
mechanism without touching the renderer, which is testable in
hours, low-risk (no rendering output change), and survives the engine
swap (Phase 2 changes the renderer *inside* the same child-process
boundary).

### Design

Lift `pdfPageToImage` out of the worker thread and into a child
process. The worker thread orchestrates as before (fetch PDF, text
fast-path, OCR cascade); when it needs a rendered JPEG, it spawns a
short-lived child process, pipes the PDF buffer in on stdin, receives
the JPEG buffer back on stdout, and either gets bytes (success) or
gets nothing because the parent SIGKILL'd the child after a wall-clock
timeout (recoverable failure that doesn't poison the parent).

```
main thread
  └─ OcrLane (worker_thread) ─ orchestrates per row
        ├─ fetch PDF
        ├─ try text fast-path  (pdfjs.getTextContent — stays in-worker)
        ├─ spawn renderPdfChild ─ child_process ─ runs pdfjs + node-canvas
        │     stdin:  PDF bytes
        │     stdout: JPEG bytes
        │     stderr: structured progress / error JSON
        │     parent: kill(SIGKILL) on RENDER_TIMEOUT
        ├─ cascade OCR engines (GV → ocr.space → Tesseract) over the JPEG
        └─ return result
```

The wedge can't survive `SIGKILL`. The OS releases everything the
child held — libcairo mutex, font cache, file handles, memory. The
worker thread continues. The parent process never dies.

### Why per-render spawn (not a pool)

Per-render spawn adds ~200ms of Node startup per render. For a 1000-row
queue, that's ~3 minutes of overhead — acceptable; today's wedges cost
far more than that (120s parent-side timeout + manual operator
restart). The alternatives (pool of long-lived children, dispatch
queue, lifecycle management) add complexity that earns back the 200ms
only at very large queue sizes. Phase 2 (PDFium) is fast enough that
even per-spawn renders complete in milliseconds, so the choice can be
revisited then if needed.

### Files

New:

- **`src/services/ocr/renderPdfChild.js`** — standalone Node script. Reads
  PDF bytes from stdin, parses CLI args (`--page N --scale S
  --max-pixels P --max-width W --max-height H --min-scale M`), runs
  the existing rendering logic (size caps, refuse-if-too-small, JPEG
  encode), writes JPEG bytes to stdout. On error: writes a JSON object
  `{ code, message, stage, ... }` to stderr and exits non-zero.
- **`src/services/ocr/spawnRenderChild.js`** — parent-side wrapper.
  Exposes `renderPdfInChild(pdfBuffer, { pageNum, scale, timeoutMs })`
  returning `Promise<Buffer>`. Spawns the child, pipes buffers,
  enforces SIGTERM then SIGKILL on timeout, parses structured stderr
  for error transport.
- **`test/spawnRenderChild.test.js`** — unit tests covering: success path
  (valid PDF in, JPEG out), child timeout (slow child, SIGKILL fires),
  child crash (non-zero exit, structured error parsed), structured
  refusal (too-large PDF), invalid buffer in.

Modified:

- **`src/services/ocrWorker.js`** — `pdfPageToImage` becomes a thin
  wrapper around `renderPdfInChild`. Existing imports of `pdfjs` and
  `canvas` are removed from this file (they move to
  `renderPdfChild.js`). The text-layer fast-path (`getTextContent`)
  stays in-worker — it doesn't wedge in the same way; only the raster
  render does.
- **`src/services/batReconciliation.js`** — same change at the second
  callsite (cold path for the Google Vision retry button).

Removed: nothing yet. pdfjs + node-canvas stay as deps for Phase 1
because they're still doing the actual rendering, just inside the
child. Removed in Phase 2 along with the CI pin guard.

### Behaviour change

- **Healthy PDFs**: identical output (same library, same code). Minimal
  perf change beyond the ~200ms spawn cost.
- **Wedging PDF on first attempt**: parent times out, SIGKILLs child,
  the row's `bat.ocr.row` failure is recorded as today, URL goes on
  the blacklist. Difference: the worker thread is still alive and
  picks up the next row immediately.
- **Three wedging PDFs in a row**: each one fails fast, blacklisted,
  worker keeps going. Queue makes progress instead of dying. Operator
  no longer needs to restart the service.
- **The "consecutive wedge" mode that requires service restart today**:
  goes away. There's nothing for libcairo's mutex to leak into the
  parent.

### Constants and config

- `OCR_RENDER_CHILD_TIMEOUT_MS` (env, default 30000): wall-clock cap
  the parent enforces. Below this, SIGTERM grace; at 32s, SIGKILL.
  Same envelope as the existing in-worker 30s timeout in
  `ocrWorker.js:734`, just relocated and now actually enforceable
  because the parent is on the safe side of the wedge.
- `OCR_MAX_RENDER_WIDTH`, `OCR_MAX_RENDER_HEIGHT`, `OCR_MAX_RENDER_PIXELS`:
  unchanged. Passed through to the child as CLI args so they remain
  operator-tunable without restarting the orchestrator.
- The `PDF_TIMEOUT` (120s) in `batReconciliation.js` becomes a backstop
  for the WHOLE row, not just render. Render timeout is now the
  child-process one above.

### Risk profile

- **Output equivalence**: same renderer code, just hosted in a child
  process. No rendering changes to validate against reference PDFs.
- **Spawn overhead**: ~200ms per render. Mitigated by the text-layer
  fast-path still skipping render entirely (~30-40% of PODs).
- **Windows SIGKILL semantics**: on Windows, the spawned `node.exe`
  child process is a normal process; `kill(SIGKILL)` ends it cleanly.
- **Native binary already-packaged**: pdfjs + node-canvas already ship
  in the Windows installer; no installer changes for Phase 1.

### Acceptance tests

1. Healthy 50-PDF batch: completes with no behavioural regression.
2. Synthetic wedging PDF (the recorded one from production, or a
   handcrafted banner-format test fixture): row fails fast, URL
   blacklisted, **next row processes successfully**. Today the next
   row also wedges; that's the regression we're fixing.
3. Service uptime: process survives a 100-row queue with 20 wedging
   PDFs interleaved. No `nssm restart` required.
4. Performance: render time for healthy PDFs increases by ≤300ms per
   row at p50 (spawn overhead + transport).

---

## Phase 2 — Engine swap (calm week, ~1-2 days)

**Goal**: remove the pdfjs pin and the structural risk that every pdfjs
upgrade reintroduces the wedge. Replace pdfjs+node-canvas with a
Node-native PDF engine that doesn't depend on browser APIs.

Phase 1 ships first. Phase 2 changes the renderer **inside the
existing child-process boundary** — the SIGKILL machinery from Phase 1
stays in place and continues to protect against any future native wedge
(PDFium is less likely to wedge, but native code is native code).

### Phase 2 goal

Replace `pdfjs-dist` + `node-canvas` with a Node-native PDF engine that
doesn't depend on browser APIs. Outcome: pdfjs and node-canvas removed
from `package.json`, OCR pipeline runs on a stable Node-native stack,
upstream upgrades become routine instead of a load-bearing pin.

### Where pdfjs is used today

Two callsites, both for PDF→image rendering ahead of OCR:

1. `src/services/ocrWorker.js` — `pdfPageToImage(buffer, pageNum, scale)`.
   Hot path, runs in a `worker_thread`.
2. `src/services/batReconciliation.js` — `pdfPageToImage(buffer, pageNum, scale)`.
   Cold path, used only by the "Retry with Google Vision" button.

Both produce a PNG buffer that `sharp` then resizes/rotates before being
sent to Google Vision / ocr.space / Tesseract.

There's also a "fast path" in the worker that uses pdfjs's text-layer
extraction (`page.getTextContent()`) to find an invoice number without
rendering. ~30-40% of PODs are matched this way without ever needing OCR.
The replacement engine must support this too, or we accept losing the
fast path and OCRing every PDF.

### Engine candidates

### `@hyzyla/pdfium` (recommended)

- Wraps Google's PDFium (the renderer Chrome uses for embedded PDFs).
- Pre-built binaries for Linux/macOS/Windows on npm — no build toolchain
  required.
- Active maintenance.
- API: `await pdfium.render({ data: buffer, page: 1, scale: 2.0 })` returns
  a PNG buffer directly. Replaces both `pdfjs.getDocument` + `page.render` +
  `canvas.toBuffer` in one call.
- Text extraction: supports `getText({ data, page })`. Need to verify it's
  positionally-aware enough for our invoice-number regex pipeline.

Pros: smallest API surface, pre-built binaries, fastest.

Cons: still a native dep (so the Windows installer needs to bundle the
right binary; `@hyzyla/pdfium` claims this works via npm, verify).

### `node-poppler`

- Wraps poppler-utils (a 20-year-old Linux PDF toolkit).
- Mature, well-tested.
- Requires poppler-utils installed on the host (not bundled). We'd need to
  ship poppler-utils with the Windows installer or document a prerequisite.
- API: shells out to `pdftoppm` for rendering, `pdftotext` for text.

Pros: very stable, ubiquitous on Linux servers.

Cons: external dependency on poppler-utils binaries → extra installer
work. Shell-out adds process-spawn overhead per PDF.

### `mupdf-js`

- WASM-based.
- Fast, no native compilation.
- AGPL license — almost certainly fine for an internal app, but flag it
  for review.

Pros: no native binaries.

Cons: AGPL license review needed. WASM startup overhead on first call.

### Phase 2 plan of work (estimated 1-2 focused days)

1. **Pick the engine.** Default to `@hyzyla/pdfium` unless its Windows
   binary distribution turns out to be problematic. Test installation on
   a clean Windows VM.
2. **Save a reference set of real BAT PDFs.** Pick ~20 representative ones
   covering the variety: clean text-layer PDFs, scanned PDFs, large
   multi-page, near-duplicate, ones that previously OCR'd cleanly, ones
   that were tricky. Stash under `tests/fixtures/pdfs/` (gitignore'd).
3. **Snapshot current outputs.** Run the existing pipeline against each
   reference PDF, save:
   - The PNG buffer hash (proves rendering matches)
   - The extracted invoice number (proves OCR matches)
   - The text-layer text (proves fast-path matches)
4. **Implement the new `pdfPageToImage` against the chosen engine.** Keep
   the function signature identical so the rest of the OCR pipeline is
   untouched.
5. **Implement text-layer fast-path** if the new engine supports it. If it
   doesn't, accept the regression — every PDF will OCR, ~30% slower
   throughput. Probably acceptable; the speedup was nice-to-have.
6. **Run reference-PDF regression suite.** Every reference PDF must
   produce the same final invoice number on the new engine as on the old.
   Visual diffs of the PNG outputs to catch rendering regressions
   (different DPI, color handling, etc.).
7. **Bundle the native binary** with NSIS. `@hyzyla/pdfium` ships its
   `.node` file via npm so this should "just work" — verify by installing
   on a Windows VM with no Node toolchain.
8. **Remove pdfjs-dist + node-canvas from package.json.** Remove the CI
   guard. Delete this doc and the long-form pin comments in
   `ocrWorker.js` / `batReconciliation.js`.
9. **Ship in a release dedicated to this migration** — no other changes
   batched in. If anything regresses, easy bisect.

### Phase 2 constraints and gotchas

- **Don't do this under fire.** pdfjs broke twice in two days because
  `npm update` snuck a bump in. Migrating to a new engine while OCR is
  on fire is the wrong time to be making architectural decisions.
  Phase 1 ships first specifically so Phase 2 doesn't have to.
- **PDF rendering isn't deterministic across engines.** Different rasterizers
  produce slightly different PNGs (anti-aliasing, color profiles, font
  rendering). The "snapshot rendered output" check should be a similarity
  threshold, not byte-exact.
- **OCR result equivalence is the real test.** What matters is that the
  *invoice number extraction* still works on the same PDFs. Pixel-level
  diffs are diagnostic only.
- **Phase 1's child-process boundary is the integration point.** After
  Phase 1, the swap is a single-file change inside
  `renderPdfChild.js`: replace the pdfjs+node-canvas calls with the
  chosen engine's. Parent-side spawn / SIGKILL / transport machinery
  stays exactly as Phase 1 leaves it.

### When to do Phase 2

Not during firefight. Schedule a clear week where OCR isn't being actively
chased. Likely candidate: after the next round of Sage / reporting work
when everything's stable, AND after Phase 1 has been live in production
for at least a couple of weeks (so any Phase-1-specific regressions have
been caught and the SIGKILL path is known to work).
