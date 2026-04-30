import fs from 'fs';
import path from 'path';

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

export function logError(scope, err, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    scope: scope || 'unknown',
    message: err?.message || String(err || 'unknown error'),
    stack: err?.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : undefined,
    ...meta,
  };
  rotateIfNeeded();
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (e) {
    process.stderr.write(`[errorLog] failed to write: ${e.message}\n`);
  }
  // Mirror to stderr so devs see it in the terminal too
  process.stderr.write(`[${entry.scope}] ${entry.message}\n`);
}
