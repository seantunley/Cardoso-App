import { cn } from "@/lib/utils";

/**
 * Ledger-style stat card.
 * Sharp edges, monospace label, display-serif value, optional phosphor accent bar.
 * The `color` prop maps to accent direction: slate (neutral), emerald (good),
 * amber (attention / signature phosphor), rose (danger), blue (info).
 */
export default function StatCard({ title, value, subtitle, icon: Icon, trend, color = "slate" }) {
  const accentBar = {
    slate:   "hsl(30 10% 42%)",
    emerald: "hsl(145 55% 45%)",
    amber:   "var(--phosphor)",
    rose:    "hsl(var(--destructive))",
    blue:    "hsl(210 70% 50%)",
  }[color] || "hsl(var(--border))";

  const accentGlow = {
    slate:   "transparent",
    emerald: "hsla(145, 55%, 45%, 0.25)",
    amber:   "hsla(33, 95%, 55%, 0.35)",
    rose:    "hsla(0, 72%, 50%, 0.3)",
    blue:    "hsla(210, 70%, 50%, 0.25)",
  }[color] || "transparent";

  return (
    <div
      className="relative overflow-hidden bg-card border border-border group transition-colors hover:border-[var(--phosphor)]"
      style={{ borderRadius: "12px" }}
    >
      {/* Phosphor left accent — the signature element */}
      <div
        className="absolute left-0 top-0 bottom-0 w-[2px] transition-all"
        style={{ background: accentBar, boxShadow: `0 0 12px ${accentGlow}` }}
      />

      <div className="p-6 pl-7 flex items-start justify-between gap-4">
        <div className="space-y-3 min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground truncate">
              {title}
            </p>
            {trend != null && (
              <span
                className={cn(
                  "font-mono text-[10px] tabular-nums",
                  trend > 0 ? "text-[hsl(145_55%_45%)]" : "text-destructive"
                )}
              >
                {trend > 0 ? "▲" : "▼"}{Math.abs(trend)}%
              </span>
            )}
          </div>

          <p className="font-display text-5xl leading-none text-foreground tracking-tight tabular-nums">
            {value}
          </p>

          {subtitle && (
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          )}
        </div>

        {Icon && (
          <Icon
            className="w-4 h-4 shrink-0 text-muted-foreground/60 group-hover:text-[var(--phosphor)] transition-colors"
            strokeWidth={1.5}
          />
        )}
      </div>
    </div>
  );
}
