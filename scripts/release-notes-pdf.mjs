// Build a customer-facing "Product Update" PDF.
//
// The notes are curated (hand-written in customer language) rather than a raw
// git dump — commit subjects are internal shorthand and not suitable for
// customers. Add an entry to RELEASES for each update, then run:
//
//   node scripts/release-notes-pdf.mjs              (latest release)
//   node scripts/release-notes-pdf.mjs 2026-05-28   (a specific date)
//
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { jsPDF } from 'jspdf';

// ---- Content (curated), keyed by ISO date ---------------------------------
const RELEASES = {
  '2026-06-09': {
    product: 'Cardoso App',
    title: 'Product Update',
    date: '9 June 2026',
    slug: '09-June-2026',
    intro:
      "This update brings head-office reporting across branches to the whole " +
      "reporting suite: every report and the Reporting Dashboard can now be viewed " +
      "for all branches consolidated, or narrowed to a single branch, and the " +
      "dashboard's sales and inventory highlights now work at head office. It also " +
      "adds at-a-glance dashboard tiles, a daily sales report, a new customers-by-" +
      "sales view, clearer charts, on-screen help, and several accuracy and " +
      "permission fixes. Every figure continues to be drawn from, and reconcile " +
      "to, Sage.",
    sections: [
      {
        label: 'NEW',
        heading: 'New Features',
        items: [
          {
            title: 'Head-office branch filtering across the reporting suite',
            body:
              "At head office, every report and the Reporting Dashboard now show all " +
              "branches consolidated by default, with a Branch selector to focus on a " +
              "single branch.",
            details: [
              "A consistent 'All branches / pick one' Branch selector on Aged Debtors, Aged Creditors, Sales Rep Exposure, Inventory Value and Monthly Sales Figures.",
              "The Reporting Dashboard gains one Branch selector that filters every card and the headline customer figures together.",
              "Consolidated is the default everywhere: totals sum across every branch that has reported in, and choosing a branch narrows the same view.",
              "The dashboard's customer counts and flag totals now read from the consolidated head-office data (previously they could show as zero at head office).",
              "BAT reconciliation, an operational per-branch process, shows a clear 'open on a branch' note rather than an empty page.",
            ],
          },
          {
            title: 'Reporting Dashboard — sales & inventory highlights',
            body:
              "Three new at-a-glance tiles on the Reporting Dashboard surface the " +
              "month's best sellers, the costliest dead stock and the biggest " +
              "customers, each as a compact ranked list.",
            details: [
              "Top Items Sold this month by units, showing the item code and description.",
              "Top Dead Stock: the highest-value items still in stock with no sale in the last three months.",
              "Top Customers by sales value over the last 12 months.",
              "Inter-branch stock transfers are excluded from all three, so the figures reflect real customer trade.",
              "At head office these consolidate across branches and follow the dashboard's Branch selector; the underlying figures are brought up from each branch automatically.",
              "Each tile links through to the fuller view in Trends.",
            ],
          },
          {
            title: 'Daily Sales Figures report',
            body:
              "A new report breaking the current month's posted invoices, credit " +
              "notes and debit notes down by day, with VAT shown separately — the " +
              "daily companion to the Monthly Sales Figures report.",
            details: [
              "Day-by-day rows for the current month with a Net column (Invoices + Debit notes - Credit notes) and a totals row.",
              "Same Sage source as the Monthly Sales Figures, so the two reconcile.",
              "Amounts in Rand, exportable to CSV, and printable with the standard header.",
              "Grouped under the Monthly Reports permission, alongside Monthly Sales Figures.",
            ],
          },
          {
            title: 'Customers by Sales (Trends)',
            body:
              "A new view under Trends > Customers that ranks customers by sales " +
              "value over a timeline you choose.",
            details: [
              "Full ranked table of customers by sales value, with a units column and a relative bar.",
              "Timeline filter: last 3, 6, 12 or 24 months, or all time.",
              "Inter-branch transfers excluded so the ranking reflects real customers.",
              "The Customer area now uses the same tabbed layout as Inventory (Record trends / By sales), with the filter in a consistent place.",
            ],
          },
        ],
      },
      {
        label: 'IMPROVED',
        heading: 'Improvements',
        items: [
          {
            title: 'Aged Creditors - filter by payment history',
            body:
              "The Aged Creditors report gains a Payments filter, on by default, " +
              "matching the Creditor Balances page and the dashboard tile.",
            details: [
              "'With payment history' (default) hides never-paid accounts; switch to 'All vendors' to include them.",
              "The choice flows through to the PDF and Excel exports and the printed filter line.",
            ],
          },
          {
            title: 'BAT weekly chart - total value per week',
            body:
              "The second chart on the BAT Weekly Reconciliation report now shows " +
              "each week's BAT and Sage credit-note totals, replacing a variance line " +
              "that sat flat at zero on a clean reconciliation and carried no useful scale.",
            details: [
              "Per-week BAT supplier total and Sage credit-notes total, in Rand.",
              "The two lines track closely when a week reconciles; a visible gap is that week's variance.",
            ],
          },
          {
            title: 'On-screen help across the new screens',
            body:
              "Hover tooltips explain the new dashboard tiles, filters, charts and " +
              "table columns, so it is clear what each figure means and how it is derived.",
            details: [
              "Each dashboard tile explains what it ranks and that inter-branch transfers are excluded.",
              "Filters and table headers (units vs sales value, timelines, the branch selector) carry short explanations.",
            ],
          },
          {
            title: 'Item descriptions on sold-item figures',
            body:
              "Sold-item figures now carry the item description alongside the code, " +
              "captured automatically as sales are synced from Sage.",
            details: [
              "The Top Items tile shows 'code - description' once a sales sync has run.",
              "Descriptions travel with the sales data, so they are available even where the item master has not been loaded.",
            ],
          },
          {
            title: 'Rand symbols on the sales reports',
            body:
              "The Monthly and Daily Sales Figures reports now show the Rand (R) " +
              "symbol against every amount, for South African currency clarity.",
            details: [
              "Consistent 'R' prefix on every figure and the totals row, on screen and in exports.",
            ],
          },
        ],
      },
      {
        label: 'FIXED',
        heading: 'Fixes',
        items: [
          {
            title: 'Inter-branch transfers excluded from sales figures',
            body:
              "Internal stock transfers between branches are no longer counted as " +
              "customer sales in the dashboard sales tiles or the customers-by-sales view.",
            details: [
              "Previously the largest 'customer' could be an inter-branch transfer account; these are now filtered out so the figures reflect real trade.",
            ],
          },
          {
            title: 'Daily Sales Figures access aligned with Monthly Reports',
            body:
              "The Daily Sales Figures report is now governed by the same Monthly " +
              "Reports permission as the Monthly Sales Figures report.",
            details: [
              "Users without the Monthly Reports permission no longer see or can reach the daily figures, closing a gap where the same posted-document totals were otherwise reachable.",
            ],
          },
          {
            title: "Sage query 'Reset to default' now reverts fully",
            body:
              "In Settings > Sage Queries, resetting a query to its default now " +
              "reliably restores the shipped query.",
            details: [
              "On installs upgraded from the older per-module settings, a reset could fall back to a previously saved query; it now clears cleanly to the default.",
              "The editor also accepts the shipped defaults that begin with a leading semicolon, so they can be copied, adjusted and saved.",
            ],
          },
          {
            title: 'Aged Debtors data sync reports failures honestly',
            body:
              "When the nightly Aged Debtors open-item sync cannot reach Sage or hits " +
              "a bad query, it now reports a failure instead of recording a successful run.",
            details: [
              "Previously a failed run could still stamp a 'last synced' time, making stale data look fresh; the sync now surfaces the error to the screen and to the scheduled-job status.",
            ],
          },
        ],
      },
    ],
  },
  '2026-06-08': {
    product: 'Cardoso App',
    title: 'Product Update',
    date: '15 May to 8 June 2026',
    slug: 'mid-May-to-08-June-2026',
    intro:
      "This update spans mid-May to early June 2026 and represents a substantial " +
      "expansion of the platform: two new financial modules (Creditors and Sales " +
      "Commission), a Sage-faithful aging system for both debtors and creditors, " +
      "new inventory and sales analytics, a reporting dashboard with a proactive " +
      "insights feed, multi-site consolidation at head office, and a broad set of " +
      "usability, performance and accuracy improvements. Every figure is drawn " +
      "from, and reconciles to, Sage. The detail below itemises what each module, " +
      "improvement and fix delivers.",
    sections: [
      {
        label: 'NEW',
        heading: 'New Modules & Features',
        items: [
          {
            title: 'Creditors (Accounts Payable) module',
            body:
              "A complete new accounts-payable area for managing supplier accounts, " +
              "fed from Sage and reconciled and refreshed automatically every night " +
              "so the figures on screen are always current.",
            details: [
              "Creditor Summary screen showing each vendor's outstanding balance, with header totals, resizable columns and a tidy, dense layout.",
              "Creditor Search to look a supplier up by code or name and drill into its open documents and full payment history.",
              "Automated nightly sync from Sage built on column names verified against the live Sage database (replacing earlier guessed names), so balances and payments are correct.",
              "Correct supplier-payment matching, so receipts are applied to the right documents and fully paid vendors drop off.",
              "A 'has payment history' filter, on by default, that hides never-paid and zero-balance vendors so the list shows who you actually trade with.",
              "A Settings tab where an administrator can override the Sage query and choose how many months of history to load, with no code change.",
              "A dedicated access permission (administrators granted automatically), and its own sidebar group ordered to mirror the Customer module.",
              "A head-office mirror so creditor balances can be consolidated across every branch.",
            ],
          },
          {
            title: 'Aged Creditors report (Sage Aged Payables method)',
            body:
              "A new report that ages every open supplier document the way Sage's " +
              "Aged Payables trial balance does, instead of dropping a whole balance " +
              "into a single period.",
            details: [
              "Built on a shared, tested Sage-300 aging engine that also powers the Aged Debtors report.",
              "Ages each open document by its due date into Sage's monthly periods: Current, 1-30, 31-60, 61-90 and Over 90 days.",
              "Distributes a vendor across several periods document by document, exactly matching the Sage Aged Payables trial balance.",
              "Reconciles to the live Sage open-item total to the cent.",
              "Per-period columns with a totals row; downloads as a polished PDF or an Excel workbook that matches the on-screen view.",
              "Reachable from both the Reports area and the Creditors module (by either permission).",
              "Head-office all-sites support, with a Site column and correct per-site vendor scoping.",
              "Credit balances shown with the correct sign, so the screen and the downloads agree.",
            ],
          },
          {
            title: 'Aged Debtors, rebuilt on the Sage open-item ledger',
            body:
              "The customer aging report was rebuilt on a new accounts-receivable " +
              "open-item ledger synced from Sage, so every open invoice, credit note " +
              "and debit note is aged individually rather than approximating a " +
              "customer's whole balance from the oldest invoice.",
            details: [
              "A new open-item ledger, synced nightly from Sage, holding each open document with its dates and amounts.",
              "Sage weekly periods: Current, 1-7, 8-14, 15-21 and Over 21 days, aged by document date to match Sage.",
              "Each document placed in its own period, so a customer correctly appears across several buckets.",
              "Customers belonging to a national account roll up under the parent account and inherit its sales rep and account type.",
              "Reconciles to the live Sage open items rather than a master balance that had drifted from the underlying invoices.",
              "Sales-rep, account-type, site and minimum-balance filters, with CSV, PDF and Excel export.",
              "Head-office all-sites support with a Site column.",
            ],
          },
          {
            title: 'Monthly Sales Figures report',
            body:
              "A new month-by-month summary of posted invoices, credit notes and " +
              "debit notes with VAT separated, sourced live from the Sage invoice " +
              "batches and matching your existing Sage 'Sales Figures' report to the cent.",
            details: [
              "Sourced from Sage's posted invoice batches, with the document type (invoice / credit note / debit note) read directly from Sage.",
              "Excludes error batches and zero-VAT documents, exactly as the operator's report does, so the totals match precisely.",
              "Ex-VAT, VAT and Inclusive figures for each document type, a Net line (Invoices + Debit notes - Credit notes), monthly rows and grand totals.",
              "The current month is highlighted; exports to CSV and prints with the branded header.",
              "At head office each branch's figures are synced down and shown both per branch and consolidated across the group.",
            ],
          },
          {
            title: 'Sales Commission reporting',
            body:
              "Monthly sales-commission reports that reproduce your existing " +
              "spreadsheet, drawn directly from Sage, with automatic archiving and " +
              "careful per-rep accuracy.",
            details: [
              "Sage-native queries that reproduce the operator spreadsheet, including the Sweets and Cigarettes+Tobacco splits and reference rate.",
              "Commission calculated on paid sales, with a clear, collapsible per-rep breakdown of any unpaid invoices.",
              "A clawback workflow for invoices that remain unpaid across periods, floored at zero so a return or credit note never credits the rep.",
              "Automatic month-end archiving, bundled per site as PDFs and pushed to head office, with safe re-runs of closed periods.",
              "A printed report with dedicated Unpaid Invoices and Clawback pages and right-aligned numeric columns.",
              "An administrator query-override panel and a configurable filename branch tag.",
            ],
          },
          {
            title: 'Inventory & sales analytics (Trends)',
            body:
              "New reporting that compares inventory and sales year over year, " +
              "highlights top sellers by season and surfaces slow-moving stock, for a " +
              "single site or the whole group.",
            details: [
              "Customer and Inventory views, the Inventory view split into Sales reports, Seasonal, Mix and Movement sub-views.",
              "Top ten items per South African season, with commodity codes shown as names (Sweets / Cigarettes / Tobacco / Mixed).",
              "Year-over-year charts that enumerate every year in the data (no rolling-window gaps), with a site filter.",
              "Dead-stock view restricted to stock currently held, so the list is actionable.",
              "Inventory history extended to three calendar years to support the comparisons, with operator-friendly chart subtitles.",
            ],
          },
          {
            title: 'Reporting Dashboard & Sage health',
            body:
              "A new at-a-glance home for reporting: headline figures and a summary " +
              "card for each report, with a strip that shows whether your Sage data " +
              "is current.",
            details: [
              "Summary cards for Aged Debtors, Aged Creditors, Sales Rep Exposure, Inventory Value and BAT, each opening the full, filterable report in one click.",
              "A Sage health panel that shows 'Unavailable' rather than a misleading green when the connection cannot be reached.",
              "The Aged Creditors card is filtered to vendors you actually pay, and the Aged Debtors headline matches the Customer Balances screen.",
            ],
          },
          {
            title: 'Proactive Insights feed with no-code rules',
            body:
              "The application now surfaces what needs attention on its own, as a " +
              "ranked feed, rather than waiting for someone to open a report.",
            details: [
              "Detects falling sales, customers buying less, dead stock building up and large debtor exposure.",
              "Administrators can add their own rules in plain language (for example, alert me if revenue drops more than 10%).",
              "The feed is pre-computed and cached after the nightly sync and refreshed when data changes, so it loads instantly.",
            ],
          },
          {
            title: 'Reorder planning',
            body:
              "See exactly what to order and when: items at or below their reorder " +
              "point, grouped by supplier, with an exportable purchase sheet.",
            details: [
              "Click any item to view its sales trend and seasonality before committing to an order.",
            ],
          },
          {
            title: 'Inventory Movement',
            body:
              "A new view of how quickly stock is selling, so slow and dead stock is " +
              "easy to spot.",
            details: [
              "Sell-through velocity per item, with dead-stock highlighting.",
              "Figures roll up across sites for a group-wide picture at head office.",
            ],
          },
          {
            title: 'Stock Receipt Expiry tracking',
            body:
              "Capture expiry dates against stock as it is received, kept in step " +
              "with your Sage purchase orders, so you can stay ahead of short-dated stock.",
            details: [
              "Per-line expiry capture as goods are received against a Sage purchase order.",
              "Reversed receipt lines are reconciled automatically, so quantities stay correct.",
            ],
          },
          {
            title: 'Monthly Reports menu, with its own access control',
            body:
              "A new Monthly Reports area groups the Monthly Sales Figures and Sales " +
              "Commission reports together, behind a single permission so you decide " +
              "who can see them.",
            details: [
              "Administrators and anyone who already had Sales Commission access keep it automatically.",
            ],
          },
          {
            title: 'Collections, price lists and account families',
            body:
              "Several day-to-day tools to chase money and find the right account.",
            details: [
              "Collections worklists keep each rep on their assigned outstanding accounts; auto-detected payments come off the list and everything else stays manual.",
              "A printable price list on your letterhead for quick reference.",
              "Linked customer accounts: a prefixed sub-account now shows its full account family, navigable from either side.",
              "A tool that tidies up Sage credit-note descriptions for cleaner, more consistent records.",
            ],
          },
          {
            title: 'Downloadable reports, fast search and saved views',
            body:
              "Reports are easy to share and file, and the whole application is " +
              "quicker to move around.",
            details: [
              "Aged Debtors and Sales Rep Exposure download as a polished PDF or an Excel workbook that matches your on-screen filters.",
              "A command palette (Ctrl/Cmd-K) jumps to any page or report instantly.",
              "A notifications bell flags anything needing attention from anywhere in the app.",
              "Report filters are kept in the page link, so a filtered view can be bookmarked or shared, and favourite views saved and reopened in one click.",
            ],
          },
        ],
      },
      {
        label: 'IMPROVED',
        heading: 'Improvements',
        items: [
          {
            title: 'Balances that reconcile to Sage',
            body:
              "Customer and creditor balances are now built directly from Sage's " +
              "open items, so on-screen totals match Sage to the cent rather than a " +
              "balance that could drift over time.",
            details: [
              "Aging summary tiles on the Customer Balances and Creditor Balances screens that always match the filter you have applied.",
              "The Customer Balances age filter is driven from the open-item ledger, so filtering by period is accurate.",
              "Location and Terms shown per customer, with a National / Standard account filter.",
            ],
          },
          {
            title: 'Branded, print-ready reports',
            body:
              "Every report now prints as a professional document.",
            details: [
              "Your depot name (from Settings) and logo appear as a header on every report's print and PDF.",
              "Reports fit a single landscape page, print in solid black for clarity, and no longer carry a faint watermark.",
              "Fixed a long-standing issue where the branded header did not appear at all when printing.",
            ],
          },
          {
            title: 'Clearer navigation and tidier screens',
            body:
              "The application is easier to find your way around.",
            details: [
              "Menus reorganised into logical groups; the sidebar tidied into a compact account menu; redundant section labels removed.",
              "Explanatory tooltips added across the new modules.",
              "Pagination now includes first/last page jumps and a go-to-page box for long lists; summary tables support resizable columns.",
              "Page headings share a single consistent style across the application.",
            ],
          },
          {
            title: 'Faster, smoother performance',
            body:
              "Reports and dashboards load noticeably faster and feel more responsive.",
            details: [
              "A dedicated frontend performance pass, plus database query optimisations (including replacing a slow reconciliation query and a faster, cached insights query).",
              "Tidy loading placeholders instead of blank screens, and a one-click retry if something fails to load.",
              "Configurable data sync: administrators can tune how supplier data is retrieved and how much history is loaded.",
            ],
          },
        ],
      },
      {
        label: 'FIXED',
        heading: 'Fixes & Reliability',
        items: [
          {
            title: 'Accurate local timestamps',
            body:
              "Recorded dates and times now consistently reflect local (UTC+2) time " +
              "across the application.",
            details: [
              "A central time function used everywhere, with an automated guard that prevents the old behaviour creeping back in.",
            ],
          },
          {
            title: 'Problems are surfaced, not hidden',
            body:
              "Issues that previously went unreported are now raised clearly, with " +
              "system-log telemetry across modules, so they can be resolved sooner.",
            details: [
              "Several boot and runtime errors exposed when switching between single-site and head-office views were resolved.",
              "Head-office multi-site isolation and permission handling were tightened so each site's data and access stay separate.",
            ],
          },
          {
            title: 'Commission report accuracy',
            body:
              "The commission figures and printed report were corrected in several ways.",
            details: [
              "Dedicated Unpaid Invoices and Clawback pages in the printed report.",
              "Clawback floored at zero and no longer treats returns or credit notes as a credit to the rep.",
              "The commission-at-risk total now adds up correctly, and a row-multiplication error was fixed.",
            ],
          },
          {
            title: 'Cleaner, correct report figures',
            body:
              "Balance, payment and aging figures were corrected across a number of " +
              "reports and screens so the headline and the detail always agree.",
            details: [
              "The customer pop-up shows only genuinely outstanding invoices and receipts; anything paid or matched off (within a small rounding tolerance) is no longer listed.",
              "Customers who have not traded in a long time are flagged dormant even at a zero balance.",
              "Corrected aging dates and period totals across the debtor and creditor reports, and aligned the dashboard debtor headline with the Customer Balances screen.",
              "Credit balances on the creditor and debtor reports now carry the correct sign on screen, matching the downloads.",
            ],
          },
          {
            title: 'Quality and maintenance',
            body:
              "Behind-the-scenes work to keep the application reliable as it grows.",
            details: [
              "Large pages split into smaller pieces, a typed boundary added to the data layer, and database migrations reorganised one per version.",
              "A range of review findings addressed across the release (forecasting calendar gaps, collections dates, response handling and more).",
            ],
          },
        ],
      },
    ],
  },

  '2026-05-29': {
  product: 'Cardoso App',
  title: 'Product Update',
  date: '29 May 2026',
  intro:
    'A big update: a new Reporting Dashboard and proactive Insights feed, a new ' +
    'Creditors module, reorder planning and richer inventory & sales reporting, ' +
    'downloadable reports, faster navigation — plus improved sales-commission ' +
    'tracking and a range of refinements and fixes across the application.',
  sections: [
    {
      label: 'NEW',
      heading: 'New Features',
      items: [
        {
          title: 'Creditors module',
          body:
            'A new area for managing supplier accounts. View outstanding ' +
            'balances at a glance, search individual creditors, and drill into ' +
            'payment history. Balances sync automatically each night, so the ' +
            'figures you see are always current.',
        },
        {
          title: 'Inventory & sales trends',
          body:
            'New reporting that compares inventory and sales year over year, ' +
            'highlights your top sellers by season, and surfaces slow-moving ' +
            'stock — making it easier to spot patterns and plan ahead.',
        },
        {
          title: 'Sales commission tracking',
          body:
            'Commission is now calculated on paid sales, with a clear per-rep ' +
            'breakdown of any unpaid invoices. Invoices that remain unpaid ' +
            'across periods are reconciled automatically, keeping commission ' +
            'figures accurate.',
        },
        {
          title: 'Reporting dashboard',
          body:
            'A new at-a-glance home for reporting: headline figures and a ' +
            'summary card for each report, plus a system-health strip that ' +
            'shows whether your Sage data is current. Open any full report in ' +
            'one click.',
        },
        {
          title: 'Insights — automatic alerts',
          body:
            'The app now surfaces what needs attention on its own — falling ' +
            'sales, customers buying less, dead stock building up, and large ' +
            'debtor exposure — as a ranked feed. Administrators can add their ' +
            'own rules (e.g. "alert me if revenue drops more than 10%").',
        },
        {
          title: 'Reorder planning',
          body:
            'See exactly what to order and when: items at or below their ' +
            'reorder point, grouped by supplier, with an exportable purchase ' +
            'sheet. Click any item to view its sales trend and seasonality.',
        },
        {
          title: 'Download reports as PDF or Excel',
          body:
            'Aged Debtors and Sales Rep Exposure can now be downloaded as a ' +
            'polished PDF or an Excel workbook that matches your on-screen ' +
            'filters — easy to share or file.',
        },
      ],
    },
    {
      label: 'IMPROVED',
      heading: 'Improvements',
      items: [
        {
          title: 'Clearer navigation',
          body:
            'Menus have been reorganised into logical groups so the report and ' +
            'tool you need is easier to find.',
        },
        {
          title: 'More flexible tables',
          body:
            'Summary tables now support resizable columns and tidier layouts, ' +
            'with more of the page used for your data.',
        },
        {
          title: 'Configurable data sync',
          body:
            'A new settings area lets administrators fine-tune how supplier ' +
            'data is retrieved and how much history is loaded.',
        },
        {
          title: 'Instant navigation & notifications',
          body:
            'Press Ctrl/Cmd-K to jump to any page or report instantly, and a ' +
            'new notifications bell flags anything that needs attention from ' +
            'anywhere in the app. The sidebar has also been tidied up.',
        },
        {
          title: 'Shareable & saved report views',
          body:
            'Report filters are now kept in the page link, so a filtered view ' +
            'can be bookmarked or shared — and you can save your favourite ' +
            'views and jump back to them in one click.',
        },
        {
          title: 'Faster, smoother screens',
          body:
            'Reports and dashboards load noticeably faster, show tidy loading ' +
            'placeholders instead of blank screens, and offer a one-click ' +
            'retry if something fails to load. Helpful tooltips have been added ' +
            'throughout the new areas.',
        },
      ],
    },
    {
      label: 'FIXED',
      heading: 'Fixes',
      items: [
        {
          title: 'Accurate timestamps',
          body:
            'Recorded dates and times now consistently reflect local time ' +
            'across the application.',
        },
        {
          title: 'Stability improvements',
          body:
            'Resolved several issues that could cause errors when switching ' +
            'between views, and corrected balance and payment figures in a ' +
            'number of reports.',
        },
        {
          title: 'Commission report accuracy',
          body:
            'The printed commission report now includes dedicated Unpaid ' +
            'Invoices and Clawback pages. Clawback no longer treats returns / ' +
            'credit notes as a credit to the rep, and the "commission at risk" ' +
            'total now adds up correctly.',
        },
      ],
    },
  ],
  },

  '2026-05-28': {
    product: 'Cardoso App',
    title: 'Product Update',
    date: '28 May 2026',
    intro:
      'This update brings new sales-commission reporting, stock expiry tracking ' +
      'and inventory movement insights, along with a number of usability ' +
      'improvements and performance gains across the application.',
    sections: [
      {
        label: 'NEW',
        heading: 'New Features',
        items: [
          {
            title: 'Sales commission reporting',
            body:
              'Generate monthly sales-commission reports that mirror your ' +
              'existing spreadsheet, drawn directly from Sage. Reports are ' +
              'archived automatically each month and bundled per site as PDFs ' +
              'for easy distribution.',
          },
          {
            title: 'Stock receipt expiry tracking',
            body:
              'Capture expiry dates against stock as it is received, kept in ' +
              'step with your Sage purchase orders — so you can stay ahead of ' +
              'short-dated and expiring stock.',
          },
          {
            title: 'Inventory movement insights',
            body:
              'New views show how quickly stock is selling, highlight dead ' +
              'stock, and roll figures up across sites for a group-wide picture.',
          },
          {
            title: 'Linked customer accounts',
            body:
              'Customers that belong to the same account family are now shown ' +
              'together, so related sub-accounts are easy to find from either ' +
              'side.',
          },
          {
            title: 'Credit note corrections',
            body:
              'A new tool tidies up credit-note descriptions for cleaner, more ' +
              'consistent records.',
          },
          {
            title: 'Collections worklists & price lists',
            body:
              'New collections worklists help prioritise outstanding accounts, ' +
              'with an accompanying price list for quick reference.',
          },
        ],
      },
      {
        label: 'IMPROVED',
        heading: 'Improvements',
        items: [
          {
            title: 'Helpful tooltips',
            body:
              'Explanatory tooltips have been added throughout the newer ' +
              'modules to make features more discoverable.',
          },
          {
            title: 'Easier navigation of large lists',
            body:
              'Pagination now includes first/last page jumps and a go-to-page ' +
              'box, making long lists quicker to move through.',
          },
          {
            title: 'Smarter inventory filtering',
            body:
              'A new toggle filters inventory to items priced at or below cost, ' +
              'helping you spot margin issues at a glance.',
          },
          {
            title: 'Faster performance',
            body:
              'Reconciliation and status screens load noticeably faster, and ' +
              'overall responsiveness has been improved through page-load ' +
              'optimisations.',
          },
        ],
      },
      {
        label: 'FIXED',
        heading: 'Fixes',
        items: [
          {
            title: 'More reliable error reporting',
            body:
              'Issues that previously went unreported are now surfaced clearly, ' +
              'so problems can be spotted and resolved sooner.',
          },
          {
            title: 'Report bundle consistency',
            body:
              'Corrected file naming and layout when exporting report bundles, ' +
              'preventing duplicate or mislabelled files.',
          },
        ],
      },
    ],
  },
};

