// Match supplier (POD/OCR) extractions to Cardoso invoices.
//
// Carved out of src/services/batReconciliation.js as part of the BAT
// module split. Matching is the heart of the reconciliation pipeline:
// every row the operator sees on the recon detail page (matched,
// auto-corrected, mismatched, unmatched supplier, unmatched Cardoso)
// flows through here. Pulling it into its own file (with `db` as an
// explicit arg) lets us pin the behaviour with in-memory SQLite tests
// — particularly the two sharp edges:
//
//   1. The 1-digit fuzzy auto-correct, which writes back to
//      bat_invoice_extractions.extracted_invoice. A regression that
//      makes this too eager corrupts real OCR data on disk.
//   2. The manual_override sacred-edit guard: rows the operator has
//      manually corrected MUST NOT be re-fuzzy-matched, otherwise
//      the auto-correct will silently undo their fix the next time
//      matching runs.

/**
 * @typedef {Object} MatchResultRow
 * @property {number|null} extraction_id   null for unmatched Cardoso rows
 * @property {number|null} cardoso_id      null for unmatched supplier rows
 * @property {string} invoice_number
 * @property {number|null} supplier_amount
 * @property {number|null} cardoso_amount
 * @property {number|null} difference
 * @property {boolean} matched
 * @property {boolean} amount_mismatch     true when |difference| > 0.01
 * @property {boolean} [auto_corrected]    true when fuzzy fix was applied
 *
 * @typedef {Object} MatchStats
 * @property {number} total
 * @property {number} matched
 * @property {number} mismatches
 * @property {number} autoCorrections
 * @property {number} unmatchedSupplier
 * @property {number} unmatchedCardoso
 *
 * @typedef {Object} MatchResult
 * @property {MatchResultRow[]} results
 * @property {MatchStats} stats
 */

const EXTRACTION_COLS = `
  e.id, e.extracted_invoice, e.order_amount,
  e.supplier_discount, e.supplier_del_fee, e.supplier_pricing,
  e.delivery_date, e.is_exception, e.manual_override,
  e.reconciliation_id, r.week_number, r.year
`;
const CARDOSO_COLS = `id, invoice_number, amount, price_diff, discount, del_fee`;

/**
 * Match supplier extractions against Cardoso invoices, with a single-
 * digit fuzzy auto-correct fallback. When `reconId` is null, runs
 * across ALL reconciliations (used after Cardoso bulk upload + by the
 * cross-recon audit views).
 *
 * Side effect: writes corrected invoice numbers back to
 * bat_invoice_extractions when fuzzy matching succeeds. Manual edits
 * (manual_override=1) are never auto-corrected.
 *
 * @param {{ db: import('better-sqlite3').Database, reconId?: number|null }} args
 * @returns {MatchResult}
 */
