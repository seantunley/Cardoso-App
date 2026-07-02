// Global command palette (Ctrl/Cmd-K) — fuzzy "jump to anything" launcher.
// Mounted by Layout, which passes the already-permission-filtered nav items so
// the palette never offers a destination the user can't open. Built on the
// shared cmdk primitive (src/components/ui/command.jsx).
//
// Besides page navigation (`items`), Layout can pass `sections` — extra
// command groups (quick actions, settings-tab deep links) where each item
// carries its own `run` closure. The palette stays dumb: it renders what it's
// given and closes; all gating and behaviour live with the caller.
import { useEffect, useMemo } from "react";
import {
  CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem,
} from "@/components/ui/command";

export default function CommandPalette({ open, onOpenChange, items, onSelect, sections = [] }) {
  // Cmd/Ctrl-K toggles the palette anywhere in the app. Ignored while typing
  // in an input/textarea/contenteditable so it doesn't hijack those.
  useEffect(() => {
    const onKey = (e) => {
      // Plain Ctrl/Cmd+K only — Ctrl+Shift+K belongs to the easter-egg console
      // (CardosoEasterEgg.jsx); without the shift guard both opened at once.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && (e.key === "k" || e.key === "K")) {
        const t = e.target;
        const tag = t?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  // Group nav items by their sidebar group for a familiar structure.
  const grouped = useMemo(() => {
    const map = new Map();
    for (const it of items || []) {
      const g = it.group || "Other";
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(it);
    }
    return [...map.entries()];
  }, [items]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Jump to a page, setting, or action…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        {/* Caller-supplied sections first: quick actions + settings deep
            links are what the operator reaches for most once they know the
            pages — and page names still win the fuzzy match when typed. */}
        {sections.map((sec) => (
          <CommandGroup key={sec.heading} heading={sec.heading}>
            {sec.items.map((it) => (
              <CommandItem
                key={it.id}
                value={`${it.name} ${it.keywords || ""}`}
                onSelect={() => { it.run(); onOpenChange(false); }}
              >
                {it.icon && <it.icon className="mr-2 h-4 w-4" />}
                <span>{it.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">{sec.heading}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
        {grouped.map(([group, groupItems]) => (
          <CommandGroup key={group} heading={group}>
            {groupItems.map((it) => (
              <CommandItem
                key={`${group}:${it.page}:${it.name}`}
                value={`${it.name} ${group}`}
                onSelect={() => { onSelect(it); onOpenChange(false); }}
              >
                {it.icon && <it.icon className="mr-2 h-4 w-4" />}
                <span>{it.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">{group}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
