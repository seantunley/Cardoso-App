// Cross-recon duplicate-invoice index for BAT extractions.
//
// Carved out of src/services/batReconciliation.js as part of the BAT
// module split — the function lived in the middle of the recon-loading
// path with module-level `db` access; pulling it into its own file
// (with `db` as an explicit arg) lets us pin the SQL behaviour with
// in-memory SQLite tests and reuse it from any caller that needs the
// global-duplicate view (the cross-recon audit panel, future analytics).
//
// Why this exists at all: OCR and manual entry can both produce the
// same invoice number in different weeks (short numeric IDs are
// particularly prone — "1234" misreads as "1334" in W19, then misreads
// correctly back to "1234" in W22, and now two different POD rows
// claim invoice 1234). The previous within-recon duplicate check
// missed every cross-week dupe — operator only noticed when Sage
// reconciled and one of the two rows came back unmatched.

/**
 * @typedef {Object} DuplicateOccurrence
 * @property {number} extraction_id
 * @property {number} reconciliation_id
 * @property {number} week
 * @property {number} year
 *
 * @typedef {Object} DuplicateEntry
 * @property {number} count                   total occurrences anywhere
 * @property {DuplicateOccurrence[]} occurrences
 */

/**
 * Single-query global duplicate index keyed by upper-cased trimmed
 * invoice number. Only includes numbers that actually have >1
 * occurrence anywhere — every other invoice is omitted to keep the
 * in-memory map small. Each entry carries the total count plus the
 * list of (extraction_id, reconciliation_id, week, year) tuples so
 * the UI can show the operator EXACTLY which other recons hold the
 * duplicates.
 *
 * Performance: idx_bat_extractions_invoice covers the GROUP BY; on a
 * hub with ~50k extractions this query is ~5ms.
 *
 * @param {{ db: import('better-sqlite3').Database }} args
 * @returns {Map<string, DuplicateEntry>}
 */
export function buildGlobalDuplicateIndex({ db }) {
  const rows = db.prepare(`
    SELECT UPPER(TRIM(e.extracted_invoice)) AS k,
           e.id  AS extraction_id,
           e.reconciliation_id,
           r.week_number,
           r.year
    FROM bat_invoice_extractions e
    JOIN bat_reconciliations r ON r.id = e.reconciliation_id
    WHERE e.extracted_invoice IS NOT NULL
      AND TRIM(e.extracted_invoice) <> ''
      AND UPPER(TRIM(e.extracted_invoice)) IN (
        SELECT UPPER(TRIM(extracted_invoice))
        FROM bat_invoice_extractions
        WHERE extracted_invoice IS NOT NULL AND TRIM(extracted_invoice) <> ''
        GROUP BY UPPER(TRIM(extracted_invoice))
        HAVING COUNT(*) > 1
      )
  `).all();

  const index = new Map();
  for (const r of rows) {
    if (!index.has(r.k)) index.set(r.k, { count: 0, occurrences: [] });
    const entry = index.get(r.k);
    entry.count++;
    entry.occurrences.push({
      extraction_id: r.extraction_id,
      reconciliation_id: r.reconciliation_id,
      week: r.week_number,
      year: r.year,
    });
  }
  return index;
}
