// ArticleBody — the ONE place that turns HelpBlock[] into UI. Never fork this
// renderer: it supports two palettes via `variant`.
//   • "app"   → uses the app's theme tokens, so it adapts to light/dark.
//   • "print" → a fixed light palette for the printable manual (PR 2), legible
//               on paper regardless of the operator's current theme.
// Inline **bold** and a small set of HTML entities are honoured in text blocks.

import { Fragment } from "react";
import { Lightbulb, AlertTriangle, Info } from "lucide-react";

/** @typedef {import("@/lib/help/types.js").HelpBlock} HelpBlock */

// Minimal entity decoding so authored strings can contain literal punctuation
// without fighting JSX (e.g. "R&amp;D", "a &lt; b").
const ENTITIES = /** @type {Record<string,string>} */ ({
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
});
/** @param {string} s */
function decodeEntities(s) {
  return s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

/**
 * Render a text string with **bold** spans and decoded entities into React
 * nodes. Split keeps the delimiters so we can re-detect the bold chunks.
 * @param {string} text
 */
function inline(text) {
  const decoded = decodeEntities(text);
  const parts = decoded.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    const m = /^\*\*([^*]+)\*\*$/.exec(part);
    if (m) return <strong key={i} className="font-semibold">{m[1]}</strong>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

// Two palettes, same structure. App classes lean on theme tokens; print
// classes are fixed light values so window.print() output stays legible.
const THEME = {
  app: {
    h: "text-foreground",
    p: "text-muted-foreground",
    table: "border-border",
    th: "bg-muted/40 text-foreground",
    td: "text-muted-foreground",
    tableBorder: "border-border",
  },
  print: {
    h: "text-zinc-900",
    p: "text-zinc-700",
    table: "border-zinc-300",
    th: "bg-zinc-100 text-zinc-900",
    td: "text-zinc-700",
    tableBorder: "border-zinc-300",
  },
};

// Callout tone → icon + tint, per variant. Standard-palette utilities are used
// (not arbitrary var-based colors) so Tailwind reliably generates them and the
// opacity modifiers work; emerald/amber/sky read fine on dark AND light.
const CALLOUT = {
  app: {
    tip: { Icon: Lightbulb, box: "border-emerald-500/40 bg-emerald-500/10", icon: "text-emerald-500" },
    warning: { Icon: AlertTriangle, box: "border-amber-500/40 bg-amber-500/10", icon: "text-amber-500" },
    info: { Icon: Info, box: "border-sky-500/40 bg-sky-500/10", icon: "text-sky-500" },
  },
  print: {
    tip: { Icon: Lightbulb, box: "border-emerald-300 bg-emerald-50", icon: "text-emerald-600" },
    warning: { Icon: AlertTriangle, box: "border-amber-300 bg-amber-50", icon: "text-amber-600" },
    info: { Icon: Info, box: "border-sky-300 bg-sky-50", icon: "text-sky-600" },
  },
};

/**
 * @param {{ blocks: HelpBlock[], variant?: "app" | "print" }} props
 */
export default function ArticleBody({ blocks, variant = "app" }) {
  const t = THEME[variant];
  return (
    <div className="space-y-4">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "h":
            return (
              <h3 key={i} className={`mt-6 text-lg font-semibold ${t.h}`}>
                {inline(block.text)}
              </h3>
            );
          case "p":
            return (
              <p key={i} className={`text-[15px] leading-relaxed ${t.p}`}>
                {inline(block.text)}
              </p>
            );
          case "steps":
            return (
              <ol key={i} className={`ml-5 list-decimal space-y-1.5 text-[15px] leading-relaxed marker:font-medium ${t.p}`}>
                {block.items.map((item, j) => (
                  <li key={j}>{inline(item)}</li>
                ))}
              </ol>
            );
          case "list":
            return (
              <ul key={i} className={`ml-5 list-disc space-y-1.5 text-[15px] leading-relaxed ${t.p}`}>
                {block.items.map((item, j) => (
                  <li key={j}>{inline(item)}</li>
                ))}
              </ul>
            );
          case "callout": {
            const c = CALLOUT[variant][block.tone];
            return (
              <div key={i} className={`flex gap-3 rounded-lg border p-3.5 ${c.box}`}>
                <c.Icon className={`mt-0.5 h-5 w-5 shrink-0 ${c.icon}`} />
                <p className={`text-[15px] leading-relaxed ${t.p}`}>{inline(block.text)}</p>
              </div>
            );
          }
          case "table":
            return (
              <div key={i} className="overflow-x-auto">
                <table className={`w-full border-collapse text-sm ${t.table}`}>
                  <thead>
                    <tr>
                      {block.headers.map((h, j) => (
                        <th key={j} className={`border ${t.tableBorder} px-3 py-2 text-left font-semibold ${t.th}`}>
                          {inline(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td key={c} className={`border ${t.tableBorder} px-3 py-2 align-top ${t.td}`}>
                            {inline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
