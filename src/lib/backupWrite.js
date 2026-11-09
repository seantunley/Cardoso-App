// Write a local backup so that only a COMPLETE file ever carries the real name.
//
// db.backup() copies the database page by page. If the service is stopped part
// way (restart, shutdown, crash), the half-written file used to sit in backups/
// under its final name, looking like the newest backup: verify picked it, and
// prune counted it as one of the "newest 3" it always keeps. Writing to
// `<name>.partial` and renaming once it's finished means a cut-off backup never
// looks like a real one. Verify, prune and backup health only look at `.db`.
import fs from 'fs';
import path from 'path';

export async function writeBackupFile(db, destPath) {
  const tmp = `${destPath}.partial`;
  try {
    await db.backup(tmp);
    const size = fs.statSync(tmp).size;
    if (!(size > 0)) throw new Error(`backup file is ${size} bytes after db.backup() — unusable`);
    fs.renameSync(tmp, destPath);
    return size;
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort; removeStalePartials catches it later */ }
    throw err;
  }
}

// Delete `.partial` files left by a backup that was cut off. Only ones older
// than `olderThanMs`, so a backup still being written right now is left alone.
export function removeStalePartials(dir, olderThanMs = 6 * 3_600_000, now = Date.now()) {
  let removed = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.partial')) continue;
    const full = path.join(dir, f);
    try {
      if (now - fs.statSync(full).mtimeMs > olderThanMs) { fs.rmSync(full, { force: true }); removed += 1; }
    } catch (e) { console.warn('[backup.remove_partial]', { file: f }, e.message); }
  }
  return removed;
}
