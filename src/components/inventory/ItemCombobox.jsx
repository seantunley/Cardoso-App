import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, Loader2, Package } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandItem, CommandGroup } from "@/components/ui/command";

// Server-driven item picker (combobox) for the stock card. Built on the shared
// shadcn Command (cmdk) + Popover so it gets keyboard navigation, focus
// management and a11y roles for free — the old hand-rolled absolute dropdown
// had none of that. cmdk's own client-side filter is OFF (shouldFilter=false):
// the server already filters by the query, and letting cmdk re-filter against
// the option value would hide valid server results.

const fmtQty = (v) => {
  if (v == null) return "—";
  const n = Math.round(Number(v) * 1000) / 1000;
  return n.toLocaleString("en-ZA", { maximumFractionDigits: 3 });
};

export default function ItemCombobox({ id, value, onChange, fetchItems }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  // One request per typing pause, not per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 200);
    return () => clearTimeout(t);
  }, [search]);

  const q = useQuery({
    queryKey: ["inv-movement-items", debounced],
    queryFn: () => fetchItems(debounced),
    enabled: open && debounced.length >= 1,
    staleTime: 30_000,
    placeholderData: (prev) => prev, // keep the last results visible while the next load runs — no flash to empty
  });
  const rows = q.data?.rows || [];

  const pick = (r) => { onChange(r); setOpen(false); setSearch(""); };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch(""); }}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          aria-expanded={open}
          aria-haspopup="listbox"
          className="flex h-10 w-full items-center justify-between gap-2 rounded-xl border border-border bg-background px-3 text-sm text-foreground transition-colors hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Package className="h-4 w-4 shrink-0 text-muted-foreground" />
            {value ? (
              <span className="truncate">
                <span className="font-mono text-foreground">{value.item_number}</span>
                <span className="ml-2 text-muted-foreground">{value.item_description || "—"}</span>
                <span className="ml-2 text-muted-subtle">· {value.location}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">Search item number or description…</span>
            )}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command shouldFilter={false}>
          <CommandInput value={search} onValueChange={setSearch} placeholder="Type to search items…" />
          <CommandList>
            {debounced.length < 1 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">Type an item number or description to search.</div>
            ) : q.isFetching && rows.length === 0 ? (
              <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Searching…
              </div>
            ) : rows.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">No items match “{debounced}”.</div>
            ) : (
              <CommandGroup>
                {rows.map((r) => {
                  const key = `${r.item_number}/${r.location}`;
                  const selected = value && value.item_number === r.item_number && value.location === r.location;
                  return (
                    <CommandItem key={key} value={key} onSelect={() => pick(r)} className="flex items-center justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-2">
                        <Check className={cn("h-4 w-4 shrink-0", selected ? "opacity-100" : "opacity-0")} />
                        <span className="min-w-0 truncate">
                          <span className="font-mono text-xs text-foreground">{r.item_number}</span>
                          <span className="ml-2 text-xs text-muted-foreground">{r.item_description || "—"}</span>
                        </span>
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{r.location} · on hand {fmtQty(r.qty_on_hand)}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
