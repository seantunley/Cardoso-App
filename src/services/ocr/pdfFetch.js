// SSRF-guarded, size-bounded PDF download for the MAIN process.
//
// This deliberately mirrors the guard + bounded-stream logic in ocrWorker.js
// (isAllowedPdfUrl / fetchBoundedBuffer) rather than importing it: ocrWorker.js
// is a worker_threads entrypoint (it reads workerData and attaches parentPort
// handlers at import time), so importing it from the main process would be
// wrong. The preview backfill runs in the main process and needs the same
// protections, so the small amount of duplication is the safe trade-off. Keep
// the two in sync if the SSRF rules change.

import { Buffer } from 'buffer';

const _PRIVATE_IPV4 = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // Tailscale CGNAT 100.64.0.0/10
  /^0\./,
];
const _PRIVATE_IPV6_PREFIXES = ['::1', 'fc', 'fd', 'fe80'];

// Extract the embedded IPv4 ('a.b.c.d') from an IPv4-mapped IPv6 literal, or
// null if `s` isn't one. Critically, new URL() normalises [::ffff:127.0.0.1] to
// the HEX form ::ffff:7f00:1 (and ::ffff:c0a8:1, ::ffff:808:808), so we must
// decode the two trailing 16-bit hex groups — matching only a dotted quad would
// miss every real normalised case.
function _ipv4FromMappedIpv6(s) {
  const idx = s.indexOf('::ffff:');
  if (idx !== 0) return null; // only the canonical mapped prefix
  const tail = s.slice(7);
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(tail)) return tail; // dotted form
  const m = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/); // hex form 7f00:1
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function _isPrivateOrLoopbackHost(hostname) {
  let lower = hostname.toLowerCase();
  if (lower.startsWith('[') && lower.endsWith(']')) lower = lower.slice(1, -1);
  if (lower === 'localhost') return true;
  if (lower === '::1') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(lower)) {
    return _PRIVATE_IPV4.some((re) => re.test(lower));
  }
  if (lower.includes(':')) {
    if (lower === '::' || lower === '::0') return true; // unspecified — binds to all
    // IPv4-mapped IPv6: fetch reaches the embedded IPv4, so the bare prefix
    // check (::1/fc/fd/fe80) misses ::ffff:7f00:1 etc. Decode + IPv4 private
    // check; reject any ::ffff: literal we can't decode (fail-closed for SSRF).
    if (lower.startsWith('::ffff:')) {
      const v4 = _ipv4FromMappedIpv6(lower);
      return v4 ? _PRIVATE_IPV4.some((re) => re.test(v4)) : true;
    }
    return _PRIVATE_IPV6_PREFIXES.some((p) => lower.startsWith(p));
  }
  return false;
}

function _hostMatchesAllowEntry(host, entry) {
  const h = host.toLowerCase();
  const e = entry.toLowerCase();
  if (e.startsWith('*.')) {
    const suffix = e.slice(1);
    return h.endsWith(suffix) && h !== suffix.slice(1);
  }
  return h === e;
}

export function isAllowedPdfUrl(pdfUrl, allowedHostsEnv) {
  let u;
  try { u = new URL(pdfUrl); } catch { return { ok: false, reason: 'malformed_url' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, reason: `protocol_unsupported (${u.protocol})` };
  }
  if (_isPrivateOrLoopbackHost(u.hostname)) return { ok: false, reason: `host_in_private_range (${u.hostname})` };
  const allowed = (allowedHostsEnv || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length > 0) {
    const matches = allowed.some((entry) => _hostMatchesAllowEntry(u.hostname, entry));
    if (!matches) return { ok: false, reason: `host_not_in_allowlist (${u.hostname})` };
  }
  return { ok: true };
}

// An oversized PDF won't get smaller on retry — tag the error so callers can
// treat it as PERMANENT (the backfill marks the row done instead of
// re-downloading the same too-big file on every run forever).
function tooLargeError(msg) {
  const e = new Error(msg);
  e.code = 'PDF_TOO_LARGE';
  return e;
}