// Pick the requested release, or the most recent by date.
const REQUESTED = process.argv[2];
const RELEASE = REQUESTED
  ? RELEASES[REQUESTED]
  : RELEASES[Object.keys(RELEASES).sort().at(-1)];
if (!RELEASE) {
  console.error(
    `No release notes for "${REQUESTED}". Available: ${Object.keys(RELEASES).join(', ')}`,
  );
  process.exit(1);
}

// ---- Theme ----------------------------------------------------------------
const NAVY = [27, 38, 59];
const SLATE = [90, 100, 115];
const HAIR = [222, 226, 232];
const INK = [33, 37, 41];
const LABEL_COLORS = {
  NEW: [22, 122, 80],
  IMPROVED: [37, 99, 162],
  FIXED: [176, 124, 24],
};

// ---- Render ---------------------------------------------------------------
const doc = new jsPDF({ unit: 'mm', format: 'a4' });
const W = doc.internal.pageSize.getWidth();
const H = doc.internal.pageSize.getHeight();
const M = 18; // page margin
const contentW = W - M * 2;

// Header band
doc.setFillColor(...NAVY);
doc.rect(0, 0, W, 32, 'F');
doc.setTextColor(255);
doc.setFont('helvetica', 'bold');
doc.setFontSize(18);
doc.text(RELEASE.product, M, 16);
doc.setFont('helvetica', 'normal');
doc.setFontSize(11);
doc.setTextColor(205, 212, 222);
doc.text(RELEASE.title, M, 24);
doc.setFontSize(10);
doc.text(RELEASE.date, W - M, 24, { align: 'right' });

