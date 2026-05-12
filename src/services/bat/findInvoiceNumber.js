// Invoice-number extraction from OCR'd POD text.
//
// Lifted from two near-identical copies that lived inline in
// ocrWorker.js and batReconciliation.js. Both files now import from
// here so the patterns can never drift apart again.
//
// History of the matcher's selection logic:
//   v1 (pre-PR-#316) — first match wins, in pattern-priority order.
//                      Vulnerable to letterhead numbers that appear
//                      before the real invoice number on the page.
//   v2 (PR #316)     — same first-wins logic, but with `excludeSet`:
//                      any candidate string in the set is skipped and
//                      the loop falls through to the next match.
//                      Hard-coded poison set + per-recon dynamic
//                      blacklist drove down the cross-recon poison
//                      family that round-6 PDFium QA surfaced.
//   v3 (this PR)     — POSITIONAL BIAS via textual proximity. We now
//                      collect EVERY candidate from EVERY pattern
//                      (with its index in the cleaned text), then if
//                      ANY candidate is "near" an "INVOICE NUMBER:" /
//                      "INV #" / similar label, rank by min absolute
//                      distance to the nearest such label. If no
//                      candidate is near any label (or the text has
//                      no labels), fall back to the v1 pattern-
//                      priority order. excludeSet from v2 still
//                      applies — we just have a smarter tie-breaker
//                      among the surviving candidates.
//
// Why textual proximity rather than full bounding-box positional?
// Bounding boxes would require plumbing {text, boxes[]} through
// EVERY OCR engine (ocr.space, Google Vision, Tesseract, the
// pdfjs text-layer fast path) and threading the new shape through
// the whole cascade. That's a real refactor for a marginal
// improvement: on every real BAT POD I have seen, the engine's
// linearised text already preserves the relative order of the
// "Invoice Number:" label and the number that follows it — that
// order IS the positional signal. Bounding-box plumbing would
// rule out a small minority of two-column layouts where the
// linearisation interleaves regions, but those are rare and for
// the cost we get a much bigger blast radius. Punting until the
// data justifies it.

// Hard-coded poison set — numbers we have confirmed by hand are
// header/account/footer artefacts mistaken for invoice numbers.
// Add carefully; a real invoice number landing in here would be
// silently dropped from every recon. Each entry should have an
// inline comment naming the originating supplier/POD pattern so a
// future engineer can audit.
export const HARDCODED_POISON_INVOICES = new Set([
  // The 'IN[5/8][0/8]0115[68]07' family — four near-identical numbers
  // that all behave the same way: appear on PODs from unrelated RBA
  // suppliers across multiple weeks/recons (one per recon, never
  // exceeds a per-recon dup threshold), never match an actual Sage
  // invoice. Cross-recon analysis on 2026-05-12 confirmed all four
  // recur across 3-8 different recons each. Almost certainly a
  // recurring header/account/branch artefact in the same template.
  'IN500115607',
  'IN500115807',
  'IN580115607',
  'IN580115807',
]);

