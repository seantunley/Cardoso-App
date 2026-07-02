// HealthStrip — the always-visible "is anything wrong?" row in the sidebar.
//
// Design rule it exists to enforce: never show INTENT (next run) more
// prominently than OUTCOME (did the thing actually happen). The schedule
// panel shows what will run; the bell shows a single anonymous dot; this
// strip names WHICH subsystem is unhappy, at a glance, on every screen:
//
//   Sage · Syncs · Backup · Alerts
//
// Pure derivation of /api/system/sage-health via the shared useSageHealth
// hook (same query key as NotificationsBell/SageHealthPanel → one request,
// one cache, no second opinion). No health logic lives here: the endpoint
// computes truth; the strip only maps it to a dot.
//
// Segments whose data is absent hide themselves — on the hub install the
// endpoint returns no sources/backup and a never-probed sage, so the strip
// collapses to Alerts (hub-wide health lives on HubMetrics/HubBackups).
//
// Colors are FIXED bright values, not the theme status tokens: the sidebar
// is always dark (see --sidebar-* in index.css), so the light theme's dim
// 40%-lightness ok-green would vanish here exactly like sidebar text would.
import { useNavigate } from "react-router-dom";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSageHealth } from "@/lib/useSageHealth";
import { cn } from "@/lib/utils";

const TONE_COLOR = {
  ok: "hsl(145 65% 55%)",
  warn: "hsl(50 95% 58%)",
  critical: "hsl(0 88% 62%)",
  unknown: "hsl(30 10% 58%)",
};

const fmtAge = (h) => (h == null ? "never" : h < 1 ? `${Math.round(h * 60)}m ago` : h < 48 ? `${h.toFixed(1)}h ago` : `${Math.round(h / 24)}d ago`);

// Each builder returns { tone, detail } or null to hide the segment.
function segSage(data) {
  const sage = data?.sage;
  if (!sage || sage.ok === null) return null; // never probed (hub / no Sage configured)
  if (sage.ok === false) {
    const mins = sage.downForMinutes ?? 0;
    return {
      tone: mins > 5 ? "critical" : "warn",
      detail: `Sage MSSQL unreachable for ${mins} min. ${sage.lastError || ""}`.trim(),
    };
  }
  return { tone: "ok", detail: "Sage MSSQL connection is healthy." };
}

function segSyncs(data) {
  const sources = data?.sources || [];
  if (sources.length === 0) return null; // hub — nightly syncs don't run here
  const stale = sources.filter((s) => s.stale);
  if (stale.length) {
    return {
      tone: "warn",
      detail: `Stale: ${stale.map((s) => `${s.label} (${fmtAge(s.age_hours)})`).join(", ")}. Reports reading this data may be out of date.`,
    };
  }
  return {
    tone: "ok",
    detail: sources.map((s) => `${s.label} ${fmtAge(s.age_hours)}`).join(" · "),
  };
}

function segBackup(data) {
  const b = data?.backup;
  if (!b) return null; // hub — no local backups
  if (b.status === "critical") return { tone: "critical", detail: b.message || "Backup problem." };
  if (b.status === "warn") return { tone: "warn", detail: b.message || "Latest backup is unverified." };
  return { tone: "ok", detail: b.message || "Backup is current." };
}

function segAlerts(data) {
  if (!data) return null;
  const critical = data.criticalAlerts ?? 0;
  const active = data.activeAlerts ?? 0;
  if (critical > 0) return { tone: "critical", detail: `${critical} critical alert${critical === 1 ? "" : "s"} active — open Operations for details.` };
  if (active > 0) return { tone: "warn", detail: `${active} active alert${active === 1 ? "" : "s"} — open Operations for details.` };
  return { tone: "ok", detail: "No active alerts." };
}

const SEGMENTS = [
  { key: "sage", label: "Sage", build: segSage },
  { key: "syncs", label: "Syncs", build: segSyncs },
  { key: "backup", label: "Backup", build: segBackup },
  { key: "alerts", label: "Alerts", build: segAlerts },
];

export default function HealthStrip({ collapsed, isAdmin }) {
  const navigate = useNavigate();
  const { data } = useSageHealth();

  const segments = SEGMENTS
    .map((s) => ({ ...s, state: s.build(data) }))
    .filter((s) => s.state);

  // Nothing derivable yet (first load, or endpoint erroring — the bell and
  // Operations surface fetch errors; a wrongly-green strip would be worse
  // than none).
  if (segments.length === 0) return null;

  // Admins can jump to Operations for the full picture; for everyone else
  // the strip is informational (the tooltip carries the detail).
  const onSegmentClick = isAdmin ? () => navigate("/Operations") : undefined;

  return (
    <div
      className={cn(
        "border-t",
        collapsed ? "px-1 py-2 flex flex-col items-center gap-2" : "px-3 py-2 flex items-center justify-between gap-1",
      )}
      style={{ borderColor: "hsl(var(--sidebar-border))" }}
      aria-label="System health"
    >
      {segments.map((s) => (
        <Tooltip key={s.key}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onSegmentClick}
              aria-label={`${s.label}: ${s.state.tone}`}
              className={cn(
                "flex items-center gap-1.5 rounded px-1 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--phosphor)]",
                onSegmentClick ? "cursor-pointer hover:bg-[hsl(var(--sidebar-accent))]" : "cursor-default",
              )}
            >
              <span
                className={cn("h-2 w-2 rounded-full shrink-0", s.state.tone === "critical" && "animate-pulse")}
                style={{ background: TONE_COLOR[s.state.tone] }}
              />
              {!collapsed && (
                <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-[hsla(var(--sidebar-foreground),0.65)]">
                  {s.label}
                </span>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side={collapsed ? "right" : "top"} className="max-w-[280px]">
            <p className="text-xs">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em]">{s.label}</span>
              {" — "}{s.state.detail}
              {isAdmin ? " Click to open Operations." : ""}
            </p>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
