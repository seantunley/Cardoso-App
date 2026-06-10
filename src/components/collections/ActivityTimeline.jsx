import {
  CheckCircle2, AlertCircle, PhoneCall, FileText,
  ArrowDownCircle, ArrowRightCircle, CalendarClock, ClipboardList,
} from "lucide-react";
import { formatCurrency, timeAgo } from "./utils";

// ── Activity styling ─────────────────────────────────────────────
// Local to ActivityTimeline — no other extracted component renders
// activity rows, so the meta map stays in this file.
const ACTIVITY_META = {
  note:             { label: "Note",             Icon: FileText,        color: "text-muted-foreground" },
  contacted:        { label: "Contacted",        Icon: PhoneCall,       color: "text-sky-400" },
  promise_made:     { label: "Promise made",     Icon: CalendarClock,   color: "text-amber-400" },
  promise_kept:     { label: "Promise kept",     Icon: CheckCircle2,    color: "text-emerald-400" },
  promise_broken:   { label: "Promise broken",   Icon: AlertCircle,     color: "text-red-400" },
  payment_received: { label: "Payment received", Icon: ArrowDownCircle, color: "text-emerald-400" },
  status_changed:   { label: "Status changed",   Icon: ArrowRightCircle,color: "text-muted-foreground" },
};

export default function ActivityTimeline({ items }) {
  if (!items?.length) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        <ClipboardList className="h-6 w-6 mx-auto mb-2 opacity-60" />
        No activity logged yet. Use the buttons above to record a call, note, promise, or status change.
      </div>
    );
  }
  return (
    <ol className="space-y-2">
      {items.map((a) => {
        const meta = ACTIVITY_META[a.kind] || { label: a.kind, Icon: FileText, color: "text-muted-foreground" };
        const Icon = meta.Icon;
        return (
          <li key={a.id} className="flex gap-3 rounded-lg border border-border bg-card px-3 py-2">
            <div className={`mt-0.5 ${meta.color}`}>
              <Icon className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap text-xs">
                <span className="font-semibold text-foreground">{meta.label}</span>
                {a.amount != null && (
                  <span className="text-emerald-400 tabular-nums">R {formatCurrency(a.amount)}</span>
                )}
                {a.promise_date && (
                  <span className="text-amber-400">due {a.promise_date}</span>
                )}
                <span className="text-muted-foreground">· {timeAgo(a.at)}</span>
                {a.source === "sync" && (
                  <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">auto</span>
                )}
                <span className="ml-auto text-muted-subtle">
                  {a.user_name || a.user_email || (a.source === "sync" ? "system" : "")}
                </span>
              </div>
              {a.notes && <p className="mt-1 text-sm text-foreground leading-snug">{a.notes}</p>}
              {a.previous_balance != null && a.new_balance != null && (
                <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
                  R {formatCurrency(a.previous_balance)} → R {formatCurrency(a.new_balance)}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
