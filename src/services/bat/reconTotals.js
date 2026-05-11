// BAT reconciliation supplier_total drift detection + healing.
//
// Why this module exists: the upload upsert in createReconciliation
// stamps supplier_total from the spreadsheet's fee section. When two
// branch spreadsheets (Welkom + JHB, etc.) land on the same week, the
// SECOND upload's smaller fees overwrite the first's, and the recon's
// headline BAT TOTAL goes silently wrong. We've grown several layers
// of defence around this:
//
//   - PR #274 — warn at upload if a fee column header isn't recognised
//   - PR #275 — Maintenance-tab Recompute button (this module is its
//               core — was inlined in src/routes/system.js until we
//               extracted it here)
//   - PR #277 — auto-recompute on every successful upload + backfill
//
// The logic in this file is the **detection + apply primitive** —
// independent of routes, audit-logging, or UI. Imported by:
//   - src/routes/system.js for the Maintenance endpoint
//   - (future) anywhere we want to expose a programmatic
//     "fix this recon's total" call
//
// The aggregate query and bucketing logic are unit-testable against
// an in-memory DB — see test/batReconTotals.test.js.

// SQL kept as module-level constants so callers can also use them
// for diagnostic dumps without re-implementing.
//
// missing_amount_count's `AND e.id IS NOT NULL` guard is load-bearing
// — without it, the LEFT JOIN's synthetic NULL row for any recon with
// ZERO PODs (e.id NULL, is_exception NULL → COALESCE=0, order_amount
// NULL) would match the predicate and return 1, causing the recon to
// be classified as skippedIncomplete and never recomputed even when
// its stored supplier_total should be corrected to 0. (Codex catch
// on the original PR #275.)
const AGGREGATE_SQL = `
  SELECT
    r.id, r.year, r.week_number,
    COALESCE(r.supplier_total, 0) AS current_total,
    COALESCE(SUM(CASE WHEN COALESCE(e.is_exception, 0) = 0 THEN COALESCE(e.order_amount, 0) ELSE 0 END), 0) AS derived_total,
    COUNT(e.id) AS pod_count,
    SUM(CASE WHEN COALESCE(e.is_exception, 0) = 1 THEN 1 ELSE 0 END) AS exception_count,
    SUM(CASE WHEN e.id IS NOT NULL AND COALESCE(e.is_exception, 0) = 0 AND e.order_amount IS NULL THEN 1 ELSE 0 END) AS missing_amount_count
  FROM bat_reconciliations r
  LEFT JOIN bat_invoice_extractions e ON e.reconciliation_id = r.id
  GROUP BY r.id
  ORDER BY r.year DESC, r.week_number DESC
`;

const UPDATE_SQL = `UPDATE bat_reconciliations SET supplier_total = ? WHERE id = ?`;

// Drift threshold. Anything below R 0.01 is floating-point noise from
// the SUM and not worth flagging as a mismatch.
const DRIFT_THRESHOLD = 0.01;

/**
 * Read-only: scan every BAT reconciliation, bucket into ok / mismatch /
 * skippedIncomplete based on whether the stored supplier_total agrees
 * with the sum of non-exception order_amounts.
 *
 * Buckets (only the non-ok ones are returned):
 *   - mismatch          — drift >= R 0.01 AND every non-exception row
 *                         has a populated order_amount. Safe to recompute.
 *   - skippedIncomplete — at least one non-exception row has NULL
 *                         order_amount. Refuse to recompute because
 *                         the derived value would treat nulls as zero
 *                         and could overwrite a possibly-correct value.
 *
 * @param {{ db: import('better-sqlite3').Database }} args
 */
export function findReconTotalDrift({ db }) {
  const rows = db.prepare(AGGREGATE_SQL).all();
  const mismatches = [];
  const skippedIncomplete = [];
  for (const r of rows) {
    if (r.missing_amount_count > 0) {
      skippedIncomplete.push({
        id: r.id,
        year: r.year,
        week_number: r.week_number,
        current_total: r.current_total,
        pod_count: r.pod_count,
        exception_count: r.exception_count,
        missing_amount_count: r.missing_amount_count,
        reason: `${r.missing_amount_count} non-exception row(s) have no order_amount yet — backfill from a later upload would change the derived total. Refusing to recompute.`,
      });
      continue;
    }
    const drift = Math.abs(r.derived_total - r.current_total);
    if (drift >= DRIFT_THRESHOLD) {
      mismatches.push({
        id: r.id,
        year: r.year,
        week_number: r.week_number,
        current_total: r.current_total,
        derived_total: r.derived_total,
        diff: r.derived_total - r.current_total,
        pod_count: r.pod_count,
        exception_count: r.exception_count,
      });
    }
  }
  return { scanned: rows.length, mismatches, skippedIncomplete };
}

/**
 * Detect drift and (optionally) heal it. Wraps the SELECT + UPDATE in
 * a single transaction so no other writer can interleave between the
 * read and the write.
 *
 * dryRun=true uses the default deferred (read-only) transaction.
 * dryRun=false uses BEGIN IMMEDIATE so the write lock is taken at
 * the start of the body — no concurrent bat_upload or
 * backfillOrderAmounts can change bat_invoice_extractions in the gap.
 * (Without the IMMEDIATE wrapping we'd be writing stale derived
 * values over fresh row data; Codex catch on PR #275.)
 *
 * @param {{ db: import('better-sqlite3').Database, dryRun?: boolean }} args
 */
export function recomputeReconTotals({ db, dryRun = true }) {
  const updStmt = db.prepare(UPDATE_SQL);
  const txn = db.transaction(() => {
    const { scanned, mismatches, skippedIncomplete } = findReconTotalDrift({ db });
    let updated = 0;
    if (!dryRun) {
      for (const m of mismatches) {
        updStmt.run(m.derived_total, m.id);
        updated++;
      }
    }
    return { scanned, mismatches, skippedIncomplete, updated };
  });
  const result = dryRun ? txn() : txn.immediate();
  return { dryRun, ...result };
}
