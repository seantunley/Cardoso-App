/**
 * Rate-limiter middleware — extracted from server.js (US-003).
 */
import rateLimit from 'express-rate-limit';

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per IP per window
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Reporting API rate limiter (per token/IP) ─────────────────────────────
export const reportingRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 120, // 120 requests/min per IP — generous for polling clients
  keyGenerator: (req) => {
    const token = req.headers['x-reporting-token'];
    return token ? String(token).slice(0, 16) : (req.ip || 'unknown');
  },
  message: { error: 'Too many requests. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});