async function fetchBoundedBuffer(response, maxBytes) {
  const reportedLen = parseInt(response.headers.get('content-length') || '', 10);
  if (Number.isFinite(reportedLen) && reportedLen > maxBytes) {
    throw tooLargeError(`PDF size ${reportedLen} exceeds limit ${maxBytes}`);
  }
  if (!response.body) {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > maxBytes) throw tooLargeError(`PDF size ${buf.length} exceeds limit ${maxBytes}`);
    return buf;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* best effort */ }
        throw tooLargeError(`PDF size exceeds limit ${maxBytes} (cancelled at ${total} bytes)`);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* best effort */ }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

export const MAX_PDF_BYTES = (() => {
  const n = parseInt(process.env.OCR_MAX_PDF_MB || '100', 10);
  return Number.isFinite(n) && n >= 1 ? n * 1024 * 1024 : 100 * 1024 * 1024;
})();

/**
 * Download a POD PDF with the same SSRF + size protections the OCR worker uses.
 * Throws an Error tagged with `.code` (URL_REJECTED / DOWNLOAD_FAILED /
 * HTTP_ERROR / INVALID_PDF / size errors). The timeout covers the whole
 * download (headers + body streaming).
 * @returns {Promise<Buffer>}
 */
export async function downloadPdf(pdfUrl, opts = {}) {
  const {
    maxBytes = MAX_PDF_BYTES,
    timeoutMs = 60_000,
    allowedHostsEnv = process.env.OCR_PDF_ALLOWED_HOSTS,
  } = opts;

  const check = isAllowedPdfUrl(pdfUrl, allowedHostsEnv);
  if (!check.ok) {
    const e = new Error(`PDF URL rejected: ${check.reason}`);
    e.code = 'URL_REJECTED';
    throw e;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // Follow redirects MANUALLY, re-running the SSRF/private-host guard on every
    // hop's target. fetch's default redirect:'follow' only vets the original
    // URL, so an allowed/public host could 30x us to a private/LAN/metadata
    // address (169.254.169.254, internal services) and we'd fetch it before the
    // %PDF body check ever runs. redirect:'manual' returns the 3xx so we can
    // validate Location ourselves first.
    let response;
    let currentUrl = pdfUrl;
    for (let hop = 0; ; hop++) {
      try {
        response = await fetch(currentUrl, { signal: ctrl.signal, redirect: 'manual' });
      } catch (err) {
        const e = new Error(`Download failed: ${err.message}`);
        e.code = 'DOWNLOAD_FAILED';
        throw e;
      }
      const isRedirect = response.status >= 300 && response.status < 400 && response.headers.get('location');
      if (!isRedirect) break;
      if (hop >= 5) {
        const e = new Error('Too many redirects downloading PDF');
        e.code = 'TOO_MANY_REDIRECTS';
        throw e;
      }
      let next;
      try { next = new URL(response.headers.get('location'), currentUrl).toString(); }
      catch { const e = new Error('PDF redirect to a malformed URL'); e.code = 'URL_REJECTED'; throw e; }
      const recheck = isAllowedPdfUrl(next, allowedHostsEnv);
      if (!recheck.ok) {
        const e = new Error(`PDF redirect rejected: ${recheck.reason}`);
        e.code = 'URL_REJECTED';
        throw e;
      }
      // Drain the redirect response body before reusing the connection.
      try { await response.body?.cancel(); } catch { /* best effort */ }
      currentUrl = next;
    }
    if (!response.ok) {
      const e = new Error(`HTTP ${response.status} downloading PDF`);
      e.code = 'HTTP_ERROR';
      e.status = response.status;
      throw e;
    }
    const buf = await fetchBoundedBuffer(response, maxBytes);
    if (buf.length < 100 || !buf.subarray(0, 5).toString().startsWith('%PDF')) {
      const e = new Error('Downloaded file is not a valid PDF');
      e.code = 'INVALID_PDF';
      throw e;
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
}
