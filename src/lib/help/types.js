// Help Centre content model — TYPES ONLY.
//
// Deliberately free of any React import: the same typed data feeds the in-app
// viewer, the search index, and (PR 2) the printable manual. Authoring happens
// in plain .js files that carry these @typedef shapes; the UI layer resolves
// icon names to components and renders the blocks.
//
// This project is checkJs (tsc runs over .js), so these JSDoc typedefs are the
// contract the validation test and every consumer type-check against.

/**
 * A single renderable block within an article body. Kept small and product-
 * shaped on purpose — one renderer (ArticleBody) turns each variant into UI.
 *
 * @typedef {(
 *   | { type: "p", text: string }
 *   | { type: "h", text: string }
 *   | { type: "steps", items: string[] }
 *   | { type: "list", items: string[] }
 *   | { type: "callout", tone: "tip" | "warning" | "info", text: string }
 *   | { type: "table", headers: string[], rows: string[][] }
 * )} HelpBlock
 */

/**
 * Who an article is written for. Drives the badge on the article page and can
 * later gate visibility; "everyone" is the default and safe fallback.
 *
 * @typedef {"everyone" | "managers" | "admins"} HelpAudience
 */

/**
 * One key per top-level area of the app. Keep the list short and mirror the
 * sidebar nav grouping so the manual reads in the same shape as the product.
 *
 * @typedef {(
 *   | "getting-started"
 *   | "customers"
 *   | "reconciliation"
 *   | "inventory"
 *   | "reports"
 *   | "hub"
 *   | "admin"
 * )} HelpCategoryKey
 */

/**
 * @typedef {Object} HelpArticle
 * @property {string} slug            URL segment / ?article value; globally unique.
 * @property {string} title           Shown in nav, cards, and as the article H1.
 * @property {string} summary         One line; shown on cards and in search.
 * @property {HelpCategoryKey} category
 * @property {HelpAudience} audience
 * @property {string[]} keywords      Boosts search recall; not shown.
 * @property {HelpBlock[]} body
 */

/**
 * @typedef {Object} HelpCategory
 * @property {HelpCategoryKey} key
 * @property {string} label
 * @property {string} description
 * @property {string} icon   lucide icon NAME as a string; resolved in the UI layer.
 */

// This file is types-only; the empty export makes it an ES module so
// `import('./types.js').HelpArticle` resolves cleanly under checkJs.
export {};
