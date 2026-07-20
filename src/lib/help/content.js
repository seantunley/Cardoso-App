// Help Centre — single source of truth.
//
// Every consumer (in-app viewer, search box, PR 2's printable manual) imports
// from here. Add a new article file by importing it and spreading it into
// HELP_ARTICLES; nothing else needs to change. Helpers below are pure so they
// can run in the browser or in a test without a DOM.

import { HELP_CATEGORIES } from "./categories.js";
import { gettingStartedArticles } from "./articles/getting-started.js";
import { customersArticles } from "./articles/customers.js";

/** @typedef {import('./types.js').HelpArticle} HelpArticle */
/** @typedef {import('./types.js').HelpCategoryKey} HelpCategoryKey */

/** @type {HelpArticle[]} */
export const HELP_ARTICLES = [
  ...gettingStartedArticles,
  ...customersArticles,
];

/** @type {Map<string, HelpArticle>} */
const BY_SLUG = new Map(HELP_ARTICLES.map((a) => [a.slug, a]));

/**
 * @param {string} slug
 * @returns {HelpArticle | undefined}
 */
export const getArticle = (slug) => BY_SLUG.get(slug);

/**
 * Articles in one category, in authoring order.
 * @param {HelpCategoryKey} key
 * @returns {HelpArticle[]}
 */
export const articlesInCategory = (key) =>
  HELP_ARTICLES.filter((a) => a.category === key);

/**
 * Categories that actually have articles, in display order, each with its
 * articles attached. Empty categories are dropped so the UI never renders a
 * heading with nothing under it.
 * @returns {Array<import('./types.js').HelpCategory & { articles: HelpArticle[] }>}
 */
export function categoriesWithArticles() {
  return HELP_CATEGORIES
    .map((c) => ({ ...c, articles: articlesInCategory(c.key) }))
    .filter((c) => c.articles.length > 0);
}

/**
 * Flattened text of a block, used only for search scoring.
 * @param {import('./types.js').HelpBlock} b
 * @returns {string}
 */
function blockText(b) {
  if ("text" in b) return b.text;
  if ("items" in b) return b.items.join(" ");
  if ("headers" in b) return `${b.headers.join(" ")} ${b.rows.flat().join(" ")}`;
  return "";
}

/**
 * Weighted relevance search over title, summary, keywords and body text.
 * Title matches dominate, then the "strong" fields (summary + keywords), then
 * body text. Returns the matching articles, most relevant first.
 * @param {string} query
 * @returns {HelpArticle[]}
 */
export function searchArticles(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  /** @type {{ a: HelpArticle, score: number }[]} */
  const scored = [];
  for (const a of HELP_ARTICLES) {
    const title = a.title.toLowerCase();
    const strong = `${a.title} ${a.summary} ${a.keywords.join(" ")}`.toLowerCase();
    const body = a.body.map(blockText).join(" ").toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 6;
      if (strong.includes(t)) score += 3;
      if (body.includes(t)) score += 1;
    }
    if (score > 0) scored.push({ a, score });
  }
  return scored.sort((x, y) => y.score - x.score).map((s) => s.a);
}

/**
 * Lightweight index for a client search box that doesn't want the full body
 * payload (title/summary/keywords are enough to rank and label results).
 */
export const HELP_SEARCH_INDEX = HELP_ARTICLES.map(
  ({ slug, title, summary, category, keywords }) => ({ slug, title, summary, category, keywords }),
);
