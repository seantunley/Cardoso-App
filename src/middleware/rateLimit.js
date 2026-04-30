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

// ── Reporting API rate limiter (per token / IP) ───────────────────────────
export const reportingRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 120, // 120 requests/min per IP — generous for polling clients
  keyGenerator: (req) => {
    const token = req.headers['x-reporting-token'];
    return token ? String(token).slice(0, 16) : ipKeyGenerator(req);
  },
  message: { error: 'Too many requests. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});
