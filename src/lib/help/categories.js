// Help Centre categories — the ordered top-level sections of the manual.
//
// The order here IS the display order (landing cards, nav groups, printable
// manual). It mirrors the sidebar nav grouping in Layout.jsx so the help
// reads in the same shape as the product. `icon` is a lucide icon NAME (a
// string); the UI layer maps it to a component via an ICONS table, keeping
// this data file free of any React import.

/** @typedef {import('./types.js').HelpCategory} HelpCategory */
/** @typedef {import('./types.js').HelpCategoryKey} HelpCategoryKey */

/** @type {HelpCategory[]} */
export const HELP_CATEGORIES = [
  {
    key: "getting-started",
    label: "Getting started",
    description: "Sign in, find your way around, and set up the basics.",
    icon: "Compass",
  },
  {
    key: "customers",
    label: "Customers",
    description: "Customer search, balances, and collections.",
    icon: "Users",
  },
  {
    key: "creditors",
    label: "Creditors",
    description: "Vendor balances, payments, and purchase activity.",
    icon: "Building2",
  },
  {
    key: "reconciliation",
    label: "BAT & reconciliation",
    description: "Reconciling BAT claims against Sage.",
    icon: "Scale",
  },
  {
    key: "inventory",
    label: "Inventory & pricing",
    description: "Stock lists, movement, expiry, and price lists.",
    icon: "Boxes",
  },
  {
    key: "reports",
    label: "Reports & insights",
    description: "Reporting dashboard, insights feed, and trends.",
    icon: "BarChart3",
  },
  {
    key: "hub",
    label: "Hub & backups",
    description: "The hub view of the fleet, and off-site backups.",
    icon: "Server",
  },
  {
    key: "admin",
    label: "Administration",
    description: "Users, permissions, and system settings.",
    icon: "Cog",
  },
];

/**
 * Quick key → label lookup for badges and breadcrumbs.
 * @type {Record<string, string>}
 */
export const CATEGORY_LABEL = Object.fromEntries(
  HELP_CATEGORIES.map((c) => [c.key, c.label]),
);
