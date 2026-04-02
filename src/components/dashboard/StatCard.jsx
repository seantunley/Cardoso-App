import { cn } from "@/lib/utils";

export default function StatCard({ title, value, subtitle, icon: Icon, trend, color = "slate" }) {
  const colorClasses = {
    slate: "from-slate-500/10 to-slate-600/5 border-border",
    emerald: "from-emerald-500/10 to-emerald-600/5 border-border",
    amber: "from-amber-500/10 to-amber-600/5 border-border",
    rose: "from-rose-500/10 to-rose-600/5 border-border",
    blue: "from-blue-500/10 to-blue-600/5 border-border",
  };

  const iconColorClasses = {
    slate: "bg-slate-500/15 text-slate-400",
    emerald: "bg-emerald-500/15 text-emerald-400",
    amber: "bg-amber-500/15 text-amber-400",
    rose: "bg-rose-500/15 text-rose-400",
    blue: "bg-blue-500/15 text-blue-400",
  };

  return (
    <div className={cn(
      "relative overflow-hidden rounded-2xl border bg-gradient-to-br p-6 transition-all duration-300 hover:shadow-lg hover:-translate-y-0.5",
      colorClasses[color]
    )}>
      <div className="flex items-start justify-between">
        <div className="space-y-3">
          <p className="text-sm font-medium text-muted-foreground tracking-wide uppercase">
            {title}
          </p>
          <p className="text-4xl font-bold text-foreground tracking-tight">
            {value}
          </p>
          {subtitle && (
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          )}
          {trend && (
            <div className={cn(
              "inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full",
              trend > 0 ? "bg-emerald-500/15 text-emerald-400" : "bg-rose-500/15 text-rose-400"
            )}>
              {trend > 0 ? "↑" : "↓"} {Math.abs(trend)}%
            </div>
          )}
        </div>
        {Icon && (
          <div className={cn("p-3 rounded-xl", iconColorClasses[color])}>
            <Icon className="w-6 h-6" />
          </div>
        )}
      </div>
    </div>
  );
}
