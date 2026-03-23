import { cn } from "@/lib/utils";

export default function StatCard({ title, value, subtitle, icon: Icon, trend, color = "slate" }) {
  const colorClasses = {
    slate: "from-slate-500/10 to-slate-600/5 border-slate-200/50",
    emerald: "from-emerald-500/10 to-emerald-600/5 border-emerald-200/50",
    amber: "from-amber-500/10 to-amber-600/5 border-amber-200/50",
    rose: "from-rose-500/10 to-rose-600/5 border-rose-200/50",
    blue: "from-blue-500/10 to-blue-600/5 border-blue-200/50",
  };

  const iconColorClasses = {
    slate: "bg-slate-100 text-slate-600",
    emerald: "bg-emerald-100 text-emerald-600",
    amber: "bg-amber-100 text-amber-600",
    rose: "bg-rose-100 text-rose-600",
    blue: "bg-blue-100 text-blue-600",
  };

  return (
    <div className={cn(
      "relative overflow-hidden rounded-2xl border bg-gradient-to-br p-6 transition-all duration-300 hover:shadow-lg hover:-translate-y-0.5",
      colorClasses[color]
    )}>
      <div className="flex items-start justify-between">
        <div className="space-y-3">
          <p className="text-sm font-medium text-slate-500 tracking-wide uppercase">
            {title}
          </p>
          <p className="text-4xl font-bold text-slate-900 tracking-tight">
            {value}
          </p>
          {subtitle && (
            <p className="text-sm text-slate-500">{subtitle}</p>
          )}
          {trend && (
            <div className={cn(
              "inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full",
              trend > 0 ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"
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