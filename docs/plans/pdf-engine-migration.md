# PDF Engine Migration

## Why this exists

`pdfjs-dist` is pinned to **exactly `4.8.69`** in `package.json`. Bumping it
breaks the BAT OCR pipeline.

The root cause: pdfjs 4.10 switched its image rendering pipeline to
browser-only Web APIs (`createImageBitmap`, `OffscreenCanvas.transferToImageBitmap`).
When pdfjs runs under Node and then internally calls
`ctx.drawImage(imgData.bitmap, 0, 0)`, `node-canvas` rejects the
`ImageBitmap` argument with "Image or Canvas expected" because node-canvas
only accepts its own `Image` / `Canvas` types — it doesn't bridge the
ImageBitmap web API.

This is an architectural mismatch, not a fixable bug. pdfjs treats Node as
a second-class environment and is only going to drift further from
node-canvas compatibility over time. Every pdfjs upgrade carries the same
risk.

The CI guard in `.github/workflows/build-windows.yml` fails the build if
anything bumps pdfjs-dist off `4.8.69`, including a stray `npm update`.

## Goal

Replace `pdfjs-dist` + `node-canvas` with a Node-native PDF engine that
doesn't depend on browser APIs. Outcome: pdfjs and node-canvas removed
from `package.json`, OCR pipeline runs on a stable Node-native stack,
upstream upgrades become routine instead of a load-bearing pin.

## Where pdfjs is used today

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

## Engine candidates

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

## Plan of work (estimated 1-2 focused days)

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

## Constraints and gotchas

- **Don't do this under fire.** pdfjs broke twice in two days because
  `npm update` snuck a bump in. Migrating to a new engine while OCR is
  on fire is the wrong time to be making architectural decisions.
- **PDF rendering isn't deterministic across engines.** Different rasterizers
  produce slightly different PNGs (anti-aliasing, color profiles, font
  rendering). The "snapshot rendered output" check should be a similarity
  threshold, not byte-exact.
- **OCR result equivalence is the real test.** What matters is that the
  *invoice number extraction* still works on the same PDFs. Pixel-level
  diffs are diagnostic only.
- **The Google Vision retry path** (cold) and the worker pipeline (hot)
  use the same `pdfPageToImage` signature today — keep that.

## When to do this

Not during firefight. Schedule a clear week where OCR isn't being actively
chased. Likely candidate: after the next round of Sage / reporting work
when everything's stable.
