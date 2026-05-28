import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const FLAG_DOT = {
  red: "bg-red-500", orange: "bg-orange-400", yellow: "bg-yellow-400",
  green: "bg-green-500", blue: "bg-blue-500", purple: "bg-purple-500",
  pink: "bg-pink-400", gray: "bg-gray-400",
};

export default function FlagDot({ color, reason }) {
  // Reserve the dot's slot even when there's no flag, so every row in
  // the table has the STANDARD/NATIONAL/etc. pill starting at the same
  // x-position. Without this placeholder the flex container collapses
  // and the pill shifts left into the dot's would-be slot, breaking
  // alignment across the column. (Operator-reported: badges visually
  // jumped between rows depending on whether the row had a flag.)
  if (!color || color === "none") {
    return <span className="inline-block h-2.5 w-2.5 flex-shrink-0" aria-hidden="true" />;
  }
  const cls = FLAG_DOT[color] || "bg-gray-400";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`inline-block h-2.5 w-2.5 rounded-full flex-shrink-0 cursor-default ${cls}`} />
      </TooltipTrigger>
      <TooltipContent>{reason ? `${color} flag: ${reason}` : `${color} flag`}</TooltipContent>
    </Tooltip>
  );
}
