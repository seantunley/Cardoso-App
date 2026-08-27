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
    slug: "invoice-profit",
    title: "Invoice Profit",
    summary: "Selling, cost and profit on every invoice, rolled up by day, week and month.",
    category: "reports",
    audience: "managers",
    keywords: ["profit", "margin", "cost", "gross profit", "invoice profit", "selling", "markup", "gp", "daily profit", "weekly profit", "monthly profit"],
    body: [
      {
        type: "p",
        text: "**Reports → Sales → Invoice Profit** shows what each invoice actually made. Every document carries its selling value, its cost and the profit between them, and those add up through three levels — day, week and month.",
      },
      { type: "h", text: "Reading the report" },
      {
        type: "p",
        text: "The four cards across the top adapt to the range. Over a single month they are the to-date figures — the latest trading day, the week and month that day falls in, and the range total. Over a longer range those would each describe a sliver of the final month, so you get the range total, the best and weakest months, and a monthly average instead.",
      },
      {
        type: "steps",
        items: [
          "Set the **From** and **To** dates. It opens on the current month to date.",
          "Click a **month** row to open its weeks.",
          "Click a **week** row to open its days.",
          "Click a **day** row to see every invoice and credit note raised that day.",
          "Click an **invoice** to see the stock lines behind it — item, quantity, unit price, and the selling, cost, profit and margin of each line.",
        ],
      },
      {
        type: "table",
        headers: ["Column", "What it is"],
        rows: [
          ["Selling", "The invoice total excluding VAT — the same figure the Daily Sales Figures report shows."],
          ["Cost", "What the stock on that invoice cost, as Sage costed it onto the document when it was raised."],
          ["Profit", "Selling less Cost. Red when negative."],
          ["Margin", "Profit as a percentage of Selling."],
          ["Inv / CN", "How many invoices and credit notes are in that day, week or month."],
        ],
      },
      { type: "h", text: "Finding the bad ones" },
      {
        type: "p",
        text: "The **Show** dropdown narrows the report to the invoices worth investigating:",
      },
      {
        type: "list",
        items: [
          "**Invoices that made no profit** — everything at R0 profit or below, including break-even.",
          "**Invoices in a profit range** — give a lower bound, an upper bound, or both. The **R / %** switch beside the boxes decides whether those bounds mean rand of profit or margin percentage. Bounds include their endpoints, and a blank box means unbounded, so leaving \"from\" empty and typing 5 into \"to\" gives you everything that made R5 or less.",
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: "While a filter is on, every total on the page — the cards, the day/week/month rollups and the exports — covers the matching invoices only, and the orange bar at the top says how many matched. Credit notes are left out of a filtered view: each one reverses a sale, so they all carry a negative profit and would swamp the genuinely loss-making invoices.",
      },
      { type: "h", text: "What the numbers include" },
      {
        type: "list",
        items: [
          "**Credit notes are netted off** — they appear as their own rows with negative selling, cost and profit, so every subtotal is a net figure.",
          "**Inter-branch transfers are excluded** — stock moved between depots is an internal movement at cost, not a sale, and the same stock is invoiced again when the receiving branch sells it. The line at the foot of the report says how much was left out.",
          "**Amounts are ex-VAT**, in Rand.",
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: "Cost is the cost Sage recorded on the invoice at the time — not the item's current cost. That means a month you printed last year prints the same figures today; the report never restates itself when a cost changes.",
      },
      {
        type: "callout",
        tone: "tip",
        text: "**PDF** gives you the day/week/month rollup on a landscape sheet (the per-invoice detail lives in Excel, which is the right tool for 2,000 rows). **Excel** gives you three sheets: the day/week/month rollup, one row per invoice (filter-ready, for pivoting), and a Notes sheet explaining the rules — so a workbook you email on still explains itself.",
      },
      {
        type: "p",
        text: "A week that starts in one month and ends in the next is shown under **both** months, marked **part**, holding only that month's days. That way each level is exactly the sum of the level below it and a month total is never inflated by days outside it.",
      },
      {
        type: "callout",
        tone: "warning",
        text: "This report shows cost and margin, so it sits behind the same monthly-reports permission as Daily Sales Figures.",
      },
      { type: "h", text: "On the hub" },
      {
      type: "p",
        text: "The hub shows the same profit figures for every branch, as totals only. Pick **Day**, **Week**, **Month** or **Year**, and each row opens to show the branches that make it up.",
      },
      {
      type: "p",
        text: "The hub deliberately keeps no invoices \u2014 every branch row carries an **invoices \u2192** link that opens that branch's own Invoice Profit report, already set to that period's dates. The detail stays where it was raised, so there is only ever one copy of it and it cannot drift from the totals.",
      },
      {
      type: "callout",
      tone: "info",
        text: "Hub figures arrive with the branch sync, so they are as fresh as the last sync rather than live \u2014 the time of the most recent one is shown beside the period buttons. A branch that has never synced simply does not appear yet.",
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
