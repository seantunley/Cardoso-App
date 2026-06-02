import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const AGE_BUCKETS = [
  { value: "all",   label: "All" },
  { value: "7-13",  label: "7–13 days" },
  { value: "14-20", label: "14–20 days" },
  { value: "21+",   label: "21+ days" },
];

export const AGE_BUCKET_TOOLTIPS = {
  all:     "Show all customers with outstanding balances",
  "7-13":  "Customer has at least one unpaid invoice that's 7–13 days old",
  "14-20": "Customer has at least one unpaid invoice that's 14–20 days old",
  "21+":   "Customer has at least one unpaid invoice that's 21 or more days old",
};

export default function AgeBucketPill({ active, onClick, children, value }) {
  const btn = (
    <button
      type="button"
      onClick={onClick}
      className={`min-h-[40px] rounded-full border px-3.5 py-2 text-xs font-semibold transition-all ${
        active
          ? "border-amber-500 bg-amber-500 text-black shadow-[0_0_0_1px_rgba(245,158,11,0.2)]"
          : "border-border bg-background text-muted-foreground hover:border-amber-500/40 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
  const tip = AGE_BUCKET_TOOLTIPS[value];
  if (!tip) return btn;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}
