// Per-recon integrity invariants. Single source of truth for "do the
// numbers an operator sees on a recon page actually agree with the
// underlying data?". Runs at every getReconciliation() call so any
// drift produces an immediate red blocking banner — operators don't
// have to spot inconsistencies by hand the way they did during the
// W3/W5 investigation (PR #354).
//
// Every check returns:
//   { id, name, passed, skipped?, expected?, actual?, drift?, detail }
//
// A `skipped` check is one we can't evaluate yet (typically because
// bat_overview_orders hasn't been seeded for the recon — pre-v72
// recons; operator re-uploads to enable). Skipped checks DO NOT fail
// the overall integrity result — they're informational so the banner
// distinguishes "drift found" from "can't verify yet".
//
// All comparisons use a R 0.01 tolerance for float rounding. Counts
// are strict-equal.

const PENNY = 0.01;

const eqMoney = (a, b) => Math.abs((a || 0) - (b || 0)) < PENNY;
const fmtR = (v) => `R ${Number(v || 0).toFixed(2)}`;

/**
 * Run every integrity invariant against a single reconciliation. Pure
 * read — no writes.
 *
 * @param {{ db: import('better-sqlite3').Database, reconId: number }} args
 * @returns {{ passed: boolean, overviewStored: number, checks: Array }}
 */
