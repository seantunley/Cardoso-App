// Hub & backups articles. Written from the actual hub screens (HubDashboard,
// HubMetrics, HubBackups + its Restore/Snapshots dialogs, HubTrends) as they
// exist on main. The snapshot Delete / Run-maintenance controls and the SQL
// off-site verification panel are NOT covered here — they ship in a separate
// PR (#522) and will get their own article once merged, so this content never
// describes UI that isn't in the app yet. Business meaning (verdict scoring,
// health roll-up formulas) is deferred to an SME.

/** @typedef {import('./../types.js').HelpArticle} HelpArticle */

/** @type {HelpArticle[]} */
export const hubArticles = [
  {
    slug: "hub-dashboard",
    title: "The hub dashboard",
    summary: "Every site in one view — flags, syncs, and cross-site customer search.",
    category: "hub",
    audience: "managers",
    keywords: ["hub", "dashboard", "sites", "fleet", "sync", "accpac", "customer search", "flags"],
    body: [
      {
        type: "p",
        text: "The hub dashboard (\"All sites, one view\") shows a card per connected site. Each card has the site's customer flag counts — Total, Critical (red), Attention (orange), Approved (green) — and a status pill of Online, Offline, or Orphan.",
      },
      { type: "h", text: "Keeping data current" },
      {
        type: "list",
        items: [
          "**Sync Now** pulls the latest data from every site into the hub.",
          "**Force Resync** clears synced data and re-pulls everything (with a confirmation).",
          "On a site card, **Sync from Accpac** triggers a Sage/Accpac sync at that site, and the resync icon re-pulls just that site.",
        ],
      },
      {
        type: "p",
        text: "Use the **KPI range** dropdown to scope the headline numbers (all time, last 7/30/90 days). Click a flag tile to drill into that site's flagged customers, or use the **Customer Search** panel to look up a customer across all sites (or one site).",
      },
      {
        type: "callout",
        tone: "info",
        text: "A customer opened from the hub is a read-only snapshot. Flags and other changes must be made at the site directly. \"Orphan\" means a site was removed from the hub's site list — it's read-only until re-added.",
      },
    ],
  },
  {
    slug: "site-metrics",
    title: "Site machine health",
    summary: "Windows machine vitals — CPU, RAM, disk, uptime — across every site.",
    category: "hub",
    audience: "managers",
    keywords: ["metrics", "machine", "health", "cpu", "ram", "disk", "uptime", "ping", "tailscale", "vitals"],
    body: [
      {
        type: "p",
        text: "Site Metrics (\"Network vitals\") shows the health of each site's Windows machine, one card per site, worst first.",
      },
      {
        type: "p",
        text: "Each card carries a health badge — Healthy, Attention, Critical, or Unavailable — and a reachability badge (Online / Offline over the private network, with the round-trip time). Below that are the machine vitals:",
      },
      {
        type: "list",
        items: [
          "**CPU** — usage across all cores at the last check.",
          "**RAM** — physical memory in use versus total.",
          "**Uptime** — how long since the last restart.",
          "**Cardoso Service** — whether the app's service is running, and its start type.",
          "**Disk Space** — free versus total per drive, and the site's local IP addresses.",
        ],
      },
      {
        type: "p",
        text: "The page refreshes on its own; **Refresh** forces an immediate check.",
      },
    ],
  },
  {
    slug: "site-backups",
    title: "Site backups and restore",
    summary: "The nightly backup status for every site, and how to restore one.",
    category: "hub",
    audience: "admins",
    keywords: ["backup", "restore", "kopia", "off-site", "snapshot", "hub copy", "local", "sql", "recovery"],
    body: [
      {
        type: "p",
        text: "Site Backups (\"Safe, every night\") shows one row per site, worst first, with a status dot and age for each backup layer: Local (on the site), Hub copy (pulled to the hub), Off-site (the encrypted Kopia repository), and SQL (the site's SQL Server backup).",
      },
      {
        type: "callout",
        tone: "info",
        text: "Freshness, per the page footer: Local is OK up to 25 hours old, Overdue from 25–48h, and Stale beyond 48h. The overall health pill reads Healthy, Overdue, or Problem. Click a row for the per-layer detail.",
      },
      { type: "h", text: "Pulling and browsing" },
      {
        type: "list",
        items: [
          "**Pull Now** pulls fresh backups from all sites; **Sync On/Off** controls the automatic pull.",
          "On a row, **Pull DB** and **Pull .env** fetch those from the site over the network.",
          "**View snapshots** lists the off-site snapshots; the **Kopia UI** button opens Kopia's own web interface for the full tree.",
        ],
      },
      { type: "h", text: "Restoring a site" },
      {
        type: "p",
        text: "**Restore from hub** or **Restore off-site** opens the restore dialog. Pick a complete snapshot (incomplete ones can't be restored). You can **Stage & download** the database first — that's non-destructive, the live site is untouched.",
      },
      {
        type: "callout",
        tone: "warning",
        text: "Pushing a restore to the live site replaces its database and takes it offline for about 30 seconds. It requires your password. The current database is saved first, and if the integrity check fails the restore rolls back automatically.",
      },
    ],
  },
  {
    slug: "hub-trends",
    title: "Trends across the fleet",
    summary: "Customer and inventory trends over time, per site or aggregated.",
    category: "hub",
    audience: "managers",
    keywords: ["hub", "trends", "over time", "velocity", "revenue", "seasonal", "per site", "fleet"],
    body: [
      {
        type: "p",
        text: "Hub Trends shows the same customer and inventory trends as the site view, but across the fleet. The Site selector at the top narrows every chart to one site or aggregates across all of them.",
      },
      {
        type: "list",
        items: [
          "**Customers** — record volume and flag rate over time, bucketed weekly or monthly, with a line per site.",
          "**Inventory** — sales velocity, revenue, and order count (year over year), revenue by commodity (Mix), dead-stock movement, and the top items per South African season.",
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: "Inventory trends build up as sites sync movement data and the hub pulls it in — they appear once there's enough history to bucket.",
      },
    ],
  },
];
