// Alert rules — pure evaluators that decide whether to fire/resolve
// alerts based on system state. The engine (src/lib/alertEngine.js)
// owns the dedup + persistence; rules just decide.
//
// Each rule is one async function that takes no args, queries some
// state, and calls fireAlert/resolveAlerts. The scheduler runs
// evaluateAllRules() once a minute; when a rule fires repeatedly the
// dedup_key collapses it to one active row, so this loop is safe to
// run frequently.
//
// Adding a new rule: define a new async function below, add it to
// `RULES`. Tests pin each rule's fire/resolve transitions.

import db from '../db/index.js';
import { fireAlert, resolveAlerts } from './alertEngine.js';
import { getSageHealth } from '../services/batReconciliation.js';
import { ruleSecuritySignals } from './securitySignals.js';

// Lazy-prepared statement cache. Mirrors the pattern in alertEngine.js so
// the rule loop (evaluateAllRules, runs every minute) doesn't re-allocate
// JS prepared-statement wrappers for the same SQL strings on every tick.
// Lazy because some rules tolerate a missing job_runs table (PR #178 not
// merged yet on a given install) by catching "no such table" — preparing
// at module load would throw on those installs.
const _stmts = {};
function _prep(key, sql) {
  if (!_stmts[key]) _stmts[key] = db.prepare(sql);
  return _stmts[key];
}

// ── Rule: Sage MSSQL down ────────────────────────────────────────────────
//
// The Sage health probe (added in v2026.4.18, runs every 60s) tracks
// consecutive failures. Five in a row means roughly 5 minutes of
// downtime — that's the threshold the admin banner already uses for
// "attention". Mirror that here so the same threshold drives alerts.
//
// Hub-only sites and dev installs without Sage configured won't reach
// the failure threshold (the probe doesn't run there) so this is
// effectively a no-op outside production sites.
async function ruleSageDown() {
  const health = getSageHealth();
  // attention is true once consecutive_failures >= 5 (≈ 5 min of probes
  // failing). Same threshold the in-app banner uses.
  if (health.attention) {
    fireAlert({
      ruleName: 'sage-down',
      severity: 'critical',
      message: `Sage MSSQL unreachable for ${health.downForMinutes} min (${health.consecutiveFailures} consecutive probe failures). Last error: ${health.lastError || 'unknown'}`,
      context: {
        downForMinutes: health.downForMinutes,
        consecutiveFailures: health.consecutiveFailures,
        lastError: health.lastError,
        lastOkAt: health.lastOkAt,
      },
      dedupKey: 'sage-down',
    });
  } else if (health.ok === true) {
    // Connection is back. Auto-resolve any active sage-down alerts.
    resolveAlerts('sage-down', 'auto');
  }
  // health.ok === null means never probed yet (just-booted hub) — leave
  // any prior state alone.
}

// ── Rule: backup verification failed ─────────────────────────────────────
//
// PR #178 introduced job_runs + the `backup-verify` job that runs
// daily at 03:30. With the soft-failure successCheck wired up,
// stale/missing/corrupt backups get persisted as status='failed' with
// the reason in error_message. This rule fires when the LATEST
// backup-verify run is failed — operator gets one alert until the next
// run succeeds.
//
// If the job_runs table doesn't exist yet (PR #178 not merged), the
// query throws and the rule logs + skips. Graceful degrade.
async function ruleBackupVerifyFailed() {
  let row;
  try {
    row = _prep('backupVerifyLatest', `
      SELECT status, error_message, ended_at
      FROM job_runs
      WHERE name = 'backup-verify'
      ORDER BY started_at DESC
      LIMIT 1
    `).get();
  } catch (err) {
    if (/no such table/i.test(err.message)) return; // PR #178 not merged yet
    throw err;
  }
  if (!row) return; // never run yet

  if (row.status === 'failed') {
    fireAlert({
      ruleName: 'backup-verify-failed',
      severity: 'critical',
      message: `Daily backup verification failed: ${row.error_message || 'unknown reason'}. The latest backup file may be corrupt, stale, or missing.`,
      context: {
        last_failed_at: row.ended_at,
        error: row.error_message,
      },
      dedupKey: 'backup-verify-failed',
    });
  } else if (row.status === 'succeeded') {
    resolveAlerts('backup-verify-failed', 'auto');
  }
}

