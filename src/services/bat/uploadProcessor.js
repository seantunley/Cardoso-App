// processSupplierUpload — the per-file flow shared by the single and
// batch supplier-upload routes.
//
// Lifted out so the two endpoints can't drift over time. Behaviour
// mirrors the original single-file route exactly:
//
//   parse → createReconciliation → archive (best-effort, NULLs path
//   on failure so re-uploads don't serve stale forensic bytes) →
//   query Sage credit notes (best-effort, persists error on failure)
//   → backfill order amounts → return the reconciliation row.
//
// Throws SpreadsheetValidationError when the spreadsheet is structurally
// rejected — caller (route handler) translates that to a 400.
// Throws any other Error for unexpected failures — caller translates
// to a 500 (single endpoint) or a per-file 'error' row (batch endpoint).
//
// Side effects on disk: copies the uploaded file into the per-recon
// archive dir (or logs + nulls archive_path on failure). Does NOT
// unlink the source temp file — that's the route handler's
// responsibility (it owns the multer lifecycle).

import { archiveSupplierUpload } from './uploadArchive.js';

/**
 * @typedef {{
 *   path: string,
 *   originalname: string,
 * }} UploadedFile
 *
 * @typedef {{
 *   reconciliation: object,
 *   backfilled: number,
 *   weekNumber: number,
 *   year: number,
 *   podCount: number,
 *   fees: object,
 *   archived: boolean,
 *   sageError: string | null,
 * }} ProcessedUpload
 */

/**
 * Parse + persist a single supplier spreadsheet upload.
 *
 * @param {{
 *   file: UploadedFile,
 *   fallbackYear: number | null,                     // from req.body.year on the route, or null
 *   userId: number,
 *   db: import('better-sqlite3').Database,
 *   parseSupplierSpreadsheet: (path: string, name: string) => any,
 *   createReconciliation: (args: object) => number,
 *   querySageCreditNotes: (week: number, year: number) => Promise<any[]>,
 *   replaceSageCreditNotes: (reconId: number, notes: any[]) => void,
 *   backfillOrderAmounts: (orderAmounts: any) => number,
 *   getReconciliation: (id: number) => object,
 *   toIsoYear: (d: Date) => number,
 * }} args
 * @returns {Promise<ProcessedUpload>}
 */
export async function processSupplierUpload({
  file,
  fallbackYear,
  userId,
  db,
  parseSupplierSpreadsheet,
  createReconciliation,
  querySageCreditNotes,
  replaceSageCreditNotes,
  backfillOrderAmounts,
  getReconciliation,
  toIsoYear,
}) {
  // parseSupplierSpreadsheet throws SpreadsheetValidationError with a
  // list of human-readable reasons when the file is structurally
  // unusable. We let it propagate — route handler catches and shapes
  // the response.
  const parsed = parseSupplierSpreadsheet(file.path, file.originalname);

  // Year fallback chain: parser-detected → caller-supplied → ISO year
  // of current date. ISO year (not calendar year) so a late-Dec
  // upload for a W1 file doesn't get filed under the previous year.
  const year = parsed.year || fallbackYear || toIsoYear(new Date());
  if (parsed.year) console.log(`[bat] Year detected from spreadsheet: ${parsed.year}`);

  const reconId = createReconciliation({
    weekNumber: parsed.weekNumber,
    year,
    filename: file.originalname,
    fees: parsed.fees,
    podUrls: parsed.podUrls,
    userId,
  });

  // Archive the original .xlsx so a later supplier dispute can be
  // replayed against the source bytes. createReconciliation upserts
  // on (week, year), so a re-upload of the same week reuses the
  // existing row — if the archive copy fails, we MUST null any
  // previously-stored archive_path so we don't lie about what bytes
  // are available for this version of the row.
  let archived = false;
  try {
    const archivePath = archiveSupplierUpload({
      srcPath: file.path,
      reconId,
      originalName: file.originalname,
    });
    db.prepare('UPDATE bat_reconciliations SET archive_path = ? WHERE id = ?')
      .run(archivePath, reconId);
    archived = true;
  } catch (archiveErr) {
    console.error(`[bat] Failed to archive uploaded spreadsheet for recon ${reconId} (${file.originalname}): ${archiveErr.message}`);
    db.prepare('UPDATE bat_reconciliations SET archive_path = NULL WHERE id = ?')
      .run(reconId);
  }

  // Auto-query Sage for credit notes — non-blocking on failure but
  // the error is persisted so the UI shows it instead of silently
  // displaying zero credit notes. Use replaceSageCreditNotes for
  // atomicity even though there's nothing to delete on a freshly-
  // created recon (the DELETE is a cheap no-op).
  let sageError = null;
  try {
    const creditNotes = await querySageCreditNotes(parsed.weekNumber, year);
    replaceSageCreditNotes(reconId, creditNotes);
  } catch (sageErr) {
    sageError = String(sageErr.message);
    console.error('[bat] Sage query failed:', sageError);
    db.prepare('UPDATE bat_reconciliations SET sage_error = ? WHERE id = ?')
      .run(sageError.slice(0, 500), reconId);
  }

  const backfilled = backfillOrderAmounts(parsed.orderAmounts);
  const reconciliation = getReconciliation(reconId);

  return {
    reconciliation,
    backfilled,
    weekNumber: parsed.weekNumber,
    year,
    podCount: parsed.podUrls?.length || 0,
    fees: parsed.fees,
    archived,
    sageError,
  };
}
