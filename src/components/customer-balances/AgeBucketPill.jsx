import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const AGE_BUCKETS = [
  { value: "all",     label: "All" },
  { value: "1-7",     label: "1–7 days" },
  { value: "8-14",    label: "8–14 days" },
  { value: "15-21",   label: "15–21 days" },
  { value: "over-21", label: "Over 21 days" },
];

export const AGE_BUCKET_TOOLTIPS = {
  all:       "Show all customers with outstanding balances",
  "1-7":     "Customer has at least one open document aged 1–7 days (Sage aging, by document date)",
  "8-14":    "Customer has at least one open document aged 8–14 days",
  "15-21":   "Customer has at least one open document aged 15–21 days",
  "over-21": "Customer has at least one open document aged over 21 days",
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
