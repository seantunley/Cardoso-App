// Shared metadata for Collections — assignment status pill styling is
// referenced by both CustomerDrawer (right panel) and the assignment
// list rendered in the Collections page itself, so it lives here rather
// than inside either component.

export const ASSIGNMENT_STATUS_META = {
  active:      { label: "Active",       cls: "border-amber-500/40 bg-amber-500/15 text-amber-300" },
  collected:   { label: "Collected",    cls: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300" },
  escalated:   { label: "Escalated",    cls: "border-red-500/40 bg-red-500/15 text-red-300" },
  written_off: { label: "Written off",  cls: "border-slate-500/40 bg-slate-500/15 text-slate-300" },
  closed:      { label: "Closed",       cls: "border-slate-500/40 bg-slate-500/15 text-slate-300" },
};
