import fs from 'fs';
import path from 'path';
import db from '../db/index.js';

const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'errors.log');
const MAX_BYTES = 10 * 1024 * 1024; // 10MB before rotation

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_BYTES) {
      fs.renameSync(LOG_FILE, path.join(LOG_DIR, 'errors.log.1'));
    }
  } catch {}
}

// ── SQLite mirror (synchronous) ──────────────────────────────────────────────
// Errors are written synchronously, not batched. The previous batched-flush
// implementation (250ms timer) lost in-memory rows when the OCR pipeline
// crashed the process (native addon segfault in canvas/sharp/pdfjs takes
// down the whole node executable — no chance to flush). Synchronous writes
// guarantee the row is on disk before we return, so the post-mortem stack
// always survives. logError is infrequent enough that sync-write overhead
// is irrelevant.
let insertStmt = null;

function getInsertStmt() {
  // Lazy-prepare so a logError() call before migrations have finished
  // doesn't crash — first writes are dropped silently, file log still fires.
  if (insertStmt) return insertStmt;
  try {
    insertStmt = db.prepare(`
      INSERT INTO error_log (source, level, message, stack, context, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  } catch { /* migration hasn't run yet */ }
  return insertStmt;
}

export function logError(scope, err, meta = {}, level = 'error') {
  const ts = new Date().toISOString();
  const message = err?.message || String(err || 'unknown event');
  const stack = err?.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : undefined;
  const entry = { ts, scope: scope || 'unknown', level, message, stack, ...meta };

  // 1) File log (existing — preserved so log-file tooling keeps working)
  rotateIfNeeded();
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (e) {
    process.stderr.write(`[errorLog] failed to write file: ${e.message}\n`);
  }

  // 2) SQLite mirror — synchronous so it survives a process crash
  try {
    const stmt = getInsertStmt();
    if (stmt) {
      let serializedMeta = null;
      if (Object.keys(meta).length) {
        try { serializedMeta = JSON.stringify(meta).slice(0, 4000); } catch { serializedMeta = '[unserializable meta]'; }
      }
      stmt.run(
        String(scope || 'unknown').slice(0, 80),
        level,
        String(message).slice(0, 2000),
        stack ? String(stack).slice(0, 8000) : null,
        serializedMeta,
        ts,
      );
    }
  } catch (e) {
    // Last-resort stderr — don't recurse into logError or we could loop on
    // a persistently failing DB.
    process.stderr.write(`[errorLog] sqlite insert failed: ${e.message}\n`);
  }

  // 3) Mirror to stderr so devs see it in the terminal too
  process.stderr.write(`[${entry.scope}] ${entry.message}\n`);
}
