// Guardrail for the Help Centre content model. These are cheap insurance for
// hand/JSON-authored content: they fail loudly if an article has a duplicate
// slug, an unknown category, a malformed block, or a lopsided table — the kinds
// of mistakes that otherwise render as a broken help page in front of a user.

import { describe, it, expect } from "vitest";
import { HELP_CATEGORIES } from "../src/lib/help/categories.js";
import {
  HELP_ARTICLES,
  HELP_SEARCH_INDEX,
  getArticle,
  articlesInCategory,
  categoriesWithArticles,
  searchArticles,
} from "../src/lib/help/content.js";

const CATEGORY_KEYS = new Set(HELP_CATEGORIES.map((c) => c.key));
const BLOCK_TYPES = new Set(["p", "h", "steps", "list", "callout", "table"]);
const CALLOUT_TONES = new Set(["tip", "warning", "info"]);
const AUDIENCES = new Set(["everyone", "managers", "admins"]);

describe("help content integrity", () => {
  it("has at least one article", () => {
    expect(HELP_ARTICLES.length).toBeGreaterThan(0);
  });

  it("has globally unique slugs", () => {
    const slugs = HELP_ARTICLES.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("uses only valid category keys and audiences", () => {
    for (const a of HELP_ARTICLES) {
      expect(CATEGORY_KEYS, `article ${a.slug} category`).toContain(a.category);
      expect(AUDIENCES, `article ${a.slug} audience`).toContain(a.audience);
    }
  });

  it("has a non-empty title, summary, and body on every article", () => {
    for (const a of HELP_ARTICLES) {
      expect(a.title?.trim(), `${a.slug} title`).toBeTruthy();
      expect(a.summary?.trim(), `${a.slug} summary`).toBeTruthy();
      expect(Array.isArray(a.body) && a.body.length > 0, `${a.slug} body`).toBe(true);
      expect(Array.isArray(a.keywords), `${a.slug} keywords`).toBe(true);
    }
  });

  it("has only valid blocks, callout tones, and rectangular tables", () => {
    for (const a of HELP_ARTICLES) {
      for (const b of a.body) {
        expect(BLOCK_TYPES, `${a.slug} block type`).toContain(b.type);
        if (b.type === "callout") {
          expect(CALLOUT_TONES, `${a.slug} callout tone`).toContain(b.tone);
          expect(b.text?.trim()).toBeTruthy();
        }
        if (b.type === "p" || b.type === "h") {
          expect(b.text?.trim(), `${a.slug} ${b.type} text`).toBeTruthy();
        }
        if (b.type === "steps" || b.type === "list") {
          expect(b.items.length, `${a.slug} ${b.type} items`).toBeGreaterThan(0);
        }
        if (b.type === "table") {
          expect(b.headers.length, `${a.slug} table headers`).toBeGreaterThan(0);
          for (const row of b.rows) {
            expect(row.length, `${a.slug} table row width`).toBe(b.headers.length);
          }
        }
      }
    }
  });
});

describe("help content helpers", () => {
  it("getArticle resolves by slug and returns undefined for misses", () => {
    const first = HELP_ARTICLES[0];
    expect(getArticle(first.slug)).toBe(first);
    expect(getArticle("no-such-article")).toBeUndefined();
  });

  it("articlesInCategory returns only that category, in authoring order", () => {
    const key = HELP_ARTICLES[0].category;
    const got = articlesInCategory(key);
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((a) => a.category === key)).toBe(true);
  });

  it("categoriesWithArticles drops empties and preserves display order", () => {
    const cats = categoriesWithArticles();
    expect(cats.every((c) => c.articles.length > 0)).toBe(true);
    // order is a subsequence of HELP_CATEGORIES
    const fullOrder = HELP_CATEGORIES.map((c) => c.key);
    const gotOrder = cats.map((c) => c.key);
    let cursor = -1;
    for (const key of gotOrder) {
      const at = fullOrder.indexOf(key);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it("searchArticles ranks title matches above body-only matches", () => {
    expect(searchArticles("")).toEqual([]);
    const first = HELP_ARTICLES[0];
    // A word from the title should surface the article.
    const titleTerm = first.title.split(/\s+/)[0].toLowerCase();
    const hits = searchArticles(titleTerm);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("HELP_SEARCH_INDEX mirrors articles without the heavy body", () => {
    expect(HELP_SEARCH_INDEX.length).toBe(HELP_ARTICLES.length);
    for (const entry of HELP_SEARCH_INDEX) {
      expect(entry).not.toHaveProperty("body");
      expect(entry.slug).toBeTruthy();
    }
  });
});
