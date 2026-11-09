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
  {
    slug: "customer-sync",
    title: "How customer data stays in sync with Sage",
    summary: "When customers sync, what each sync result means, and what to do when a sync is failing.",
    category: "admin",
    audience: "admins",
    keywords: ["sync", "sync now", "sync all", "connection", "sage", "customers", "balances", "stale", "alert", "timeout", "national account"],
    body: [
      {
        type: "p",
        text: "Customer balances, aging and open invoices come from Sage through the site's customer connection (Settings → Data → Connections). The app copies them in on a schedule; nothing is ever written back to Sage.",
      },
      { type: "h", text: "When it syncs" },
      {
        type: "list",
        items: [
          "Every 30 minutes on weekdays from 06:00 to 16:30, plus an end-of-day sync at 17:00.",
          "A connection with its own sync interval also syncs whenever that interval has passed.",
          "**Sync now** on a connection runs it straight away; **Sync all** runs every connection that can be synced. BAT-only and switched-off connections are skipped.",
        ],
      },
      { type: "h", text: "Reading a sync result" },
      {
        type: "p",
        text: "Each sync reports what actually changed, for example: \"Synced 6 590 customer rows from Sage: 3 new, 120 updated, 6 467 unchanged, 2 no longer in Sage (balances cleared).\" The same line is kept in the sync history and the audit log.",
      },
      {
        type: "table",
        headers: ["Term", "Meaning"],
        rows: [
          ["New", "Customers that weren't in the app yet."],
          ["Updated", "Customers whose balance, aging or details changed in Sage."],
          ["Unchanged", "Customers that were checked and are already up to date."],
          ["No longer in Sage", "Customers Sage stopped returning — deleted in Sage, or rolled into a national account (whose row now carries the balance). Their balance, aging and open invoices are cleared so totals match Sage; the customer, flags and notes are kept. If they come back, the next sync fills them in again."],
          ["Duplicate rows skipped", "Sage returned the same customer more than once; it's counted once."],
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: "Safety check: if Sage suddenly returns far fewer customers than last time, the app does not clear anyone on that run and says why. That usually means the sync query or Sage needs checking. If Sage keeps returning the lower number, the next sync accepts it.",
      },
      { type: "h", text: "When a sync fails" },
      {
        type: "list",
        items: [
          "Brief hiccups — a timeout or a dropped connection to Sage — are retried automatically twice within the same sync before it gives up.",
          "A connection whose sync failed shows the error on its card and is retried automatically every 30 minutes until it succeeds. You don't need to press anything for it to recover.",
          "If a sync is already running when you press **Sync now**, you'll be told to try again in a minute rather than starting a second one.",
        ],
      },
      {
        type: "p",
        text: "If a customer connection goes more than 2 hours of scheduled sync time (weekdays 06:00–17:30 — nights and weekends don't count) without a successful sync, an alert appears for admins in the notifications bell and under Operations → health panel → Active alerts, with the last error. New alerts are raised on weekdays between 08:00 and 18:00, and clear themselves after the next successful sync.",
      },
      {
        type: "steps",
        items: [
          "Open the alert or the connection card and read the last error.",
          "\"SQL Server didn't respond in time\" or similar: check that the Sage server is on and reachable from this machine (network / VPN).",
          "\"Login failed\": the connection's username or password has changed — update it under Settings → Data → Connections.",
          "No error but still stale: check that the Cardoso service is running on this machine.",
          "Press **Sync now** to confirm it's fixed.",
        ],
      },
    ],
  },
];
