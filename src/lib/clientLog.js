// Send a client-side error to the server's errors.log.
// Use alongside toast.error so the user sees the failure AND we capture it for review.
export function reportClientError(scope, err, meta) {
  try {
    const message = err?.message || String(err || 'unknown error');
    const stack = err?.stack ? String(err.stack) : undefined;
    fetch('/api/log/client-error', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, message, stack, meta }),
      keepalive: true,
    }).catch(() => {});
  } catch {}
}
