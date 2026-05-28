// Shared API + formatting helpers for the Collections page and its
// extracted components. The page-level Collections.jsx, CustomerDrawer,
// NewWorklistDialog, AssignCustomersDialog, and ActivityTimeline all
// touch one or more of these — keeping them in a single module avoids
// duplicating fetch/parse code per component.

export async function apiGet(url) {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

export async function apiSend(url, method, body) {
  const r = await fetch(url, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

export function parseAmount(value) {
  const n = parseFloat(String(value ?? "").replace(/,/g, "").replace(/\s/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function formatCurrency(value) {
  const n = parseAmount(value);
  return n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function timeAgo(iso) {
  if (!iso) return "";
  // SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" without a
  // timezone marker. JS's lax Date parser treats that as LOCAL time,
  // but it's actually UTC — without normalising, "just now" events
  // show "2h ago" for a SAST user (UTC+2). Append Z when missing.
  const normalised = /[+\-Z]\d{2}|Z$/.test(iso) ? iso : iso.replace(" ", "T") + "Z";
  const t = new Date(normalised).getTime();
  if (Number.isNaN(t)) return "";
  const ms = Date.now() - t;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toLocaleDateString("en-ZA");
}
