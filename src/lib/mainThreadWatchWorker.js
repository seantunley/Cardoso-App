// Watchdog worker for main-thread freeze forensics (see mainThreadWatch.js).
//
// Runs on its own thread with its own event loop, so it keeps ticking while
// the main thread is wedged. Reads the heartbeat + active-operation names
// from the SharedArrayBuffer; when the beat goes stale past hardFreezeMs it
// writes/updates a freeze-marker JSON next to the database. The main thread
// can't write that file itself — it's frozen; that's the whole point.
//
// The marker survives the service restart; checkPreviousRunFreeze() reads it
// on the next boot and turns it into an error_log entry + critical alert.
import { workerData, parentPort } from 'worker_threads';
import { writeFileSync } from 'fs';

const { sab, markerPath, hardFreezeMs, pid } = workerData;
const beatView = new Float64Array(sab, 0, 1);
const opsView = new Uint8Array(sab, 8);

const CHECK_INTERVAL_MS = 1_000;
let freezeStartBeat = null;
let lastPayload = null;

function readOps() {
  const end = opsView.indexOf(0);
  const slice = opsView.subarray(0, end === -1 ? opsView.length : end);
  const text = Buffer.from(slice).toString('utf8').trim();
  return text || '(none registered — blocker not yet instrumented with trackOp)';
}

setInterval(() => {
  const lastBeat = beatView[0];
  if (!lastBeat) return; // main thread hasn't started beating yet
  const staleMs = Date.now() - lastBeat;

  if (staleMs >= hardFreezeMs) {
    if (freezeStartBeat === null) freezeStartBeat = lastBeat;
    const payload = {
      detected_at: new Date(freezeStartBeat + hardFreezeMs).toISOString(),
      last_heartbeat_at: new Date(lastBeat).toISOString(),
      frozen_for_ms: staleMs,
      active_operations: readOps(),
      pid,
      note: 'Main thread heartbeat stopped — event loop blocked. Written by the watchdog worker while the app was frozen.',
    };
    lastPayload = payload;
    try {
      writeFileSync(markerPath, JSON.stringify(payload, null, 2));
    } catch { /* disk trouble — retry next tick */ }
    // Also shout to stderr — on service installs this lands in the
    // service's captured log, giving a second, timestamped trail.
    console.error(`[main-thread-watch] MAIN THREAD FROZEN for ${(staleMs / 1000).toFixed(0)}s — active: ${payload.active_operations}`);
  } else if (freezeStartBeat !== null) {
    // Recovered without a restart after all — a very long stall, not a
    // wedge. Mark the marker as recovered (so a later boot never reports
    // "restart required" for it) and tell the now-alive main thread, which
    // logs the episode and archives the marker immediately.
    freezeStartBeat = null;
    const recovered = { ...(lastPayload || {}), recovered_at: new Date().toISOString() };
    try { writeFileSync(markerPath, JSON.stringify(recovered, null, 2)); } catch { /* boot check still copes */ }
    try { parentPort?.postMessage({ type: 'recovered', payload: recovered }); } catch { /* main thread logger is best-effort */ }
  }
}, CHECK_INTERVAL_MS);
