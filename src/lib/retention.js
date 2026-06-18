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
// Because VACUUM holds an EXCLUSIVE lock and rewrites the whole file, every
// reader AND writer in the app blocks for its entire duration — it is the
// single longest main-thread freeze the scheduler can cause. So only pay it
// when there is meaningful space to reclaim: a DB that hasn't churned much
// since last month has a near-empty freelist, and rewriting it just to shuffle
// the same bytes is a pure multi-second freeze with no benefit. We VACUUM when
// the free pages are ≥ 100 MB OR ≥ 10% of the file, OR a real VACUUM hasn't run
// in VACUUM_MAX_SKIP_DAYS (the fragmentation fallback below); skip otherwise.
// Thresholds tunable via VACUUM_MIN_FREE_BYTES / VACUUM_MIN_FREE_FRACTION /
// VACUUM_MAX_SKIP_DAYS.
//
// Returns the elapsed time (when it ran, with the trigger) or the skip reason,
// plus the figures it decided on, so job_runs.context shows what happened/why.
/**
 * @returns {{ elapsed_ms: number, trigger: string, freelist_pages: number, free_mb: number, days_since_last_vacuum: number | null } | { skipped: true, reason: string, freelist_pages: number, free_mb: number, free_fraction: number, days_since_last_vacuum: number | null }}
 */
export function vacuumDb() {
  const freelistPages = Number(db.pragma('freelist_count', { simple: true })) || 0;
  const pageCount = Number(db.pragma('page_count', { simple: true })) || 0;
  const pageSize = Number(db.pragma('page_size', { simple: true })) || 4096;
  const freeBytes = freelistPages * pageSize;
  const freeFraction = pageCount > 0 ? freelistPages / pageCount : 0;

  const minFreeBytesRaw = parseInt(process.env.VACUUM_MIN_FREE_BYTES ?? '', 10);
  const minFreeBytes = Number.isFinite(minFreeBytesRaw) && minFreeBytesRaw >= 0 ? minFreeBytesRaw : 100 * 1024 * 1024;
  const minFreeFractionRaw = parseFloat(process.env.VACUUM_MIN_FREE_FRACTION ?? '');
  const minFreeFraction = Number.isFinite(minFreeFractionRaw) && minFreeFractionRaw >= 0 ? minFreeFractionRaw : 0.10;

  // Fragmentation fallback (Codex review on PR #480): freelist_count only counts
  // COMPLETELY free pages. Sparse, interleaved deletes can leave the freelist
  // near-empty while many B-tree pages sit only partially filled — bloat a
  // VACUUM would repack but the freelist gate alone would skip forever. So also
  // force an unconditional VACUUM when a real one hasn't run in
  // VACUUM_MAX_SKIP_DAYS (default 90). "Real" excludes prior skips, which are
  // ALSO recorded status='succeeded' (their context carries "skipped") — so we
  // must filter those out or the timer would never elapse.
  const maxSkipDaysRaw = parseInt(process.env.VACUUM_MAX_SKIP_DAYS ?? '', 10);
  const maxSkipDays = Number.isFinite(maxSkipDaysRaw) && maxSkipDaysRaw >= 0 ? maxSkipDaysRaw : 90;
  let daysSinceLastVacuum = Infinity;
  try {
    const row = db.prepare(`
      SELECT MAX(ended_at) AS last FROM job_runs
      WHERE name = 'vacuum-db' AND status = 'succeeded'
        AND (context IS NULL OR context NOT LIKE '%"skipped"%')
    `).get();
    if (row?.last) {
      const ms = Date.now() - Date.parse(row.last);
      if (Number.isFinite(ms) && ms >= 0) daysSinceLastVacuum = ms / (1000 * 60 * 60 * 24);
    }
  } catch { /* job_runs unavailable → leave Infinity → treat as overdue → VACUUM */ }
  const overdue = daysSinceLastVacuum >= maxSkipDays;
  const daysSinceForReport = Number.isFinite(daysSinceLastVacuum) ? Math.round(daysSinceLastVacuum) : null;

  if (!overdue && freeBytes < minFreeBytes && freeFraction < minFreeFraction) {
    return {
      skipped: true,
      reason: 'little_to_reclaim',
      freelist_pages: freelistPages,
      free_mb: Math.round(freeBytes / (1024 * 1024)),
      free_fraction: Number(freeFraction.toFixed(3)),
      days_since_last_vacuum: daysSinceForReport,
    };
  }

  const t0 = Date.now();
  db.exec('VACUUM');
  return {
    elapsed_ms: Date.now() - t0,
    trigger: overdue ? 'overdue_fragmentation_guard' : 'freelist',
    freelist_pages: freelistPages,
    free_mb: Math.round(freeBytes / (1024 * 1024)),
    days_since_last_vacuum: daysSinceForReport,
  };
}
