// Reports & insights articles. Written from the actual screens (Reporting
// Dashboard, Insights, Reports, Trends). Describes what each screen shows and
// how to drive it. Where a figure's MEANING is business logic (BAT variance,
// what a flag colour implies, forecast/insight formulas), the text points at
// the relevant screen/policy rather than inventing a rule.

/** @typedef {import('./../types.js').HelpArticle} HelpArticle */

/** @type {HelpArticle[]} */
export const reportsArticles = [
  {
    slug: "reporting-dashboard",
    title: "The reporting dashboard",
    summary: "Headline numbers across the business, each opening a full report.",
    category: "reports",
    audience: "managers",
    keywords: ["dashboard", "reporting", "kpi", "aged debtors", "creditors", "exposure", "inventory value", "headline"],
    body: [
      {
        type: "p",
        text: "The Reporting Dashboard is the at-a-glance view: headline numbers as cards, each of which opens the full, filterable report behind it.",
      },
      {
        type: "list",
        items: [
          "**Customer flag tiles** — total customers and the red / orange / green flag counts.",
          "**Aged Debtors** and **Aged Creditors** — outstanding totals with an ageing breakdown, linking to the full report.",
          "**Rep Exposure**, **Inventory Value**, and **BAT Weekly** — summary totals that open their reports.",
          "**Highlight cards** — Top Items Sold this month, Top Dead Stock, and Top Customers over 12 months (these open Trends).",
        ],
      },
      {
        type: "p",
        text: "Click **View report** on any card to open it. On the hub, a branch filter at the top narrows everything to one site.",
      },
      {
        type: "callout",
        tone: "info",
        text: "The highlight cards (sales and inventory) read the local sales cache, so they show data on branch (site) installs and a short note on the hub.",
      },
    ],
  },
  {
    slug: "insights-feed",
    title: "The insights feed",
    summary: "Automatically surfaced changes and risks, and your own threshold rules.",
    category: "reports",
    audience: "managers",
    keywords: ["insights", "alerts", "rules", "threshold", "risk", "severity", "detect"],
    body: [
      {
        type: "p",
        text: "Insights automatically surfaces changes and risks across sales, customers, inventory and receivables. Each card is rated High, Medium, Low, or FYI, and — where it can — links to the page where you'd act on it.",
      },
      {
        type: "p",
        text: "Click **Refresh** to recompute from the latest data. The line at the top shows when the feed was last updated.",
      },
      { type: "h", text: "Your own rules" },
      {
        type: "p",
        text: "**Manage rules** (admin-only) lets you get an insight whenever a metric crosses a threshold you set:",
      },
      {
        type: "steps",
        items: [
          "Give the rule a name.",
          "Pick the metric to watch and a comparison (greater than, at least, less than, at most).",
          "Enter the threshold and choose a severity.",
          "Click **Add rule**. Toggle rules on and off, or delete them, from the list below.",
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: "Insights run on site installs — the feed reads the local sales cache, which isn't populated on the hub.",
      },
    ],
  },
  {
    slug: "reports-archive",
    title: "The reports archive",
    summary: "Where the operational, accounting, and reconciliation reports live.",
    category: "reports",
    audience: "managers",
    keywords: ["reports", "aged debtors", "aged creditors", "exposure", "reconciliation", "saved views", "print"],
    body: [
      {
        type: "p",
        text: "Reports is the printable archive. Pick a report from the toolbar at the top — they're grouped by category — and it opens filterable and chartable below.",
      },
      {
        type: "table",
        headers: ["Group", "Reports"],
        rows: [
          ["Accounts Receivable", "Aged Debtors, Sales Rep Exposure, Daily Sales Figures"],
          ["Accounts Payable", "Aged Creditors"],
          ["BAT Reconciliation", "Weekly Reconciliation, YTD Fee Breakdown, Exceptions Summary, Exceptions by Week"],
          ["Sales", "Sales by Vendor"],
          ["Inventory", "Value & Composition"],
        ],
      },
      {
        type: "p",
        text: "Each report has its own filters, date ranges, and export options once it's open. Use **Saved Views** to keep a filter setup you return to.",
      },
      {
        type: "callout",
        tone: "info",
        text: "Daily Sales Figures is only shown to users with the monthly-reports permission. What the BAT reconciliation figures mean is covered in the BAT & reconciliation section.",
      },
    ],
  },
  {
    slug: "trends",
    title: "Trends over time",
    summary: "Customer volume and flag rate, and inventory velocity, revenue, and seasonality.",
    category: "reports",
    audience: "managers",
    keywords: ["trends", "over time", "velocity", "seasonal", "revenue", "year over year", "customers", "sales"],
    body: [
      {
        type: "p",
        text: "Trends shows how things move over time, split into Customers and Inventory.",
      },
      { type: "h", text: "Customers" },
      {
        type: "list",
        items: [
          "**Record trends** — customer record volume and flag rate, bucketed weekly or monthly.",
          "**By sales** — customers ranked by sales value over a timeline you choose (3 to 24 months, or all time). Inter-branch transfers are excluded.",
        ],
      },
      { type: "h", text: "Inventory" },
      {
        type: "list",
        items: [
          "**Sales reports** — velocity, revenue, and order count, one line per calendar year; toggle the year chips to compare.",
          "**Mix** — revenue by commodity over time.",
          "**Movement** — dead-stock trend and top movers versus the prior year.",
          "**Seasonal** — the top 10 items per South African season.",
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: "Inventory trends build up from the sales cache — they appear once Inventory Movement → Sync has assembled enough months of history.",
      },
    ],
  },
];
