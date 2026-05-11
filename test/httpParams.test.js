// Tests for src/lib/httpParams.js — the clampInt + pagination helpers
// that consolidate the limit/offset parsing pattern previously hand-
// rolled at every paginated route.
//
// Why this matters: every Math.min(Math.max(parseInt(req.query.X)...))
// chain in the codebase used to be a chance to forget the upper bound
// and let a client request limit=999999. Centralising the clamp makes
// "missing the cap" structurally impossible at sites that use the
// helper. These tests pin the contract so the cap can never silently
// regress.

import { describe, it, expect } from 'vitest';
import { clampInt, pagination } from '../src/lib/httpParams.js';

describe('clampInt', () => {
  it('parses integer strings', () => {
    expect(clampInt('42')).toBe(42);
    expect(clampInt('0')).toBe(0);
    expect(clampInt('-7')).toBe(-7);
  });

  it('returns the default when raw is unparseable', () => {
    expect(clampInt(undefined, { default: 99 })).toBe(99);
    expect(clampInt(null, { default: 99 })).toBe(99);
    expect(clampInt('', { default: 99 })).toBe(99);
    expect(clampInt('not a number', { default: 99 })).toBe(99);
  });

  it('default defaults to 0 when not specified', () => {
    expect(clampInt(undefined)).toBe(0);
  });

  it('clamps to [min, max]', () => {
    expect(clampInt('500', { min: 1, max: 100 })).toBe(100);
    expect(clampInt('-5',  { min: 1, max: 100 })).toBe(1);
    expect(clampInt('50',  { min: 1, max: 100 })).toBe(50);
  });

  it('skips min/max bounds when not specified', () => {
    expect(clampInt('999999')).toBe(999999);
    expect(clampInt('-999999')).toBe(-999999);
  });

  it('applies min/max independently — only one bound is fine', () => {
    expect(clampInt('-10', { min: 0 })).toBe(0);
    expect(clampInt('5',   { min: 0 })).toBe(5);
    expect(clampInt('999', { max: 100 })).toBe(100);
    expect(clampInt('5',   { max: 100 })).toBe(5);
  });

  it('clamps the default itself when default falls outside [min, max]', () => {
    // If a caller passes default: 50 with max: 10, the result should
    // still respect max — defensive against a caller that changes the
    // max but forgets to update the default.
    expect(clampInt(undefined, { default: 50, min: 1, max: 10 })).toBe(10);
    expect(clampInt(undefined, { default: -5, min: 1, max: 10 })).toBe(1);
  });

  it('follows parseInt semantics for partial numeric strings', () => {
    // parseInt('1.5') → 1, parseInt('5px') → 5. Documented quirk;
    // pinning so a refactor to Number(...) doesn't silently change it.
    expect(clampInt('1.5')).toBe(1);
    expect(clampInt('5px')).toBe(5);
  });
});

describe('pagination', () => {
  function fakeReq(query = {}) {
    return { query };
  }

  it('returns defaults when no query params present', () => {
    expect(pagination(fakeReq())).toEqual({ limit: 50, offset: 0 });
  });

  it('honours custom defaultLimit and maxLimit', () => {
    expect(pagination(fakeReq(), { defaultLimit: 100, maxLimit: 500 }))
      .toEqual({ limit: 100, offset: 0 });
  });

  it('clamps oversized limit requests to maxLimit', () => {
    // The whole point of this helper — limit=99999999 cannot OOM the server.
    const result = pagination(fakeReq({ limit: '99999999' }), { maxLimit: 200 });
    expect(result.limit).toBe(200);
  });

  it('forces limit >= 1 (no zero-or-negative limit)', () => {
    expect(pagination(fakeReq({ limit: '0' })).limit).toBe(1);
    expect(pagination(fakeReq({ limit: '-5' })).limit).toBe(1);
  });

  it('forces offset >= 0', () => {
    expect(pagination(fakeReq({ offset: '-100' })).offset).toBe(0);
  });

  it('reads offset from the query as an integer', () => {
    expect(pagination(fakeReq({ offset: '250' })).offset).toBe(250);
  });

  it('handles a missing query object gracefully', () => {
    // Defensive: req shape isn't always {query:{}}, e.g. tests/mocks.
    expect(pagination({})).toEqual({ limit: 50, offset: 0 });
    expect(pagination(null)).toEqual({ limit: 50, offset: 0 });
    expect(pagination(undefined)).toEqual({ limit: 50, offset: 0 });
  });

  it('falls back to default for unparseable limit/offset strings', () => {
    expect(pagination(fakeReq({ limit: 'abc', offset: 'xyz' }), { defaultLimit: 30, maxLimit: 100 }))
      .toEqual({ limit: 30, offset: 0 });
  });
});
