// Resolves the string icon NAME stored on each HelpCategory (see categories.js)
// to a lucide component. Keeping this map in the UI layer is what lets the data
// files stay free of any React/lucide import. Unknown names fall back to
// BookOpen so a new category never renders a broken icon.

import { Compass, Users, Scale, Boxes, BarChart3, Server, Cog, BookOpen } from "lucide-react";

const ICONS = { Compass, Users, Scale, Boxes, BarChart3, Server, Cog, BookOpen };

/**
 * @param {string} name
 * @returns {import("lucide-react").LucideIcon}
 */
export function helpIcon(name) {
  return ICONS[name] || BookOpen;
}
