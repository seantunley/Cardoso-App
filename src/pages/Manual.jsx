// Manual — the printable full manual. Renders EVERY article, light-themed, for
// print/PDF. Deliberately lives OUTSIDE the app chrome (its own top-level route
// in App.jsx, not in pages.config) so there's no sidebar in the printout. It
// reuses the exact same ArticleBody renderer as the in-app viewer, in its
// "print" variant — one renderer, two palettes, never forked.

import { Link } from "react-router-dom";
import { Printer, ArrowLeft } from "lucide-react";
import ArticleBody from "@/components/help/ArticleBody";
import { categoriesWithArticles } from "@/lib/help/content.js";

// Print rules that Tailwind utilities don't cover cleanly: force a light page,
// start each category on a fresh sheet, keep an article's heading with its body,
// and strip link chrome so URLs don't get underlined in the PDF.
const PRINT_CSS = `
@media print {
  .manual-noprint { display: none !important; }
  .manual-page { background: #fff !important; }
  .manual-section { break-before: page; }
  .manual-article { break-inside: avoid-page; }
  .manual-article h3, .manual-toc { break-after: avoid; }
  a { color: inherit; text-decoration: none; }
}
`;

export default function Manual() {
  const groups = categoriesWithArticles();
  const printedOn = new Date().toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="manual-page min-h-screen bg-white text-zinc-900">
      <style>{PRINT_CSS}</style>

      {/* Top bar — hidden in the printout */}
      <div className="manual-noprint sticky top-0 z-10 border-b border-zinc-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-3">
          <Link
            to="/Help"
            className="inline-flex items-center gap-1.5 text-sm text-zinc-600 hover:text-zinc-900"
          >
            <ArrowLeft className="h-4 w-4" /> Back to help centre
          </Link>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700"
          >
            <Printer className="h-4 w-4" /> Print / Save as PDF
          </button>
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-6 py-10">
        {/* Cover */}
        <header className="mb-10 border-b border-zinc-200 pb-8">
          <p className="text-sm font-semibold uppercase tracking-widest text-zinc-500">
            Cardoso Depots
          </p>
          <h1 className="mt-2 text-4xl font-bold tracking-tight text-zinc-900">User manual</h1>
          <p className="mt-3 text-zinc-600">
            A printable copy of the in-app help centre. Generated {printedOn}.
          </p>
        </header>

        {/* Table of contents */}
        <nav className="manual-toc mb-12" aria-label="Contents">
          <h2 className="mb-3 text-lg font-semibold text-zinc-900">Contents</h2>
          <ol className="space-y-4">
            {groups.map((group) => (
              <li key={group.key}>
                <span className="font-semibold text-zinc-800">{group.label}</span>
                <ul className="mt-1 ml-4 space-y-0.5">
                  {group.articles.map((a) => (
                    <li key={a.slug}>
                      <a href={`#${a.slug}`} className="text-zinc-600 hover:text-zinc-900">
                        {a.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </nav>

        {/* Body — every article, grouped by category */}
        {groups.map((group, gi) => (
          <section
            key={group.key}
            className={gi > 0 ? "manual-section pt-10" : "pt-2"}
          >
            <h2 className="mb-6 border-b border-zinc-200 pb-2 text-2xl font-bold text-zinc-900">
              {group.label}
            </h2>
            <div className="space-y-12">
              {group.articles.map((a) => (
                <article key={a.slug} id={a.slug} className="manual-article scroll-mt-20">
                  <h3 className="mb-1 text-xl font-semibold text-zinc-900">{a.title}</h3>
                  {a.summary && <p className="mb-4 text-sm text-zinc-500">{a.summary}</p>}
                  <ArticleBody blocks={a.body} variant="print" />
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
