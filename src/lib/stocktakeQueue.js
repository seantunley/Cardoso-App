// The counter's outbox.
//
// Warehouses have dead spots. A scan that only exists in React state is lost
// the moment the phone sleeps, the browser reloads, or the counter walks
// behind the cold room — so every scan is written to localStorage first and
// sent afterwards. The server is the authority; this is just the outbox.
//
// Each scan carries a client_id generated here. The server ignores a repeat of
// one it has already stored, which is what makes retrying a batch safe: after
// a dropped connection we do not know whether the server got it, so we send it
// again and let the id settle it.

const KEY = 'stocktake.queue.v1';

/** A per-scan id. Two phones must never generate the same one. */
export function makeClientId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Read the outbox. Never throws: private browsing, cleared site data and
 * storage quotas all present as an exception here, and a counter losing the
 * screen because of it would be worse than losing the queue.
 *
 * @returns {any[]}
 */
export function loadQueue() {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** @param {any[]} queue */
export function saveQueue(queue) {
  try {
    localStorage.setItem(KEY, JSON.stringify(queue));
    return true;
  } catch {
    // Out of quota, or storage is blocked. The caller keeps the queue in
    // memory and must tell the counter that scans are not being saved across
    // a reload — silently pretending it worked is how counts go missing.
    return false;
  }
}

/**
 * Add a scan to the outbox.
 * @param {any[]} queue
 * @param {any} scan
 */
export function enqueue(queue, scan) {
  return [...queue, { ...scan, client_id: scan.client_id || makeClientId(), queued_at: new Date().toISOString() }];
}

/**
 * Take a scan back out before it has been sent. Used by "undo" — once a scan
 * has reached the server the undo has to go there instead, because another
 * device may already have seen it.
 *
 * @param {any[]} queue
 * @param {string} clientId
 */
export function dequeue(queue, clientId) {
  return queue.filter((s) => s.client_id !== clientId);
}

/** Only the scans belonging to one count and zone. */
export function pending(queue, sessionId, zoneId) {
  return queue.filter((s) => Number(s.session_id) === Number(sessionId) && Number(s.zone_id) === Number(zoneId));
}

/**
 * Remove everything the server has now accounted for.
 *
 * Accepted and duplicate both mean "the server has it" — a duplicate is the
 * normal outcome of a retry, not a problem. Rejected also leaves the queue,
 * because resending it would only be rejected again; the caller shows the
 * reasons so nothing disappears quietly.
 *
 * @param {any[]} queue
 * @param {{ accepted?: string[], duplicates?: string[], rejected?: {client_id: string|null}[] }} result
 */
export function applyResult(queue, result) {
  const done = new Set([
    ...(result?.accepted || []),
    ...(result?.duplicates || []),
    ...(result?.rejected || []).map((r) => r.client_id).filter(Boolean),
  ]);
  return queue.filter((s) => !done.has(s.client_id));
}