// Intro
let y = 44;
doc.setTextColor(...SLATE);
doc.setFont('helvetica', 'normal');
doc.setFontSize(10.5);
const introLines = doc.splitTextToSize(RELEASE.intro, contentW);
doc.text(introLines, M, y);
y += introLines.length * 5.2 + 6;

const bottom = H - 18;
const ensure = (needed) => {
  if (y + needed > bottom) {
    doc.addPage();
    y = 22;
  }
};

for (const section of RELEASE.sections) {
  ensure(18);
  const lc = LABEL_COLORS[section.label] || SLATE;

  // Section heading + coloured label pill
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...INK);
  doc.text(section.heading, M, y);

  doc.setFontSize(7.5);
  const pillText = section.label;
  const pillW = doc.getTextWidth(pillText) + 6;
  doc.setFillColor(...lc);
  doc.roundedRect(W - M - pillW, y - 4.4, pillW, 6, 1.2, 1.2, 'F');
  doc.setTextColor(255);
  doc.text(pillText, W - M - pillW / 2, y, { align: 'center' });

  y += 3;
  doc.setDrawColor(...HAIR);
  doc.setLineWidth(0.3);
  doc.line(M, y, W - M, y);
  y += 6;

  for (const item of section.items) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(...INK);
    const bodyLines = doc.splitTextToSize(item.body, contentW - 4);
    ensure(6 + bodyLines.length * 4.8 + 4);

    // accent tick
    doc.setFillColor(...lc);
    doc.rect(M, y - 3, 1.4, 1.4, 'F');

    doc.text(item.title, M + 4, y);
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...SLATE);
    doc.text(bodyLines, M + 4, y);
    y += bodyLines.length * 4.8 + (item.details ? 2.5 : 4.5);

    // Optional detail sub-points — used to itemise what a module/fix delivers.
    if (Array.isArray(item.details)) {
      for (const d of item.details) {
        const dLines = doc.splitTextToSize(d, contentW - 11);
        ensure(dLines.length * 4.3 + 1.6);
        doc.setFillColor(...lc);
        doc.circle(M + 6, y - 1.4, 0.5, 'F');
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(...SLATE);
        doc.text(dLines, M + 9, y);
        y += dLines.length * 4.3 + 1.4;
      }
      y += 4;
    }
  }
  y += 4;
}

// Footer on every page
const pages = doc.getNumberOfPages();
for (let p = 1; p <= pages; p++) {
  doc.setPage(p);
  doc.setDrawColor(...HAIR);
  doc.setLineWidth(0.3);
  doc.line(M, H - 12, W - M, H - 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...SLATE);
  doc.text(`${RELEASE.product} · ${RELEASE.date}`, M, H - 7);
  doc.text(`Page ${p} of ${pages}`, W - M, H - 7, { align: 'right' });
}

const slug = RELEASE.slug || RELEASE.date.replace(/\s+/g, '-');
const outPath = path.join('docs', `release-notes-${slug}.pdf`);
writeFileSync(outPath, Buffer.from(doc.output('arraybuffer')));
console.log(`Wrote ${RELEASE.sections.length} sections → ${outPath}`);
