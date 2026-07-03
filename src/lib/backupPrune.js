// Which local .db backups to delete, as a PURE function (no fs/db) so it can be
// unit-tested — it deletes files, so its selection logic must be provably safe.
//
// Two things it fixes over the old inline prune in scheduler.runLocalBackup:
//
// 1. FILENAME MATCH. The old regex required a fully DASH-separated timestamp
//    (`cardoso-<id>-YYYY-MM-DD-HH-MM-SS.db`), but the backup writer produces an
//    ISO 'T' (`…-YYYY-MM-DDTHH-MM-SS.db`) and some site builds produced an
//    underscore form (`…-YYYY-MM-DD_HHMMSS.db`). So the regex matched NOTHING
//    the writer actually wrote — the prune never ran and backups grew forever.
//    BACKUP_FILE_RE below accepts all three time separators.
//
// 2. POLICY. Keep by AGE (default 3 days) instead of a fixed count — but ALWAYS
//    retain at least the newest `minKeep`, so a stalled backup job (nothing new
//    for > keepDays) can NEVER prune the folder to zero.
//
// Safety: it only ever matches `cardoso-<id>-<timestamp>.db`. The live
// `cardoso.db` and a forensic `cardoso.db.corrupt.db` start `cardoso.` (dot),
// not `cardoso-` (dash), so they can never be selected. JTI/BAT archives live
// under uploads/, not this folder, and aren't `.db` — untouched regardless.

// A dated site backup: cardoso-<siteId>-<YYYY-MM-DD><sep><time>.db, where <sep>
// is '-', '_' or 'T'. Anchored on a real YYYY-MM-DD date so non-backup .db
// files can't match.
export const BACKUP_FILE_RE = /^cardoso-.+-\d{4}-\d{2}-\d{2}[-_T]\d.*\.db$/i;

/**
 * @param {Array<{ name: string, mtime: number }>} entries  every .db file in the backup dir
 * @param {{ now?: number, keepDays?: number, minKeep?: number }} [opts]
 * @returns {string[]} filenames to delete (only ever real backups)
 */
export function selectPrunableBackups(entries, { now = Date.now(), keepDays = 3, minKeep = 3 } = {}) {
  const days = Number.isFinite(keepDays) && keepDays >= 0 ? keepDays : 3;
  const floor = Number.isFinite(minKeep) && minKeep >= 0 ? minKeep : 3;
  const cutoff = now - days * 86_400_000;
  const backups = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.name === 'string' && BACKUP_FILE_RE.test(e.name))
    .sort((a, b) => b.mtime - a.mtime); // newest first
  // Delete a backup only if it's past the newest `floor` AND older than cutoff.
  return backups.filter((e, i) => i >= floor && e.mtime < cutoff).map((e) => e.name);
}
