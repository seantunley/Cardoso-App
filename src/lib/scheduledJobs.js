// Tiny in-memory registry for the scheduler's cron / interval /
// one-shot jobs, so the Operations page can render a "what's scheduled
// to run" view without us hardcoding a separate manifest that drifts
// from the actual scheduler.js call sites.
//
// Each scheduled job in src/scheduler.js calls registerJob(...) right
// next to its cron.schedule / setInterval / setTimeout call. The
// registry stores the name + type + schedule + mode gate + an optional
// description; the cron task object (which exposes .getNextRun() in
// node-cron 4.x) is held by reference so the API can compute next-fire
// times on demand without re-parsing the cron expression.

const registry = [];

/**
 * Record a scheduled job in the registry.
 *
 * @param {object} job
 * @param {string}  job.name             matches the job_runs.name when wrapped in track()
 * @param {'cron'|'interval'|'one-shot'} job.type
 * @param {string} [job.cronExpression]  raw cron expression (cron type only)
 * @param {number} [job.intervalMs]      tick period in ms (interval type only)
 * @param {number} [job.delayMs]         delay from registration in ms (one-shot type only)
 * @param {object} [job.taskRef]         node-cron task object — used for getNextRun()
 * @param {'site'|'hub'|'all'} [job.mode='all']
 * @param {string} [job.description]
 */
export function registerJob(job) {
  if (!job || !job.name || !job.type) {
    throw new TypeError('registerJob: { name, type } required');
  }
  registry.push({
    name: job.name,
    type: job.type,
    cronExpression: job.cronExpression || null,
    intervalMs: job.intervalMs ?? null,
    delayMs: job.delayMs ?? null,
    runAt: job.type === 'one-shot' && job.delayMs != null
      ? new Date(Date.now() + job.delayMs).toISOString()
      : null,
    mode: job.mode || 'all',
    description: job.description || null,
    taskRef: job.taskRef || null,
    registeredAt: new Date().toISOString(),
  });
}

/**
 * Snapshot the registry for read API consumption. Computes nextRun
 * for cron jobs from the task's getNextRun(); strips the taskRef so
 * the JSON serialisation doesn't carry a heavy node-cron object.
 */
export function listScheduledJobs() {
  return registry.map(j => {
    let nextRun = null;
    let nextRunError = null;
    if (j.type === 'cron' && j.taskRef && typeof j.taskRef.getNextRun === 'function') {
      try {
        const d = j.taskRef.getNextRun();
        nextRun = d instanceof Date ? d.toISOString() : (d?.toISOString?.() || String(d));
      } catch (err) {
        nextRunError = err.message;
      }
    } else if (j.type === 'one-shot' && j.runAt) {
      // For one-shots we display the runAt computed at registration time.
      // After it fires, this still shows when it WAS supposed to fire,
      // which is the useful info for an operator looking at "what ran on
      // boot 45s after start".
      nextRun = j.runAt;
    }
    // Strip taskRef from the JSON payload
    const { taskRef, ...serialisable } = j;
    return { ...serialisable, nextRun, nextRunError };
  });
}

/** Test-only — clears the registry between vitest test runs. */
export function _resetScheduledJobsRegistry() {
  registry.length = 0;
}
