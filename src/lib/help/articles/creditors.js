// Creditors (vendor/supplier) articles. Written from the actual screens
// (Creditor Balances, Creditor Search, and the Vendor detail popup). The one
// genuinely subtle concept here — "true outstanding" vs Sage's posted figure
// when there are unposted batches — is explained on-screen by the app's own
// info tooltip, so this article uses that wording rather than inventing it.
// Sage table codes in the tooltips (APOBL, PORCPH1, …) are left out.

/** @typedef {import('./../types.js').HelpArticle} HelpArticle */

/** @type {HelpArticle[]} */
export const creditorsArticles = [
  {
    slug: "creditor-balances",
    title: "Reading Creditor Balances",
    summary: "Vendors you owe — filtering, ageing, and the unposted-batch adjustment.",
    category: "creditors",
    audience: "managers",
    keywords: ["creditors", "vendors", "suppliers", "balances", "outstanding", "ageing", "unposted", "sync", "payables"],
    body: [
      {
        type: "p",
        text: "Creditor Balances (\"Who you owe\") lists vendors with an outstanding balance. The columns are Code, Vendor, Terms, Last receipt, Last payment, YTD receipts, and Outstanding. Click a header to sort — it opens sorted by Outstanding, largest first.",
      },
      { type: "h", text: "Filtering" },
      {
        type: "list",
        items: [
          "**Outstanding balance** bands (< R1k up to > R250k).",
          "**Last receipt** and **Last payment** age bands (30+ days up to 1+ year, or Never).",
          "Toggles: **Has payment history**, **Active vendors only**, and **Include zero balances**.",
        ],
      },
      {
        type: "p",
        text: "Active filters show as chips you can clear individually or all at once. The ageing tiles above the list break the total into 1–30, 31–60, 61–90, and over-90-day buckets.",
      },
      { type: "h", text: "Posted vs. true outstanding" },
      {
        type: "callout",
        tone: "info",
        text: "The ageing tiles show Sage's POSTED figures only. Invoices and payments captured in batches that accounts hasn't posted yet can't be placed in an ageing bucket, so they adjust a separate \"true outstanding\" line instead. That line disappears once the batches post. A row with an amber dot has unposted activity — hover it for the breakdown.",
      },
      {
        type: "p",
        text: "On a site, **Sync from Sage** pulls the latest vendor, invoice, payment, and PO data, and **Print / PDF** produces a copy of the filtered list. On the hub the page is read-only across branches, with a branch filter in place of the sync button.",
      },
    ],
  },
  {
    slug: "creditor-search-and-detail",
    title: "Vendor search and detail",
    summary: "Look up a vendor and review its receipts, invoices, payments, and POs.",
    category: "creditors",
    audience: "managers",
    keywords: ["vendor", "search", "creditor", "detail", "receipts", "invoices", "payments", "purchase orders"],
    body: [
      {
        type: "p",
        text: "Creditor Search finds a vendor fast. Type a vendor code or supplier name (two characters is enough) and pick from the results — each shows the code and whether the vendor is active. The full detail opens in a popup. Three tiles at the top summarise the vendor count, true outstanding, and any unposted batches.",
      },
      { type: "h", text: "The vendor detail popup" },
      {
        type: "p",
        text: "The popup header shows the vendor's outstanding position (with the posted-vs-true breakdown when there are unposted adjustments), terms, contact details, and the last payment and receipt dates. Below that are four tabs:",
      },
      {
        type: "table",
        headers: ["Tab", "Shows"],
        rows: [
          ["Receipts", "Goods received from the vendor, grouped by receipt — expand a row for the line detail."],
          ["Open invoices", "Outstanding AP invoices, with document, dates, original and outstanding amounts, and a total."],
          ["Payments", "Payments made to the vendor — method, bank, reference, amount, and a total."],
          ["Purchase orders", "Issued POs, expandable to their lines (ordered, received, unit cost)."],
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: "The same popup opens from a row on the Creditor Balances page (on a site). A ?code= link opens a specific vendor directly.",
      },
    ],
  },
];
