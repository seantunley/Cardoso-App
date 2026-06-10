import crypto from 'crypto';

// Constant-time comparison for shared-secret tokens (the reporting token gates
// the full-DB download and the .env config export). A plain !== leaks, via
// timing, how many leading bytes matched — over a long-lived secret that lets an
// attacker recover it byte-by-byte. crypto.timingSafeEqual needs equal-length
// buffers, so length-guard first (the length itself isn't the secret). Returns
// false for an empty/missing provided token so a blank header never matches.
export function safeTokenEqual(provided, expected) {
  const a = Buffer.from(String(provided ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
