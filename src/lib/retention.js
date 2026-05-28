// Centralised retention/prune jobs for tables that grow unbounded.
//
// Until this module landed, only `job_runs` (via lib/jobRunner.js) and
// `alerts` (via lib/alertEngine.js) had retention. The rest grew forever:
// `error_log` accumulated thousands of rows from the recurring OCR PDF
// timeouts, `auditlog` accumulated every operator action, `syncrun` got
// a row per sync (~30/day during business hours), `login_log` per login.
// Combined with the defunct `record_snapshots` table (dropped in
// migration v66) one production site was found at 3.7 GB cardoso.db
// where 99% of it was dead snapshot rows.
//
// Each prune entry uses an env var so an operator on a constrained box
// can dial retention shorter, or a site with stricter audit needs can
// dial it longer. Defaults are conservative — long enough that an
// operator triaging "what happened last week" still has the data,
// short enough that the file doesn't balloon over months.

import db from './../db/index.js';
import { logError } from './errorLog.js';

/**
 * @typedef {object} RetentionTable
 * @property {string} table
 * @property {string} date_col
 * @property {number} default_days
 * @property {string} env
 */
/** @typedef {{ table: string, deleted: number, kept_days: number } | { table: string, error: string, kept_days: number }} PruneSummary */

// Tables to prune on the daily tick. Each entry names the SQLite column
// that holds the row's wall-clock timestamp (ISO 8601 string compared
// lexicographically — works because ISO 8601 is sort-friendly).
//
// `job_runs` is intentionally NOT here — it has its own dedicated prune
// in lib/jobRunner.js with a different keep-days default (30) that the
// scheduler already wires up. Adding it here would double-prune.
/** @type {RetentionTable[]} */
const RETENTION_TABLES = [
  {
    table: 'error_log',
    date_col: 'occurred_at',
    default_days: 30,
    env: 'RETENTION_ERROR_LOG_DAYS',
    // 30 days: operator triages this week's noise; older entries are
    // forensics, not actionable. Verbose-English log expansion in
    // PR #237 will accelerate growth — start tighter.
  },
  {
    table: 'auditlog',
    date_col: 'created_date',
    default_days: 365,
    env: 'RETENTION_AUDITLOG_DAYS',
    // 365 days: audit trail for "who did what" wants longer retention
    // than the operational logs. Tune longer if compliance demands.
  },
  {
    table: 'syncrun',
    date_col: 'started_at',
    default_days: 30,
    env: 'RETENTION_SYNCRUN_DAYS',
    // 30 days: matches job_runs default; same use case (recent sync
    // history for diagnosis).
  },
  {
    table: 'login_log',
    date_col: 'logged_in_at',
    default_days: 90,
    env: 'RETENTION_LOGIN_LOG_DAYS',
    // 90 days: security/audit signal; longer than ops logs because a
    // suspicious-login investigation often references months back.
  },
];

// NaN-guard mirroring lib/jobRunner.js: parseInt('abc', 10) returns
// NaN, and Math.max(1, NaN) is NaN — every `>= NaN` comparison
// downstream is false, which would silently disable the prune if a
// typo landed in the env. Validate before using.
/**
 * @param {string | undefined} envVal
 * @param {number} defaultVal
 * @returns {number}
 */
function parseDays(envVal, defaultVal) {
  const n = parseInt(envVal ?? '', 10);
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return n;
}

// Run the daily prune across every table in RETENTION_TABLES. Returns
// a summary array suitable for attaching to job_runs.context via the
// scheduler's `track()` helper. Per-table failures are logged and the
// loop continues — one bad table shouldn't block the others.
//
// Comparison uses SQLite datetime() on BOTH sides, NOT raw lexicographic
// string compare. The targeted tables write timestamps in two
// incompatible formats:
//   - error_log.occurred_at + syncrun.started_at: ISO 8601 with `T`
//     separator and `.sssZ` suffix (logError + recordJob both call
//     `new Date().toISOString()`)
//   - auditlog.created_date + login_log.logged_in_at: SQLite
//     CURRENT_TIMESTAMP / datetime('now') format
//     ('YYYY-MM-DD HH:MM:SS')
//
// In raw string compare, ' ' (0x20) sorts BEFORE 'T' (0x54), so a
// CURRENT_TIMESTAMP-format row that lands EXACTLY on the cutoff
// boundary gets deleted as "older than kept_days" when it's actually
// at the cutoff. Wrapping both sides in datetime() normalises to a
// single comparable form (julianday-based internally) and the
// boundary works as intended.
//
// Codex catch on PR #245.
/**
 * @returns {PruneSummary[]}
 */
export function pruneOldRows() {
  /** @type {PruneSummary[]} */
  const summary = [];
  for (const { table, date_col, default_days, env } of RETENTION_TABLES) {
    const keepDays = parseDays(process.env[env], default_days);
    const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
    try {
      const result = db
        .prepare(`DELETE FROM ${table} WHERE datetime(${date_col}) < datetime(?)`)
        .run(cutoff);
      summary.push({ table, deleted: result.changes, kept_days: keepDays });
    } catch (err) {
      try { logError(`retention.${table}`, err, { table, kept_days: keepDays }); } catch {} // eslint-disable-line no-empty -- logError wrapper; we still push the error into the summary below
      summary.push({ table, error: err instanceof Error ? err.message : String(err), kept_days: keepDays });
    }
  }
  return summary;
}

// Reclaim disk space freed by prior DELETEs. DELETE alone marks pages
// as free inside the file but doesn't shrink it; only VACUUM rewrites
// the file at its actual size.
//
// VACUUM acquires an EXCLUSIVE lock for its duration and rewrites the
// entire DB file. On a healthy site post-record_snapshots-drop this
// completes in seconds, but on a bloated site (multi-GB) it can take
// 30-180 seconds. Schedule for the quietest hour (cron picks 04:45 on
// the 1st) so it doesn't contend with operator activity or the daily
// backup job at 02:00.
//
// Returns the elapsed time so a slow VACUUM (suggesting filesystem
// fragmentation or unusually heavy DELETE-and-grow churn) is visible
// in job_runs.context.
/**
 * @returns {{ elapsed_ms: number }}
 */
export function vacuumDb() {
  const t0 = Date.now();
  db.exec('VACUUM');
  return { elapsed_ms: Date.now() - t0 };
}
