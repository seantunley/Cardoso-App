// Pure helpers for multi-page OCR preview filenames.
//
// A reconciliation row's POD can be multiple pages. OCR detection only ever
// uses page 1, but the in-app viewer shows every page. Each page is cached as
// its own JPEG in the preview dir:
//
//   page 1      -> `<id>.jpg`        (UNCHANGED from the old single-page
//                                      previews, so existing rows + the stored
//                                      preview_path keep working as-is)
//   page 2..N   -> `<id>-<page>.jpg`
//
// These helpers are the single source of truth for that naming so the worker
// (which writes the files) and the route (which lists them) can't drift.

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Canonical preview filename for a given extraction id + 1-based page number.
 * @param {number|string} extractionId
 * @param {number} pageNum  1-based
 * @returns {string}
 */
export function previewFileName(extractionId, pageNum) {
  return pageNum === 1 ? `${extractionId}.jpg` : `${extractionId}-${pageNum}.jpg`;
}

/**
 * From a flat list of filenames in the preview dir, return the ordered pages
 * belonging to one extraction id: `[{ page, filename }, ...]` sorted by page.
 *
 * Robust against id collisions: id=1's `1-2.jpg` (page 2) is anchored to id 1
 * and never matches id=12's regex, and vice-versa. The legacy single-page
 * `<id>.jpg` is recognised as page 1.
 *
 * @param {string[]} files
 * @param {number|string} extractionId
 * @returns {{ page: number, filename: string }[]}
 */
export function listPreviewPagesFromFiles(files, extractionId) {
  const id = String(extractionId);
  const single = `${id}.jpg`;
  const extra = new RegExp(`^${escapeRegExp(id)}-(\\d+)\\.jpg$`);
  const pages = [];
  for (const f of files) {
    if (f === single) {
      pages.push({ page: 1, filename: f });
      continue;
    }
    const m = extra.exec(f);
    if (m) {
      const p = parseInt(m[1], 10);
      // Only page >= 2 uses the suffixed form; `<id>-1.jpg` is never written
      // (page 1 is `<id>.jpg`) but if one ever appears, fold it to page 1
      // rather than producing a duplicate.
      if (Number.isInteger(p) && p >= 2) pages.push({ page: p, filename: f });
    }
  }
  pages.sort((a, b) => a.page - b.page);
  return pages;
}
