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
// Two branches in the alternation:
//   1. Word-form labels — INVOICE / INVOIC / WNVOICE / WNVOIC / NVOICE
//      / NVOIC. Each may stand alone (e.g. just "INVOICE" as a heading)
//      or carry an optional NO/NUMBER/#/etc. suffix and a colon. A
//      trailing \b is REQUIRED on the word-form group — otherwise
//      "INVOICE" matches inside "INVOICES" / "INVOICED" / "INVOICING"
//      etc. (any -s/-d/-r/-ing suffix on a real word), creating a
//      phantom label anchor in ordinary prose like "summary invoices"
//      that flips the rank to a nearby candidate.
//   2. Abbreviated INV — REQUIRES an explicit suffix from the same
//      list. Without this requirement the bare "INV" matches inside
//      every "INV1234" candidate (the digit doesn't break the alt's
//      old (?![a-z]) lookahead), creating a phantom label anchor at
//      the candidate itself; that phantom can outrank the real
//      "Invoice Number:" label and mis-extract.
//
// Also note `INVOICE?` rather than the original `INVOIC|INVOICE` — in
// alternation, the engine takes the first hit, so listing INVOIC first
// would consume only "INVOIC" out of "INVOICE", leaving a stray E and
// shifting the captured label-end position 1 char to the left of where
// the number actually sits.
//
// `g` flag is required so matchAll works.
const INVOICE_LABEL_RE =
  /\b(?:TAX\s+)?(?:(?:INVOICE?|WNVOICE?|NVOICE?)\b(?:\s*(?:NO\.?|NUMBER|NUM|N°|#))?\s*[:.]?|INV\s*(?:NO\.?|NUMBER|NUM|N°|#|[:.]))/gi;

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

// Each pattern config is { regex, build, literal }.
//
// `regex` MUST have /g — asserted at module load via
// assertGlobalRegexes() below.
//
// `build(match)` returns the candidate string OR null to reject this
// match (e.g. partial-pattern length check).
//
// `literal` declares whether the pattern's match in the SOURCE text
// already contains a literal IN/INQ prefix that we hand back unchanged,
// or whether the build step SYNTHESISES the IN prefix from a misread
// or naked-digit form. All real BAT invoices begin with IN/INQ, so
// patterns whose source contains the literal prefix are inherently
// more trustworthy than patterns that reconstruct the prefix from a
// guess. `literal: true` candidates outrank any `literal: false`
// candidate at selection time — see findInvoiceNumber for the
// partition.
//
// Pattern order is the v1 priority order; within a literal/synthesized
// partition it is the tie-breaker when positional ranking is
// unavailable AND when two candidates are equally close to a label.
function buildPatternConfigs(inDigitLength) {
  return [
    // 0. Long-form numeric invoice (legacy "18000xxxxxx" + new
    //    "1800042xxxxx"). OCR sometimes reads I→1 N→8 so the leading
    //    "18" is actually "IN" — the IN we return is RECONSTRUCTED.
    {
      regex: /\b(18\d{8,10})\b/g,
      build: (m) => 'IN' + m[1].substring(2),
      literal: false,
    },
    // 1. INQ-prefixed (Cardoso outbound on some sites). Must come
    //    before plain IN — otherwise "INQ0214536" partially matches
    //    "IN" and we'd drop the Q.
    {
      regex: /\bINQ\s*(\d{6,10})\b/gi,
      build: (m) => `INQ${m[1]}`,
      literal: true,
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
      literal: true,
    },
    // 3. Partial 422-core: garbled prefix, recognisable body.
    //    SYNTHESISED — IN000 prefix invented from a 422-core.
    {
      regex: /\b\d?0{2,3}(422\d{3,6})\b/g,
      build: (m) => {
        const full = 'IN000' + m[1];
        return (full.length >= 11 && full.length <= 14) ? full : null;
      },
      literal: false,
    },
    // 4. Partial 422-core anchored on INVOICE keyword. Source has the
    //    label but not the IN prefix — IN000 is still SYNTHESISED.
    {
      regex: /(?:INVOIC|NVOIC|VOICE)[E]?\s*[#:.]?\s*\d{0,5}(422\d{3})\b/gi,
      build: (m) => {
        const full = 'IN000' + m[1];
        return (full.length >= 11 && full.length <= 14) ? full : null;
      },
      literal: false,
    },
    // 5. IN-prefixed short (4-7 digit body).
    { regex: /\bIN\s*(\d{4,7})\b/gi, build: (m) => `IN${m[1]}`, literal: true },
    { regex: /\bINV\s*(\d{4,7})\b/gi, build: (m) => `IN${m[1]}`, literal: true },
    // 6. OCR misread: 1N / LN read as IN-short. The character class
    //    [IL1] accepts non-I letters, so the IN we return is partially
    //    SYNTHESISED — treat as such for ranking.
    { regex: /[IL1]\s*N\s*(\d{4,7})\b/g, build: (m) => `IN${m[1]}`, literal: false },
    // IN with non-letter junk between IN and the digits — the IN itself
    // is literal in the source, so this stays literal.
    { regex: /IN[^a-zA-Z\n\d]{0,3}(\d{4,7})\b/g, build: (m) => `IN${m[1]}`, literal: true },
    // 7. Standalone 55... numbers (IN555xxx without ANY prefix in the
    //    source). Heaviest synthesis — entirely invents the IN.
    { regex: /\b(55\d{4,7})\b/g, build: (m) => `IN${m[1]}`, literal: false },
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
  // Each candidate carries (value, index, patternPriority, literal)
  // so we can partition by literal-vs-synthesised first, then rank
  // by position, then break remaining ties by pattern priority. We
  // dedupe by (value, index) so the same number matched by two
  // overlapping patterns counts once; on dedupe we keep the entry
  // with the highest "literal-ness" + lowest patternPriority — i.e.
  // the most-trusted reading of that number wins.
  const allCandidates = [];
  const seen = new Map();
  const patterns = buildPatternConfigs(inDigitLength);
  for (let pIdx = 0; pIdx < patterns.length; pIdx++) {
    const { regex, build, literal } = patterns[pIdx];
    for (const m of cleaned.matchAll(regex)) {
      const value = build(m);
      if (!value) continue;
      if (exclude && exclude.has(value)) continue;
      const dedupKey = `${value}@${m.index}`;
      const existing = seen.get(dedupKey);
      const candidate = { value, index: m.index, patternPriority: pIdx, literal };
      if (!existing) {
        seen.set(dedupKey, candidate);
        allCandidates.push(candidate);
      } else if (
        // Prefer literal over synthesised; among same-literalness,
        // prefer the lower (earlier) pattern priority.
        (candidate.literal && !existing.literal)
        || (candidate.literal === existing.literal && candidate.patternPriority < existing.patternPriority)
      ) {
        existing.literal = candidate.literal;
        existing.patternPriority = candidate.patternPriority;
      }
    }
  }
  if (allCandidates.length === 0) return null;

  // Partition: literal-prefix candidates beat synthesised-prefix
  // candidates unconditionally. All real BAT invoices begin with
  // IN/INQ in the source; the synthesised set exists ONLY as a
  // recovery hatch for OCR misreads, so it should only fire when the
  // text contains nothing more trustworthy. Past hard-learned lesson
  // (see commented-out dominant-prefix detection in batReconciliation.js
  // around the runGoogleVisionRetryInner block): heuristics that
  // synthesise prefixes have rewritten correct invoice numbers in
  // production. Don't let them outrank a real match.
  const literalCandidates = allCandidates.filter(c => c.literal);
  const candidates = literalCandidates.length > 0 ? literalCandidates : allCandidates;

  // ── 2. Find every label position. We use the END of the label as
  // the anchor — typically "INVOICE NUMBER:" is followed within a
  // few chars by the number. ────────────────────────────────────────
  const labelEnds = [];
  for (const m of cleaned.matchAll(INVOICE_LABEL_RE)) {
    labelEnds.push(m.index + m[0].length);
  }

  // ── 3. If at least one candidate is "near" any label, rank by
  // minimum DIRECTIONAL distance: candidates AFTER a label outrank
  // those before it. Real PODs lay out as "Invoice Number: <num>",
  // so the number is overwhelmingly to the RIGHT of the label.
  // Pre-label tokens are typically unrelated identifiers — customer
  // refs, order numbers, account codes — that happen to look like
  // invoice numbers but aren't.
  //
  // Concrete failure the directional bias closes:
  //   "Ref IN1234567 Invoice Number: ... IN999888777"
  // Pure absolute distance scored IN1234567 (a few chars BEFORE the
  // label) closer than IN999888777 (further AFTER), so the wrong
  // number won. Now the after-label candidate always beats any
  // before-label candidate, regardless of raw distance.
  //
  // We still keep before-label candidates in the running as a
  // last-resort tier — heavily penalised — for the rare unconventional
  // layout where the number really does precede the label. If no
  // after-label candidate exists, the closest before-label one wins.
  //
  // Otherwise fall back to v1 pattern priority. The fallback preserves
  // backwards-compatibility on POD layouts where no label keyword
  // survives the OCR pass — we then trust the regex priority order
  // as before.
  const PRE_LABEL_PENALTY = 10_000;

  // Raw absolute distance — used ONLY for the "is any candidate near
  // a label?" gate, NOT for ranking. The penalty score below would
  // disqualify all pre-label candidates from being "near" if we used
  // it in the gate, and we'd lose the rare-but-real number-before-
  // label layouts entirely.
  const rawDistance = (idx) => {
    let best = Infinity;
    for (const lEnd of labelEnds) {
      const abs = Math.abs(idx - lEnd);
      if (abs < best) best = abs;
    }
    return best;
  };

  // Directional rank score — lower is better. After-label candidates
  // get their post-label distance directly; before-label candidates
  // are PRE_LABEL_PENALTY + their pre-label distance. Any after-label
  // candidate (even one ~1000 chars away) beats any before-label one,
  // matching real-POD layout conventions.
  const directionalScore = (idx) => {
    let bestAfter = Infinity;   // smallest (idx - lEnd) for idx >= lEnd
    let bestBefore = Infinity;  // smallest (lEnd - idx) for idx < lEnd
    for (const lEnd of labelEnds) {
      const delta = idx - lEnd;
      if (delta >= 0) {
        if (delta < bestAfter) bestAfter = delta;
      } else {
        const abs = -delta;
        if (abs < bestBefore) bestBefore = abs;
      }
    }
    if (bestAfter !== Infinity) return bestAfter;
    return PRE_LABEL_PENALTY + bestBefore;
  };

  const anyNearLabel = labelEnds.length > 0
    && candidates.some(c => rawDistance(c.index) <= NEAR_LABEL_CHARS);

  if (anyNearLabel) {
    candidates.sort((a, b) => {
      const da = directionalScore(a.index);
      const db = directionalScore(b.index);
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
