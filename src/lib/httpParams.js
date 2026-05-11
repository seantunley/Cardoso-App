// Small helpers for parsing query-string parameters in route handlers.
//
// Almost every paginated endpoint in this codebase has its own copy of
//   const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || N, 1), MAX);
//   const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
// with subtly different defaults, max ceilings, and (occasionally) a
// missing clamp on one side. The variations don't matter individually
// but make it easy to ship a route with a missing upper bound — which
// is the exact shape of "client requests limit=999999, server tries
// to materialise a million rows in memory" outages. Centralising the
// pattern means new routes get the safe shape by default.
//
// These functions are deliberately framework-agnostic — they take raw
// values, not `req` objects directly — so they can be unit-tested
// without spinning up Express. The `pagination` wrapper is the one
// concession to ergonomics: it reads from `req.query` directly because
// every caller does the same thing.

/**
 * Parse a value into an integer, with optional default + clamping.
 * NaN, null, undefined, and empty strings all fall through to the
 * default. Strings that parseInt can't read (including pure-decimal
 * strings like "1.5" — parseInt reads the leading "1") follow the
 * standard parseInt rules.
 *
 * @param {unknown} raw                  the value to parse (typically req.query.X)
 * @param {object} [opts]
 * @param {number} [opts.default=0]      value to use when raw is unparseable
 * @param {number} [opts.min]            inclusive lower bound (skipped if undefined)
 * @param {number} [opts.max]            inclusive upper bound (skipped if undefined)
 * @returns {number}
 */
export function clampInt(raw, opts = {}) {
  const { default: defaultValue = 0, min, max } = opts;
  const parsed = parseInt(raw, 10);
  let n = Number.isNaN(parsed) ? defaultValue : parsed;
  if (typeof min === 'number' && n < min) n = min;
  if (typeof max === 'number' && n > max) n = max;
  return n;
}

/**
 * Read pagination params from an Express-style request — `req.query.limit`
 * and `req.query.offset`. Limit is clamped to `[1, maxLimit]`; offset is
 * clamped to `[0, ∞)`. Designed so a missing or garbage `limit` lands on
 * the default, and a malicious `limit=99999999` lands on the cap.
 *
 * @param {{ query?: Record<string, unknown> }} req
 * @param {object} [opts]
 * @param {number} [opts.defaultLimit=50]
 * @param {number} [opts.maxLimit=200]
 * @returns {{ limit: number, offset: number }}
 */
export function pagination(req, opts = {}) {
  const { defaultLimit = 50, maxLimit = 200 } = opts;
  const query = req?.query ?? {};
  return {
    limit: clampInt(query.limit, { default: defaultLimit, min: 1, max: maxLimit }),
    offset: clampInt(query.offset, { default: 0, min: 0 }),
  };
}
