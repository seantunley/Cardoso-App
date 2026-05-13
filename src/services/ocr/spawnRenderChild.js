// Parent-side wrapper around renderPdfChild.js. Spawns the child as a
// short-lived Node process, pipes the PDF buffer in on stdin, returns
// the JPEG buffer from stdout, and enforces a wall-clock timeout
// backed by SIGTERM → grace → SIGKILL.
//
// The whole point of running the renderer out-of-process is that a
// render wedge can't take down the parent. The OS can SIGKILL a wedged
// child even when it's stuck inside an uninterruptible native syscall
// (libcairo internal mutex, font cache lock) — `worker.terminate()` on
// a worker_thread in the same predicament returns immediately to the
// parent without actually reaping the wedged thread.
//
// Used by:
//   src/services/ocrWorker.js               — hot path (OCR worker thread)
//   src/services/batReconciliation.js       — cold path (GV retry button)
//
// Both callsites previously called a same-named in-worker `pdfPageToImage`;
// this wrapper exposes `renderPdfInChild` with the same signature and
// behaviour from the caller's point of view, but the render itself
// happens in a child process.

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { Buffer } from 'buffer';

const CHILD_SCRIPT = fileURLToPath(new URL('./renderPdfChild.js', import.meta.url));

// How long the parent waits after SIGTERM before escalating to SIGKILL.
// On Windows the two map to the same TerminateProcess call so the grace
// is effectively zero there; on Linux/Mac the child gets a chance to
// flush stderr structured-error output before being forcibly reaped.
const SIGTERM_GRACE_MS = 2_000;

/**
 * @typedef {Object} RenderOpts
 * @property {number} [pageNum=1]
 * @property {number} [requestedScale=2.0]
 * @property {number} [maxWidth=2400]      capped against base viewport width
 * @property {number} [maxHeight=4000]     capped against base viewport height
 * @property {number} [maxPixels=6000000]  total raster pixel cap
 * @property {number} [minScale=0.3]       refuse-to-render floor
 * @property {number} [jpegQuality]        no default here — when omitted, the
 *                                         child's own default (currently 0.95)
 *                                         applies. Pass an explicit value to
 *                                         override it.
 * @property {number} [timeoutMs=30000]    parent-side wall-clock kill timeout
 * @property {string} [childScriptPath]    test-only override for the script path
 */

/**
 * Render one PDF page in a short-lived child process and return the
 * JPEG buffer. Throws an Error tagged with a structured `.code` when
 * the child fails. The Promise NEVER hangs — either the child exits
 * (success or structured failure), the timeout fires (SIGKILL after
 * grace, reject with `code: 'RENDER_TIMEOUT'`), or spawn itself fails
 * (reject immediately with `code: 'CHILD_SPAWN_FAILED'`).
 *
 * @param {Buffer} pdfBuffer  the PDF bytes
 * @param {RenderOpts} [opts]
 * @returns {Promise<Buffer>} JPEG bytes
 */
