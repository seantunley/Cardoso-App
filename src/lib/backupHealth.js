// Request-time, artifact-based backup health.
//
// The daily backup (runLocalBackup, 02:00) and its verification
// (verifyLatestBackup, 03:30) both run inside the in-process node-cron
// scheduler. When that scheduler stops — an event-loop freeze (we have a
// stack of database/.main-thread-freeze archives), or a restart that didn't
// re-arm — backup creation AND verification stop together. And because the
// last `backup-verify` job_runs row stays 'succeeded', the dashboard kept
// showing green right through a 12-day backup outage (June 2026). Health was
// being inferred from the very process that had died.
//
// The fix in principle: TRUST THE ARTIFACT, NOT THE PROCESS. This helper is
// called on REQUEST (dashboard health poll, hub status pull, alert rule) and
// reads the backup files straight off disk at that moment, so a dead scheduler
// can't hide a missing/stale backup. The cron-written verification result is
// folded in only as a SECONDARY signal ("was the newest file integrity-checked
// recently?"), never as the primary freshness check.

import fs from 'fs';
import path from 'path';
import db, { dbPath } from '../db/index.js';

// 24h cadence + 2h buffer. Matches the verify threshold + NIGHTLY_STALE_HOURS
// in alertRules.js, so the whole system agrees on what "stale" means.
export const BACKUP_STALE_HOURS = 26;
// Beyond this a backup is so old it's a multi-day outage, not a one-off miss.
export const BACKUP_CRITICAL_HOURS = 50;
// A successful integrity verification older than this counts as "unverified" —
// a warn (the file may be fine, but nothing has confirmed it lately, which is
// itself a hint the verify cron has stopped).
export const VERIFY_STALE_HOURS = 50;

// Same filter the status endpoint uses — any .db in the backups dir.
const BACKUP_FILE_RE = /\.db$/i;

function backupDirFor() {
  return path.resolve(path.dirname(path.resolve(dbPath)), 'backups');
}

function listBackupFiles(backupDir) {
  // Throws only on a non-ENOENT FS error (perms etc.); a missing dir is a
  // valid "no backups yet" state and returns [].
  let names;
  try {
    names = fs.readdirSync(backupDir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter((f) => BACKUP_FILE_RE.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(backupDir, f));
      return { name: f, size: st.size, mtimeMs: st.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function getLatestVerifyRow() {
  // job_runs.started_at / ended_at are ISO-UTC strings (see jobRunner.js),
  // so `new Date(...)` parses them correctly regardless of the SQLite
  // local-time convention. Tolerate a pre-v60 install with no job_runs table.
  try {
    return db.prepare(`
      SELECT status, error_message, ended_at, started_at
      FROM job_runs
      WHERE name = 'backup-verify'
      ORDER BY started_at DESC
      LIMIT 1
    `).get() || null;
  } catch (err) {
    if (/no such table/i.test(err.message)) return null;
    throw err;
  }
}

/**
 * Compute backup health from the artifacts on disk (+ the last verify run).
 * Pure read. Never throws for the normal "no backups yet" case — that's a
 * `critical` verdict, not an exception.
 *
 * @param {{ now?: number }} [opts] — `now` injectable for tests.
 * @returns {{
 *   status: 'ok'|'warn'|'critical',
 *   reason: string,
 *   message: string,
 *   last_backup_at: string|null,
 *   age_hours: number|null,
 *   file: string|null,
 *   total_backups: number,
 *   total_bytes: number,
 *   latest_bytes: number|null,
 *   db_bytes: number|null,
 *   backup_dir: string,
 *   verify: { status: string|null, at: string|null, error: string|null, age_hours: number|null },
 * }}
 */
export function computeBackupHealth({ now = Date.now() } = {}) {
  const backupDir = backupDirFor();

  let files = [];
  let readError = null;
  try {
    files = listBackupFiles(backupDir);
  } catch (err) {
    readError = err.message;
  }

  let dbBytes = null;
  try { dbBytes = fs.statSync(path.resolve(dbPath)).size; } catch { dbBytes = null; }

  const hoursSince = (ts) => {
    if (!ts) return null;
    const t = new Date(ts).getTime();
    if (!Number.isFinite(t)) return null;
    return (now - t) / 3_600_000;
  };

  const verifyRow = (() => { try { return getLatestVerifyRow(); } catch { return null; } })();
  const verify = {
    status: verifyRow?.status || null,
    at: verifyRow?.ended_at || verifyRow?.started_at || null,
    error: verifyRow?.error_message || null,
    age_hours: null,
  };
  verify.age_hours = hoursSince(verify.at);
  if (verify.age_hours != null) verify.age_hours = Number(verify.age_hours.toFixed(2));

  const baseEmpty = {
    last_backup_at: null,
    age_hours: null,
    file: null,
    total_backups: 0,
    total_bytes: 0,
    latest_bytes: null,
    db_bytes: dbBytes,
    backup_dir: backupDir,
    verify,
  };

  // No backups at all (or the dir can't be read) → critical, full stop.
  if (readError) {
    return {
      ...baseEmpty,
      status: 'critical',
      reason: 'backup_dir_unreadable',
      message: `Backup directory could not be read: ${readError}`,
    };
  }
  if (files.length === 0) {
    return {
      ...baseEmpty,
      status: 'critical',
      reason: 'no_backups',
      message: 'No backup files exist. No backup has ever completed, or every backup was pruned/deleted.',
    };
  }

  const latest = files[0];
  const ageHours = (now - latest.mtimeMs) / 3_600_000;
  const base = {
    last_backup_at: new Date(latest.mtimeMs).toISOString(),
    age_hours: Number(ageHours.toFixed(2)),
    file: latest.name,
    total_backups: files.length,
    total_bytes: files.reduce((s, f) => s + f.size, 0),
    latest_bytes: latest.size,
    db_bytes: dbBytes,
    backup_dir: backupDir,
    verify,
  };

  // --- Primary signal: freshness + size of the newest artifact ---
  if (!(latest.size > 0)) {
    return { ...base, status: 'critical', reason: 'latest_empty',
      message: `The newest backup (${latest.name}) is 0 bytes — it is unusable.` };
  }
  if (ageHours > BACKUP_CRITICAL_HOURS) {
    const days = Math.round(ageHours / 24);
    return { ...base, status: 'critical', reason: 'stale_critical',
      message: `Newest backup is ${days} day${days === 1 ? '' : 's'} old (${latest.name}). The daily backup has not run — backups are effectively down.` };
  }
  if (ageHours > BACKUP_STALE_HOURS) {
    return { ...base, status: 'critical', reason: 'stale',
      message: `Newest backup is ${ageHours.toFixed(1)}h old (threshold ${BACKUP_STALE_HOURS}h) — yesterday's backup did not run.` };
  }

  // --- Secondary signal: the cron-written integrity verification ---
  if (verify.status === 'failed') {
    return { ...base, status: 'critical', reason: 'verify_failed',
      message: `A fresh backup exists but its integrity verification FAILED: ${verify.error || 'unknown reason'}.` };
  }
  if (verify.status !== 'succeeded' || (verify.age_hours != null && verify.age_hours > VERIFY_STALE_HOURS)) {
    return { ...base, status: 'warn', reason: 'unverified',
      message: `A fresh backup exists (${ageHours.toFixed(1)}h old) but it has not been integrity-verified recently — verification may have stopped.` };
  }

  return { ...base, status: 'ok', reason: 'ok',
    message: `Backup is current (${ageHours.toFixed(1)}h old) and last verified OK ${verify.age_hours != null ? `${verify.age_hours.toFixed(1)}h ago` : ''}.`.trim() };
}
