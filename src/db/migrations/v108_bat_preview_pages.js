export default {
  version: 108,
  name: 'bat_preview_pages',
  up(db) {
    // How many preview page-images have been rendered/cached for a row.
    //
    //   NULL  = never determined — old rows that predate multi-page previews,
    //           or rows whose extra pages haven't been backfilled yet. The
    //           preview backfill (services/ocr/previewBackfill.js) selects
    //           exactly these (WHERE pdf_url IS NOT NULL AND preview_pages IS NULL).
    //   >= 1  = rendered (1 = single page).
    //   0     = attempted but nothing rendered (download/render failed) — kept
    //           non-NULL so a re-run doesn't re-hammer a dead URL; an operator
    //           can clear it to force a retry.
    //
    // The live OCR path also stamps this on new extractions, so only genuine
    // pre-feature history is ever picked up by the backfill.
    const cols = db.prepare('PRAGMA table_info(bat_invoice_extractions)').all();
    if (!cols.some((c) => c.name === 'preview_pages')) {
      db.exec('ALTER TABLE bat_invoice_extractions ADD COLUMN preview_pages INTEGER');
    }
    // Partial index over just the backfill candidates (preview_pages IS NULL),
    // so the backfill's COUNT + next-rows queries don't scan the whole
    // extractions table on every status poll. It shrinks toward empty as the
    // backfill completes, then costs nothing.
    db.exec('CREATE INDEX IF NOT EXISTS idx_bat_extractions_preview_pending ON bat_invoice_extractions(id) WHERE preview_pages IS NULL');
  },
};