export function checkReconciliationIntegrity({ db, reconId }) {
  if (!Number.isFinite(reconId)) {
    return { passed: false, overviewStored: 0, checks: [{
      id: 'invalid_recon_id', name: 'reconId is a finite number',
      passed: false, detail: `Got ${reconId}; expected a positive integer recon id.`,
    }] };
  }

  const recon = db.prepare(`
    SELECT id, week_number, year,
      supplier_delivery, supplier_discount, supplier_pricing, supplier_total,
      marked_zero
    FROM bat_reconciliations WHERE id = ?
  `).get(reconId);
  if (!recon) {
    return { passed: false, overviewStored: 0, checks: [{
      id: 'recon_exists', name: 'Reconciliation exists',
      passed: false, detail: `No bat_reconciliations row with id=${reconId}.`,
    }] };
  }

  // Marked-zero recons are synthetic — no PODs, no Overview ODRs, no
  // extractions. Every check is vacuously OK; return early so we don't
  // raise false-positive "no Overview data" warnings on weeks the
  // operator explicitly marked zero.
  if (recon.marked_zero) {
    return {
      passed: true,
      overviewStored: 0,
      checks: [{
        id: 'marked_zero',
        name: 'Week marked zero — integrity checks skipped',
        passed: true,
        skipped: true,
        detail: 'Synthetic zero recon. No PODs, no Overview ODRs, no extractions expected.',
      }],
    };
  }

  const claimPerFee = (recon.supplier_delivery || 0)
                    + (recon.supplier_discount || 0)
                    + (recon.supplier_pricing  || 0);

  const overviewStoredRow = db.prepare(
    'SELECT COUNT(*) AS n FROM bat_overview_orders WHERE reconciliation_id = ?'
  ).get(reconId);
  const overviewStored = overviewStoredRow.n;

  const checks = [];

  // I1. supplier_total cached column equals the per-fee sum of the
  // recon's own three fee columns. Per the operator-confirmed rule
  // ("BAT TOTAL is the claim summary"), supplier_total IS the claim,
  // not a re-derived bottom-up POD sum. Any drift here points at a
  // stale recompute or a code path that mutated supplier_total
  // outside the documented upload-path self-heal.
  checks.push({
    id: 'supplier_total_matches_per_fee_claim',
    name: 'supplier_total column = supplier_delivery + supplier_discount + supplier_pricing',
    passed: eqMoney(recon.supplier_total, claimPerFee),
    expected: fmtR(claimPerFee),
    actual: fmtR(recon.supplier_total),
    drift: (recon.supplier_total || 0) - claimPerFee,
    detail: eqMoney(recon.supplier_total, claimPerFee)
      ? 'BAT TOTAL displayed on tiles equals the Overview-tab fees claim summary.'
      : `BAT TOTAL drifted from the Overview-tab fees claim. Something rewrote supplier_total outside the upload path. Re-uploading the supplier sheet will reset it.`,
  });

  // I2/I3 need bat_overview_orders to be populated. If not stored,
  // skip with a "re-upload to enable" detail rather than failing.
  if (overviewStored === 0) {
    checks.push({
      id: 'overview_orders_seeded',
      name: 'Overview ODR list stored (enables every other coverage check)',
      passed: true,
      skipped: true,
      detail: 'bat_overview_orders has no rows for this recon. Re-upload the supplier spreadsheet to populate — the upload path persists the Overview pivot for Missing-POD detection going forward.',
    });
    return { passed: checks.every(c => c.passed), overviewStored, checks };
  }

  // I2. Normal-pivot Overview ODR sum = claim_per_fee.
  // BAT's normal-pivot Sub Total Excl NC must equal the Overview fees
  // claim (delivery+discount+pricing). If these disagree, our parser
  // read the two halves of the same spreadsheet inconsistently, or
  // BAT's own spreadsheet is internally inconsistent.
  //
  // Skip when any normal-pivot ODR has NULL order_amount — the row
  // exists in Overview but the parser couldn't read a numeric Sub
  // Total cell yet (BAT often ships these for not-yet-priced orders;
  // a later upload upgrades them via the parser's amount-upgrade
  // path). SUM treats NULLs as zero, so checking against the claim
  // would deterministically fail and trigger a red banner even
  // though the data is simply incomplete.
  const normalRow = db.prepare(`
    SELECT COALESCE(SUM(order_amount), 0) AS s,
           SUM(CASE WHEN order_amount IS NULL THEN 1 ELSE 0 END) AS nulls
    FROM bat_overview_orders WHERE reconciliation_id = ? AND is_exception = 0
  `).get(reconId);
  const normalSum = normalRow.s;
  const normalNulls = normalRow.nulls;
  if (normalNulls > 0) {
    checks.push({
      id: 'overview_normal_sum_matches_claim',
      name: 'Σ Overview normal-pivot order_amount = claim_per_fee',
      passed: true,
      skipped: true,
      detail: `Skipped — ${normalNulls} normal-pivot ODR${normalNulls === 1 ? '' : 's'} have no parseable amount yet (BAT ships these for not-yet-priced orders). Sum of known amounts: ${fmtR(normalSum)} of claim ${fmtR(claimPerFee)}; gap of ${fmtR(claimPerFee - normalSum)} expected to be made up by the unknown rows on a later upload.`,
    });
  } else {
    checks.push({
      id: 'overview_normal_sum_matches_claim',
      name: 'Σ Overview normal-pivot order_amount = claim_per_fee',
      passed: eqMoney(normalSum, claimPerFee),
      expected: fmtR(claimPerFee),
      actual: fmtR(normalSum),
      drift: normalSum - claimPerFee,
      detail: eqMoney(normalSum, claimPerFee)
        ? 'BAT spreadsheet self-consistent on the normal pivot.'
        : `BAT's normal-pivot per-invoice line items sum to ${fmtR(normalSum)}, but BAT's Overview-tab fees claim is ${fmtR(claimPerFee)}. Either our parser drifted between the two reads, or BAT shipped a spreadsheet whose summary doesn't reconcile to its own detail. Investigate before sending the operator to BAT.`,
    });
  }

  // I3. Tab-bucket coverage. PAID + NON-COMPLIANT (extraction rows
  // + missing normal PODs) must equal the normal-pivot sum. Same
  // arithmetic the audit-trail tiles do — if it ever disagrees the
  // tile display logic and the source-of-truth have drifted.
  //
  // Skip when any of the inputs (extractions or missing-POD Overview
  // rows) carry NULL order_amount on the normal-pivot side. SUM
  // treats NULL as 0, so a missing-POD ODR with unknown amount
  // would cause this to fail deterministically even though the
  // data is just incomplete.
  const extractedNormalRow = db.prepare(`
    SELECT COALESCE(SUM(order_amount), 0) AS s,
           SUM(CASE WHEN order_amount IS NULL THEN 1 ELSE 0 END) AS nulls
    FROM bat_invoice_extractions
    WHERE reconciliation_id = ? AND COALESCE(is_exception, 0) = 0
  `).get(reconId);
  const missingNormalRow = db.prepare(`
    SELECT COALESCE(SUM(o.order_amount), 0) AS s,
           SUM(CASE WHEN o.order_amount IS NULL THEN 1 ELSE 0 END) AS nulls
    FROM bat_overview_orders o
    WHERE o.reconciliation_id = ? AND o.is_exception = 0
      AND NOT EXISTS (
        SELECT 1 FROM bat_invoice_extractions e
        WHERE e.reconciliation_id = o.reconciliation_id AND e.order_number = o.order_number
      )
  `).get(reconId);
  const paidPlusNonComp = extractedNormalRow.s + missingNormalRow.s;
  const normalSideNulls = (extractedNormalRow.nulls || 0) + (missingNormalRow.nulls || 0);
  if (normalSideNulls > 0) {
    checks.push({
      id: 'paid_plus_noncomp_equals_claim',
      name: 'PAID + NON-COMPLIANT (extractions + missing normal PODs) = claim_per_fee',
      passed: true,
      skipped: true,
      detail: `Skipped — ${normalSideNulls} normal-side row${normalSideNulls === 1 ? '' : 's'} have NULL order_amount yet (extraction or missing-POD with un-priced Overview cell). Sum of known: ${fmtR(paidPlusNonComp)} of claim ${fmtR(claimPerFee)}.`,
    });
  } else {
    checks.push({
      id: 'paid_plus_noncomp_equals_claim',
      name: 'PAID + NON-COMPLIANT (extractions + missing normal PODs) = claim_per_fee',
      passed: eqMoney(paidPlusNonComp, claimPerFee),
      expected: fmtR(claimPerFee),
      actual: fmtR(paidPlusNonComp),
      drift: paidPlusNonComp - claimPerFee,
      detail: eqMoney(paidPlusNonComp, claimPerFee)
        ? 'Audit-trail PAID + NON-COMPLIANT balances to BAT TOTAL claim.'
        : `PAID + NON-COMP bucket sum (${fmtR(paidPlusNonComp)}) does not equal BAT TOTAL claim (${fmtR(claimPerFee)}). Drift ${fmtR(paidPlusNonComp - claimPerFee)}. Likely cause: stale extraction rows from a prior upload not pruned, OR an extracted row whose order_number isn't in the persisted Overview pivot (look at the orphan-extractions check below).`,
    });
  }

  // I4. Exception bucket = exception-pivot Overview sum.
  // Same null-aware skip as I3 — exception-pivot Overview rows
  // and is_exception=1 extractions can also have NULL amounts.
  const exceptionOverviewRow = db.prepare(`
    SELECT COALESCE(SUM(order_amount), 0) AS s,
           SUM(CASE WHEN order_amount IS NULL THEN 1 ELSE 0 END) AS nulls
    FROM bat_overview_orders WHERE reconciliation_id = ? AND is_exception = 1
  `).get(reconId);
  const extractedExceptionRow = db.prepare(`
    SELECT COALESCE(SUM(order_amount), 0) AS s,
           SUM(CASE WHEN order_amount IS NULL THEN 1 ELSE 0 END) AS nulls
    FROM bat_invoice_extractions
    WHERE reconciliation_id = ? AND COALESCE(is_exception, 0) = 1
  `).get(reconId);
  const missingExceptionRow = db.prepare(`
    SELECT COALESCE(SUM(o.order_amount), 0) AS s,
           SUM(CASE WHEN o.order_amount IS NULL THEN 1 ELSE 0 END) AS nulls
    FROM bat_overview_orders o
    WHERE o.reconciliation_id = ? AND o.is_exception = 1
      AND NOT EXISTS (
        SELECT 1 FROM bat_invoice_extractions e
        WHERE e.reconciliation_id = o.reconciliation_id AND e.order_number = o.order_number
      )
  `).get(reconId);
  const exceptionsBucket = extractedExceptionRow.s + missingExceptionRow.s;
  const exceptionSideNulls = (exceptionOverviewRow.nulls || 0)
                           + (extractedExceptionRow.nulls || 0)
                           + (missingExceptionRow.nulls || 0);
  if (exceptionSideNulls > 0) {
    checks.push({
      id: 'exceptions_bucket_equals_overview_exception_pivot',
      name: 'EXCEPTIONS (extractions + missing exc PODs) = Σ Overview exception-pivot order_amount',
      passed: true,
      skipped: true,
      detail: `Skipped — ${exceptionSideNulls} exception-side row${exceptionSideNulls === 1 ? '' : 's'} have NULL order_amount yet. Sum of known: ${fmtR(exceptionsBucket)} of pivot ${fmtR(exceptionOverviewRow.s)}.`,
    });
  } else {
    checks.push({
      id: 'exceptions_bucket_equals_overview_exception_pivot',
      name: 'EXCEPTIONS (extractions + missing exc PODs) = Σ Overview exception-pivot order_amount',
      passed: eqMoney(exceptionsBucket, exceptionOverviewRow.s),
      expected: fmtR(exceptionOverviewRow.s),
      actual: fmtR(exceptionsBucket),
      drift: exceptionsBucket - exceptionOverviewRow.s,
      detail: eqMoney(exceptionsBucket, exceptionOverviewRow.s)
        ? 'EXCEPTIONS tab balances to BAT spreadsheet exception pivot.'
        : `EXCEPTIONS bucket sum (${fmtR(exceptionsBucket)}) does not equal BAT exception-pivot total (${fmtR(exceptionOverviewRow.s)}). Drift ${fmtR(exceptionsBucket - exceptionOverviewRow.s)}.`,
    });
  }

  // I5. Every extraction's order_number is in bat_overview_orders for
  // this recon — no orphan extractions referencing ODRs BAT doesn't
  // claim. Orphan extractions inflate the bucket sums above and would
  // make I3/I4 fail. Surfaced separately so the operator knows which
  // row to investigate.
  const orphanExtractions = db.prepare(`
    SELECT e.id, e.order_number, e.is_exception, e.order_amount, e.pdf_url
    FROM bat_invoice_extractions e
    WHERE e.reconciliation_id = ?
      AND e.order_number IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM bat_overview_orders o
        WHERE o.reconciliation_id = e.reconciliation_id AND o.order_number = e.order_number
      )
  `).all(reconId);
  checks.push({
    id: 'no_orphan_extractions',
    name: 'Every extraction.order_number exists in bat_overview_orders for this recon',
    passed: orphanExtractions.length === 0,
    expected: '0 orphans',
    actual: `${orphanExtractions.length} orphan${orphanExtractions.length === 1 ? '' : 's'}`,
    detail: orphanExtractions.length === 0
      ? 'Every extraction row corresponds to an ODR BAT itemised in the Overview pivot.'
      : `Found ${orphanExtractions.length} extraction row${orphanExtractions.length === 1 ? '' : 's'} whose order_number is NOT in BAT's Overview pivot for this recon. Sample: ${orphanExtractions.slice(0, 3).map(o => `${o.order_number} (ext_id=${o.id}, R ${(o.order_amount || 0).toFixed(2)})`).join('; ')}. Could be a stale row from a prior upload (the v72 prune wasn't in effect when this happened) or a parser bug attaching an extraction to the wrong recon.`,
  });

  // I6. No duplicate extraction rows for the same (reconciliation_id,
  // order_number). The UNIQUE constraint is on (reconciliation_id,
  // pdf_url), so two rows with the same order_number but different
  // pdf_urls would both exist — they'd inflate the bucket sums. We
  // saw this exact pattern on the W3 investigation (rows existed
  // under multiple recons; if the same situation existed within a
  // single recon, that would be a real bug).
  const dupOrderNumbers = db.prepare(`
    SELECT order_number, COUNT(*) AS n
    FROM bat_invoice_extractions
    WHERE reconciliation_id = ? AND order_number IS NOT NULL
    GROUP BY order_number HAVING n > 1
  `).all(reconId);
  checks.push({
    id: 'no_duplicate_order_numbers_in_extractions',
    name: 'No duplicate extraction rows for the same order_number within this recon',
    passed: dupOrderNumbers.length === 0,
    expected: '0 duplicates',
    actual: `${dupOrderNumbers.length} duplicate${dupOrderNumbers.length === 1 ? '' : 's'}`,
    detail: dupOrderNumbers.length === 0
      ? 'One extraction per order_number — bucket sums can\'t double-count.'
      : `Found ${dupOrderNumbers.length} order_number${dupOrderNumbers.length === 1 ? '' : 's'} appearing on multiple extraction rows in this recon. Sample: ${dupOrderNumbers.slice(0, 3).map(d => `${d.order_number} (×${d.n})`).join('; ')}. These will inflate PAID/NON-COMP/EXCEPTIONS bucket sums.`,
  });

  // I7. is_exception consistency between extractions and overview.
  // If an extraction's is_exception flag disagrees with BAT's Overview
  // classification for the same ODR, the row lands in the wrong tab.
  const inconsistentExceptions = db.prepare(`
    SELECT e.id, e.order_number, e.is_exception AS ext_is_exc, o.is_exception AS ovw_is_exc
    FROM bat_invoice_extractions e
    JOIN bat_overview_orders o
      ON o.reconciliation_id = e.reconciliation_id AND o.order_number = e.order_number
    WHERE e.reconciliation_id = ?
      AND COALESCE(e.is_exception, 0) <> COALESCE(o.is_exception, 0)
  `).all(reconId);
  checks.push({
    id: 'is_exception_flag_matches_overview',
    name: 'extraction.is_exception agrees with bat_overview_orders.is_exception for same order',
    passed: inconsistentExceptions.length === 0,
    expected: '0 mismatches',
    actual: `${inconsistentExceptions.length} mismatch${inconsistentExceptions.length === 1 ? '' : 'es'}`,
    detail: inconsistentExceptions.length === 0
      ? 'Every extraction is in the same pivot (normal/exception) BAT placed it in.'
      : `Found ${inconsistentExceptions.length} row${inconsistentExceptions.length === 1 ? '' : 's'} where the extraction's is_exception flag disagrees with BAT's Overview classification. Rows land in the wrong audit-trail tab. Sample: ${inconsistentExceptions.slice(0, 3).map(r => `${r.order_number} (ext=${r.ext_is_exc}, overview=${r.ovw_is_exc})`).join('; ')}.`,
  });

  const passed = checks.every(c => c.passed);
  return { passed, overviewStored, checks };
}
