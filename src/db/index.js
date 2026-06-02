import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = process.env.DB_PATH || './database/cardoso.db';
// Ensure database directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(dbPath);

/**
 * @param {unknown} value
 * @returns {string}
 */
function errorMessage(value) {
  if (value && typeof value === 'object' && 'message' in value) return String(value.message);
  return String(value);
}

// ── Performance pragmas ───────────────────────────────────────────────────
// Applied before any other query so every subsequent statement runs against
// the tuned engine. Each pragma is wrapped individually so a single
// unsupported pragma on an exotic SQLite build doesn't block boot.
//
// journal_mode = WAL
//   Default DELETE serialises writers and stalls readers during writes —
//   measurable degradation on this workload (Express + worker_threads
//   sharing one DB file). WAL lets readers proceed during writes and
//   lets writers commit without an fsync per row. Persisted in the DB
//   file header, so the conversion is one-time per DB file.
//
// synchronous = NORMAL
//   Safe to use with WAL (FULL is overkill in WAL mode). Drops the per-
//   commit fsync to once-per-checkpoint, which is the dominant write cost
//   on Windows.
//
// temp_store = MEMORY
//   Temp tables / sort buffers stay in RAM instead of writing to a temp
//   file. Speeds up complex JOIN/GROUP BY and avoids disk churn.
//
// mmap_size = 256 MB
//   Lets SQLite memory-map the DB up to this size for faster reads.
//   Conservative default — bump via SQLITE_MMAP_BYTES env var if a site
//   has lots of RAM and a multi-GB DB. Set to 0 to disable mmap.
//
// busy_timeout = 5000
//   When a writer is mid-checkpoint, readers can momentarily collide.
//   Wait up to 5s instead of immediately throwing SQLITE_BUSY.
const mmapBytes = parseInt(process.env.SQLITE_MMAP_BYTES ?? '', 10);
const PRAGMAS = [
  ['journal_mode', 'WAL'],
  ['synchronous', 'NORMAL'],
  ['temp_store', 'MEMORY'],
  ['mmap_size', Number.isFinite(mmapBytes) ? mmapBytes : 268435456],
  ['busy_timeout', 5000],
];
for (const [key, val] of PRAGMAS) {
  try {
    const result = db.pragma(`${key} = ${val}`, { simple: true });
    console.log(`[db] PRAGMA ${key}=${val} → ${result}`);
  } catch (err) {
    console.error(`[db] PRAGMA ${key}=${val} failed (continuing): ${errorMessage(err)}`);
  }
}

// ── Timezone-portable timestamp helper ────────────────────────────────────
// SQLite's built-in `datetime('now')` returns UTC. Its `'localtime'`
// modifier respects the host OS timezone — so a server moved between
// hosts (or running in Docker) silently produces different timestamps.
//
// We hard-code Africa/Johannesburg (SAST, UTC+2) for ALL timestamps the
// app writes, so behaviour is identical on every machine regardless of
// system TZ. Code MUST call `now_local()` (registered below as a
// SQLite user function) instead of `datetime('now')`.
//
// Usage in SQL:
//   INSERT INTO foo (created_at) VALUES (now_local())
//   UPDATE foo SET updated_at = now_local() WHERE id = ?
//
// Column DEFAULT CURRENT_TIMESTAMP is still UTC (it's a SQLite built-in,
// can't be overridden) — every INSERT that relies on the default must
// be migrated to set the column explicitly with now_local().
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;
// better-sqlite3's .function() exists at runtime but the bundled @types
// don't expose it on Database; cast so typecheck passes.
/** @type {any} */ (db).function('now_local', () => {
  const d = new Date(Date.now() + SAST_OFFSET_MS);
  return d.toISOString().slice(0, 19).replace('T', ' ');
});

console.log(`✅ SQLite database ready → ${dbPath}`);

export default db;
export { dbPath };
