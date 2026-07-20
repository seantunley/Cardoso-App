// Help — the in-app help centre. A two-column shell: HelpNav on the left,
// content on the right. The selected article is carried in the ?article query
// param (SPA-friendly, deep-linkable, works with the single-segment page
// router) — no ?article means the landing view with category cards.
//
// The printable full manual and the sidebar Help flyout are separate slices
// (PRs 2 and 3); this page is reachable directly at /Help in the meantime.

import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowRight, ChevronLeft } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import HelpNav from "@/components/help/HelpNav";
import ArticleBody from "@/components/help/ArticleBody";
import { helpIcon } from "@/components/help/helpIcons.js";
import {
  getArticle,
  articlesInCategory,
  categoriesWithArticles,
} from "@/lib/help/content.js";
import { CATEGORY_LABEL } from "@/lib/help/categories.js";

const AUDIENCE_LABEL = { everyone: "Everyone", managers: "Managers", admins: "Admins" };

/** @param {{ audience: string }} props */
function AudienceBadge({ audience }) {
  if (audience === "everyone") return null;
  return (
    <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {AUDIENCE_LABEL[audience] || audience}
    </span>
  );
}

const articleTo = (slug) => `/Help?article=${encodeURIComponent(slug)}`;

/** Landing view: intro + a card per non-empty category. */
function HelpLanding() {
  const groups = useMemo(() => categoriesWithArticles(), []);
  return (
    <div>
      <PageHeader
        title="Help centre"
        subtitle="Guides for using the Cardoso app, organised by area. Search on the left, or pick a topic below."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {groups.map((group) => {
          const Icon = helpIcon(group.icon);
          const first = group.articles[0];
          return (
            <Link
              key={group.key}
              to={articleTo(first.slug)}
              className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--phosphor)]"
            >
              <span className="mt-0.5 rounded-lg bg-muted/50 p-2 text-foreground">
                <Icon className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-foreground">{group.label}</span>
                <span className="mt-0.5 block text-sm text-muted-foreground">{group.description}</span>
                <span className="mt-1.5 block text-xs text-muted-foreground">
                  {group.articles.length} {group.articles.length === 1 ? "article" : "articles"}
                </span>
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/** Article view: header, body, and prev/next within the same category. */
function HelpArticleView({ slug }) {
  const article = getArticle(slug);

  const siblings = useMemo(
    () => (article ? articlesInCategory(article.category) : []),
    [article],
  );

  if (!article) {
    return (
      <div>
        <PageHeader title="Article not found" subtitle="That help topic doesn't exist or has moved." />
        <Link
          to="/Help"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" /> Back to help centre
        </Link>
      </div>
    );
  }

  const idx = siblings.findIndex((a) => a.slug === article.slug);
  const prev = idx > 0 ? siblings[idx - 1] : null;
  const next = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null;

  return (
    <article>
      <Link
        to="/Help"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> Help centre
      </Link>
      <div className="mb-5 border-b border-border pb-5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {CATEGORY_LABEL[article.category] || article.category}
          </span>
          <AudienceBadge audience={article.audience} />
        </div>
        <h1 className="font-display text-3xl leading-tight tracking-tight text-foreground lg:text-4xl">
          {article.title}
        </h1>
        {article.summary && (
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{article.summary}</p>
        )}
      </div>

      <ArticleBody blocks={article.body} variant="app" />

      {(prev || next) && (
        <div className="mt-8 flex flex-wrap justify-between gap-3 border-t border-border pt-5">
          {prev ? (
            <Link
              to={articleTo(prev.slug)}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4 shrink-0" />
              <span className="text-left">
                <span className="block text-[11px] uppercase tracking-wide">Previous</span>
                <span className="block text-foreground">{prev.title}</span>
              </span>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link
              to={articleTo(next.slug)}
              className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
            >
              <span className="text-right">
                <span className="block text-[11px] uppercase tracking-wide">Next</span>
                <span className="block text-foreground">{next.title}</span>
              </span>
              <ArrowRight className="h-4 w-4 shrink-0" />
            </Link>
          )}
        </div>
      )}
    </article>
  );
}

export default function Help() {
  const [searchParams] = useSearchParams();
  const slug = searchParams.get("article");

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="grid gap-8 lg:grid-cols-[288px_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <HelpNav activeSlug={slug} />
        </aside>
        <div className="min-w-0">
          {slug ? <HelpArticleView slug={slug} /> : <HelpLanding />}
        </div>
      </div>
    </div>
  );
}
