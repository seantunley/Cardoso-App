// Tests for the BAT invoice-number regex pipeline + the excludeSet
// poison-guard hook + the textual-proximity positional ranking.
// The function used to live inline in both ocrWorker.js and
// batReconciliation.js; it was extracted to
// src/services/bat/findInvoiceNumber.js so it can be unit-tested
// (importing ocrWorker.js directly would trigger the worker_threads
// parentPort.on dispatch at module load).
//
// Three test groups:
//   1. Regression — the original regex behaviour (no excludeSet, no
//      label keyword) still extracts the same numbers it did before
//      the refactor. These guard against accidental drift in the
//      regex pipeline.
//   2. excludeSet — both the hard-coded HARDCODED_POISON_INVOICES
//      list and ad-hoc excluded sets cause matchAll to skip the
//      excluded candidate and continue searching.
//   3. Positional bias — when an INVOICE-label keyword is present
//      and at least one candidate is "near" it, the matcher prefers
//      the closest candidate. When no label is found (or no candidate
//      is near one), behaviour falls back to v1 pattern-priority
//      order so unlabelled inputs are unaffected.

import { describe, it, expect } from 'vitest';
import {
  findInvoiceNumber,
  HARDCODED_POISON_INVOICES,
} from '../src/services/bat/findInvoiceNumber.js';

describe('findInvoiceNumber — regression on original regex pipeline', () => {
  it('matches a clean IN-prefix 9-digit invoice', () => {
    expect(findInvoiceNumber('Invoice Number: IN578457123')).toBe('IN578457123');
  });

  it('pads short IN reads up to inDigitLength=9 (dropped-zero recovery)', () => {
    // 8-digit read from OCR; legacy site canonical is 9 → pad with leading 0
    expect(findInvoiceNumber('Invoice IN57845712', 9)).toBe('IN057845712');
  });

  it('does NOT pad when inDigitLength=8 (sites whose canonical is 8 digits)', () => {
    expect(findInvoiceNumber('Invoice IN57845712', 8)).toBe('IN57845712');
  });

  it('recovers the 18→IN OCR misread (I/N read as 1/8)', () => {
    expect(findInvoiceNumber('Long invoice 1800042238')).toBe('IN00042238');
  });

  it('matches INQ-prefixed Cardoso outbound format', () => {
    expect(findInvoiceNumber('Document INQ0214536 dated')).toBe('INQ0214536');
  });

  it('reconstructs partial 422-core numbers via the keyword pattern', () => {
    expect(findInvoiceNumber('INVOICE NO 000422238')).toBe('IN000422238');
  });

  it('matches short IN-prefix invoices (4-7 digit form)', () => {
    expect(findInvoiceNumber('Stamped IN555177 below the address')).toBe('IN555177');
  });

  it('matches standalone 55... numbers as IN-prefixed', () => {
    expect(findInvoiceNumber('Reference 5555432 on the POD')).toBe('IN5555432');
  });

  it('returns null when no recognisable pattern is present', () => {
    expect(findInvoiceNumber('Just some text with no invoice numbers at all')).toBe(null);
  });

  it('returns null on empty/null input', () => {
    expect(findInvoiceNumber('')).toBe(null);
    expect(findInvoiceNumber(null)).toBe(null);
    expect(findInvoiceNumber(undefined)).toBe(null);
  });
});

describe('findInvoiceNumber — excludeSet poison guard', () => {
  it('exports the hard-coded poison set with the full known-artefact family', () => {
    // The IN[5/8][0/8]0115[68]07 family — four near-identical numbers
    // that recur across 3-8 different recons each, never match a real
    // Sage invoice. See src/services/bat/findInvoiceNumber.js for the
    // audit trail.
    expect(HARDCODED_POISON_INVOICES.has('IN500115607')).toBe(true);
    expect(HARDCODED_POISON_INVOICES.has('IN500115807')).toBe(true);
    expect(HARDCODED_POISON_INVOICES.has('IN580115607')).toBe(true);
    expect(HARDCODED_POISON_INVOICES.has('IN580115807')).toBe(true);
  });

  it('skips an excluded candidate and returns the next match in the same pattern', () => {
    // Two IN-9-digit numbers in the text. With excludeSet containing the
    // first, the matchAll loop should fall through to the second.
    const text = 'Header IN500115607 / Real invoice IN578457001 below';
    const exclude = new Set(['IN500115607']);
    expect(findInvoiceNumber(text, 9, exclude)).toBe('IN578457001');
  });

  it('skips poison candidates from the hard-coded list by default when caller passes that set', () => {
    const text = 'Header IN500115607 / Body IN578457001';
    expect(findInvoiceNumber(text, 9, HARDCODED_POISON_INVOICES)).toBe('IN578457001');
  });

  it('returns null when ALL matching candidates are excluded', () => {
    const text = 'Header IN500115607 / Footer IN580115607';
    expect(findInvoiceNumber(text, 9, HARDCODED_POISON_INVOICES)).toBe(null);
  });

  it('accepts excludeSet as an Array (coerced to Set)', () => {
    const text = 'Header IN500115607 / Real IN578457001';
    expect(findInvoiceNumber(text, 9, ['IN500115607'])).toBe('IN578457001');
  });

  it('null/undefined excludeSet behaves identically to omitting the parameter', () => {
    const text = 'Invoice IN578457001';
    const a = findInvoiceNumber(text);
    const b = findInvoiceNumber(text, 9, null);
    const c = findInvoiceNumber(text, 9, undefined);
    expect(a).toBe('IN578457001');
    expect(b).toBe('IN578457001');
    expect(c).toBe('IN578457001');
  });

  it('skipping a poisoned IN-long match falls through to a shorter IN-prefix match', () => {
    // First pattern (IN \d{8,10}) hits the poison; the loop should fall
    // through to the IN \d{4,7} pattern and pick up the shorter number.
    const text = 'Top IN500115607 / Bottom IN555177';
    expect(findInvoiceNumber(text, 9, HARDCODED_POISON_INVOICES)).toBe('IN555177');
  });

  it('does NOT skip a candidate that only LOOKS similar to a poisoned one', () => {
    // IN500115608 differs by one digit — must NOT be excluded.
    const text = 'IN500115608';
    expect(findInvoiceNumber(text, 9, HARDCODED_POISON_INVOICES)).toBe('IN500115608');
  });
});

