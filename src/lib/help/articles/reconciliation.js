// BAT & reconciliation articles — DRAFT pending SME (Sean) review.
//
// This is the most business-sensitive module, so every business statement here
// is taken verbatim (or near-verbatim) from the app's OWN on-screen tooltips —
// e.g. the Total BAT / Total Sage / Total Variance tile tooltips define exactly
// what those figures are. Nothing is inferred. Terms the UI does NOT define
// (the precise Paid vs Non-Compliant vs Exceptions vs Missing-PODs distinction,
// TG1/TG2 rates, the integrity invariants) are described only at the mechanical
// level and flagged for Sean in the PR — NOT invented here. See the memory
// note feedback_bat_total_is_claim: BAT TOTAL is the claim summary, never
// re-derived from POD per-row data.

/** @typedef {import('./../types.js').HelpArticle} HelpArticle */

/** @type {HelpArticle[]} */
export const reconciliationArticles = [
  {
    slug: "bat-overview",
    title: "What BAT reconciliation does",
    summary: "Comparing what BAT claims against the credit notes posted in Sage.",
    category: "reconciliation",
    audience: "managers",
    keywords: ["bat", "reconciliation", "variance", "credit notes", "sage", "week", "claim"],
    body: [
      {
        type: "p",
        text: "BAT reconciliation compares what the BAT supplier says they owe against what Sage 300 has actually captured. You upload BAT's weekly reconciliation spreadsheets, and the app checks them against the credit notes posted in Sage.",
      },
      {
        type: "p",
        text: "The dashboard (\"The BAT ledger\") leads with three totals for the selected year:",
      },
      {
        type: "table",
        headers: ["Tile", "What it is (from the app)"],
        rows: [
          ["Total BAT", "The sum of every BAT supplier spreadsheet you've uploaded — what BAT says they owe in credit notes."],
          ["Total Sage", "The sum of all credit notes actually posted in Sage 300 against the BAT supplier this year."],
          ["Total Variance", "Total BAT − Total Sage. Positive means BAT is claiming more than Sage has captured; negative means Sage has captured more than BAT claimed."],
        ],
      },
      {
        type: "p",
        text: "Below the totals, \"BAT vs Sage by week\" breaks the year down week by week and by fee. Use the Year selector in the header to focus on one calendar year (it's remembered between sessions).",
      },
      {
        type: "p",
        text: "From here you **Upload BAT Week** (the supplier spreadsheet), **Download Cardoso Invoices** (pulled from Sage or uploaded), and then open a week to review it in detail.",
      },
    ],
  },
  {
    slug: "bat-reviewing-a-week",
    title: "Reviewing a BAT week",
    summary: "Fee comparison, OCR on the PODs, and the invoice audit trail.",
    category: "reconciliation",
    audience: "managers",
    keywords: ["week", "fee", "ocr", "pod", "invoice", "exception", "non-compliant", "audit"],
    body: [
      {
        type: "p",
        text: "Opening a week shows its BAT Total, Sage Total, Variance, and a \"Needs Attention\" count, then a fee-by-fee comparison and a per-invoice audit trail.",
      },
      { type: "h", text: "Fee comparison" },
      {
        type: "p",
        text: "The fee table lines up BAT (excl VAT) against Sage 300 for each fee type, with a status: green when the two agree within R 0.01, amber for a minor variance within tolerance, and red for a material difference that needs investigation.",
      },
      { type: "h", text: "PODs and OCR" },
      {
        type: "p",
        text: "**Refresh Sage** re-pulls the Sage figures. **Extract Invoices (OCR)** reads the Cardoso invoice numbers off the proof-of-delivery (POD) PDFs. If OCR is paused in Settings → Reconciliation, the button is disabled until you resume it; **Retry** re-runs OCR with a fallback engine for any that failed.",
      },
      { type: "h", text: "The audit trail" },
      {
        type: "p",
        text: "Invoices are grouped into tabs — **Paid Invoices**, **Non-Compliant**, **Exceptions**, and **Missing PODs** — each with a count and total. Each row shows the order, store, dates, OCR status, and the invoice number, which you can edit to override what OCR found. Search and per-column tooltips help you work the list.",
      },
      {
        type: "callout",
        tone: "warning",
        text: "The invoice numbers OCR reads from the PODs are for verification — matching each delivery to its Cardoso invoice. The claim totals come from BAT's spreadsheet, not from adding up the PODs.",
      },
    ],
  },
  {
    slug: "bat-hub-summary",
    title: "BAT across all sites (hub)",
    summary: "The read-only, fleet-wide reconciliation summary on the hub.",
    category: "reconciliation",
    audience: "managers",
    keywords: ["hub", "bat", "sites", "summary", "variance", "stale", "refresh"],
    body: [
      {
        type: "p",
        text: "On the hub, \"Sites at a glance\" rolls up every connected site's BAT reconciliation. It's read-only — uploading and OCR happen on each site — and it syncs once a day.",
      },
      {
        type: "p",
        text: "Network tiles total BAT, Credit Notes, and Variance across the fleet and show how many sites are reporting, stale, or in error. Each site card shows its own BAT / Credit Notes / Variance, its last BAT week and last paid week, and flags for mismatches or missing credit notes.",
      },
      {
        type: "p",
        text: "Click **Refresh now** to pull from every site immediately, or **Open** on a card to jump into that site.",
      },
    ],
  },
  {
    slug: "jti-monthly-export",
    title: "JTI monthly exports",
    summary: "Generating the JTI sales export on a site, and bundling it on the hub.",
    category: "reconciliation",
    audience: "managers",
    keywords: ["jti", "export", "monthly", "accpac", "vendor", "bundle", "archive"],
    body: [
      {
        type: "p",
        text: "The JTI page produces a vendor-scoped sales export as an Excel file, matching the existing macro output.",
      },
      {
        type: "steps",
        items: [
          "Set the install defaults once (town/city, region, country, and the site label used in the filename).",
          "Choose a date range — a preset (This month, Last month, etc.) or a custom From/To.",
          "Click **Generate JTI export** to download the .xlsx.",
        ],
      },
      {
        type: "p",
        text: "A full-month export is also generated automatically on the 1st of each month for the previous month. Past exports appear in the archive table to re-download, and are pushed to the hub.",
      },
      {
        type: "callout",
        tone: "info",
        text: "On the hub, JTI exports are grouped by month; a month becomes downloadable as one bundle (ZIP) once every expected site has reported.",
      },
    ],
  },
];
