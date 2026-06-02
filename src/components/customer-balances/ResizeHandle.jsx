import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export default function ResizeHandle({ id, startResize, resetColumn }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          onMouseDown={startResize(id)}
          onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); resetColumn(id); }}
          className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-accent/50 active:bg-accent z-30"
          style={{ touchAction: "none" }}
        />
      </TooltipTrigger>
      <TooltipContent side="right">Drag to resize · double-click to reset</TooltipContent>
    </Tooltip>
  );
}
