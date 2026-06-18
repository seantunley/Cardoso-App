// One-shot worker for daily backup verification (see verifyLatestBackup in
// scheduler.js).
//
// PRAGMA integrity_check scans the ENTIRE database file and is fully
// synchronous in better-sqlite3 — measured at 2.4s on a 600MB site DB, and
// 14-30s on a multi-GB production DB. Run on the main thread (as it was), that
// scan hard-freezes the event loop and every API request with it for its whole
// duration; the archived .main-thread-freeze markers match exactly. Running it
// here, on a worker thread, keeps the main loop responsive — the worker can
// block freely because nothing else shares its thread.
//
// The backup FILE is opened strictly read-only, so this can never touch (or
// lock) the live database. The worker always posts exactly one result message
// and then exits, so the parent's await can never hang.
import { workerData, parentPort } from 'worker_threads';
import Database from 'better-sqlite3';

const { filePath, criticalTables = [] } = workerData || {};

function verify() {
  let backupDb;
  try {
    backupDb = new Database(filePath, { readonly: true, fileMustExist: true });
  } catch (err) {
    return { ok: false, reason: 'cannot_open', error: err.message };
  }
  try {
    const integrity = backupDb.prepare('PRAGMA integrity_check').all();
    const passed = integrity.length === 1 && integrity[0].integrity_check === 'ok';
    if (!passed) {
      const issues = integrity.map((r) => r.integrity_check).slice(0, 5).join('; ');
      return { ok: false, reason: 'integrity_check_failed', issues };
    }

    // Critical tables — if any is present in the live DB but missing/empty in
    // the backup, the backup is structurally suspect. Wrapped per-table so a
    // single missing table (fresh install) doesn't fail the whole check.
    const counts = {};
    for (const t of criticalTables) {
      try {
        const row = backupDb.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get();
        counts[t] = row?.c ?? 0;
      } catch (err) {
        counts[t] = `error: ${err.message}`;
      }
    }
    return { ok: true, counts };
  } catch (err) {
    return { ok: false, reason: 'verify_crashed', error: err.message };
  } finally {
    try { backupDb.close(); } catch { /* nothing to recover; worker is exiting */ }
  }
}

// Always post a single result, even if something unexpected throws, so the
// parent (which awaits exactly one message) never hangs waiting on us.
let result;
try {
  result = verify();
} catch (err) {
  result = { ok: false, reason: 'verify_crashed', error: err?.message || String(err) };
}
parentPort.postMessage(result);
