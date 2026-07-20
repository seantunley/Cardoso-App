// Customers-module articles. Written from the actual screens (CustomerSearch,
// CustomerBalances, Collections, and the shared CustomerLookup popup) and kept
// to what those screens visibly DO. Where meaning depends on team policy or
// credit logic (what each flag colour means in practice, how the credit score
// is calculated), the text says so rather than inventing a rule — those lines
// are the ones to confirm/expand with an SME.

/** @typedef {import('./../types.js').HelpArticle} HelpArticle */

/** @type {HelpArticle[]} */
export const customersArticles = [
  {
    slug: "finding-a-customer",
    title: "Finding a customer",
    summary: "Look up an account by name/number, by an invoice, or by a payment amount.",
    category: "customers",
    audience: "everyone",
    keywords: ["customer", "search", "lookup", "invoice", "amount", "deposit", "find", "account"],
    body: [
      {
        type: "p",
        text: "Customer Search is the starting point for reviewing an account. There are three ways to find who you're looking for.",
      },
      { type: "h", text: "By name or number" },
      {
        type: "p",
        text: "Type into the customer lookup box — a customer number or part of a name. Matching accounts appear as you type; use the arrow keys and **Enter**, or click, to open the account.",
      },
      { type: "h", text: "By invoice" },
      {
        type: "steps",
        items: [
          "Click **Find by invoice**.",
          "Enter an unpaid invoice number (for example, IN587925) and click **Search** to find the customer holding it.",
          "If it isn't found locally, use **Search older in Sage** with a date range to look directly in Sage 300. That search is read-only — nothing is stored.",
        ],
      },
      { type: "h", text: "By amount" },
      {
        type: "p",
        text: "**Find by amount** is for matching an unidentified bank deposit to an invoice. Enter the rand amount and pick a tolerance (Exact, or ±R 0.05 up to ±R 50.00). It searches every unpaid invoice and recent receipt within that tolerance, with the same Sage fallback if nothing matches locally.",
      },
      { type: "h", text: "Flagged customers" },
      {
        type: "p",
        text: "The three tiles at the top — Critical (red), Attention (orange), and Approved (green) — show how many accounts carry each flag. Click a tile to see that list and open any account from it.",
      },
    ],
  },
  {
    slug: "customer-balances",
    title: "Reading the Customer Balances screen",
    summary: "Filter, sort, and interpret the outstanding-balance list.",
    category: "customers",
    audience: "managers",
    keywords: ["balances", "outstanding", "ageing", "aging", "filter", "sales rep", "site", "print", "debtors"],
    body: [
      {
        type: "p",
        text: "Customer Balances lists accounts with money outstanding. The subtitle line always summarises the filters currently applied, so you can see at a glance what the list is (and isn't) showing.",
      },
      { type: "h", text: "Filtering" },
      {
        type: "list",
        items: [
          "**Last purchase** — All, 30+, 60+, 90+, 180+ days, or 1+ year since the last invoice.",
          "**Minimum balance** — hide small balances (Off, R3+, R10+, R100+, R1 000+).",
          "**Site** and **Sales rep** dropdowns narrow to one branch or rep.",
          "**Account type** — All, National accounts, or Standard accounts.",
          "**Dormant only** and **Hide invoice = balance** toggles.",
        ],
      },
      {
        type: "p",
        text: "Active filters show as chips you can clear individually, or clear all at once. Columns are sortable (click a header) and resizable (drag the edge).",
      },
      { type: "h", text: "The columns" },
      {
        type: "table",
        headers: ["Column", "What it shows"],
        rows: [
          ["Customer Name / ID", "Trading name and Sage account number."],
          ["Site / Sales Rep / Location / Terms", "From the Sage customer master."],
          ["Last Invoice", "Date of the most recent unpaid invoice."],
          ["Last Receipt", "Date of the most recent payment received."],
          ["Outstanding Balance", "Total currently owed."],
          ["Credit", "A credit verdict based on payment history and outstanding balance."],
        ],
      },
      {
        type: "callout",
        tone: "info",
        text: "On a site, the ageing tiles (1–7, 8–14, 15–21, and Over 21 days) appear above the list. On the hub, per-age detail isn't available, so a single Total outstanding tile is shown instead.",
      },
      {
        type: "p",
        text: "Click any row to open the full customer popup. Use **Refresh** to reload, and **Print / PDF** to produce a printable copy of the current, filtered list.",
      },
    ],
  },
  {
    slug: "customer-credit-and-flags",
    title: "Customer credit view and flags",
    summary: "What the customer popup shows, and how to set or change a flag.",
    category: "customers",
    audience: "managers",
    keywords: ["flag", "credit", "verdict", "score", "green", "orange", "red", "hold", "caution", "protected"],
    body: [
      {
        type: "p",
        text: "Opening an account (from search, a balances row, or a flagged list) brings up the customer popup. At the top is a credit verdict banner with a score out of 100; below it are the account header, the Invoices and Receipts tables, and a collapsible Payment History chart.",
      },
      {
        type: "callout",
        tone: "info",
        text: "The verdict and score are derived from payment history and outstanding balance. What the score thresholds mean for a credit decision is your team's policy — treat the banner as a summary, not an instruction.",
      },
      { type: "h", text: "Flags" },
      {
        type: "p",
        text: "The sticky bar at the bottom of the popup sets the account's flag: No Flag, Green, Orange, or Red. A flag needs a reason.",
      },
      {
        type: "steps",
        items: [
          "Pick a flag colour (or **No Flag**).",
          "Type a reason in the box.",
          "Click **Apply**. Removing a flag asks for a separate removal reason.",
        ],
      },
      {
        type: "callout",
        tone: "warning",
        text: "A flag can be **Protected** — if you didn't create it (and you're not an admin), you'll see a Protected badge and can't change it. This stops one person quietly overriding another's decision.",
      },
      {
        type: "callout",
        tone: "info",
        text: "What Green / Orange / Red mean in day-to-day practice is set by your team, not by the app. The colours are the shared vocabulary; the policy behind them is yours.",
      },
    ],
  },
  {
    slug: "collections-worklists",
    title: "Working collections",
    summary: "Worklists, assigning customers, logging activity, and statuses.",
    category: "customers",
    audience: "managers",
    keywords: ["collections", "worklist", "chase", "assign", "escalate", "write off", "promise", "follow-up", "rep"],
    body: [
      {
        type: "p",
        text: "Collections keeps each rep on their assigned customers. Auto-detected payments drop off the list; everything else stays until it's actioned manually.",
      },
      { type: "h", text: "Worklists" },
      {
        type: "p",
        text: "The left sidebar lists worklists, each showing its owner and how many customers are active vs collected. Click **New** to create one — you become its owner. Filter the customers within a worklist by status (Active, Collected, Escalated, All) or by typing in the filter box.",
      },
      { type: "h", text: "Assigning customers" },
      {
        type: "p",
        text: "**Assign customers** (available to the worklist owner or an admin) opens a pool you can filter by rep, minimum outstanding, and days overdue. Tick the customers to add. Accounts already on another list are hidden or shown as blocked, so a customer is never on two lists at once.",
      },
      { type: "h", text: "Actioning a customer" },
      {
        type: "p",
        text: "Click a row to open the customer drawer. From there you can log a note, record a contact outcome, record a promise to pay (amount, date, optional note), and set a follow-up date. The Status buttons let you Escalate, Write off, Close, or Reopen — the destructive ones ask you to confirm. Every action is kept in the Timeline.",
      },
      {
        type: "p",
        text: "Tick several rows to act on them together (Escalate, Close, Write off), or use **Print** for a copy of the current list.",
      },
    ],
  },
];
