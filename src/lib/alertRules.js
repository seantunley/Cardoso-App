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
import { fireAlert, resolveAlerts, updateActiveAlert } from './alertEngine.js';
import { getSageHealth } from '../services/batReconciliation.js';
import { ruleSecuritySignals } from './securitySignals.js';
import { computeBackupHealth } from './backupHealth.js';
import { getKopiaStatus, isKopiaEnabled } from '../services/hub/kopiaStatus.js';
import { getRoleConnectionId } from '../services/connectionRoles.js';

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

// ── Rule: backup artifact missing / stale (filesystem-based) ─────────────
//
// ruleBackupVerifyFailed above reads job_runs — which is written by the SAME
// in-process scheduler that creates the backups. The June 2026 incident showed
// the failure mode that misses: when the scheduler froze, backup creation AND
// the backup-verify job stopped together, so the last backup-verify row stayed
// 'succeeded' and NO job_runs-based rule could ever notice the 12-day outage.
//
// This rule closes that blind spot by reading the actual backup FILES off disk
// (via computeBackupHealth) instead of the job ledger. It fires on the
// freshness/existence failure modes a frozen ledger can't reveal:
//   - no_backups            (none on disk at all)
//   - stale / stale_critical (newest file older than the daily threshold)
//   - latest_empty          (newest file is 0 bytes)
//   - backup_dir_unreadable (perms / disk problem)
//   - health_error          (the check itself blew up)
// Integrity-verification failures stay owned by ruleBackupVerifyFailed so the
// two don't double-alert on the same condition.
//
// NOTE: like every rule, this still runs inside the scheduler's once-a-minute
// evaluateAllRules() loop — so a TOTALLY dead event loop won't fire it either.
// The cron-independent guarantee lives in the request-time dashboard path
// (computeBackupHealth() called from GET /api/system/sage-health). This rule is
// the second layer: it catches "scheduler alive but backups not landing" (disk
// full, backup throwing, dir deleted) truthfully, because it trusts the disk.
const BACKUP_ARTIFACT_REASONS = new Set([
  'no_backups',
  'stale',
  'stale_critical',
  'latest_empty',
  'backup_dir_unreadable',
  'health_error',
]);

