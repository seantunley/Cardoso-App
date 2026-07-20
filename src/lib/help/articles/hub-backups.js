// Hub & backups articles — seed content describing the UI mechanics of the
// off-site backup verification and snapshot maintenance tools (the Site Backups
// page). These describe what the buttons and panels DO; anything touching
// backup policy/cadence is left to a reviewed pass with Sean.

/** @typedef {import('./../types.js').HelpArticle} HelpArticle */

/** @type {HelpArticle[]} */
export const hubBackupsArticles = [
  {
    slug: "site-backups-overview",
    title: "Reading the Site Backups page",
    summary: "What each site's row tells you about its off-site backups.",
    category: "hub",
    audience: "managers",
    keywords: ["backup", "kopia", "off-site", "offsite", "snapshot", "site", "fleet"],
    body: [
      {
        type: "p",
        text: "The Site Backups page (hub only) shows one row per site with the state of that site's off-site backups. A site pushes its snapshots to the hub repository; this page is where you confirm those snapshots actually arrived and are recent.",
      },
      {
        type: "p",
        text: "Each row shows the age of the newest snapshot and a status dot. Green means the newest backup is within the expected window; red means it is stale (older than the threshold); amber means the hub could not read the site's backups and the problem should be investigated rather than assumed fine.",
      },
      {
        type: "callout",
        tone: "info",
        text: "A site showing no off-site backups at all is different from a stale one — it has simply never pushed, and won't raise a stale alert.",
      },
    ],
  },
  {
    slug: "sql-offsite-verification",
    title: "Confirming SQL backups are off-site",
    summary: "The SQL panel inside a site's snapshot view, and what its states mean.",
    category: "hub",
    audience: "managers",
    keywords: ["sql", "sage", "database", "cardat", "carsys", "backup", "verify", "offsite"],
    body: [
      {
        type: "p",
        text: "Open a site's snapshots to see the SQL off-site panel. It rolls up the site's SQL backups per database, showing the most recent FULL and DIFF for each and whether the newest is fresh.",
      },
      {
        type: "table",
        headers: ["State", "Meaning"],
        rows: [
          ["OK", "The newest SQL backup is within the freshness window."],
          ["Stale", "SQL backups exist but the newest is older than the threshold."],
          ["Never", "No SQL backups have been found off-site for this site yet."],
          ["Error", "The hub could not read the SQL backup folder — investigate."],
        ],
      },
      {
        type: "p",
        text: "If the panel doesn't show what you expect, use the snapshot tree browser to look directly at the files that were backed up.",
      },
    ],
  },
  {
    slug: "delete-snapshots-and-maintenance",
    title: "Deleting snapshots and reclaiming disk",
    summary: "The admin-only Delete and Run maintenance buttons, and the order they work in.",
    category: "hub",
    audience: "admins",
    keywords: ["delete", "snapshot", "maintenance", "disk", "space", "reclaim", "gc", "prune"],
    body: [
      {
        type: "p",
        text: "Administrators can remove individual snapshots and reclaim the disk they were holding. Deleting a snapshot only removes that restore point; the disk space is not freed until maintenance runs.",
      },
      {
        type: "steps",
        items: [
          "Open a site's snapshots and find the snapshot you want to remove.",
          "Click **Delete** on that row and confirm. This unlinks the snapshot.",
          "When you've deleted everything you intend to, click **Run maintenance** in the footer.",
          "Maintenance compacts the repository and frees the disk. It can take several minutes on a large repository.",
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: "Deleting a snapshot removes that restore point permanently. Make sure a newer, verified backup exists before deleting an older one.",
      },
      {
        type: "callout",
        tone: "info",
        text: "Only one maintenance run happens at a time. If it is already running, the button reports that and won't start a second run.",
      },
    ],
  },
];
