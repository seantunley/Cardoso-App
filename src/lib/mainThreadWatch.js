// Main-thread freeze forensics.
//
// Operator report (June 2026): the whole application periodically hangs —
// pages render their empty states because API calls never return, and only a
// service restart brings it back. better-sqlite3 is synchronous and several
// subsystems do heavy work on the main thread, so the event loop CAN be
// blocked — but nothing recorded what was running when it happened, so every
// hang was unattributable after the restart.
//
// Two detectors, one tiny "active operation" registry:
//
// 1. SOFT STALLS (event loop blocked, then recovers): the main thread runs a
//    500ms heartbeat interval; when a tick arrives late by ≥ SOFT_STALL_MS,
//    the main thread itself logs the stall WITH the operations that were
//    active — "main thread blocked for 4.2s during hub-etl:site3:inventory".
//    These never need a restart but they're the everyday "app hangs a lot".
//
// 2. HARD FREEZES (blocked until someone restarts the service): the main
//    thread can't log what it can never return from — so a watchdog WORKER
//    THREAD reads the heartbeat through a SharedArrayBuffer. When the beat
//    is ≥ HARD_FREEZE_MS old, the worker (whose own loop is unaffected)
//    writes a freeze-marker JSON file next to the database with the active
//    operations and timestamps, updating it while the freeze lasts. On the
//    NEXT BOOT, checkPreviousRunFreeze() finds the marker, writes a verbose
//    error_log entry, fires a critical alert (rings the notifications bell),
//    and archives the marker. The hang stops being a mystery the moment the
//    service comes back.
//
// Wire-up: server.js calls startMainThreadWatch() + checkPreviousRunFreeze()
// after migrations. Heavy subsystems wrap their work in trackOp():
//
//    const done = trackOp('hub-etl:site3:ar-open-items');
//    try { ...synchronous heavy work... } finally { done(); }
//
import { Worker } from 'worker_threads';
import { writeFileSync, readFileSync, renameSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logError } from './errorLog.js';

const WORKER_SCRIPT = fileURLToPath(new URL('./mainThreadWatchWorker.js', import.meta.url));

export const SOFT_STALL_MS = 2_000;
export const HARD_FREEZE_MS = 10_000;
const BEAT_INTERVAL_MS = 500;
const OPS_BYTES = 512; // fixed-size op-name region of the shared buffer

// Shared layout: [0..7] = Float64 heartbeat (Date.now of last beat),
// [8..8+OPS_BYTES) = utf8 op names, NUL-padded. Main thread writes, the
// watchdog worker only reads — a torn read of the op string during an
// update is theoretically possible and acceptable for forensics.
const sab = new SharedArrayBuffer(8 + OPS_BYTES);
const beatView = new Float64Array(sab, 0, 1);
const opsView = new Uint8Array(sab, 8, OPS_BYTES);

// ── Active-operation registry ────────────────────────────────────────────
const activeOps = new Map();
let opSeq = 0;

function syncOpsToShared() {
  const joined = [...activeOps.values()].join(' | ').slice(0, OPS_BYTES - 1);
  const bytes = Buffer.from(joined, 'utf8');
  opsView.fill(0);
  opsView.set(bytes.subarray(0, OPS_BYTES - 1));
}

/**
 * Register a named operation as "currently running on the main thread".
 * Returns a disposer — call it (ideally in `finally`) when the work ends.
 * Cheap enough for per-site/per-dataset granularity.
 */
export function trackOp(name) {
  const id = ++opSeq;
  activeOps.set(id, `${name} (started ${new Date().toISOString()})`);
  syncOpsToShared();
  return () => {
    activeOps.delete(id);
    syncOpsToShared();
  };
}

/** Snapshot of active op names — used by the soft-stall logger. */
export function getActiveOps() {
  return [...activeOps.values()];
}

// ── Marker file paths ────────────────────────────────────────────────────
export function freezeMarkerPath(dbPath) {
  return path.join(path.dirname(path.resolve(dbPath)), '.main-thread-freeze.json');
}

// ── Detector 1: soft stalls (main thread notices its own late tick) ─────
let lastTick = 0;
let intervalRef = null;
let workerRef = null;

