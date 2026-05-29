// Saved report views — persists the current report + filter query string to
// localStorage so an operator can pin frequently-used filtered views (e.g.
// "Aged debtors · 21+ days · Rep X") and jump back with one click. Pairs with
// the URL-persisted report filters; the whole view is just the query string.
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Star, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

const KEY = "cardoso.savedReportViews";
const load = () => {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch { return []; }
};
const persist = (list) => {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { toast.error(`Couldn't save view: ${e.message}`); }
};

export default function SavedViews() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [views, setViews] = useState(load);

  const saveCurrent = () => {
    const name = window.prompt("Name this view:")?.trim();
    if (!name) return;
    const search = searchParams.toString();
    const next = [...views.filter((v) => v.name !== name), { name, search }].sort((a, b) => a.name.localeCompare(b.name));
    setViews(next); persist(next);
    toast.success(`Saved view "${name}"`);
  };
  const apply = (v) => setSearchParams(new URLSearchParams(v.search));
  const remove = (name) => {
    const next = views.filter((v) => v.name !== name);
    setViews(next); persist(next);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Save the current report and filters as a named view, or jump back to a saved one"
          className="inline-flex items-center gap-1.5 rounded-[12px] border border-border px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
        >
          <Star className="h-3.5 w-3.5" /> Saved views
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem onClick={saveCurrent}>
          <Plus className="mr-2 h-4 w-4" /> Save current view
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[10px]">Saved</DropdownMenuLabel>
        {views.length === 0 ? (
          <DropdownMenuItem disabled>No saved views yet</DropdownMenuItem>
        ) : (
          views.map((v) => (
            <DropdownMenuItem key={v.name} onClick={() => apply(v)} className="justify-between gap-2">
              <span className="truncate">{v.name}</span>
              <Trash2
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground hover:text-red-500"
                onClick={(e) => { e.stopPropagation(); remove(v.name); }}
              />
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
