// SessionExpiryWatcher — shows a warning popup before the user's session
// cookie expires, with options to extend or log out. Mounted once at the
// top of the app inside the AuthProvider.
//
// How it works:
//   - reads `session_expires_at` from the auth user (set by /api/auth/login
//     and /api/auth/me as an ISO timestamp).
//   - ticks every 15s, computing remaining seconds until that timestamp.
//   - when remaining drops below WARN_AT_SEC (5 min by default) and we're
//     not already showing the dialog, the dialog opens with a live
//     countdown.
//   - "Continue" → POST /api/auth/extend-session → server bumps the cookie
//     maxAge → response carries the new expires_at, which we pass to
//     refreshUser() to refresh the cached value.
//   - "Logout" → useAuth().logout() (existing flow, redirects to /login).
//   - if remaining hits 0 with the dialog open, force-logout. This is the
//     only auto-action — we don't auto-logout *without* having warned.
//
// rolling: false in server.js means the cookie expiry is fixed at login,
// so without this UI an actively-using operator would be silently logged
// out at the 12-hour mark.

import { useEffect, useState, useCallback, useRef } from "react";
import { useAuth } from "@/lib/AuthContext";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Clock, AlertTriangle } from "lucide-react";

// Show the warning dialog when this many seconds (or fewer) remain.
const WARN_AT_SEC = 5 * 60;
// How often to recheck remaining time. 15s gives sub-warn-window precision
// without being noisy.
const TICK_MS = 15_000;

function formatRemaining(seconds) {
  if (seconds <= 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function SessionExpiryWatcher() {
  const { user, isAuthenticated, logout, refreshUser } = useAuth();
  const [remaining, setRemaining] = useState(null);
  const [open, setOpen] = useState(false);
  const [extending, setExtending] = useState(false);
  const [extendError, setExtendError] = useState(null);
  // Track whether we've already auto-logged-out so we don't loop.
  const loggedOutRef = useRef(false);

  // Compute remaining seconds from the cached expiry. Single source of
  // truth — the dialog's countdown reads this same value, so the timer
  // never drifts from the warn-decision logic.
  useEffect(() => {
    if (!isAuthenticated || !user?.session_expires_at) {
      setRemaining(null);
      setOpen(false);
      loggedOutRef.current = false;
      return undefined;
    }

    const compute = () => {
      const expiresMs = new Date(user.session_expires_at).getTime();
      if (!Number.isFinite(expiresMs)) return null;
      return Math.max(0, Math.floor((expiresMs - Date.now()) / 1000));
    };

    // Run an immediate compute so the dialog opens promptly after login
    // if we're already inside the warn window (e.g. very short session
    // for testing, or an extended page that came from a previous tab).
    setRemaining(compute());

    // While the dialog is open, tick every second so the countdown is
    // smooth. Outside the dialog, tick on the slower TICK_MS interval —
    // we only need to know "are we inside the warn window yet".
    const intervalMs = 1000; // we always tick at 1s now that the dialog
                             // opens whenever inside the warn window;
                             // saving battery on a closed tab is the
                             // browser's job, not ours.
    const id = setInterval(() => {
      const r = compute();
      setRemaining(r);
    }, intervalMs);
    return () => clearInterval(id);
  }, [isAuthenticated, user?.session_expires_at]);

  // Open / auto-logout decisions react to remaining changes.
  useEffect(() => {
    if (remaining == null) return;
    if (remaining <= 0 && isAuthenticated && !loggedOutRef.current) {
      // Session has expired. The cookie itself is invalid at this point,
      // so any in-flight requests would 401 anyway — calling logout()
      // gives a clean redirect to /login with the "session expired"
      // message rather than a silent 401 storm.
      loggedOutRef.current = true;
      setOpen(false);
      logout(true);
      return;
    }
    if (remaining <= WARN_AT_SEC && !open && isAuthenticated) {
      setOpen(true);
    }
    // Don't auto-close once opened; the operator must take an action.
  }, [remaining, isAuthenticated, open, logout]);

  const handleExtend = useCallback(async () => {
    setExtending(true);
    setExtendError(null);
    try {
      const r = await fetch('/api/auth/extend-session', {
        method: 'POST',
        credentials: 'include',
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Failed to extend session');
      // refreshUser pulls /api/auth/me which now carries the new
      // session_expires_at. Could also use d.session_expires_at directly,
      // but going through refreshUser keeps AuthContext as the single
      // source of truth and lets future server-side changes (rotated
      // claims etc.) propagate without touching this component.
      await refreshUser();
      setOpen(false);
    } catch (err) {
      setExtendError(err.message || 'Failed to extend session');
    } finally {
      setExtending(false);
    }
  }, [refreshUser]);

  const handleLogout = useCallback(() => {
    setOpen(false);
    logout(true);
  }, [logout]);

  if (!isAuthenticated || !user?.session_expires_at) return null;

  return (
    <AlertDialog open={open} onOpenChange={(v) => {
      // Don't allow ESC / overlay-click to dismiss — the operator needs to
      // make a deliberate choice. Only the action buttons close the dialog.
      if (!v && remaining > 0) return;
      setOpen(v);
    }}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-500" />
            Your session is about to expire
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-3">
            <span className="block">
              For security, you'll be signed out automatically when the timer below reaches zero.
            </span>
            <span className="flex items-center justify-center gap-2 py-3 text-3xl font-mono tabular-nums">
              <Clock className="w-6 h-6 text-amber-500" />
              <span className={remaining <= 60 ? 'text-rose-400' : 'text-foreground'}>
                {formatRemaining(remaining ?? 0)}
              </span>
            </span>
            <span className="block text-xs text-muted-foreground">
              Click <strong>Stay signed in</strong> to continue working, or <strong>Log out</strong> to end your session now.
            </span>
            {extendError && (
              <span className="block text-xs text-rose-400 pt-1">{extendError}</span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleLogout} disabled={extending}>
            Log out
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleExtend} disabled={extending}>
            {extending ? 'Extending…' : 'Stay signed in'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
