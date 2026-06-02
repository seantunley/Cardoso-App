// Shared empty-state block: centred icon + title + optional message and
// action. Standardises the "no data" look across pages so each table/list
// doesn't hand-roll its own. Pass a lucide icon component as `icon`.
export default function EmptyState({ icon: Icon, title, message, action, className = "" }) {
  return (
    <div className={`flex flex-col items-center justify-center rounded-xl border border-border bg-card px-6 py-12 text-center ${className}`}>
      {Icon && <Icon className="mb-3 h-10 w-10 text-muted-foreground" aria-hidden="true" />}
      {title && <h3 className="text-sm font-medium text-foreground">{title}</h3>}
      {message && <p className="mt-1 max-w-md text-sm text-muted-foreground">{message}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
