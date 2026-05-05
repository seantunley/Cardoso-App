// Lifecycle tracking helper for scheduled background jobs.
//
// Wraps an async function. Records one row per invocation in the
// `job_runs` table (migration v60): started_at, ended_at, status,
// duration_ms, error_message. The wrapper rethrows so existing error
// handling at the call site stays the same.
//
// Why this exists: the scheduler's jobs (sync, backup, backup-verify,
// sage-cache, hub-sync, hub-ping, credit-logic-sync) used to log
// success/failure to console only. An operator who wanted to know "did
// last night's backup succeed?" had to grep service logs. With this
// table, the GET /api/system/jobs endpoint can answer in one query, and
// the alert engine (item #2) can flag repeated failures.
//
// Design choice: write start row + update on completion (vs. write on
// completion only). Trade-off:
//   - Two writes per invocation (one row inserted, one UPDATE)
//   - But: a row exists during execution, so a process crash mid-job
//     leaves a 'started' row that the alert engine and dashboard can
//     surface as "stuck" instead of disappearing entirely.
//
// Pruning is handled separately by the scheduler (keeps last 30 days).

import db from '../db/index.js';

const insertStart = db.prepare(`
  INSERT INTO job_runs (name, status, started_at, context)
  VALUES (?, 'started', ?, ?)
`);

const updateSuccess = db.prepare(`
  UPDATE job_runs
  SET status = 'succeeded',
      ended_at = ?,
      duration_ms = ?,
      context = COALESCE(?, context)
  WHERE id = ?
`);

const updateFailure = db.prepare(`
  UPDATE job_runs
  SET status = 'failed',
      ended_at = ?,
      duration_ms = ?,
      error_message = ?,
      context = COALESCE(?, context)
  WHERE id = ?
`);

/**
 * recordJob(name, fn) — wraps an async job, records lifecycle.
 *
 * @param {string} name — short stable identifier (e.g. 'local-backup').
 *                        Used as the grouping key in the dashboard and
 *                        alert rules.
 * @param {Function} fn — async function to run. Return value is forwarded.
 * @param {Function} [contextFn] — optional `(result) => object` called on
 *                                 success to attach a small JSON blob
 *                                 (e.g. row counts, sites synced). Errors
 *                                 here are silently swallowed.
 *
 * @returns {Promise<any>} — whatever fn returns. Rethrows on failure
 *                           after recording the failure row.
 */
export async function recordJob(name, fn, contextFn) {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  let runId;
  try {
    runId = insertStart.run(name, startedAt, null).lastInsertRowid;
  } catch (err) {
    // If we can't even insert the start row, the DB has bigger problems —
    // run the job anyway so we don't block actual work, but log loud.
    console.error(`[jobRunner] Failed to record start of ${name}: ${err.message}`);
    return await fn();
  }

  try {
    const result = await fn();
    let contextJson = null;
    if (contextFn) {
      try {
        const ctx = contextFn(result);
        if (ctx != null) contextJson = JSON.stringify(ctx);
      } catch { /* contextFn errors don't fail the job */ }
    }
    try {
      updateSuccess.run(new Date().toISOString(), Date.now() - startMs, contextJson, runId);
    } catch (err) {
      console.error(`[jobRunner] Failed to record success of ${name}: ${err.message}`);
    }
    return result;
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 1000);
    try {
      updateFailure.run(new Date().toISOString(), Date.now() - startMs, msg, null, runId);
    } catch (writeErr) {
      console.error(`[jobRunner] Failed to record failure of ${name}: ${writeErr.message}`);
    }
    throw err;
  }
}

/**
 * Read the latest run for each known job, plus rolling failure counts.
 * Backs GET /api/system/jobs.
 *
 * @param {object} opts
 * @param {string} [opts.since] — ISO timestamp; only count failures after this
 *                                (default: 24 hours ago)
 * @returns {Array<{ name, last_status, last_started_at, last_ended_at,
 *                   last_duration_ms, last_error, failures_in_window,
 *                   total_in_window }>}
 */
export function getJobsSummary({ since } = {}) {
  const sinceTs = since || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  // For each job name we want: latest row + failure count in the window.
  // Two queries joined in JS — simpler than a window-function query and
  // SQLite-version safe.
  const latestRows = db.prepare(`
    SELECT j.*
    FROM job_runs j
    JOIN (
      SELECT name, MAX(started_at) AS max_started
      FROM job_runs
      GROUP BY name
    ) latest ON latest.name = j.name AND latest.max_started = j.started_at
    ORDER BY j.started_at DESC
  `).all();

  const windowStats = db.prepare(`
    SELECT name,
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures
    FROM job_runs
    WHERE started_at >= ?
    GROUP BY name
  `).all(sinceTs);
  const statsByName = new Map(windowStats.map(s => [s.name, s]));

  return latestRows.map((r) => {
    const stats = statsByName.get(r.name) || { total: 0, failures: 0 };
    return {
      name: r.name,
      last_status: r.status,
      last_started_at: r.started_at,
      last_ended_at: r.ended_at,
      last_duration_ms: r.duration_ms,
      last_error: r.error_message,
      last_context: r.context ? safeJsonParse(r.context) : null,
      failures_in_window: stats.failures || 0,
      total_in_window: stats.total || 0,
    };
  });
}

/**
 * Drop job_runs rows older than `keepDays` days. Called by the scheduler
 * once daily so the table doesn't grow unbounded.
 */
export function pruneOldJobRuns(keepDays = 30) {
  const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
  const info = db.prepare('DELETE FROM job_runs WHERE started_at < ?').run(cutoff);
  if (info.changes > 0) {
    console.log(`[jobRunner] Pruned ${info.changes} job_runs row(s) older than ${keepDays} days`);
  }
  return info.changes;
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