export function renderPdfInChild(pdfBuffer, opts = {}) {
  if (!Buffer.isBuffer(pdfBuffer)) {
    return Promise.reject(makeChildError({
      code: 'BAD_INPUT',
      message: 'renderPdfInChild: pdfBuffer must be a Buffer',
    }));
  }
  if (pdfBuffer.length === 0) {
    return Promise.reject(makeChildError({
      code: 'BAD_INPUT',
      message: 'renderPdfInChild: pdfBuffer is empty',
    }));
  }

  const {
    pageNum = 1,
    requestedScale = 2.0,
    maxWidth = 2400,
    maxHeight = 4000,
    maxPixels = 6_000_000,
    minScale = 0.3,
    // No default for jpegQuality — see RenderOpts typedef. The child
    // owns the default (currently 0.95, bumped from 0.85 in Phase 2
    // round-2 because heavier compression bled digit edges and OCR
    // misread 9 vs 8 / 5). If we defaulted to a value here, the
    // child's default would be unreachable and the migration's
    // quality bump would silently regress.
    jpegQuality,
    timeoutMs = 30_000,
    childScriptPath = CHILD_SCRIPT,
  } = opts;

  const params = { pageNum, requestedScale, maxWidth, maxHeight, maxPixels, minScale };
  if (jpegQuality !== undefined) params.jpegQuality = jpegQuality;
  const paramsJson = JSON.stringify(params);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(process.execPath, [childScriptPath, paramsJson], {
        stdio: ['pipe', 'pipe', 'pipe'],
        // Don't inherit the parent's env wholesale — but DO pass through
        // any OCR_* overrides + NODE_OPTIONS so the child sees the same
        // tunables the operator configured. (Today the caps are sent via
        // paramsJson, not env, so the child doesn't actually need them.
        // But future Phase-2 native binaries may key off NODE_OPTIONS,
        // and dev workflows benefit from inherited PATH on Windows.)
        env: process.env,
      });
    } catch (spawnErr) {
      return reject(makeChildError({
        code: 'CHILD_SPAWN_FAILED',
        message: `failed to spawn render child: ${spawnErr.message}`,
        cause: spawnErr.code,
      }));
    }

    /** @type {Buffer[]} */
    const stdoutChunks = [];
    let stderrText = '';
    let timedOut = false;
    let settled = false;
    let killTimer = null;

    // Wall-clock kill timer. On expiry: SIGTERM (gives the child a
    // chance to flush a structured error if it's still healthy), then
    // SIGKILL after the grace window if it hasn't exited.
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* child may already be dead */ }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* idempotent */ }
      }, SIGTERM_GRACE_MS);
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    const settle = (fn) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    child.stdout.on('data', (chunk) => { stdoutChunks.push(chunk); });
    child.stderr.on('data', (chunk) => {
      // Cap stderr capture so a runaway child can't blow parent memory.
      // 16 KB is way more than our structured-error payloads need.
      if (stderrText.length < 16_384) stderrText += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      // `error` fires when spawn fails AFTER the constructor returned,
      // or when the process couldn't be started at all (ENOENT on
      // node binary, etc.). Distinct from non-zero exit.
      settle(() => reject(makeChildError({
        code: 'CHILD_SPAWN_FAILED',
        message: `render child error: ${err.message}`,
        cause: err.code,
      })));
    });

    // Listen on 'close' rather than 'exit'. Node fires 'exit' as soon as
    // the child terminates, but stdout/stderr pipes may still have
    // buffered data the parent hasn't drained — Buffer.concat at that
    // moment can return a truncated payload, and a 100 KB JPEG arriving
    // as 87 KB causes sharp/OCR to fail with confusing decode errors
    // downstream that look unrelated to the renderer. 'close' is fired
    // AFTER all stdio streams have flushed and closed, so the chunks
    // array is guaranteed complete.
    //
    // From Node docs: 'close' fires for every spawned child, including
    // the SIGKILL'd one — code is null, signal is the killing signal.
    child.on('close', (code, signal) => {
      settle(() => {
        if (timedOut) {
          return reject(makeChildError({
            code: 'RENDER_TIMEOUT',
            message: `render child wall-clock killed after ${timeoutMs}ms (signal=${signal || 'none'}, exit=${code === null ? 'killed' : code})`,
            timeoutMs,
            signal: signal || null,
          }));
        }
        if (code === 0) {
          return resolve(Buffer.concat(stdoutChunks));
        }
        // Non-zero exit — parse structured stderr if present.
        const parsed = parseStructuredStderr(stderrText);
        if (parsed) return reject(makeChildError(parsed));
        return reject(makeChildError({
          code: 'CHILD_FAILED',
          message: `render child exited with code ${code} (signal=${signal || 'none'})${stderrText ? `; stderr=${truncate(stderrText, 300)}` : ''}`,
          exitCode: code,
          signal: signal || null,
        }));
      });
    });

    // Pipe PDF bytes into the child. Wrap in try/catch: if the child
    // dies between spawn and stdin.write (rare but seen on overloaded
    // boxes), we'd otherwise get an uncaught EPIPE — let the exit
    // handler resolve the promise normally with the structured error.
    try {
      child.stdin.on('error', () => { /* EPIPE if child died early */ });
      child.stdin.end(pdfBuffer);
    } catch { /* same — exit handler will fire */ }
  });
}

// stderr can carry incidental warnings (Node deprecation notices,
// pdfjs's "Warning: TT: ..." debug output, etc.) alongside our
// structured-error line. Walk from the end and grab the LAST line that
// parses as a JSON object — that's our line.
function parseStructuredStderr(text) {
  if (!text) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    if (line[0] === '{' && line[line.length - 1] === '}') {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch { /* keep walking back */ }
    }
  }
  return null;
}

function makeChildError(obj) {
  const err = new Error(obj.message || 'render child error');
  err.code = obj.code || 'CHILD_FAILED';
  // Copy every structured field through so logError contexts can pick
  // them up without parsing the message.
  for (const k of Object.keys(obj)) {
    if (k === 'message') continue;
    err[k] = obj[k];
  }
  return err;
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}
