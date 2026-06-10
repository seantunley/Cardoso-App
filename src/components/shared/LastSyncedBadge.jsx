// Standardized data-freshness pill: "● Synced 3h ago", amber once the data is
// older than its expected refresh cadence, red when it has never synced.
// Answers "is this number current?" at a glance on every data page, instead of
// each page hand-rolling its own "Last sync: <timestamp>" text (or showing
// nothing). Hover shows the raw stored timestamp.
//
// Timestamps come from SQLite's now_local() (SAST wall-clock, no TZ suffix) —
// parsed as local time, which is correct on the SAST-deployed sites; the raw
// string is always shown in the tooltip so an operator can verify.
import { useEffect, useState } from "react";

function ageMs(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Date.now() - t : null;
}

export function humanAge(ms) {
  if (ms == null) return null;
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

export default function LastSyncedBadge({
  iso,                    // last-synced timestamp (now_local() string or ISO)
  staleAfterHours = 26,   // nightly cadence + buffer, same convention as backup-verify
  label = "Synced",
  detail,                 // optional extra tooltip line, e.g. "Nightly at 04:30"
  className = "",
}) {
  // Re-render every 60s so the relative age stays honest while the page sits
  // open on an operator's second monitor.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const ms = ageMs(iso);
  const never = ms == null;
  const stale = !never && ms > staleAfterHours * 3_600_000;
  const tone = never
    ? "border-rose-500/40 bg-rose-500/10 text-rose-400"
    : stale
      ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-400";
  const dot = never ? "bg-rose-400" : stale ? "bg-amber-400" : "bg-emerald-400";
  const text = never ? "Never synced" : `${label} ${humanAge(ms)}${stale ? " — stale" : ""}`;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium whitespace-nowrap ${tone} ${className}`}
      title={[iso ? `Last synced: ${iso}` : "No successful sync recorded yet", detail].filter(Boolean).join("\n")}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
      {text}
    </span>
  );
}
