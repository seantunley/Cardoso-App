// Single source of truth for how a backup status maps to the design system's
// semantic status tokens (--status-ok/warn/critical/stale, PR #509). The old
// Hub Backups page hand-rolled emerald-500/amber-500/red-500/slate-500 in a
// dozen places, which clashed with the walnut/phosphor Ledger theme and drifted
// out of sync. Everything on the page now routes through here.
//
// `tone` is the four-value vocabulary the tokens express; every raw backend
// status string collapses onto one of them via STATUS_TONE.

export const TONE = {
  ok: {
    dot: "bg-status-ok",
    text: "text-status-ok",
    chip: "border-status-ok/30 bg-status-ok/10 text-status-ok",
    ring: "ring-status-ok/30",
  },
  warn: {
    dot: "bg-status-warn",
    text: "text-status-warn",
    chip: "border-status-warn/30 bg-status-warn/10 text-status-warn",
    ring: "ring-status-warn/30",
  },
  critical: {
    dot: "bg-status-critical",
    text: "text-status-critical",
    chip: "border-status-critical/30 bg-status-critical/10 text-status-critical",
    ring: "ring-status-critical/30",
  },
  // "stale" token = the dim grey for unknown / not-applicable / offline — a
  // muted state, distinct from the red of an actual failure.
  muted: {
    dot: "bg-status-stale",
    text: "text-muted-foreground",
    chip: "border-border bg-muted/40 text-muted-foreground",
    ring: "ring-border",
  },
};

// Raw backend status → tone. Covers every vocabulary the three data sources
// speak: the live app poll (ok/warning/stale/never/error/unreachable/unknown),
// the SQL health (ok/stale/failed/unavailable), the hub-copy integrity
// (ok/corrupt), and the Kopia off-site verdict (ok/critical/never).
const STATUS_TONE = {
  ok: "ok",
  warning: "warn",
  overdue: "warn",
  unverified: "warn",
  stale: "critical",
  never: "critical",
  error: "critical",
  failed: "critical",
  corrupt: "critical",
  critical: "critical",
  unreachable: "muted",
  offline: "muted",
  unavailable: "muted",
  unknown: "muted",
  off: "muted",
  none: "critical",
};

export function toneFor(status) {
  return TONE[STATUS_TONE[status] || "muted"];
}

export function toneKey(status) {
  return STATUS_TONE[status] || "muted";
}

// Roll several layer statuses up to the worst one, for the fleet-table "Health"
// column. critical > warn > ok > muted(unknown). muted never outranks a real
// signal — a site that's ok on two layers and "unknown" on a third reads ok.
const TONE_RANK = { critical: 3, warn: 2, ok: 1, muted: 0 };
export function worstTone(statuses) {
  let worst = "muted";
  for (const s of statuses) {
    if (s == null) continue;
    const t = toneKey(s);
    if (TONE_RANK[t] > TONE_RANK[worst]) worst = t;
  }
  return worst;
}

export const OVERALL_LABEL = {
  ok: "Healthy",
  warn: "Overdue",
  critical: "Problem",
  muted: "Unknown",
};
