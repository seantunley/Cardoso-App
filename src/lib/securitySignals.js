// Security signals — in-memory rolling counter of "is anything weird
// happening RIGHT NOW" telemetry. Backs the Operations → Security tab
// and feeds threshold breaches into the existing alert engine.
//
// SCOPE — read this before relying on it:
//   - Volatile. Buckets live in process memory. A restart wipes them.
//   - Use this for "live dashboard" and "fire alerts when thresholds
//     break", NOT for forensic post-incident review. Persistent records
//     of what triggered an alert live in the `alerts` table (via the
//     alertRules engine) and `error_log`.
//
// Layout: a Map keyed by ISO minute (YYYY-MM-DDTHH:MM). Each bucket
// holds counters for that minute. Old buckets get pruned by a
// once-per-minute timer (NOT per-request — see commit history for the
// review feedback that motivated that).

import { fireAlert, resolveAlerts } from './alertEngine.js';

const WINDOW_MINUTES = 60;
const RETAIN_MINUTES = 24 * 60;
const PRUNE_INTERVAL_MS = 60 * 1000;

// Auth endpoints whose 401/429 responses count as "login failures".
// Centralised here so adding a new login flow (e.g. SAML) is one edit
// instead of a hunt through res.on('finish') callbacks. The set is
// matched exactly — not a prefix — so /api/auth/me (which 401s when not
// logged in but isn't a login attempt) doesn't poison the metric.
const AUTH_ENDPOINTS = new Set([
  '/api/auth/login',
  '/api/auth/hub-token-login',
  '/api/auth/set-initial-password',
]);

const buckets = new Map();
let pruneTimerStarted = false;

function minuteKey(date = new Date()) {
  return date.toISOString().slice(0, 16);
}

function ensureBucket(key) {
  let b = buckets.get(key);
  if (!b) {
    b = {
      // Cached at create-time so prune doesn't re-parse the key string
      // every iteration. Saves CPU on the once-per-minute prune sweep.
      startedAtMs: Date.parse(`${key}:00.000Z`) || Date.now(),
      requests: 0,
      latency_ms_total: 0,
      status_401: 0,
      status_403: 0,
      status_429: 0,
      // Login failures = HTTP 401 against an AUTH endpoint. Not 429s —
      // 429 means rate limit kicked in BEFORE auth verified, so the
      // user may not have submitted credentials at all. Tracked as a
      // separate counter so a stuffer being throttled doesn't masquerade
      // as people typing wrong passwords.
      login_failures: 0,
      login_throttle_events: 0,
      upload_bytes: 0,
    };
    buckets.set(key, b);
  }
  return b;
}

function pruneOldBuckets() {
  const cutoff = Date.now() - RETAIN_MINUTES * 60 * 1000;
  for (const [key, bucket] of buckets) {
    if (bucket.startedAtMs < cutoff) buckets.delete(key);
  }
}

function startPruneTimer() {
  if (pruneTimerStarted) return;
  pruneTimerStarted = true;
  const t = setInterval(pruneOldBuckets, PRUNE_INTERVAL_MS);
  if (typeof t.unref === 'function') t.unref();
}

function isUpload(req) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return false;
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  return ct.includes('multipart/form-data')
    || ct.includes('application/octet-stream')
    || ct.includes('application/pdf')
    || ct.startsWith('image/');
}

export function captureSecuritySignal(req, res, next) {
  startPruneTimer();
  const startedAt = Date.now();
  res.on('finish', () => {
    // Defensive: this listener fires AFTER the response has flushed, so
    // a throw here can't affect the client — but it can become an
    // uncaughtException and crash the process if it bubbles. Catch and
    // swallow; metrics collection must never poison the request cycle.
    try {
      const bucket = ensureBucket(minuteKey());
      bucket.requests += 1;
      bucket.latency_ms_total += Math.max(0, Date.now() - startedAt);

      if (res.statusCode === 401) bucket.status_401 += 1;
      if (res.statusCode === 403) bucket.status_403 += 1;
      if (res.statusCode === 429) bucket.status_429 += 1;

      if (AUTH_ENDPOINTS.has(req.path)) {
        if (res.statusCode === 401) bucket.login_failures += 1;
        if (res.statusCode === 429) bucket.login_throttle_events += 1;
      }

      if (isUpload(req)) {
        const bytes = Number.parseInt(req.headers['content-length'] || '0', 10);
        if (Number.isFinite(bytes) && bytes > 0) bucket.upload_bytes += bytes;
      }
    } catch {
      // Never throw out of a metrics listener.
    }
  });
  next();
}

