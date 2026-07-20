// Administration articles. Written from the actual screens (Users page, the
// Edit-user and Permissions modals, and the settings tab catalog). Describes
// the mechanics of managing users, permissions, and settings. What each
// individual setting DOES to the business is out of scope here — those live in
// the relevant module's help or with an SME.

/** @typedef {import('./../types.js').HelpArticle} HelpArticle */

/** @type {HelpArticle[]} */
export const adminArticles = [
  {
    slug: "managing-users",
    title: "Managing user accounts",
    summary: "Add, edit, disable, and remove operators.",
    category: "admin",
    audience: "admins",
    keywords: ["users", "accounts", "operators", "add user", "delete", "password", "role", "admin"],
    body: [
      {
        type: "p",
        text: "The Users page (admin-only) lists every operator, with a summary of how many are active and how many are admins. Each row shows the name, email, role (Admin or User), and status (Active or Disabled).",
      },
      { type: "h", text: "Adding and editing" },
      {
        type: "list",
        items: [
          "**Add User** creates a new account.",
          "**Edit** (pencil) changes the user's name and username.",
          "**Set Password** (key) sets a new password for the user.",
          "**Permissions** (shield) opens the permissions and role controls — see the next article.",
          "**Delete** (red trash) removes a user after a confirmation. You can't delete your own account.",
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: "On the hub, a separate hub-user manager appears below the table for managing access across sites.",
      },
    ],
  },
  {
    slug: "user-permissions",
    title: "Roles and permissions",
    summary: "Set a user's role and switch individual modules on or off.",
    category: "admin",
    audience: "admins",
    keywords: ["permissions", "role", "access", "modules", "enable", "disable", "diagnose"],
    body: [
      {
        type: "p",
        text: "The Permissions dialog (the shield icon on a user's row) controls what that user can reach.",
      },
      { type: "h", text: "Account status and role" },
      {
        type: "list",
        items: [
          "**Active Account** — turn off to stop a user signing in without deleting them.",
          "**Role** — **Admin** or **User**. Admins have full access by default and bypass the per-module gates; you can still turn individual modules off for an admin.",
        ],
      },
      { type: "h", text: "Per-module permissions" },
      {
        type: "p",
        text: "Permissions are grouped into tabs — Customer, Creditors, Inventory, Operations (BAT/JTI/reports), Hub, System, and Admin & Actions. Each is a set of switches you turn on or off, then **Save**.",
      },
      {
        type: "callout",
        tone: "tip",
        text: "If you're not sure why a user can or can't see something, turn on **Diagnose** in the dialog — it lists each permission as allowed or denied with the reason.",
      },
    ],
  },
  {
    slug: "settings-overview",
    title: "Finding your way around Settings",
    summary: "How the settings panel is organised and how to jump to a section.",
    category: "admin",
    audience: "admins",
    keywords: ["settings", "configure", "tabs", "connections", "maintenance", "deep link", "panel"],
    body: [
      {
        type: "p",
        text: "Settings opens as a panel over whatever you're on. Reach it from the gear in the sidebar, the Settings flyout, or the command palette (⌘K → \"Settings\"). It's organised into groups, each with its own tabs.",
      },
      {
        type: "table",
        headers: ["Group", "Tabs"],
        rows: [
          ["Access", "Users"],
          ["Company", "Depot Details"],
          ["Customer", "Credit Logic, Auto-Flag Rules, Fields"],
          ["Data", "Connections, Sage Corrections, Sage Queries, Sync Log"],
          ["Modules", "Reconciliation, Forecast, Price List, Commission, Creditors, Debtors"],
          ["System", "Accounting, Audit Log, Maintenance, Disaster Recovery, Hub Maintenance, Network, TLS"],
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: "You'll only see the tabs your role and install allow — some are admin-only, and hub installs show different tabs from sites. A tab you can't access simply won't appear.",
      },
      {
        type: "p",
        text: "Settings is deep-linkable: opening a specific section puts it in the address bar (for example ?settings=pricelist), so you can refresh or share a link and land on the same tab.",
      },
    ],
  },
];