async function ruleBackupArtifactStale() {
  // Hub installs have no local backup job; they monitor sites via HubBackups.
  if (process.env.HUB_MODE === 'true') return;

  let health;
  try {
    health = computeBackupHealth();
  } catch (err) {
    // A thrown health check shouldn't silence the alert — surface it loudly.
    fireAlert({
      ruleName: 'backup-artifact-stale',
      severity: 'critical',
      message: `Backup health check itself failed: ${err.message}`,
      context: { error: err.message },
      dedupKey: 'backup-artifact-stale',
    });
    return;
  }

  if (BACKUP_ARTIFACT_REASONS.has(health.reason)) {
    fireAlert({
      ruleName: 'backup-artifact-stale',
      severity: 'critical',
      message: health.message,
      context: {
        reason: health.reason,
        last_backup_at: health.last_backup_at,
        age_hours: health.age_hours,
        file: health.file,
        total_backups: health.total_backups,
      },
      dedupKey: 'backup-artifact-stale',
    });
  } else {
    // ok, warn (unverified), or verify_failed (owned by the other rule) →
    // the artifact itself is present and fresh, so clear this alert.
    resolveAlerts('backup-artifact-stale', 'auto');
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

// ── Rule: nightly sync stale ─────────────────────────────────────────────
//
// The nightly Sage syncs run once per day (inventory 04:00, creditors 04:30,
// debtors 04:45), so the job-failure-spike rule (3+ fails per HOUR) can
// mathematically never catch them — and if the machine is off at 4am the
// cron never fires at all, leaving NO failed row to alert on. Operator
// report: data quietly going 29h+ stale with nothing announcing it.
//
// This rule alerts on the DATA, not the run: if a nightly job's most recent
// SUCCESSFUL run is older than 26h (24h cadence + 2h buffer — same threshold
// as the LastSyncedBadge), fire one deduped warning per job. The message says
// which failure mode it was: last attempt failed (with the error), or no
// attempt ran at all (machine off / asleep at the scheduled time).
//
// Skips jobs that have never been attempted (fresh install before the first
// scheduled night) and skips entirely on the hub (these are site-mode jobs).
const NIGHTLY_SYNC_JOBS = ['inventory-sales-sync', 'creditors-sync', 'debtors-sync'];
const NIGHTLY_STALE_HOURS = 26;

async function ruleNightlySyncStale() {
  if (process.env.HUB_MODE === 'true') return;
  for (const name of NIGHTLY_SYNC_JOBS) {
    let lastSuccess;
    let lastRun;
    try {
      lastSuccess = _prep('nightlyLastSuccess', `
        SELECT started_at FROM job_runs
        WHERE name = ? AND status = 'succeeded'
        ORDER BY started_at DESC LIMIT 1
      `).get(name);
      lastRun = _prep('nightlyLastRun', `
        SELECT status, error_message, started_at FROM job_runs
        WHERE name = ? ORDER BY started_at DESC LIMIT 1
      `).get(name);
    } catch (err) {
      if (/no such table/i.test(err.message)) return;
      throw err;
    }
    const dedupKey = `nightly-sync-stale:${name}`;
    // Never attempted at all → fresh install before its first scheduled
    // night. The freshness badge covers that state; don't nag.
    if (!lastRun) continue;

    const ageHours = lastSuccess
      ? (Date.now() - new Date(lastSuccess.started_at).getTime()) / 3_600_000
      : Infinity;
    if (ageHours <= NIGHTLY_STALE_HOURS) {
      resolveAlerts(dedupKey, 'auto');
      continue;
    }

    const ageText = lastSuccess
      ? `${ageHours.toFixed(1)} hours ago`
      : 'never';
    const why = lastRun.status === 'failed'
      ? `The most recent attempt failed: ${lastRun.error_message || 'unknown error'}.`
      : `No attempt has run since — if the machine was off or asleep at the scheduled 4am window, the sync never fired.`;
    fireAlert({
      ruleName: 'nightly-sync-stale',
      severity: 'warning',
      message: `Nightly sync '${name}' last succeeded ${ageText} (threshold ${NIGHTLY_STALE_HOURS}h) — its data is stale and reports reading it may be inconsistent. ${why}`,
      context: {
        job: name,
        last_success_at: lastSuccess?.started_at || null,
        age_hours: lastSuccess ? Number(ageHours.toFixed(1)) : null,
        last_run_status: lastRun.status,
        last_run_error: lastRun.error_message || null,
      },
      dedupKey,
    });
  }
}

// ── Rule: JTI monthly export missing ─────────────────────────────────────
//
// The JTI Sales export is generated on the 1st at 02:00 (jti-monthly-export),
// with a boot catch-up, a 09:00 daily self-heal, and an hourly generation
// retry as safety nets. Every one of those paths records a skip
// (pool_unavailable, or a fire dropped because the main thread was frozen at
// the scheduled minute) as a SUCCESSFUL job run, and node-cron never replays a
// missed fire — so a month that genuinely never got produced is invisible on
// both the schedule panel (which only shows the NEXT fire, identical whether
// last month ran or not) and Job Runs (green skips). Operators only found out
// by manually checking the archive list.
//
// This rule alerts on the ARTIFACT, not the run: on a JTI site, if the PREVIOUS
// calendar month has no archive, fire one deduped warning. It holds off until
// 10:00 on the 1st so the 02:00 cron + boot catch-up + 09:00 self-heal have all
// had their shot before it complains. The message carries WHY from the most
// recent generation attempt (pool down / never fired / threw). Auto-resolves
// the moment the month lands (the hourly retry, a restart's catch-up, or a
// manual export).
//
// "Is this a JTI site?" is answered by the jti_export connection routing FIRST,
// then archive history as a fallback. Routing is the authoritative signal and,
// crucially, catches a freshly-onboarded site whose VERY FIRST month-end fails —
// archive history alone would have no scheduled row yet and stay silent exactly
// when the operator most needs the alert.
//
// Site-only (HUB_MODE receives archives via push, it doesn't generate them).
async function ruleJtiExportMissing() {
  if (process.env.HUB_MODE === 'true') return;

  // Per-period dedup key so each missing month is its own alert. A single fixed
  // key would let a NEWER month's success resolve an OLDER month's still-valid
  // alert (June missing, alert fires in July; a normal July archive on Aug 1
  // must NOT clear the June alert).
  const keyFor = (yr, mn) => `jti-export-missing:${yr}-${String(mn).padStart(2, '0')}`;

  const listActiveMissing = () => {
    try {
      return _prep('activeJtiMissing', `
        SELECT dedup_key FROM alerts
        WHERE resolved_at IS NULL AND dedup_key LIKE 'jti-export-missing:%'
      `).all();
    } catch { return []; }
  };

  const jtiRouted = Boolean(getRoleConnectionId('jti_export'));
  let everScheduled = false;
  if (!jtiRouted) {
    try {
      everScheduled = Boolean(_prep('jtiEverScheduled', `
        SELECT 1 FROM jti_archive WHERE source = 'scheduled' LIMIT 1
      `).get());
    } catch (err) {
      if (/no such table/i.test(err.message)) return; // JTI module not installed
      throw err;
    }
  }
  // Not a JTI site: no jti_export routing configured AND never produced a
  // scheduled export. Nothing to enforce; clear any stale per-period alerts.
  if (!jtiRouted && !everScheduled) {
    for (const a of listActiveMissing()) resolveAlerts(a.dedup_key, 'auto');
    return;
  }

  // A jti_archive row is only ever written for a full calendar month (partial
  // exports stay download-only), so a source='manual' row means the operator
  // produced that month by hand — the remediation for this very alert. Count it
  // as present alongside 'scheduled'.
  const periodArchived = (yr, mn) => {
    try {
      return Boolean(_prep('jtiPeriodArchived', `
        SELECT 1 FROM jti_archive
        WHERE period_year = ? AND period_month = ? AND source IN ('scheduled', 'manual')
        LIMIT 1
      `).get(yr, mn));
    } catch (err) {
      if (/no such table/i.test(err.message)) return false;
      throw err;
    }
  };

  // Heal any active per-period alert whose month has SINCE been archived (a late
  // boot catch-up / retry / manual export finally produced it) — independent of
  // the grace window and of which month we check below. Each key carries its own
  // period, so this only ever clears the month that was actually produced.
  for (const a of listActiveMissing()) {
    const m = /^jti-export-missing:(\d{4})-(\d{2})$/.exec(a.dedup_key);
    if (m && periodArchived(Number(m[1]), Number(m[2]))) resolveAlerts(a.dedup_key, 'auto');
  }

  const now = new Date();
  // Hold off until the 1st-of-month heal window (02:00 cron → boot catch-up →
  // 09:00 daily-ensure) has fully passed, so we never fire during the few hours
  // a fresh month is legitimately still being generated. Uses server-local time
  // to match the crons (which are also server-local).
  if (now.getDate() === 1 && now.getHours() < 10) return;

  const y = now.getFullYear();
  const mo = now.getMonth() + 1; // 1..12
  const prevYear = mo === 1 ? y - 1 : y;
  const prevMonth = mo === 1 ? 12 : mo - 1;
  const dedupKey = keyFor(prevYear, prevMonth);

  // Previous month present (scheduled or manual) → nothing to fire; the heal
  // loop above already cleared any active alert for it.
  if (periodArchived(prevYear, prevMonth)) return;

  // Missing. Pull the most recent attempt across all JTI generation jobs so the
  // message can say WHY it didn't land — the whole point is that a silent skip
  // (recorded as job success) stops being invisible.
  let lastRun = null;
  try {
    lastRun = _prep('jtiLastGenAttempt', `
      SELECT name, status, error_message, context, started_at
      FROM job_runs
      WHERE name IN ('jti-monthly-export', 'jti-daily-ensure', 'jti-boot-catchup', 'jti-generation-retry')
      ORDER BY started_at DESC LIMIT 1
    `).get();
  } catch (err) {
    if (!/no such table/i.test(err.message)) throw err;
  }

  const period = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
  let why;
  if (!lastRun) {
    why = 'No generation attempt has run at all yet.';
  } else if (lastRun.status === 'failed') {
    why = `The most recent attempt (${lastRun.name}) failed: ${lastRun.error_message || 'unknown error'}.`;
  } else {
    // Succeeded-but-didn't-produce: the skip reason (pool_unavailable etc.)
    // rides in the run context — dig it out so the operator sees the cause.
    let reason = '';
    try {
      const ctx = JSON.parse(lastRun.context || '{}');
      reason = ctx?.failed?.error || ctx?.reason || '';
    } catch { /* context not JSON — leave reason blank */ }
    why = reason
      ? `The most recent attempt (${lastRun.name}) skipped it: ${reason}.`
      : `The most recent attempt (${lastRun.name}) completed without producing it — the 02:00 fire may have been dropped by a main-thread freeze, or the JTI Sage pool was unavailable.`;
  }

  const message = `JTI monthly export for ${period} has not been produced. ${why} It should self-heal within the hour via the generation-retry tick (or on the next restart); if this alert persists, the JTI Sage pool is likely unreachable on this site.`;
  const context = {
    period,
    period_year: prevYear,
    period_month: prevMonth,
    last_attempt_job: lastRun?.name || null,
    last_attempt_status: lastRun?.status || null,
    last_attempt_error: lastRun?.error_message || null,
    last_attempt_at: lastRun?.started_at || null,
  };
  const fired = fireAlert({ ruleName: 'jti-export-missing', severity: 'warning', message, context, dedupKey });
  // The condition can persist across many ticks while the REASON evolves — e.g.
  // the alert engine's minute-pass fires "No generation attempt" before the 45s
  // boot catch-up runs, then that catch-up records a pool_unavailable failure.
  // fireAlert dedups and won't refresh the message, so update the active row to
  // reflect the latest attempt.
  if (fired?.deduped) updateActiveAlert(dedupKey, { message, context });
}

// ── Rule: Kopia off-site backup stale / missing (hub-only) ───────────────
//
// The hub runs the Kopia repository server; every site agent pushes snapshots
// to it (see docs/kopia-backups.md). This rule reads that repo and fires when a
// site's newest off-site snapshot is older than the threshold, has NEVER
// arrived, or the repo/binary is unreachable — so the push model's "a site
// silently stopped backing up" blind spot is loud on the hub.
//
// Hub-only and gated on KOPIA_ENABLED. Site lists come from the hub storage
// runtime (hub_sites lives there, not in the local app db); alerts fire/resolve
// through the normal engine (the alerts table is in the local app db).
async function ruleKopiaSiteStale() {
  if (process.env.HUB_MODE !== 'true') return; // hub-only

  const clearAll = () => {
    resolveAlerts('kopia-repo-error', 'auto');
    try {
      const actives = _prep('activeKopiaSiteStale', `
        SELECT dedup_key FROM alerts
        WHERE resolved_at IS NULL AND dedup_key LIKE 'kopia-site-stale:%'
      `).all();
      for (const a of actives) resolveAlerts(a.dedup_key, 'auto');
    } catch (err) {
      if (!/no such table/i.test(err.message)) throw err;
    }
  };

  if (!isKopiaEnabled()) { clearAll(); return; } // feature off → don't nag

  let knownSites = [];
  try {
    // Query hub_sites directly for slug (needed to match the Kopia host) and to
    // EXCLUDE retired sites (in_env=0). A site removed from HUB_SITES keeps its
    // row until an admin forgets it; feeding those in would keep a permanent
    // kopia-site-stale alert for a branch that intentionally no longer backs up.
    const { getHubStorageRuntime } = await import('../hub/storage/runtime.js');
    const { sqliteDb } = getHubStorageRuntime();
    knownSites = sqliteDb.prepare('SELECT id, slug, name FROM hub_sites WHERE COALESCE(in_env, 1) = 1').all();
  } catch (err) {
    console.error(`[alertRules] kopia: could not list hub sites: ${err.message}`);
  }

  const status = await getKopiaStatus({ knownSites });

  // Repo / binary unreachable → one critical; skip per-site churn on top.
  if (status.error) {
    fireAlert({
      ruleName: 'kopia-repo-error',
      severity: 'critical',
      message: `Kopia off-site repository is unreachable on the hub: ${status.error}`,
      context: { error: status.error },
      dedupKey: 'kopia-repo-error',
    });
    return;
  }
  resolveAlerts('kopia-repo-error', 'auto');

  // Only alert on KNOWN sites (site_id present). A retired site (removed from
  // HUB_SITES, in_env=0) is excluded from knownSites but its historical
  // snapshots still sit in the repo, so mergeWithKnownSites surfaces them as
  // unknown-host rows (site_id=null) for dashboard visibility. Without this
  // guard, once that last snapshot ages out, the rule would fire
  // kopia-site-stale forever for a branch that was intentionally retired.
  const stale = status.sites.filter((s) => s.status === 'critical' && s.site_id);
  const staleKeys = new Set();
  for (const s of stale) {
    const key = `kopia-site-stale:${s.site_id || s.site}`;
    staleKeys.add(key);
    const label = s.site_name || s.site;
    const detail = s.reason === 'never'
      ? 'no off-site snapshot has ever reached the hub'
      : `the last off-site snapshot is ${s.age_hours != null ? `${s.age_hours.toFixed(1)}h old` : 'of unknown age'} (threshold ${status.stale_hours}h)`;
    fireAlert({
      ruleName: 'kopia-site-stale',
      severity: 'critical',
      message: `Off-site backup for '${label}' is not current — ${detail}.`,
      context: {
        site: s.site, site_id: s.site_id || null, reason: s.reason,
        age_hours: s.age_hours, last_snapshot_at: s.last_snapshot_at, count: s.count,
      },
      dedupKey: key,
    });
  }

  // Resolve previously-stale sites that are healthy again.
  let actives;
  try {
    actives = _prep('activeKopiaSiteStale', `
      SELECT dedup_key FROM alerts
      WHERE resolved_at IS NULL AND dedup_key LIKE 'kopia-site-stale:%'
    `).all();
  } catch (err) {
    if (/no such table/i.test(err.message)) return;
    throw err;
  }
  for (const a of actives) {
    if (!staleKeys.has(a.dedup_key)) resolveAlerts(a.dedup_key, 'auto');
  }
}

const RULES = [
  { name: 'sage-down', fn: ruleSageDown },
  { name: 'backup-verify-failed', fn: ruleBackupVerifyFailed },
  { name: 'backup-artifact-stale', fn: ruleBackupArtifactStale },
  { name: 'job-failure-spike', fn: ruleJobFailureSpike },
  { name: 'nightly-sync-stale', fn: ruleNightlySyncStale },
  { name: 'jti-export-missing', fn: ruleJtiExportMissing },
  { name: 'kopia-site-stale', fn: ruleKopiaSiteStale },
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
