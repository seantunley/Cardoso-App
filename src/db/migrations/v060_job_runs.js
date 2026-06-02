import { ensureColumn, ensureTable } from './_helpers.js';

export default {
      version: 60,
      name: 'job_runs',
      up(db) {
        // Lifecycle tracking for scheduled background jobs. One row per
        // invocation: started_at, ended_at, status, duration_ms,
        // error_message, optional context JSON. Backs the
        // GET /api/system/jobs admin endpoint and the alert engine's
        // job-failure-spike rule.
        //
        // (Originally shipped with PR #178 but the migration entry was
        // dropped in the #178 ↔ #180 merge collision — same merge that
        // ate the recordJob imports and the /api/system/jobs route.
        // jobRunner.js was already on disk; only this migration entry
        // was missing. Restoring it here so existing installs running
        // jobRunner queries stop failing with `no such table: job_runs`.)
        db.exec(`
          CREATE TABLE IF NOT EXISTS job_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('started','succeeded','failed')),
            started_at TEXT NOT NULL,
            ended_at TEXT,
            duration_ms INTEGER,
            error_message TEXT,
            context TEXT
          )
        `);
        // Compound index for "latest N runs of job X" — the dominant read
        // pattern from /api/system/jobs and from the alert engine's dedup checks.
        db.exec(`CREATE INDEX IF NOT EXISTS idx_job_runs_name_started ON job_runs(name, started_at DESC)`);
        // For "all jobs since timestamp" queries (the dashboard view).
        db.exec(`CREATE INDEX IF NOT EXISTS idx_job_runs_started ON job_runs(started_at DESC)`);
      },
    };
