// Invoice-number extraction from OCR'd POD text.
//
// Lifted from two near-identical copies that lived inline in
// ocrWorker.js and batReconciliation.js. Both files now import from
// here so the patterns can never drift apart again.
//
// New in this rev: optional `excludeSet` parameter. When supplied, any
// candidate string that appears in the set is treated as "not a match"
// and the loop falls through to the next candidate (within the same
// pattern via matchAll, then to subsequent patterns). Use cases:
//   1. HARDCODED_POISON_INVOICES — known-bad numbers we've manually
//      identified (e.g. customer-account / branch-reference tokens that
//      look like invoice numbers and recur on every POD from a sender).
//   2. Per-recon dynamic blacklist — invoice numbers that have already
//      been extracted from N or more PODs in the same recon. Above a
//      threshold this is overwhelmingly likely to be a header/footer
//      artefact rather than a legitimate multi-delivery invoice.
//
// Why not positional bias / bounding-box matching? A second PR is
// planned for that (see docs/plans/ocr-future-work.md). It needs every
// engine (Google Vision, ocr.space, Tesseract, pdfjs-text) to start
// returning {text, boxes[]} and the cascade plumbed accordingly. That's
// a real refactor; this excludeSet hook is the safety net while we
// design it.

// Hard-coded poison set — numbers we have confirmed by hand are
// header/account/footer artefacts mistaken for invoice numbers.
// Add carefully; a real invoice number landing in here would be
// silently dropped from every recon. Each entry should have an
// inline comment naming the originating supplier/POD pattern so a
// future engineer can audit.
export const HARDCODED_POISON_INVOICES = new Set([
  // Recurs across SKY CITY and several other RBA suppliers' PODs;
  // appears 5-7× per week of recon-18-shaped data, never matches an
  // actual Sage invoice. Spotted by Sean during round 6 PDFium QA.
  'IN500115607',
  // Sister artefact to IN500115607, same suppliers, same recurrence.
  'IN580115607',
]);

// `excludeSet` accepts a Set OR an Array (some callers find it easier
// to build an array; we coerce here so callers can pass either).
function normalizeExclude(excludeSet) {
  if (!excludeSet) return null;
  if (excludeSet instanceof Set) return excludeSet;
  if (Array.isArray(excludeSet)) return new Set(excludeSet);
  return null;
}

// Try every match of `regex` in `text`. For each, build a candidate
// via `buildCandidate(match)`. Return the first candidate that is
// non-null AND not in `excludeSet`. Returns null if none qualify.
//
// `regex` MUST be /g — without it `text.matchAll` throws. Asserted
// here so the call sites stay readable.
function firstAcceptedMatch(text, regex, buildCandidate, excludeSet) {
  if (!regex.global) {
    throw new Error(`firstAcceptedMatch: regex must have /g flag (got /${regex.source}/${regex.flags})`);
  }
  for (const m of text.matchAll(regex)) {
    const candidate = buildCandidate(m);
    if (!candidate) continue;
    if (excludeSet && excludeSet.has(candidate)) continue;
    return candidate;
  }
  return null;
}

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

  // Long-form numeric invoice (legacy "18000xxxxxx" format and the new
  // "1800042xxxxx" 11-12 digit form). Without the wider {8,10} range the
  // 10-digit-after-IN format that BAT rolled out recently was never
  // matched, every row hit no_regex_match, and the cascade walked the
  // whole engine list before timing out at extract_total.
  const long = firstAcceptedMatch(
    cleaned,
    /\b(18\d{8,10})\b/g,
    (m) => 'IN' + m[1].substring(2),
    exclude,
  );
  if (long) return long;

  // INQ-prefixed (Cardoso outbound invoice format on some sites).
  // Must come BEFORE the IN-prefixed match below — INQ would otherwise
  // partially match IN and return without the Q. Real-world example
  // from a SASOL DELIGHT MARSHALL POD: GoogleVision read "INQ0214536"
  // perfectly but findInvoiceNumber dropped it because no INQ pattern
  // existed and IN\d{8,10} didn't match (Q breaks the digit run).
  // No padding — INQ uses a 7-digit canonical that may differ from the
  // IN-prefix sites' inDigitLength.
  const inq = firstAcceptedMatch(
    cleaned,
    /\bINQ\s*(\d{6,10})\b/gi,
    (m) => `INQ${m[1]}`,
    exclude,
  );
  if (inq) return inq;

  // IN-prefixed long. Range widened from {8,9} to {8,10} for the
  // post-rollover 10-digit form. Padding to the per-site canonical length
  // (`inDigitLength`, default 9): a one-short read is treated as a
  // dropped-zero OCR error and padded; an at-or-above-length read is
  // returned as-is.
  const inLong = firstAcceptedMatch(
    cleaned,
    /\bIN\s*(\d{8,10})\b/gi,
    (m) => {
      let digits = m[1];
      if (digits.length < inDigitLength) digits = '0'.repeat(inDigitLength - digits.length) + digits;
      return `IN${digits}`;
    },
    exclude,
  );
  if (inLong) return inLong;

  const partialPatterns = [
    /\b\d?0{2,3}(422\d{3,6})\b/g,
    /(?:INVOIC|NVOIC|VOICE)[E]?\s*[#:.]?\s*\d{0,5}(422\d{3})\b/gi,
  ];
  for (const p of partialPatterns) {
    const cand = firstAcceptedMatch(
      cleaned,
      p,
      (m) => {
        const full = 'IN000' + m[1];
        // Length range covers BAT's two known invoice formats:
        //   IN<9 digits>  → 11 chars (e.g. IN000422238 — pre-rollover)
        //   IN<10 digits> → 12 chars (e.g. IN0004225236 — post-rollover)
        return (full.length >= 11 && full.length <= 14) ? full : null;
      },
      exclude,
    );
    if (cand) return cand;
  }

  const inPatterns = [
    /\bIN\s*(\d{4,7})\b/gi,
    /\bINV\s*(\d{4,7})\b/gi,
    /[IL1]\s*N\s*(\d{4,7})\b/g,
    /IN[^a-zA-Z\n\d]{0,3}(\d{4,7})\b/g,
  ];
  for (const pattern of inPatterns) {
    const cand = firstAcceptedMatch(cleaned, pattern, (m) => `IN${m[1]}`, exclude);
    if (cand) return cand;
  }

  const standalone = firstAcceptedMatch(
    cleaned,
    /\b(55\d{4,7})\b/g,
    (m) => `IN${m[1]}`,
    exclude,
  );
  if (standalone) return standalone;

  return null;
}
