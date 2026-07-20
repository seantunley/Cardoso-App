// HelpNav — the left column of the Help Centre. Two modes:
//   • empty search  → categories (with articles) as grouped links.
//   • typed search  → a flat, relevance-ranked result list.
// The active article (from the ?article query param) is highlighted. Long
// titles WRAP — never truncate — because a clipped help title reads as broken.

import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Search, X } from "lucide-react";
import { categoriesWithArticles, searchArticles } from "@/lib/help/content.js";
import { helpIcon } from "./helpIcons.js";

/** Build the /Help link that selects an article. */
const articleTo = (slug) => `/Help?article=${encodeURIComponent(slug)}`;

/**
 * @param {{ activeSlug?: string | null }} props
 */
export default function HelpNav({ activeSlug = null }) {
  const [, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");
  const trimmed = query.trim();

  const groups = useMemo(() => categoriesWithArticles(), []);
  const results = useMemo(() => (trimmed ? searchArticles(trimmed) : []), [trimmed]);

  // Clicking a result/link updates the query param; keep it a real <Link> so
  // deep-linking and browser back/forward work, but selecting the "Help home"
  // clears the param.
  const linkClass = (slug) =>
    [
      "block rounded-md px-2.5 py-1.5 text-sm leading-snug transition-colors",
      // wrap, don't truncate
      "whitespace-normal break-words",
      activeSlug === slug
        ? "bg-accent text-foreground font-medium"
        : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
    ].join(" ");

  return (
    <nav className="space-y-4" aria-label="Help topics">
      {/* Search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search help…"
          aria-label="Search help"
          className="w-full rounded-md border border-border bg-background py-2 pl-8 pr-8 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--phosphor)]"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--phosphor)]"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {trimmed ? (
        // ── Search results ──
        <div>
          {results.length === 0 ? (
            <p className="px-2.5 py-2 text-sm text-muted-foreground">
              No results for “{trimmed}”.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {results.map((a) => (
                <li key={a.slug}>
                  <Link to={articleTo(a.slug)} className={linkClass(a.slug)}>
                    <span className="block">{a.title}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{a.summary}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        // ── Browse by category ──
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => setSearchParams({}, { replace: false })}
            className={[
              "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
              activeSlug == null
                ? "bg-accent text-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            ].join(" ")}
          >
            Help home
          </button>
          {groups.map((group) => {
            const Icon = helpIcon(group.icon);
            return (
              <div key={group.key}>
                <div className="flex items-center gap-2 px-2.5 pb-1.5 pt-1">
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </span>
                </div>
                <ul className="space-y-0.5">
                  {group.articles.map((a) => (
                    <li key={a.slug}>
                      <Link to={articleTo(a.slug)} className={linkClass(a.slug)}>
                        {a.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </nav>
  );
}