// "Invoice Number" / "Inv #" / "Tax Invoice No." / etc. — the labels
// that, when present, anchor positional ranking. OCR mangling tolerated:
// "WNVOICE" / "NVOICE" / "INVOIC" all show up in real engine output.
// Captures the END of the label so candidates AFTER the label score
// the smallest absolute distances.
//
// `g` flag is required so matchAll works.
const INVOICE_LABEL_RE =
  /\b(?:TAX\s+)?(?:INVOIC|INVOICE|WNVOICE|WNVOIC|NVOICE|NVOIC|INV(?![a-z]))\s*(?:NO\.?|NUMBER|NUM|N°|#)?\s*[:.]?/gi;

// A candidate within this many characters of a label is "near" enough
// for the positional rank to apply. ~140 chars covers most "Invoice
// Number: IN578001" header lines and the 1-2 line block typically
// underneath, but stays well below the typical body-text + footer
// distance where an unrelated number could live.
const NEAR_LABEL_CHARS = 140;

// `excludeSet` accepts a Set OR an Array (some callers find it easier
// to build an array; we coerce here so callers can pass either).
function normalizeExclude(excludeSet) {
  if (!excludeSet) return null;
  if (excludeSet instanceof Set) return excludeSet;
  if (Array.isArray(excludeSet)) return new Set(excludeSet);
  return null;
}

// Each pattern config is { regex, build }. `regex` MUST have /g —
// asserted at module load via the assertGlobalRegexes() pass below.
// `build(match)` returns the candidate string OR null to reject this
// match (e.g. partial-pattern length check).
//
// Pattern order is the v1 priority order; it is the tie-breaker when
// positional ranking is unavailable AND when two candidates are equally
// close to a label.
function buildPatternConfigs(inDigitLength) {
  return [
    // 0. Long-form numeric invoice (legacy "18000xxxxxx" + new
    //    "1800042xxxxx"). OCR sometimes reads I→1 N→8 so the leading
    //    "18" is actually "IN".
    {
      regex: /\b(18\d{8,10})\b/g,
      build: (m) => 'IN' + m[1].substring(2),
    },
    // 1. INQ-prefixed (Cardoso outbound on some sites). Must come
    //    before plain IN — otherwise "INQ0214536" partially matches
    //    "IN" and we'd drop the Q.
    {
      regex: /\bINQ\s*(\d{6,10})\b/gi,
      build: (m) => `INQ${m[1]}`,
    },
    // 2. IN-prefixed long (8-10 digit body). Padded up to inDigitLength
    //    when short — treats a one-short read as dropped-zero OCR.
    {
      regex: /\bIN\s*(\d{8,10})\b/gi,
      build: (m) => {
        let digits = m[1];
        if (digits.length < inDigitLength) {
          digits = '0'.repeat(inDigitLength - digits.length) + digits;
        }
        return `IN${digits}`;
      },
    },
    // 3. Partial 422-core: garbled prefix, recognisable body. Sometimes
    //    the only thing the engine returns cleanly.
    {
      regex: /\b\d?0{2,3}(422\d{3,6})\b/g,
      build: (m) => {
        const full = 'IN000' + m[1];
        return (full.length >= 11 && full.length <= 14) ? full : null;
      },
    },
    // 4. Partial 422-core anchored on INVOICE keyword.
    {
      regex: /(?:INVOIC|NVOIC|VOICE)[E]?\s*[#:.]?\s*\d{0,5}(422\d{3})\b/gi,
      build: (m) => {
        const full = 'IN000' + m[1];
        return (full.length >= 11 && full.length <= 14) ? full : null;
      },
    },
    // 5. IN-prefixed short (4-7 digit body).
    { regex: /\bIN\s*(\d{4,7})\b/gi, build: (m) => `IN${m[1]}` },
    { regex: /\bINV\s*(\d{4,7})\b/gi, build: (m) => `IN${m[1]}` },
    // 6. OCR misread: 1N / IN / LN / lN read as IN-short.
    { regex: /[IL1]\s*N\s*(\d{4,7})\b/g, build: (m) => `IN${m[1]}` },
    { regex: /IN[^a-zA-Z\n\d]{0,3}(\d{4,7})\b/g, build: (m) => `IN${m[1]}` },
    // 7. Standalone 55... numbers (IN555xxx without the IN prefix).
    { regex: /\b(55\d{4,7})\b/g, build: (m) => `IN${m[1]}` },
  ];
}

// Module-load sanity: every pattern.regex must be /g. Failing fast
// here makes a mistake in the table impossible to ship — the test
// suite will see the throw on first import.
(function assertGlobalRegexes() {
  for (const p of buildPatternConfigs(9)) {
    if (!p.regex.global) {
      throw new Error(
        `findInvoiceNumber pattern config missing /g flag: ` +
        `/${p.regex.source}/${p.regex.flags}`,
      );
    }
  }
})();

export function findInvoiceNumber(text, inDigitLength = 9, excludeSet = null) {
  if (!text) return null;
  const exclude = normalizeExclude(excludeSet);

  const cleaned = text
    .replace(/[|]/g, 'I')
    .replace(/[oO](?=\d{3,})/g, '0')
    .replace(/[lI](?=N\d)/g, 'I')
    .replace(/\*/g, '')
    .replace(/[{}[\]()]/g, '')
    .replace(/[—–-]{2,}/g, ' ');

  // ── 1. Collect every accepted candidate from every pattern. ─────
  // Each candidate carries (value, index, patternPriority) so we can
  // rank by position later but still have the v1 priority order to
  // break ties. We dedupe by (value, index) so the same number
  // matched by two overlapping patterns counts once.
  const candidates = [];
  const seen = new Set();
  const patterns = buildPatternConfigs(inDigitLength);
  for (let pIdx = 0; pIdx < patterns.length; pIdx++) {
    const { regex, build } = patterns[pIdx];
    for (const m of cleaned.matchAll(regex)) {
      const value = build(m);
      if (!value) continue;
      if (exclude && exclude.has(value)) continue;
      const dedupKey = `${value}@${m.index}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      candidates.push({ value, index: m.index, patternPriority: pIdx });
    }
  }
  if (candidates.length === 0) return null;

  // ── 2. Find every label position. We use the END of the label as
  // the anchor — typically "INVOICE NUMBER:" is followed within a
  // few chars by the number. ────────────────────────────────────────
  const labelEnds = [];
  for (const m of cleaned.matchAll(INVOICE_LABEL_RE)) {
    labelEnds.push(m.index + m[0].length);
  }

  // ── 3. If at least one candidate is "near" any label, rank by
  // minimum absolute distance. Otherwise fall back to v1 pattern
  // priority. The fallback preserves backwards-compatibility on
  // POD layouts where no label keyword survives the OCR pass — we
  // then trust the regex priority order as before. ──────────────────
  const distance = (idx) => {
    let best = Infinity;
    for (const lEnd of labelEnds) {
      const d = Math.abs(idx - lEnd);
      if (d < best) best = d;
    }
    return best;
  };

  const anyNearLabel = labelEnds.length > 0
    && candidates.some(c => distance(c.index) <= NEAR_LABEL_CHARS);

  if (anyNearLabel) {
    candidates.sort((a, b) => {
      const da = distance(a.index);
      const db = distance(b.index);
      if (da !== db) return da - db;
      if (a.patternPriority !== b.patternPriority) return a.patternPriority - b.patternPriority;
      return a.index - b.index;
    });
  } else {
    candidates.sort((a, b) => {
      if (a.patternPriority !== b.patternPriority) return a.patternPriority - b.patternPriority;
      return a.index - b.index;
    });
  }
  return candidates[0].value;
}