export function startMainThreadWatch(dbPath) {
  if (intervalRef) return; // idempotent
  lastTick = Date.now();
  beatView[0] = lastTick;
  syncOpsToShared();

  intervalRef = setInterval(() => {
    const now = Date.now();
    const gap = now - lastTick;
    // Expected gap is BEAT_INTERVAL_MS; anything ≥ SOFT_STALL_MS means the
    // event loop was blocked that long and just came back.
    if (gap >= SOFT_STALL_MS) {
      const ops = getActiveOps();
      try {
        logError(
          'main_thread.stall',
          new Error(`Main thread (event loop) was blocked for ${(gap / 1000).toFixed(1)}s — every API request and page in the app froze for that long.`),
          {
            blocked_ms: gap,
            active_operations: ops.length ? ops : ['(none registered — the blocker is not yet instrumented with trackOp)'],
            hint: 'better-sqlite3 runs synchronously on the main thread; look at the active operations above for the culprit.',
          },
          'warn',
        );
      } catch { /* never let forensics break the app */ }
    }
    lastTick = now;
    beatView[0] = now;
  }, BEAT_INTERVAL_MS);
  // The heartbeat must never keep a shutting-down process alive.
  if (intervalRef.unref) intervalRef.unref();

  // ── Detector 2: hard freezes (watchdog worker) ────────────────────────
  try {
    workerRef = new Worker(WORKER_SCRIPT, {
      workerData: {
        sab,
        markerPath: freezeMarkerPath(dbPath),
        hardFreezeMs: HARD_FREEZE_MS,
        pid: process.pid,
      },
    });
    workerRef.on('error', (err) => {
      try { logError('main_thread.watch_worker', err, { phase: 'error' }); } catch { /* forensics must not throw */ }
    });
    // A hard freeze that recovers WITHOUT a restart: the worker marks the
    // marker recovered and pings us — log it live and archive the marker so
    // the next boot doesn't re-report it.
    workerRef.on('message', (msg) => {
      if (msg?.type !== 'recovered') return;
      const p = msg.payload || {};
      try {
        logError(
          'main_thread.freeze_recovered',
          new Error(`Main thread froze hard for ${p.frozen_for_ms ? Math.round(p.frozen_for_ms / 1000) : '?'}s and then recovered without a restart. Active during the freeze: ${p.active_operations || '(none recorded)'}`),
          p,
          'error',
        );
      } catch { /* forensics must not throw */ }
      try {
        const marker = freezeMarkerPath(dbPath);
        const stamp = (p.detected_at || new Date().toISOString()).replace(/[:.]/g, '-');
        if (existsSync(marker)) renameSync(marker, marker.replace(/\.json$/, `.${stamp}.archived.json`));
      } catch { /* boot check copes with a leftover recovered marker */ }
    });
    workerRef.unref(); // must not keep the process alive on shutdown
  } catch (err) {
    try { logError('main_thread.watch_worker', err, { phase: 'spawn' }); } catch { /* forensics must not throw */ }
  }
}

export function stopMainThreadWatch() {
  if (intervalRef) { clearInterval(intervalRef); intervalRef = null; }
  if (workerRef) { workerRef.terminate().catch(() => {}); workerRef = null; }
}

// ── Boot check: did the PREVIOUS run freeze hard? ────────────────────────
//
// Returns the parsed marker (or null). Logs a loud error_log entry and, when
// an alert engine hook is provided, fires a critical alert — the operator
// finds out what froze the moment the service comes back, instead of the
// hang evaporating into "it works again after a restart".
export function checkPreviousRunFreeze(dbPath, { fireAlert } = {}) {
  const marker = freezeMarkerPath(dbPath);
  if (!existsSync(marker)) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(marker, 'utf8'));
  } catch {
    parsed = { unparseable: true };
  }
  const frozenSecs = parsed?.frozen_for_ms ? Math.round(parsed.frozen_for_ms / 1000) : null;
  const ops = parsed?.active_operations || '(none recorded)';
  const opsText = typeof ops === 'string' ? ops : JSON.stringify(ops);
  // A marker WITH recovered_at means the freeze healed on its own and the
  // process later exited normally before archiving — report it as history,
  // not as the reason for this restart.
  const recovered = Boolean(parsed?.recovered_at);
  try {
    logError(
      'main_thread.freeze_previous_run',
      new Error(recovered
        ? `A previous run's main thread froze hard${frozenSecs ? ` for at least ${frozenSecs}s` : ''} and recovered on its own (${parsed.recovered_at}). Active during the freeze: ${opsText}`
        : `The previous run's main thread froze hard${frozenSecs ? ` for at least ${frozenSecs}s` : ''} and never recovered — the service was restarted to bring the app back. Active at the moment of the freeze: ${opsText}`),
      { ...parsed, marker_file: marker },
      recovered ? 'warn' : 'error',
    );
  } catch { /* still archive below */ }
  try {
    if (fireAlert && !recovered) {
      fireAlert({
        ruleName: 'main-thread-froze',
        severity: 'critical',
        message: `The app froze hard during the previous run (main thread blocked${frozenSecs ? ` ≥${frozenSecs}s` : ''}, restart required). It was running: ${opsText}. Detected ${parsed?.detected_at || 'unknown time'}.`,
        context: parsed,
        dedupKey: `main-thread-froze:${parsed?.detected_at || 'unknown'}`,
      });
    }
  } catch { /* alert engine unavailable — error_log entry above still lands */ }
  try {
    const stamp = (parsed?.detected_at || new Date().toISOString()).replace(/[:.]/g, '-');
    renameSync(marker, marker.replace(/\.json$/, `.${stamp}.archived.json`));
  } catch {
    // If archive fails we'd re-report on every boot — better than never.
  }
  return parsed;
}

// Test-only: write a marker the way the worker does, so the boot check can
// be exercised without spinning a real worker + waiting out a real freeze.
export function _writeFreezeMarkerForTest(dbPath, payload) {
  writeFileSync(freezeMarkerPath(dbPath), JSON.stringify(payload));
}
