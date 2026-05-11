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

console.log(`✅ SQLite database ready → ${dbPath}`);

export default db;
export { dbPath };