export function matchCardosoToSupplier({ db, reconId = null }) {
  const extractions = reconId
    ? db.prepare(`SELECT ${EXTRACTION_COLS} FROM bat_invoice_extractions e LEFT JOIN bat_reconciliations r ON r.id = e.reconciliation_id WHERE e.reconciliation_id = ? AND e.extracted_invoice IS NOT NULL`).all(reconId)
    : db.prepare(`SELECT ${EXTRACTION_COLS} FROM bat_invoice_extractions e LEFT JOIN bat_reconciliations r ON r.id = e.reconciliation_id WHERE e.extracted_invoice IS NOT NULL`).all();
  const cardosoInvoices = reconId
    ? db.prepare(`SELECT ${CARDOSO_COLS} FROM bat_cardoso_invoices WHERE reconciliation_id = ?`).all(reconId)
    : db.prepare(`SELECT ${CARDOSO_COLS} FROM bat_cardoso_invoices`).all();

  // Build lookup: normalized invoice number → cardoso row
  const cardosoMap = new Map();
  for (const ci of cardosoInvoices) {
    const key = ci.invoice_number.replace(/\s/g, '').toUpperCase();
    cardosoMap.set(key, ci);
  }

  // Fuzzy match helper: find Cardoso invoice within 1 digit difference.
  // Length must match exactly and be >=4 chars — shorter strings produce
  // too many false positives (every 3-digit invoice would fuzzy-match
  // every other 3-digit invoice with one common digit).
  function fuzzyFind(ocrInvoice) {
    const ocrKey = ocrInvoice.replace(/\s/g, '').toUpperCase();
    if (ocrKey.length < 4) return null;
    for (const [cardosoKey, ci] of cardosoMap) {
      if (cardosoKey.length !== ocrKey.length) continue;
      let diffs = 0;
      for (let i = 0; i < ocrKey.length; i++) {
        if (ocrKey[i] !== cardosoKey[i]) diffs++;
        if (diffs > 1) break;
      }
      if (diffs === 1) return { ci, correctedInvoice: ci.invoice_number };
    }
    return null;
  }

  const results = [];
  const matchedCardosoIds = new Set();
  let autoCorrections = 0;

  // Auto-correct update statement
  const correctInvoice = db.prepare('UPDATE bat_invoice_extractions SET extracted_invoice = ? WHERE id = ?');

  for (const ext of extractions) {
    const key = (ext.extracted_invoice || '').replace(/\s/g, '').toUpperCase();
    let cardoso = cardosoMap.get(key);

    // Fuzzy match: if exact match fails, try 1-digit-off — but ONLY for rows
    // the user hasn't manually corrected. Manual edits are sacred.
    let wasCorrected = false;
    if (!cardoso && !ext.manual_override) {
      const fuzzy = fuzzyFind(ext.extracted_invoice);
      if (fuzzy) {
        cardoso = fuzzy.ci;
        console.log(`[bat-match] Auto-corrected ${ext.extracted_invoice} → ${fuzzy.correctedInvoice} (1-digit OCR fix)`);
        correctInvoice.run(fuzzy.correctedInvoice, ext.id);
        ext.extracted_invoice = fuzzy.correctedInvoice;
        wasCorrected = true;
        autoCorrections++;
      }
    }

    if (cardoso) {
      matchedCardosoIds.add(cardoso.id);
      const diff = (ext.order_amount || 0) - (cardoso.amount || 0);
      results.push({
        extraction_id: ext.id,
        cardoso_id: cardoso.id,
        invoice_number: ext.extracted_invoice,
        supplier_amount: ext.order_amount,
        cardoso_amount: cardoso.amount,
        supplier_discount: ext.supplier_discount,
        supplier_del_fee: ext.supplier_del_fee,
        supplier_pricing: ext.supplier_pricing,
        cardoso_price_diff: cardoso.price_diff,
        cardoso_discount: cardoso.discount,
        cardoso_del_fee: cardoso.del_fee,
        difference: diff,
        matched: true,
        amount_mismatch: Math.abs(diff) > 0.01,
        auto_corrected: wasCorrected,
        is_exception: ext.is_exception,
        week_number: ext.week_number,
        year: ext.year,
        delivery_date: ext.delivery_date,
      });
    } else {
      results.push({
        extraction_id: ext.id,
        cardoso_id: null,
        invoice_number: ext.extracted_invoice,
        supplier_amount: ext.order_amount,
        supplier_discount: ext.supplier_discount,
        supplier_del_fee: ext.supplier_del_fee,
        supplier_pricing: ext.supplier_pricing,
        cardoso_amount: null,
        cardoso_price_diff: null,
        cardoso_discount: null,
        cardoso_del_fee: null,
        difference: null,
        matched: false,
        amount_mismatch: false,
        is_exception: ext.is_exception,
        week_number: ext.week_number,
        year: ext.year,
        delivery_date: ext.delivery_date,
      });
    }
  }

  // Unmatched Cardoso invoices (not found in supplier)
  for (const ci of cardosoInvoices) {
    if (!matchedCardosoIds.has(ci.id)) {
      results.push({
        extraction_id: null,
        cardoso_id: ci.id,
        invoice_number: ci.invoice_number,
        supplier_amount: null,
        cardoso_amount: ci.amount,
        cardoso_price_diff: ci.price_diff,
        cardoso_discount: ci.discount,
        cardoso_del_fee: ci.del_fee,
        difference: null,
        matched: false,
        amount_mismatch: false,
      });
    }
  }

  const matched = results.filter(r => r.matched).length;
  const mismatches = results.filter(r => r.amount_mismatch).length;
  console.log(`[bat] Matching: ${matched} matched (${autoCorrections} auto-corrected), ${mismatches} amount mismatches, ${results.length - matched} unmatched`);

  return {
    results,
    stats: {
      total: results.length,
      matched,
      mismatches,
      autoCorrections,
      unmatchedSupplier: results.filter(r => !r.matched && r.extraction_id).length,
      unmatchedCardoso: results.filter(r => !r.matched && r.cardoso_id).length,
    },
  };
}