// ── Rule: job-failure spike ──────────────────────────────────────────────
//
// Generic "this job is broken" alert — fires when ANY single job has 3+
// failed runs in the last hour. Catches transient flapping that
// individual rules might miss (e.g. credit-logic-sync failing every
// 10 min for an hour because the hub URL is wrong). Per-job dedup so
// one job's spike doesn't suppress alerts on another.
async function ruleJobFailureSpike() {
  let rows;
  try {
    // The cutoff has to be computed in JS, not via SQLite's `datetime('now',
    // '-1 hour')`. Reason: started_at is stored as an ISO string with a 'T'
    // separator (`2026-05-05T15:34:30.000Z`), but SQLite's datetime()
    // returns a space-separated string (`2026-05-05 15:34:30`). The two
    // are TEXT-compared, and 'T' (0x54) > ' ' (0x20) lexically, so a
    // same-day stale row would compare as "newer than the cutoff" and
    // leak into the spike count. Match the stored format by computing the
    // cutoff as ISO in JS — both sides lexically sortable, indexes used.
    const oneHourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    rows = _prep('jobFailuresLastHour', `
      SELECT name, COUNT(*) AS fails
      FROM job_runs
      WHERE status = 'failed'
        AND started_at >= ?
      GROUP BY name
      HAVING fails >= 3
    `).all(oneHourAgoIso);
  } catch (err) {
    if (/no such table/i.test(err.message)) return;
    throw err;
  }

  // Track which dedup_keys are currently spiking so we can resolve the
  // ones that are not.
  const spikingNames = new Set(rows.map(r => r.name));
  for (const row of rows) {
    fireAlert({
      ruleName: 'job-failure-spike',
      severity: 'warning',
      message: `Job '${row.name}' failed ${row.fails} times in the last hour.`,
      context: { job: row.name, failures: row.fails },
      dedupKey: `job-failure-spike:${row.name}`,
    });
  }

  // Resolve any active job-failure-spike alerts whose job is no longer
  // spiking. Query the active alert names and intersect with `spikingNames`.
  let activeRows;
  try {
    activeRows = _prep('activeJobFailureSpikes', `
      SELECT dedup_key FROM alerts
      WHERE resolved_at IS NULL AND dedup_key LIKE 'job-failure-spike:%'
    `).all();
  } catch {
    return;
  }
  for (const a of activeRows) {
    const jobName = a.dedup_key.slice('job-failure-spike:'.length);
    if (!spikingNames.has(jobName)) {
      resolveAlerts(a.dedup_key, 'auto');
    }
  }
}

const RULES = [
  { name: 'sage-down', fn: ruleSageDown },
  { name: 'backup-verify-failed', fn: ruleBackupVerifyFailed },
  { name: 'job-failure-spike', fn: ruleJobFailureSpike },
  // Security signals — brute-force, flood, scanner detection. Rule
  // owner lives next to the metric collection in src/lib/securitySignals.js
  // so adding a new threshold is one file edit.
  { name: 'security-signals', fn: ruleSecuritySignals },
];

/**
 * Evaluate every rule once. Each rule's errors are caught and logged so
 * one broken rule doesn't take the whole evaluation pass down.
 * Designed to be called every 60s by the scheduler.
 */
export async function evaluateAllRules() {
  for (const rule of RULES) {
    try {
      await rule.fn();
    } catch (err) {
      console.error(`[alertRules] ${rule.name} threw: ${err.message}`);
    }
  }
}

// Exported for tests.
export const _rules = RULES;
