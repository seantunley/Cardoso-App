// Tests for the BAT invoice-number regex pipeline + the new
// excludeSet poison-guard hook. The function used to live inline in
// both ocrWorker.js and batReconciliation.js; it was extracted to
// src/services/bat/findInvoiceNumber.js so it can be unit-tested
// (importing ocrWorker.js directly would trigger the worker_threads
// parentPort.on dispatch at module load).
//
// Two test groups:
//   1. Regression — the original regex behaviour (no excludeSet)
//      still extracts the same numbers it did before the refactor.
//      These guard against accidental drift in the regex pipeline.
//   2. excludeSet — both the hard-coded HARDCODED_POISON_INVOICES
//      list and ad-hoc excluded sets cause matchAll to skip the
//      excluded candidate and continue searching.

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
  it('exports the hard-coded poison set with the known artefacts', () => {
    // These two are the smoking-gun numbers Sean spotted recurring across
    // unrelated suppliers' PODs in round 6 (recon 18) — see
    // src/services/bat/findInvoiceNumber.js for the audit trail.
    expect(HARDCODED_POISON_INVOICES.has('IN500115607')).toBe(true);
    expect(HARDCODED_POISON_INVOICES.has('IN580115607')).toBe(true);
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
