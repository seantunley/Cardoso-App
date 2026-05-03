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

// ── SQLite mirror (batched) ──────────────────────────────────────────────────
// Same batching pattern as audit.js — keep request-thread overhead minimal so
// noisy error sites (e.g. an OCR worker crashing 200 times) don't dog-pile.
const QUEUE = [];
const QUEUE_HARD_CAP = 5000;
const FLUSH_INTERVAL_MS = 250;
let flushTimer = null;
let insertStmt = null;

function getInsertStmt() {
  // Lazy-prepare so the table-not-yet-migrated case is forgiven
  if (insertStmt) return insertStmt;
  try {
    insertStmt = db.prepare(`
      INSERT INTO error_log (source, level, message, stack, context, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
  } catch { /* migration hasn't run yet */ }
  return insertStmt;
}

const flushBatch = (rows) => {
  const stmt = getInsertStmt();
  if (!stmt) return; // table not ready; drop silently — file log + stderr still fired
  const tx = db.transaction((batch) => {
    for (const r of batch) stmt.run(...r);
  });
  tx(rows);
};

function flush() {
  if (QUEUE.length === 0) return;
  const batch = QUEUE.splice(0, QUEUE.length);
  try {
    flushBatch(batch);
  } catch (err) {
    // Last-resort: write to stderr only. Don't recurse into logError or we
    // could loop on a persistently failing DB.
    process.stderr.write(`[errorLog] sqlite flush failed: ${err.message} — dropped ${batch.length} row(s)\n`);
  }
}

function ensureFlushScheduled() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_INTERVAL_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

const finalFlush = () => { try { if (flushTimer) clearTimeout(flushTimer); flush(); } catch {} };
process.on('SIGTERM', finalFlush);
process.on('SIGINT', finalFlush);
process.on('beforeExit', finalFlush);

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

  // 2) SQLite mirror (new — feeds the in-app System Log viewer)
  QUEUE.push([
    String(scope || 'unknown').slice(0, 80),
    level,
    String(message).slice(0, 2000),
    stack ? String(stack).slice(0, 8000) : null,
    Object.keys(meta).length ? JSON.stringify(meta).slice(0, 4000) : null,
    ts,
  ]);
  if (QUEUE.length > QUEUE_HARD_CAP) {
    const dropped = QUEUE.splice(0, QUEUE.length - QUEUE_HARD_CAP);
    process.stderr.write(`[errorLog] queue overflowing — dropped ${dropped.length} oldest row(s)\n`);
  }
  ensureFlushScheduled();

  // 3) Mirror to stderr so devs see it in the terminal too
  process.stderr.write(`[${entry.scope}] ${entry.message}\n`);
}
