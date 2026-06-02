import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export default function FilterToggle({ active, onClick, children, tooltip }) {
  const btn = (
    <button
      onClick={onClick}
      className={`min-h-[42px] rounded-xl border px-3 py-2 text-xs font-medium transition-colors ${
        active ? "border-amber-500 bg-amber-500/15 text-amber-400"
               : "border-border bg-card text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
  if (!tooltip) return btn;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
