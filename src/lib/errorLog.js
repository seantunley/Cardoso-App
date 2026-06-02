import fs from 'fs';
import path from 'path';
import db from '../db/index.js';

const LOG_DIR = path.join(process.cwd(), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'errors.log');
const MAX_BYTES = 10 * 1024 * 1024; // 10MB before rotation

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {} // eslint-disable-line no-empty -- logging here would recurse into errorLog itself

/** @typedef {Record<string, unknown>} LogMeta */

/**
 * @param {unknown} value
 * @returns {string}
 */
function errorMessage(value) {
  if (value && typeof value === 'object' && 'message' in value) return String(value.message);
  return String(value || 'unknown event');
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function errorStack(value) {
  if (value && typeof value === 'object' && 'stack' in value && value.stack) return String(value.stack);
  return undefined;
}

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_BYTES) {
      fs.renameSync(LOG_FILE, path.join(LOG_DIR, 'errors.log.1'));
    }
  } catch {} // eslint-disable-line no-empty -- logging rotation failure would recurse into errorLog
}

// ── SQLite mirror (synchronous) ──────────────────────────────────────────────
// Errors are written synchronously, not batched. The previous batched-flush
// implementation (250ms timer) lost in-memory rows when the OCR pipeline
// crashed the process (native addon segfault in canvas/sharp/pdfjs takes
// down the whole node executable — no chance to flush). Synchronous writes
// guarantee the row is on disk before we return, so the post-mortem stack
// always survives. logError is infrequent enough that sync-write overhead
// is irrelevant.
/** @typedef {{ run: (...params: unknown[]) => unknown }} InsertStatement */

/** @type {InsertStatement | null} */
let insertStmt = null;

/**
 * @returns {InsertStatement | null}
 */
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

/**
 * @param {string} scope
 * @param {unknown} err
 * @param {LogMeta} [meta]
 * @param {string} [level]
 * @returns {void}
 */
export function logError(scope, err, meta = {}, level = 'error') {
  const ts = new Date().toISOString();
  const message = errorMessage(err);
  const stack = errorStack(err)?.split('\n').slice(0, 6).join('\n');
  const entry = { ts, scope: scope || 'unknown', level, message, stack, ...meta };

  // 1) File log (existing — preserved so log-file tooling keeps working)
  rotateIfNeeded();
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (e) {
    process.stderr.write(`[errorLog] failed to write file: ${errorMessage(e)}\n`);
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
    process.stderr.write(`[errorLog] sqlite insert failed: ${errorMessage(e)}\n`);
  }

  // 3) Mirror to stderr so devs see it in the terminal too
  process.stderr.write(`[${entry.scope}] ${entry.message}\n`);
}