export function getSecuritySignals() {
  // Window the buckets by REAL TIME, not bucket count. Earlier we used
  // `keys.slice(-WINDOW_MINUTES)` which grabs the 60 most-recent buckets
  // — but buckets are only created when a request lands in that minute,
  // so on a low-traffic site 60 buckets can span hours. That meant the
  // dashboard (and ruleSecuritySignals) could fire alerts on yesterday's
  // activity long after it ended. startedAtMs is cached on each bucket
  // at create time, so this filter is cheap.
  //
  // Single-pass aggregation: no sort + filter array materialisation.
  // The previous version did `[...buckets.keys()].sort().filter(...)`
  // then iterated. Order doesn't matter for sums and we don't keep the
  // intermediate array, so iterate `buckets.values()` directly and skip
  // the per-call O(N log N) sort + the array allocation.
  const cutoffMs = Date.now() - WINDOW_MINUTES * 60 * 1000;
  const totals = {
    requests: 0,
    status_401: 0,
    status_403: 0,
    status_429: 0,
    login_failures: 0,
    login_throttle_events: 0,
    upload_bytes: 0,
    avg_latency_ms: 0,
  };
  let latencyTotal = 0;
  for (const b of buckets.values()) {
    if (b.startedAtMs < cutoffMs) continue;
    totals.requests += b.requests;
    totals.status_401 += b.status_401;
    totals.status_403 += b.status_403;
    totals.status_429 += b.status_429;
    totals.login_failures += b.login_failures;
    totals.login_throttle_events += b.login_throttle_events;
    totals.upload_bytes += b.upload_bytes;
    latencyTotal += b.latency_ms_total;
  }
  totals.avg_latency_ms = totals.requests > 0 ? Math.round(latencyTotal / totals.requests) : 0;

  const thresholds = {
    login_failures_per_hour: Number.parseInt(process.env.SECURITY_LOGIN_FAILURE_THRESHOLD_PER_HOUR || '80', 10),
    status_429_per_hour: Number.parseInt(process.env.SECURITY_429_THRESHOLD_PER_HOUR || '150', 10),
    status_401_403_per_hour: Number.parseInt(process.env.SECURITY_401_403_THRESHOLD_PER_HOUR || '300', 10),
  };

  const alerts = [];
  if (totals.login_failures >= thresholds.login_failures_per_hour) {
    alerts.push(`High login failures: ${totals.login_failures}/h`);
  }
  if (totals.status_429 >= thresholds.status_429_per_hour) {
    alerts.push(`High 429 responses: ${totals.status_429}/h`);
  }
  if (totals.status_401 + totals.status_403 >= thresholds.status_401_403_per_hour) {
    alerts.push(`High unauthorized responses: ${totals.status_401 + totals.status_403}/h`);
  }

  // NOTE on `series`: an earlier draft returned the per-minute
  // breakdown, but the panel only renders totals + alerts and a 60-row
  // array on every 30s poll wasn't earning its keep. Add it back when
  // the panel grows a sparkline.

  return {
    generated_at: new Date().toISOString(),
    window_minutes: WINDOW_MINUTES,
    thresholds,
    totals,
    alerts,
  };
}

// ── Alert engine integration ────────────────────────────────────────────────
//
// Wires threshold breaches into the existing alertRules engine so they
// land in the `alerts` table (Operations → Alerts panel) — that's the
// PERSISTENT record that survives restarts. The in-memory dashboard
// above is "live view"; the alerts table is the audit trail.
//
// Each threshold gets its own dedupKey so e.g. a login-failure spike
// and a 429 spike fire as two separate alerts that can be acknowledged
// independently.
export async function ruleSecuritySignals() {
  const signals = getSecuritySignals();
  const { totals, thresholds } = signals;

  const breaches = [
    {
      tripped: totals.login_failures >= thresholds.login_failures_per_hour,
      dedupKey: 'security-signals:login-failures',
      message: `High login-failure rate: ${totals.login_failures} failed login(s) in the last hour (threshold ${thresholds.login_failures_per_hour}). Possible brute-force or credential-stuffing attempt.`,
      context: { window_hour: totals.login_failures, threshold: thresholds.login_failures_per_hour },
    },
    {
      tripped: totals.status_429 >= thresholds.status_429_per_hour,
      dedupKey: 'security-signals:rate-limit',
      message: `High rate-limit rejections: ${totals.status_429} HTTP 429(s) in the last hour (threshold ${thresholds.status_429_per_hour}). Either traffic flood or a misconfigured client.`,
      context: { window_hour: totals.status_429, threshold: thresholds.status_429_per_hour },
    },
    {
      tripped: (totals.status_401 + totals.status_403) >= thresholds.status_401_403_per_hour,
      dedupKey: 'security-signals:unauthorized',
      message: `High unauthorized response rate: ${totals.status_401 + totals.status_403} HTTP 401/403(s) in the last hour (threshold ${thresholds.status_401_403_per_hour}). Could be a scanner enumerating endpoints.`,
      context: {
        status_401: totals.status_401,
        status_403: totals.status_403,
        threshold: thresholds.status_401_403_per_hour,
      },
    },
  ];

  for (const breach of breaches) {
    if (breach.tripped) {
      fireAlert({
        ruleName: 'security-signals',
        severity: 'warning',
        message: breach.message,
        context: breach.context,
        dedupKey: breach.dedupKey,
      });
    } else {
      resolveAlerts(breach.dedupKey, 'auto');
    }
  }
}
