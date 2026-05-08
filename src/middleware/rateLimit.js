/**
 * Rate-limiter middleware — extracted from server.js (US-003).
 */
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

// Why a custom keyGenerator at all? The reporting API can be hit either by a
// hub server (presenting an x-reporting-token header) or by a direct browser
// session. Per-token bucketing is more useful than per-IP for the token case
// (so two browsers on the same NAT don't share a quota with the hub puller).
// Per-IP fallback covers anonymous calls. ipKeyGenerator() is required by
// express-rate-limit v7+ so IPv6 addresses get bucketed by /64 prefix instead
// of by full address (the per-address default is trivially bypassed).

export const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 20, // 20 attempts per IP per window
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Token-or-IP keyGenerator factory ──────────────────────────────────────
//
// CRITICAL: only use the client-supplied token as the bucket key when it
// matches THIS site's expected REPORTING_TOKEN. The naive form
// `token ? token : ip` is bypass-trivial — an attacker rotates the
// x-reporting-token header per request to get a fresh bucket every time,
// and the rate limit silently does nothing. Limits run BEFORE auth
// middleware, so we can't rely on requireReportingToken here; the
// keyGenerator has to validate the token itself.
//
// Behaviour:
//   - valid token (matches process.env.REPORTING_TOKEN) → per-token bucket
//   - missing / wrong token / no expected token configured → per-IP bucket
//
// Per-token is still useful for the valid case (one bucket per legitimate
// client even when multiple share an IP, e.g. behind a NAT). Per-IP for
// the invalid case prevents the bypass.
function _tokenOrIpKey(req) {
  const token = req.headers['x-reporting-token'];
  const expectedToken = process.env.REPORTING_TOKEN;
  if (token && expectedToken && token === expectedToken) {
    return String(token).slice(0, 16);
  }
  return ipKeyGenerator(req);
}

// ── Reporting API rate limiter (per token / IP) ───────────────────────────
export const reportingRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 120, // 120 requests/min per IP — generous for polling clients
  keyGenerator: _tokenOrIpKey,
  message: { error: 'Too many requests. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Backup-export rate limiter (heavy endpoints) ──────────────────────────
//
// /api/backup/download streams a SQLite snapshot (potentially hundreds of MB);
// /api/backup/config returns the site's .env. Both are sensitive and
// expensive — legitimate traffic is the hub puller, which hits these once
// per scheduled cycle (roughly once an hour). 10/hour per token-or-IP gives
// the hub plenty of headroom (cycle + manual smoke + retry) while making any
// probing/exfil attempt visible by tripping limits.
//
// Uses the validated token-or-IP key (see _tokenOrIpKey). The earlier draft
// trusted any client-supplied token as the bucket key, which an attacker
// could rotate per request to bypass the 10/hour cap entirely.
//
// Cap is env-tunable so a small estate that schedules cycles more often can
// dial it up. NaN guard: parseInt('garbage') returns NaN and Math.max(N, NaN)
// returns NaN — leaving the comparison silently disabled. Validate explicitly.
function _parseHeavyMaxFromEnv() {
  const n = parseInt(process.env.BACKUP_HEAVY_MAX_PER_HOUR || '10', 10);
  if (!Number.isFinite(n) || n < 1) return 10;
  return n;
}

export const backupHeavyRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour window
  max: _parseHeavyMaxFromEnv(),
  keyGenerator: _tokenOrIpKey,
  message: { error: 'Too many backup-export requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
