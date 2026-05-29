// Standard page header: a display title, an optional subtitle, and an optional
// right-aligned actions slot. Gives pages a consistent top instead of each
// rolling its own h1. (The `eyebrow` prop is accepted but no longer rendered.)
export default function PageHeader({ title, subtitle, actions, className = "" }) {
  return (
    <div className={`mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-border pb-5 ${className}`}>
      <div className="min-w-0">
        <h1 className="font-display text-3xl leading-tight tracking-tight text-foreground lg:text-4xl">
          {title}
        </h1>
        {subtitle && <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
