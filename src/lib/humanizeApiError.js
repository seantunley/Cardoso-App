// Frontend toast helper. Operations on this app fall into a few
// network-shape buckets and operators see the same generic string for
// every one of them — "Failed: fetch failed" is not actionable. This
// helper standardises toast.error wording across the UI.
//
// Usage:
//   try { ... } catch (err) {
//     toast.error(humanizeApiError(err, "create connection"));
//   }
//
// Result strings look like:
//   "Couldn't create connection — server is offline (check Tailscale / network)"
//   "Couldn't create connection — the server returned HTTP 500"
//   "Couldn't create connection — Sage rejected the login"
//
// `op` is a verb phrase like "save invoice", "load reconciliation",
// "create connection". The helper prefixes it with "Couldn't " — so don't
// pass "Saving" or "Couldn't save", just "save".

/**
 * @param {{ message?: string } | null | undefined} err
 * @param {string} [op]
 */
export function humanizeApiError(err, op) {
  const verb = op ? `Couldn't ${op}` : "Request failed";

  // 1. Native fetch failure (no Response object reached us at all)
  //    err.message is "fetch failed" / "Failed to fetch" / "Network request failed".
  if (err && /^(fetch failed|Failed to fetch|Network request failed|TypeError: NetworkError)/i.test(err.message || "")) {
    return `${verb} — server is offline (check Tailscale / network)`;
  }

  // 2. Server returned a structured error (we extracted .error earlier)
  //    Use it verbatim if it's plausibly user-facing.
  const msg = err?.message ? String(err.message).trim() : "";

  // 3. HTTP status from a response we could parse but had no body for.
  //    Common shapes: "HTTP 500", "HTTP 401: Unauthorized".
  const httpMatch = msg.match(/^HTTP\s+(\d{3})\b(.*)/i);
  if (httpMatch) {
    const status = parseInt(httpMatch[1], 10);
    const tail = httpMatch[2].replace(/^[:\s-]+/, "");
    if (status === 401) return `${verb} — not signed in or session expired`;
    if (status === 403) return `${verb} — you don't have permission`;
    if (status === 404) return `${verb} — the server returned 404 (not found)`;
    if (status >= 500) return `${verb} — the server returned HTTP ${status}${tail ? `: ${tail}` : ""}`;
    return `${verb} — HTTP ${status}${tail ? `: ${tail}` : ""}`;
  }

  // 4. Empty / opaque error → ask the operator to retry.
  if (!msg) return `${verb} — unknown error (try again, then check the System Log)`;

  // 5. Otherwise, surface the message but with the verb prefix so the
  //    operator at least knows which action failed.
  return `${verb} — ${msg}`;
}