describe('findInvoiceNumber — positional bias (textual proximity)', () => {
  it('prefers a candidate near "Invoice Number:" over an earlier candidate without a label', () => {
    // The footer-style "IN578457001" appears FIRST in the text. Pre-v3
    // (first-match-wins) would have returned it. v3 sees the second
    // candidate is right after a label and prefers it.
    const text =
      'Header letterhead IN578457001 ' +
      'and twenty more chars of fluff in between then ' +
      'Invoice Number: IN999888777';
    expect(findInvoiceNumber(text)).toBe('IN999888777');
  });

  it('recognises the "INV #" abbreviation as a label anchor', () => {
    const text = 'Top IN500115608 / footer / INV # IN777666555';
    expect(findInvoiceNumber(text)).toBe('IN777666555');
  });

  it('recognises "Tax Invoice No." as a label anchor', () => {
    const text = 'Header IN500115608 ... Tax Invoice No. IN888777666';
    expect(findInvoiceNumber(text)).toBe('IN888777666');
  });

  it('still anchors when the label itself is OCR-mangled (WNVOICE NO)', () => {
    const text = 'Top IN500115608 below logo. WNVOICE NO IN999000111';
    expect(findInvoiceNumber(text)).toBe('IN999000111');
  });

  it('falls back to v1 first-match order when NO label keyword is present', () => {
    // Pre-v3 would return the first IN-9-digit match. Post-v3 with no
    // label, fallback ranks by pattern priority then position — same
    // outcome.
    const text = 'IN111222333 ... IN444555666 ... IN777888999';
    expect(findInvoiceNumber(text)).toBe('IN111222333');
  });

  it('falls back to v1 order when a label exists but NO candidate is near it', () => {
    // Label is at the very start. Candidates are ~400 chars away —
    // beyond the NEAR_LABEL_CHARS threshold. Should NOT use the label
    // and instead fall back to first-match.
    const filler = ' lorem ipsum dolor sit amet '.repeat(20); // ~580 chars
    const text = `Invoice Number: (page break)${filler}IN111222333 then later IN444555666`;
    expect(findInvoiceNumber(text)).toBe('IN111222333');
  });

  it('positional bias still respects excludeSet (poison near label is skipped)', () => {
    // Poison is RIGHT after the label — best position by distance.
    // But it's in the hard-coded poison set, so it's filtered out
    // BEFORE positional ranking applies. The far candidate wins.
    const text = 'Invoice Number: IN500115607 / further down IN578457001';
    expect(findInvoiceNumber(text, 9, HARDCODED_POISON_INVOICES)).toBe('IN578457001');
  });

  it('a "naked" INVOICE keyword still anchors when no NO/NUMBER suffix is present', () => {
    // Some PODs print just "INVOICE" as a heading, with the number on
    // the next line. The label regex tolerates that.
    const text = 'Header IN500115608\nINVOICE\nIN111222333\nbody...';
    expect(findInvoiceNumber(text)).toBe('IN111222333');
  });

  it('does NOT misread the word "investment" as an INV label', () => {
    // The (?![a-z]) lookahead on the bare INV form prevents matching
    // INV inside INVOICE-unrelated words like investment / inverse.
    // Without that guard, "investment" would create a phantom label
    // and skew the rank.
    const text =
      'Mention of investments and inversions IN555111 ' +
      'and elsewhere IN999000';
    // No real label → falls back to first-match → IN555111.
    expect(findInvoiceNumber(text)).toBe('IN555111');
  });
});
