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
  '2026-06-17': {
    product: 'Cardoso App',
    title: 'Product Update',
    date: '17 June 2026',
    slug: '17-June-2026',
    intro:
      "This update (v2026.5.9.8) adds a new Sales by Vendor report and a " +
      "breakdown of BAT exceptions by reason. Report printing has also been " +
      "tightened: the page footer no longer bleeds into table content, and " +
      "week blocks in the BAT Exceptions report stay together across page breaks.",
    sections: [
      {
        label: 'NEW',
        heading: 'New Features',
        items: [
          {
            title: 'Sales by Vendor report',
            body:
              "A new report shows all item sales per vendor for any date range " +
              "you choose. Filter by vendor, toggle a year-over-year comparison " +
              "to see how each vendor's sales track against the same period last " +
              "year, and switch to a month-by-month matrix for a detailed " +
              "breakdown. Vendor names are sourced directly from the Sage vendor " +
              "master so they are always accurate.",
          },
          {
            title: 'BAT Exceptions by Week — totals by exception reason',
            body:
              "The BAT Exceptions by Week report now shows the total value of " +
              "exceptions broken down by reason, so you can see at a glance " +
              "which exception types are driving the most variance each week.",
          },
        ],
      },
      {
        label: 'FIXED',
        heading: 'Fixes',
        items: [
          {
            title: 'Report footers no longer overlap table content when printing',
            body:
              "The footer on printed reports now flows naturally at the bottom " +
              "of the page and no longer bleeds into the last rows of a table.",
          },
          {
            title: 'BAT Exceptions week blocks stay together across page breaks',
            body:
              "When printing the BAT Exceptions report, each week's block is " +
              "now kept whole — entries for a week are no longer split across " +
              "two pages.",
          },
        ],
      },
    ],
  },
  '2026-06-18': {
    product: 'Cardoso App',
    title: 'Product Update',
    date: '18 June 2026',
    slug: '18-June-2026',
    intro:
      "This update centres on the Sales by Vendor report. The former CSV export " +
      "has been replaced with a full Excel workbook: a year-over-year Dashboard " +
      "tab highlighting the top movers, per-month quantities, prior-year comparison " +
      "figures, and all amounts in Rand — ready to pivot and chart without any " +
      "manual setup. Head-office users receive the same data broken out by branch. " +
      "Accompanying accuracy improvements sharpen the year-over-year rankings, and " +
      "under-the-hood fixes make inventory syncing more resilient and self-healing.",
    sections: [
      {
        label: 'NEW',
        heading: 'New Features',
        items: [
          {
            title: 'Excel export with year-over-year dashboard for Sales by Vendor',
            body:
              "The Sales by Vendor export is now a formatted Excel workbook instead " +
              "of a plain CSV. It includes a Dashboard tab with the Top-10 year-over-" +
              "year movers by value, a long-format Data sheet with Year and Month as " +
              "separate columns ready for pivot charting, prior-year quantities " +
              "alongside current figures, and all amounts in Rand.",
          },
          {
            title: 'Per-branch breakdown at head office',
            body:
              "When viewed from the hub, the Sales by Vendor Excel export splits the " +
              "data by branch, giving head-office users a complete per-depot picture " +
              "in a single workbook.",
          },
        ],
      },
      {
        label: 'IMPROVED',
        heading: 'Improvements',
        items: [
          {
            title: 'Year-over-year figures shown per month',
            body:
              "On the Sales by Vendor report, year-over-year comparisons are now " +
              "broken down by month, making seasonal patterns and monthly swings " +
              "easier to read.",
          },
          {
            title: 'Same-day recovery for failed nightly syncs',
            body:
              "The scheduled data sync now runs an hourly catch-up during the day, " +
              "so a branch whose nightly sync failed no longer has to wait until the " +
              "following night to get current figures.",
          },
        ],
      },
      {
        label: 'FIXED',
        heading: 'Fixes',
        items: [
          {
            title: 'Top-10 year-over-year movers show only true comparisons',
            body:
              "Items that had no sales in the prior year are no longer included in " +
              "the Top-10 movers list. The ranking now compares only items with sales " +
              "in both years, giving a meaningful year-over-year view.",
          },
          {
            title: 'Money amounts stay on one line in the by-month matrix',
            body:
              "Large Rand amounts in the Sales by Vendor by-month view no longer " +
              "wrap onto a second line.",
          },
          {
            title: 'Inventory sync is more robust',
            body:
              "The inventory sync now stages data before committing it, so a sync " +
              "that fails partway through cannot publish a half-built result. " +
              "Concurrent syncs no longer produce duplicate rows, and the sync no " +
              "longer stalls other parts of the application while running.",
          },
        ],
      },
    ],
  },
  '2026-06-22': {
    product: 'Cardoso App',
    title: 'Product Update',
    date: '22 June 2026',
    slug: '22-June-2026',
    intro:
      "This update centres on the proof-of-delivery (POD) viewer in BAT " +
      "reconciliation. You can now page through every page of a multi-page " +
      "POD document directly in the app, rotate pages to any orientation, " +
      "and see previews for historical deliveries — right back to your " +
      "earliest records. Sideways pages are straightened automatically, " +
      "existing previews are preserved if a new render fails, and the " +
      "viewer no longer clips tall documents. The app also stays responsive " +
      "while previews are being generated in the background.",
    sections: [
      {
        label: 'NEW',
        heading: 'New Features',
        items: [
          {
            title: 'Multi-page POD document viewer',
            body:
              "Proof-of-delivery documents with more than one page can now " +
              "be paged through directly in the app — no need to download " +
              "the file. Use the forward and back controls to step through " +
              "each page of a delivery document.",
          },
          {
            title: 'Rotate documents in the POD viewer',
            body:
              "Left and right 90° rotation buttons let you correct the " +
              "orientation of a sideways or inverted document without " +
              "leaving the reconciliation screen.",
          },
          {
            title: 'Historical POD previews',
            body:
              "Deliveries processed before the preview feature was " +
              "introduced now show their POD previews too. The Operations " +
              "OCR panel displays backfill progress week by week, so you " +
              "can track how much of your history has been filled in.",
          },
        ],
      },
      {
        label: 'IMPROVED',
        heading: 'Improvements',
        items: [
          {
            title: 'Sideways pages auto-straightened',
            body:
              "When a POD document contains pages that were scanned or " +
              "photographed sideways, those pages are now automatically " +
              "rotated upright for comfortable reading.",
          },
          {
            title: 'Existing preview preserved on render failure',
            body:
              "If a new render attempt encounters a problem, the previously " +
              "confirmed preview is kept in place rather than being replaced " +
              "with an error, so a working view is never lost.",
          },
        ],
      },
      {
        label: 'FIXED',
        heading: 'Fixes',
        items: [
          {
            title: 'POD preview no longer shrinks',
            body:
              "A stray height limit in the viewer was compressing tall " +
              "documents. It has been removed — previews now display at " +
              "their full size.",
          },
          {
            title: 'App stays responsive while previews generate',
            body:
              "Background preview generation previously competed with the " +
              "interface for processing time, causing occasional " +
              "sluggishness. The work is now properly offloaded so the app " +
              "stays fast while previews are being built.",
          },
        ],
      },
    ],
  },
  '2026-06-23': {
    product: 'Cardoso App',
    title: 'Product Update',
    date: '23 June 2026',
    slug: '23-June-2026',
    intro:
      "This update (v2026.5.10) adds a write-off candidate picker that exports a " +
      "formatted PDF of items flagged for write-off, and resolves a performance " +
      "issue in BAT reconciliation where preview rendering could slow the interface " +
      "and re-OCR'd rows were not always shown correctly.",
    sections: [
      {
        label: 'NEW',
        heading: 'New Features',
        items: [
          {
            title: 'Write-off candidate picker with PDF export',
            body:
              "A new tool identifies inventory items flagged as write-off candidates " +
              "and exports the list as a formatted PDF, ready to review with management " +
              "or file for audit purposes.",
          },
        ],
      },
      {
        label: 'FIXED',
        heading: 'Fixes',
        items: [
          {
            title: 'BAT reconciliation preview no longer slows the interface',
            body:
              "Loading a BAT reconciliation preview could make the interface sluggish " +
              "or briefly unresponsive. Preview rendering now yields correctly so the " +
              "interface stays smooth. Rows that have been re-processed by OCR are also " +
              "displayed accurately after the update.",
          },
        ],
      },
    ],
  },
  '2026-06-30': {
    product: 'Cardoso App',
    title: 'Product Update',
    date: '30 June 2026',
    slug: '30-June-2026',
    intro:
      "This update advances the off-site backup capabilities of the Cardoso App. " +
      "Head-office users can now see the status of each site's off-site Kopia " +
      "backup directly on the Hub Backups page, with proactive alerts when a " +
      "backup is stale or has encountered an error. The Kopia backup agent is now " +
      "bundled in the Windows installer so it deploys automatically alongside the " +
      "app. Backup health tracking has been rebuilt to be more accurate and " +
      "resilient — it no longer depends on the scheduler staying alive, failed " +
      "backups retry automatically, and the off-site agent guards against " +
      "uploading outdated data. A fix also eliminates a BAT reconciliation " +
      "annoyance where historical OCR error notifications re-appeared each time " +
      "the page was opened.",
    sections: [
      {
        label: 'NEW',
        heading: 'New Features',
        items: [
          {
            title: 'Off-site backup status on the Hub Backups page',
            body:
              "The Hub Backups page now shows the current state of each site's " +
              "off-site Kopia backup alongside the local backup status. When a " +
              "backup is stale or the repository reports an error, a proactive " +
              "alert is raised so nothing slips through unnoticed.",
            details: [
              "Per-site off-site backup status (last snapshot time, freshness verdict, any repository error) shown directly on the Hub Backups dashboard.",
              "A new alert rule fires when a site's off-site backup is overdue — surfaced in the existing Insights / Alerts feed.",
              "Status is scoped to the sites each head-office user is permitted to see.",
            ],
          },
          {
            title: 'Kopia backup agent bundled in the Windows installer',
            body:
              "The Kopia off-site backup agent is now included in the Windows " +
              "installer package. New and updated installations receive the " +
              "backup agent automatically — no separate download or manual " +
              "setup step required.",
          },
        ],
      },
      {
        label: 'IMPROVED',
        heading: 'Improvements',
        items: [
          {
            title: 'More reliable and accurate backup health reporting',
            body:
              "Backup health is now assessed from the actual state of the backup " +
              "files rather than relying on the Windows Task Scheduler to report " +
              "success. This means the health indicator stays correct even when " +
              "the scheduler is stopped or has not yet run.",
            details: [
              "A failed local backup now retries automatically on a back-off schedule, catching up on any missed windows.",
              "A data-age guard stops the off-site snapshot agent from uploading a stale copy — if the local source hasn't been updated recently, the snapshot is deferred until fresh data is available.",
              "The hub's backup health verdict now reflects the actual backup outcome rather than defaulting to the data age alone.",
            ],
          },
        ],
      },
      {
        label: 'FIXED',
        heading: 'Fixes',
        items: [
          {
            title: 'BAT reconciliation — old OCR errors no longer re-notify on every open',
            body:
              "Historical per-row OCR errors from previous reconciliation runs " +
              "were re-appearing as notification toasts each time the BAT " +
              "Reconciliation page was opened. They are now seeded quietly on " +
              "load and only surface as live notifications when OCR is actively " +
              "running in the current session.",
          },
          {
            title: 'Hub Backups page surfaces Kopia repository errors',
            body:
              "When the off-site backup agent encounters a repository problem — " +
              "such as a connectivity failure or a corrupt snapshot — the error " +
              "is now shown on the Hub Backups page rather than the site " +
              "appearing healthy.",
          },
        ],
      },
    ],
  },
  '2026-06-15': {
    product: 'Cardoso App',
    title: 'Product Update',
    date: '15 June 2026',
    slug: '15-June-2026',
    intro:
      "This update (v2026.5.9.5) is about seeing — and printing — the detail " +
      "behind your numbers. A new Inventory Movement History gives every item a " +
      "'stock card': every sale, receipt, credit, adjustment, write-off and " +
      "transfer, with a running balance that reconciles to your on-hand stock " +
      "figure. The Daily Sales report can now print the VAT-bearing invoices, " +
      "credit notes and debit notes behind a chosen day's figure, and the BAT " +
      "reconciliation lists print on a letterhead sheet. Installing and " +
      "updating a branch is also " +
      "faster. Every figure continues to be drawn from, and reconcile to, Sage.",
    sections: [
      {
        label: 'NEW',
        heading: 'New Features',
        items: [
          {
            title: 'Inventory Movement History — a stock card for every item',
            body:
              "A new Movement History tab on the Inventory page shows, for any " +
              "item, a dated list of every movement — sales, purchase receipts, " +
              "customer credits and returns, adjustments, write-offs and transfers " +
              "— with a running balance that reconciles to your on-hand stock " +
              "figure.",
            details: [
              "Search for an item, choose a date range, and read its movements oldest-to-newest with In / Out / running Balance / cost columns and colour-coded movement types.",
              "The running balance is anchored to the on-hand quantity from your last sync and worked backwards, so the card always ties out to that on-hand figure — even though Sage purges old transaction history (a balance summed from zero would not).",
              "Opening and closing balances for the period, total in/out, and current on-hand are shown as tiles, with an 'anchored to on-hand' check.",
              "For speed it loads the last 30 days by default — synced in the background with live progress — and a 'Load full history' button pulls a single item's complete record from Sage on demand. A clear notice appears if you look back further than what's been synced, so a partial view is never mistaken for the whole.",
              "The figures reflect your most recent sync from the branch's Sage — run a sync for the latest movements and on-hand. Export the stock card to CSV, or print it on the depot letterhead (per branch).",
            ],
          },
          {
            title: 'Print a day’s documents from Daily Sales Figures',
            body:
              "On the Daily Sales Figures report, each day now has a Print button " +
              "that lists the VAT-bearing invoices, credit notes and debit notes " +
              "behind that day's figure on a letterhead sheet.",
            details: [
              "Documents are grouped by type — Invoices, Credit Notes, Debit Notes — with per-type subtotals and a net total; each line shows the document number, customer, order and the VAT split.",
              "It uses the same source and filters as the day's summary row (VAT-bearing documents), so the printed list always reconciles to that figure on the report — note zero-rated/exempt documents, which the figure also excludes, are not listed.",
              "Printed on the depot letterhead with the date, ready to file or hand over.",
            ],
          },
          {
            title: 'Print the BAT reconciliation lists',
            body:
              "The Paid, Non-Compliant and Exceptions lists in BAT reconciliation " +
              "each gain a Print button that produces a letterhead sheet of that " +
              "list.",
            details: [
              "The header states the depot, the year and week number, and which list was printed.",
              "Each invoice row carries its order number, customer, delivery and POD-upload dates, OCR status, invoice number and amount, with the list total at the foot (and the exception reason on the Exceptions list).",
            ],
          },
        ],
      },
      {
        label: 'IMPROVED',
        heading: 'Improvements',
        items: [
          {
            title: 'Faster, more robust branch installation',
            body:
              "Installing or updating the app on a branch machine is now " +
              "noticeably quicker, and an interrupted update is safer.",
            details: [
              "The application's libraries ship as a single compressed archive and are unpacked in one pass, instead of copying tens of thousands of small files individually.",
              "An interrupted update can no longer leave a half-updated install running quietly: the installer clears the old libraries first, verifies the new ones unpacked, and stops with a clear message if anything went wrong.",
            ],
          },
        ],
      },
    ],
  },
  '2026-06-14': {
    product: 'Cardoso App',
    title: 'Product Update',
    date: '14 June 2026',
    slug: '14-June-2026',
    intro:
      "This update focuses on the Inventory Stock Card. You can now search for " +
      "items using a fast, searchable picker instead of scrolling through a full " +
      "list, print any stock card on a branded letterhead sheet, and export a " +
      "stock card to CSV for use in a spreadsheet. A fix ensures that search " +
      "errors in the item picker are surfaced clearly and that stale results no " +
      "longer flash on screen while a new search loads.",
    sections: [
      {
        label: 'NEW',
        heading: 'New Features',
        items: [
          {
            title: 'Searchable item picker on the Stock Card',
            body:
              "The item selector on the Stock Card is now a fast, searchable " +
              "combobox — type a few characters to jump straight to the item you " +
              "need instead of scrolling through the full list.",
          },
          {
            title: 'Print the stock card on your letterhead',
            body:
              "Any stock card can now be sent to the printer as a formatted, " +
              "letterhead-branded sheet, ready to file or hand to a supplier.",
          },
          {
            title: 'Export a stock card to CSV',
            body:
              "Download the stock card for any item as a CSV file, ready to open " +
              "in a spreadsheet or share with a colleague.",
          },
        ],
      },
      {
        label: 'FIXED',
        heading: 'Fixes',
        items: [
          {
            title: 'Item picker shows search errors clearly; no stale-result flash',
            body:
              "If the item search encounters a problem, the error is now shown on " +
              "screen rather than failing silently. The picker also no longer " +
              "briefly shows old results while a new search is loading.",
          },
        ],
      },
    ],
  },
  '2026-06-11': {
    product: 'Cardoso App',
    title: 'Product Update',
    date: '11 June 2026',
    slug: '11-June-2026',
    intro:
      "This update (v2026.5.9.3) sharpens the money pages. Creditor Balances " +
      "now shows each vendor's TRUE position — including invoices and payments " +
      "still sitting in unposted batches — with a plain-language breakdown and a " +
      "Cashbook capture warning so you always know how far behind posting is. The " +
      "credit-risk verdicts on Customer Balances have been rebuilt to be both more " +
      "accurate and fully explainable. Both balance pages gain in-place detail " +
      "popups, creditors get a dedicated search page and a printable report, and " +
      "overnight syncing is more resilient with automatic retries and clear " +
      "staleness warnings. Every figure continues to be drawn from, and reconcile " +
      "to, Sage.",
    sections: [
      {
        label: 'NEW',
        heading: 'New Features',
        items: [
          {
            title: 'True creditor position — including unposted batches',
            body:
              "Creditor Balances now shows what you ACTUALLY owe each vendor, not " +
              "just what Sage has finished posting. When accounts are behind on " +
              "posting batches, the figure is corrected on screen and the maths is " +
              "spelled out so it always adds up.",
            details: [
              "Each vendor's Outstanding is Sage's posted balance PLUS invoices captured in unposted batches (which Sage understates) MINUS payments captured but not yet posted (which Sage overstates).",
              "A headline line spells out the arithmetic: Total Outstanding + unposted invoices − unposted payments = true outstanding, for the vendors currently shown.",
              "Affected vendors carry an amber dot; hovering a row shows a breakdown card (posted vs unposted, with the true figure) that follows your cursor.",
              "A Cashbook capture line states the date vendor payments were last captured and how many days behind that is — turning red past a week — so figures are never mistaken for 'includes last week's payments'.",
            ],
          },
          {
            title: 'Vendor detail popup and a dedicated Creditor Search',
            body:
              "The full vendor picture now opens in a popup, and creditors get " +
              "their own 'Search the creditors' page that mirrors Customer Search.",
            details: [
              "Click a vendor on Creditor Balances — or look one up on the new Creditor Search page — to open a popup with the vendor's receipts, open invoices, payments, and purchase orders. Closing it leaves you exactly where you were.",
              "Creditor Search opens with a clean overview: vendor count, true outstanding, and unposted-batch totals, plus a last-sync card and a payment-capture status strip.",
              "Creditor Balances gains a Print / PDF button with the same letterhead as Customer Balances, and the sync controls now sit tidily on the headline row.",
            ],
          },
          {
            title: 'Open the full customer popup straight from Customer Balances',
            body:
              "Clicking a customer on the balances table now opens the same full " +
              "customer popup you'd get from a search — without leaving the page.",
            details: [
              "The popup carries the customer's credit verdict, recent invoices and receipts, and flag actions; closing it returns you to the balances list with your filters intact.",
              "Hovering a row shows the credit verdict and the reasons behind it in a prominent card that follows your cursor (see Improvements).",
            ],
          },
          {
            title: 'Show or hide small balances on Customer Balances',
            body:
              "A previously fixed 'hide anything under R3' rule is now an option you " +
              "control.",
            details: [
              "A new Minimum balance filter offers Off / R3+ / R10+ / R100+ / R1 000+, so you can surface tiny balances or focus on material ones.",
              "The choice is part of the page link, so a filtered view can be bookmarked or shared.",
            ],
          },
          {
            title: 'Creditors at head office',
            body:
              "Creditor balances and aged-creditor figures are now available on the " +
              "head-office (hub) view, per branch, alongside the existing debtor " +
              "reports.",
            details: [],
          },
        ],
      },
      {
        label: 'IMPROVED',
        heading: 'Improvements',
        items: [
          {
            title: 'Credit-risk verdicts — accurate and fully explainable',
            body:
              "The credit verdict shown against each customer has been rebuilt so it " +
              "reflects how the account actually behaves, and so you can always see " +
              "WHY a verdict was reached.",
            details: [
              "Payments now settle invoices by VALUE, oldest first — a small same-day receipt can no longer 'clear' a large invoice.",
              "Each account is judged against its OWN payment terms (e.g. 7-day vs 30-day) instead of one blanket threshold.",
              "Prepaid (PP) accounts with any outstanding balance are held — no new credit until they are clear.",
              "Payment reversals are no longer mistaken for payments, and tiny rounding residues (under R10) no longer trigger a hold.",
              "Hovering a customer row shows a prominent card with the verdict, its score, the contributing factors, and — when an account is held — the exact offending invoice (number, amount and date).",
              "Average days-to-pay, exposure limits, flag history and dormant-account detection all continue to work, now fed accurate inputs.",
            ],
          },
          {
            title: 'Overnight syncs retry themselves, and warn when data is stale',
            body:
              "Sites no longer quietly run on yesterday's numbers when an overnight " +
              "sync misses.",
            details: [
              "A failed nightly sync now retries automatically a short time later.",
              "A machine that was off overnight catches up on start-up: any missed sync runs as soon as the app comes back, instead of waiting for the next night.",
              "If data is more than about a day old, the app says so plainly instead of silently showing stale figures.",
            ],
          },
          {
            title: 'Branch shown in front of top customers at head office',
            body:
              "On the head-office reporting dashboard, viewing all branches now " +
              "prefixes each top customer with its branch name — matching the Top " +
              "Dead Stock card.",
            details: [],
          },
          {
            title: 'Smoother app during head-office data loads',
            body:
              "Large head-office syncs no longer make the interface stutter, and a " +
              "new safeguard catches the rare freeze.",
            details: [
              "Head-office data is now written in small yielding chunks, so the screen stays responsive while a sync runs.",
              "A background watchdog detects and reports any unexpected freeze, so stability issues surface instead of going unnoticed.",
            ],
          },
          {
            title: 'Consistent buttons and tidier list pages',
            body:
              "Several pages were brought in line with the app's look and feel.",
            details: [
              "The Inventory list's Print, Export CSV and Refresh buttons now match the Customer Balances styling.",
              "Vendor lookup moved off Creditor Balances onto the dedicated Creditor Search page, leaving Balances as a clean overview.",
            ],
          },
        ],
      },
      {
        label: 'FIXED',
        heading: 'Fixes',
        items: [
          {
            title: 'Creditor Balances headline now reconciles on the page',
            body:
              "The 'true outstanding' figure on Creditor Balances now always equals " +
              "the tiles shown on screen: Total Outstanding + unposted invoices − " +
              "unposted payments, for the vendors currently in view. (Creditor Search " +
              "deliberately keeps the whole-company figure across all active vendors, " +
              "so the two pages answer different questions and are labelled " +
              "accordingly.)",
            details: [],
          },
          {
            title: 'Last payment dates and missing payments surfaced',
            body:
              "Where vendor payments existed only in the Cashbook (captured but not " +
              "yet posted), the previous view could show an out-of-date 'last payment'. " +
              "The true position and the capture-date warning now make this visible " +
              "rather than misleading.",
            details: [],
          },
          {
            title: 'Money tiles no longer clip large amounts',
            body:
              "Summary tiles across the app now size themselves to the figure they " +
              "show, so multi-million Rand totals display in full instead of being " +
              "cut off.",
            details: [],
          },
        ],
      },
    ],
  },
  '2026-06-10': {
    product: 'Cardoso App',
    title: 'Product Update',
    date: '10 June 2026',
    slug: '10-June-2026',
    intro:
      "This update (v2026.5.9.2) is a broad polish-and-hardening release. The " +
      "interface gets a refresh — a redesigned sign-in screen with a daily-" +
      "changing ambient visualisation, a tidier sidebar, smoother page-to-page " +
      "navigation, and consistent in-app confirmation dialogs — alongside a long " +
      "list of reliability and security fixes: faster and more dependable site-" +
      "to-head-office syncing, stricter permission checks, hardened Sage query " +
      "validation, and accessibility-grade text contrast throughout. Every " +
      "figure continues to be drawn from, and reconcile to, Sage.",
    sections: [
      {
        label: 'NEW',
        heading: 'New Features',
        items: [
          {
            title: 'Redesigned sign-in screen',
            body:
              "The sign-in page has been redesigned with a softer, rounded look and " +
              "a live ambient visualisation behind the welcome panel.",
            details: [
              "Three visualisation styles — drifting phosphor traces, a constellation network, and breathing ledger bars — rotate automatically by day, with gentle colour blooms.",
              "Respects reduced-motion settings (shows a still image) and pauses when the tab is in the background.",
              "Rounded input fields with a clear focus glow, a pill-shaped sign-in button, and clearer error messages.",
            ],
          },
          {
            title: 'Shareable filtered views on Customer Balances',
            body:
              "Filters on Customer Balances (age bucket, branch, sales rep, and more) " +
              "are now part of the page address — copy the link to share exactly the " +
              "view you're looking at, or bookmark it. Filters also survive a refresh.",
            details: [
              "Every filter is encoded: age bucket, branch, sales rep, last-purchase window, dormant-only, account type, hide-invoice-matches and the page number.",
              "Defaults stay out of the address, so unfiltered views keep a clean link.",
              "Filter clicks don't clutter browser history — Back still leaves the page in one step.",
            ],
          },
          {
            title: 'Data-freshness badge on Creditor Balances',
            body:
              "A colour-coded badge shows at a glance how current the creditor data " +
              "is: green when fresh, amber when it has missed its nightly sync, red " +
              "if it has never synced. Hover for the exact timestamp.",
            details: [
              "Green: synced within the expected nightly window. Amber: stale (older than 26 hours). Red: never synced.",
              "The relative age ('Synced 3h ago') keeps itself up to date while the page is open.",
              "The tooltip carries the raw sync timestamp plus the schedule, e.g. 'Nightly at 04:30'.",
            ],
          },
          {
            title: 'Clean-up tool for BAT reconciliation integrity warnings',
            body:
              "When the integrity banner reports orphaned extraction rows (stale " +
              "rows from a prior upload), an admin can now review the exact rows and " +
              "tick which to remove — nothing is deleted automatically, and rows " +
              "retained from a second branch's upload are never touched.",
            details: [
              "The picker lists each orphaned row with its order number, OCR status, amount and a link to the POD PDF.",
              "Deletion is admin-only and audited; the server re-checks each ticked row is genuinely orphaned before removing it.",
              "POD PDFs themselves are never deleted — only the stale database rows.",
            ],
          },
        ],
      },
      {
        label: 'IMPROVED',
        heading: 'Improvements',
        items: [
          {
            title: 'Smoother, steadier navigation',
            body:
              "Moving between pages no longer blanks the whole screen while a page " +
              "loads — the sidebar and header stay put and only the content area " +
              "shows a brief loading spinner.",
            details: [
              "Previously, opening a page for the first time replaced the entire screen — sidebar included — with a blank loading state.",
              "Pages you have already visited continue to open instantly.",
            ],
          },
          {
            title: 'Tidier sidebar',
            body:
              "Even spacing between groups, a rounded highlight with an amber marker " +
              "on the current page, and group chevrons that sit next to their labels. " +
              "Items are indented under a subtle guide line so grouping reads at a glance.",
            details: [
              "Collapsed group headers no longer cram together while expanded groups sprawl — the vertical rhythm is even throughout.",
              "The current page is marked with a rounded highlight and a glowing amber rail instead of a square block.",
              "Icons are slightly smaller so their colours read as accents rather than dominating each row.",
            ],
          },
          {
            title: 'Faster, lighter searching',
            body:
              "Vendor, stock-receipt and collections searches now send one request " +
              "per typing pause instead of one per keystroke, and search results no " +
              "longer flash to empty while new results load.",
            details: [
              "Applies to Creditor Search, Creditor Balances, Stock Receipts and the Collections assign-customers dialog (including its minimum-value and days-overdue fields).",
              "The Operations OCR panel now polls quickly only while OCR is actually running, dropping to a slow check when idle.",
            ],
          },
          {
            title: 'Large vendor lists render instantly',
            body:
              "Creditor Balances now draws only the rows on screen, so the table " +
              "stays smooth no matter how many vendors are listed. Column sorting " +
              "also works from the keyboard.",
            details: [
              "Only the visible rows are rendered, so scrolling stays smooth at any list size.",
              "Column widths remain resizable and are remembered per user, exactly as before.",
              "Sortable headers are reachable with Tab and toggled with Enter or Space, with the sort direction announced to screen readers.",
            ],
          },
          {
            title: 'Accessibility-grade text contrast',
            body:
              "Every de-emphasised label across the app has been lifted to meet the " +
              "WCAG AA contrast standard — easier on the eyes in both themes, " +
              "especially on warehouse screens.",
            details: [
              "167 instances of faded text across 60 screens were below the 4.5:1 contrast standard; all now meet it in both themes.",
              "An accessibility linter now runs in the build pipeline so new screens can't regress.",
            ],
          },
          {
            title: 'In-app confirmation dialogs',
            body:
              "Actions that previously used the browser's built-in confirm popup " +
              "(deleting a user, bulk collections updates, forcing a full re-sync, " +
              "changing the VAT rate) now use a themed dialog, with destructive " +
              "actions clearly marked in red.",
            details: [
              "Browser popups ignored the app theme and could be suppressed by the browser after repeated prompts.",
              "The new dialogs support keyboard confirmation and cancelling with Escape.",
            ],
          },
          {
            title: 'Aged Creditors — filter by payment history',
            body:
              "The Aged Creditors report gains a Payments filter, on by default, " +
              "matching the Creditor Balances page: 'With payment history' hides " +
              "never-paid accounts; switch to 'All vendors' to include them. The " +
              "choice carries through to the PDF and Excel exports.",
          },
          {
            title: 'BAT weekly chart — total value per week',
            body:
              "The second chart on the BAT Weekly Reconciliation report now shows " +
              "each week's BAT and Sage credit-note totals. The two lines track " +
              "closely when a week reconciles; a visible gap is that week's variance.",
          },
        ],
      },
      {
        label: 'FIXED',
        heading: 'Fixes',
        items: [
          {
            title: 'First-time password setup no longer loops',
            body:
              "Setting your password on first sign-in now completes properly instead " +
              "of asking again on the next sign-in.",
            details: [
              "The 'must change password' flag was never cleared after a successful first-time setup, so every subsequent sign-in demanded a new password again.",
            ],
          },
          {
            title: 'Amounts typed with a comma decimal are read correctly',
            body:
              "Typing an amount like 1.234,56 into search-by-amount no longer reads " +
              "it 100 times too large.",
            details: [
              "South African formats (1 234,56 and 1.234,56) and plain formats (1234.56) are all recognised; the last separator typed is treated as the decimal mark.",
            ],
          },
          {
            title: 'Site-to-head-office syncing is faster and more honest',
            body:
              "Sites no longer rewrite every record on each 30-minute sync (the hub " +
              "now pulls only what changed), updates made during a sync window are " +
              "no longer missed, and a sync where one dataset fails is reported as " +
              "partial instead of silently logged as OK.",
            details: [
              "Unchanged records are skipped instead of rewritten, so head office stops re-downloading the entire customer book every half hour.",
              "The incremental window is stamped from when a sync starts (with a safety margin), so an update made mid-sync is picked up by the next one.",
              "Partial syncs show amber in the Hub Sync Log with the failing dataset named; scheduled imports run one at a time and failures are recorded in Job Runs and can raise alerts.",
              "Hub Aged Debtors decides per branch whether to use detailed open-item data or the snapshot, so one un-synced branch no longer affects the others.",
            ],
          },
          {
            title: 'Very large depots sync reliably',
            body:
              "Branches with more than ~32,000 stock items no longer fail their " +
              "inventory sync to head office.",
            details: [
              "The previous approach hit a database parameter limit at ~32,000 items, failing the whole sync every cycle so the branch's data went stale.",
            ],
          },
          {
            title: 'Keyboard shortcut collision',
            body:
              "Ctrl+K opened two overlays at once. It now opens only the page-jump " +
              "command palette; the hidden console moved to Ctrl+Shift+K — and it " +
              "now answers back whatever you type.",
            details: [
              "Ctrl+K: fuzzy page-jump across every page you have permission to open, grouped like the sidebar.",
              "Ctrl+Shift+K: the quiet-word console — it knows a few words now, and unknown words get a reply instead of silence.",
            ],
          },
          {
            title: 'Fresh installations start correctly',
            body:
              "A brand-new installation could fail on its very first start before " +
              "the database existed. New installs now boot cleanly.",
            details: [
              "Existing sites were never affected — the issue only occurred when the application started against a completely empty database.",
            ],
          },
          {
            title: 'Aged Debtors dashboard tile respects the branch filter',
            body:
              "The Aged Debtors tile on the Reporting Dashboard now correctly " +
              "reflects the selected branch, showing only that branch's aging " +
              "totals rather than all-branch figures.",
            details: [
              "Selecting a branch from the dashboard's Branch selector now narrows the Aged Debtors tile, consistent with every other tile on the page.",
            ],
          },
        ],
      },
      {
        label: 'SECURITY',
        heading: 'Security',
        items: [
          {
            title: 'Hardened Sage query validation',
            body:
              "Custom Sage query overrides are validated with a stricter read-only " +
              "check that can't be bypassed through comments or quoted text, with a " +
              "wider list of blocked commands.",
            details: [
              "The validator now understands quoted text and comments, so a forbidden command can't be smuggled past it inside a string.",
              "Blocked keywords now include data-export and server-configuration commands in addition to writes; stored-procedure calls are rejected outright.",
              "Legitimate queries that use reserved words as column aliases still validate correctly.",
            ],
          },
          {
            title: 'Tighter permission checks',
            body:
              "Several report and rule-management endpoints that previously only " +
              "required sign-in now enforce the same permissions as the pages that " +
              "use them.",
            details: [
              "Report data endpoints now require the same Reports permission as their export buttons.",
              "Auto-flag rule testing and editing requires the manage-rules permission.",
              "The head-office commission bundle download aligns with the Monthly Reports permission.",
            ],
          },
          {
            title: 'Safer service-to-service authentication',
            body:
              "Internal reporting and backup tokens are compared in constant time, " +
              "and the backup configuration export now defaults to redacting secrets " +
              "unless explicitly configured otherwise.",
            details: [
              "Constant-time comparison prevents an attacker from recovering a token byte-by-byte from response timing.",
              "Exporting the full unredacted configuration now requires an explicit opt-in setting, instead of depending on an environment flag being set.",
            ],
          },
        ],
      },
    ],
  },
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
      "sales view, and a commission monthly bundle download. Insight cards now " +
      "deep-link directly to the relevant report tabs, and the sidebar opens to " +
      "your first accessible group by default for faster navigation. The Sales " +
      "Commission module defaults VAT to 15%, saving a manual step each month. " +
      "On-screen help, clearer charts, and several accuracy and permission fixes " +
      "round out the release. Every figure is drawn from, and reconciles to, Sage.",
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
          {
            title: 'Commission monthly bundle download',
            body:
              "The head-office hub now lets you download the current month's " +
              "commission bundle in one click — all branches' PDF reports, zipped " +
              "and ready to distribute.",
          },
        ],
      },
      {
        label: 'IMPROVED',
        heading: 'Improvements',
        items: [
          {
            title: 'Insights cards deep-link to the correct report tab',
            body:
              "Clicking an Insights card now navigates directly to the relevant " +
              "tab in the associated report — no extra steps to reach the data " +
              "behind an alert.",
          },
          {
            title: 'Sidebar opens to your first accessible group by default',
            body:
              "The sidebar now opens fully expanded with only the first group you " +
              "have access to shown, so the most relevant navigation is visible " +
              "the moment you open any page.",
          },
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
          {
            title: 'Sales Commission VAT defaults to 15%',
            body:
              "When running a Sales Commission report the VAT rate now defaults " +
              "to 15% — the standard South African rate — so it no longer needs " +
              "to be entered manually each month.",
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
          {
            title: 'Commission bundle archive timestamps corrected',
            body:
              "Commission bundle archives are now stamped with the correct creation " +
              "time, so the hub shows the right date and time for each month's " +
              "bundled report.",
          },
          {
            title: 'BAT invoice reconciliation and local timestamps',
            body:
              "The BAT Cardoso-invoice matching query now works reliably across all " +
              "server configurations, and all BAT date and time values reflect local " +
              "South African time (UTC+2) rather than UTC.",
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

  '2026-08-28': {
    product: 'Cardoso App',
    title: 'Product Update',
    date: '28 Aug 2026',
    slug: '28-Aug-2026',
    intro:
      "This update introduces the Invoice Profit report — a new view of your " +
      "trading performance that shows the cost price, selling price, and gross " +
      "profit on every invoice, grouped by day, week, or month. Drill into any " +
      "period to see the contributing invoices line by line, export the result " +
      "as a PDF, and — at head office — compare profitability across branches " +
      "in a single view. Every figure is drawn from, and reconciles to, Sage.",
    sections: [
      {
        label: 'NEW',
        heading: 'New Features',
        items: [
          {
            title: 'Invoice Profit report',
            body:
              "A new report shows the cost price, selling price, and gross profit " +
              "for every invoice, grouped into daily, weekly, or monthly periods. " +
              "Spot your most and least profitable trading periods at a glance, " +
              "and drill into any row to see the individual invoices behind the figures.",
          },
          {
            title: 'Invoice line drill-down and export',
            body:
              "Open any period in the Invoice Profit report to see the individual " +
              "invoices behind the figure. Export the full date range as a formatted " +
              "PDF summary (month, week, and day totals) for filing or sharing; " +
              "detailed per-invoice data is available as an Excel workbook.",
          },
          {
            title: 'Invoice Profit at head office — branch comparison',
            body:
              "Head-office users can view Invoice Profit across all branches in " +
              "one screen, with Day, Week, Month, and Year totals and a branch " +
              "drill-down to compare profitability site by site.",
          },
        ],
      },
      {
        label: 'IMPROVED',
        heading: 'Improvements',
        items: [
          {
            title: 'Profit summary strip and filters',
            body:
              "The Invoice Profit report opens with a summary strip showing total " +
              "cost, revenue, and gross profit for the period in view. On a branch, " +
              "a date-range picker and profit filters let you narrow the figures, " +
              "with the selection encoded in the page link for bookmarking and " +
              "sharing. At head office, a period selector switches between Day, " +
              "Week, Month, and Year groupings, and a branch selector narrows to " +
              "a single site.",
          },
          {
            title: 'Data-freshness indicator',
            body:
              "The report shows when its data was last synced from Sage, with a " +
              "clear warning when figures may be out of date, so you always know " +
              "how current the numbers are.",
          },
        ],
      },
    ],
  },

  '2026-08-27': {
    product: 'Cardoso App',
    title: 'Product Update',
    date: '27 Aug 2026',
    slug: '27-Aug-2026',
    intro:
      "This update fixes an issue in BAT reconciliation where invoices with a " +
      "failed OCR scan were silently excluded from the 'OCR failed' filter. " +
      "The filter now captures every invoice that OCR could not process, the " +
      "header badge now uses the same definition of 'OCR failed' as the filter, " +
      "and any filter that returns no results displays a clear message instead " +
      "of a blank list.",
    sections: [
      {
        label: 'FIXED',
        heading: 'Fixes',
        items: [
          {
            title: "BAT reconciliation — 'OCR failed' filter now captures all failed scans",
            body:
              "When filtering the invoice list in BAT reconciliation for 'OCR " +
              "failed', invoices that had actually errored during scanning (shown " +
              "with a red 'Failed' badge) were being silently excluded — only " +
              "invoices with a 'not found' status appeared. The filter now " +
              "correctly shows every invoice that OCR could not process, " +
              "regardless of the specific failure type. The 'OCR failed' count " +
              "in the header now uses the same definition — both cover every " +
              "invoice OCR could not process. If a filter or tab returns no matching " +
              "invoices, a descriptive message is now shown in place of a blank " +
              "list, indicating which filter is active and pointing to the " +
              "correct tab when relevant.",
          },
        ],
      },
    ],
  },

  '2026-07-20': {
    product: 'Cardoso App',
    title: 'Product Update',
    date: '20 July 2026',
    slug: '20-July-2026',
    intro:
      "This update delivers a built-in Help Centre across every module — " +
      "searchable articles for Customers, Inventory, Reports, Creditors, BAT " +
      "Reconciliation, Administration, and Hub & Backups — with a sidebar shortcut " +
      "that puts help and settings one click away from wherever you are in the app. " +
      "The full user manual can be printed or saved as a PDF directly from " +
      "/manual. Head-office users gain new tools on the Hub Backups page: a " +
      "per-site indicator confirms SQL database backups have reached the off-site " +
      "repository, snapshot trees can be browsed in the app, and snapshots can be " +
      "deleted or maintenance run from the viewer without leaving Cardoso.",
    sections: [
      {
        label: 'NEW',
        heading: 'New Features',
        items: [
          {
            title: 'Built-in Help Centre with articles for every module',
            body:
              "A full Help Centre is now available inside the app. Articles cover " +
              "every module — Customers, Inventory & Reports, Administration, BAT " +
              "Reconciliation, Creditors, and Hub & Backups — and can be searched " +
              "by keyword. Find answers without leaving the page you are working on.",
          },
          {
            title: 'Help and Settings accessible from the sidebar',
            body:
              "A Help flyout and a Settings flyout are now reachable from icons in " +
              "the sidebar, so you can look something up or adjust a setting from " +
              "anywhere in the app without navigating away from your current screen.",
          },
          {
            title: 'Printable user manual at /manual',
            body:
              "The complete user manual is available at /manual as a single " +
              "print-ready page. Print a reference copy or save it as a PDF to " +
              "share with your team.",
          },
          {
            title: 'Settings tabs are bookmarkable and shareable',
            body:
              "Settings panels can now be deep-linked using ?settings=<tab> in " +
              "the address bar. Bookmark a specific settings section or share a " +
              "direct link to it with a colleague.",
          },
          {
            title: 'Verify SQL backups reached the off-site hub, and manage snapshots',
            body:
              "The Hub Backups fleet table now shows a per-site indicator " +
              "confirming whether each site's SQL database backup has been " +
              "uploaded to the off-site repository. Snapshot trees can be browsed " +
              "directly in the viewer, and you can delete individual off-site " +
              "snapshots or trigger repository maintenance without leaving Cardoso.",
          },
        ],
      },
      {
        label: 'FIXED',
        heading: 'Fixes',
        items: [
          {
            title: 'Sidebar navigation is cleaner',
            body:
              "The subsystem health strip has been removed from the sidebar, " +
              "keeping the navigation uncluttered. System status and backup health " +
              "remain available on the dedicated Hub Backups page.",
          },
        ],
      },
    ],
  },

  '2026-07-03': {
    product: 'Cardoso App',
    title: 'Product Update',
    date: '3 July 2026',
    slug: '03-July-2026',
    intro:
      "This update (v2026.5.11) delivers a major upgrade to the Hub Backups page — " +
      "now a scannable fleet table with off-site Kopia restore built in — plus a new " +
      "sidebar health strip for at-a-glance subsystem status, richer Ctrl+K command " +
      "palette actions, and filtering and export tools on two log screens. A set of " +
      "reliability fixes tighten local backup pruning, improve Kopia connectivity " +
      "diagnostics, harden monthly export stability, and correct Hub copy status " +
      "accuracy so nothing is shown as healthy when it shouldn't be.",
    sections: [
      {
        label: 'NEW',
        heading: 'New Features',
        items: [
          {
            title: 'Hub Backups redesigned as a fleet table with off-site restore',
            body:
              "The Hub Backups page has been completely redesigned as a scannable " +
              "fleet table. Every site's local, SQL Server, and off-site Kopia backup " +
              "states are now first-class columns on a single screen — no need to " +
              "click into each site separately. Head-office users can also browse " +
              "the off-site Kopia snapshot repository directly in the app (with a " +
              "link to the Kopia UI for deeper detail), and initiate a restore " +
              "without leaving Cardoso: stage a snapshot, download it, and push it " +
              "to the live site in one flow.",
          },
          {
            title: 'Sidebar health strip',
            body:
              "A compact health strip now appears in the sidebar, showing the status " +
              "of key subsystems — such as backup and data sync — at a glance. " +
              "Named subsystem outcomes are displayed in a 2×2 grid so you can see " +
              "at a glance whether everything is healthy without navigating away from " +
              "your current page.",
          },
          {
            title: 'Command palette — actions and settings deep-links',
            body:
              "The Ctrl+K command palette has been extended beyond page navigation. " +
              "It now supports direct actions and can deep-link into specific settings " +
              "tabs, reducing the steps needed to reach configuration screens. Quick " +
              "entity search is also wired in so you can jump to a specific record " +
              "directly from the palette.",
          },
          {
            title: 'Log screens — filter, column picker, and CSV export',
            body:
              "Two log screens now include a DataTable toolbar with a live search " +
              "filter, a column visibility picker to show only the fields you need, " +
              "and a one-click CSV export of the current view.",
          },
        ],
      },
      {
        label: 'IMPROVED',
        heading: 'Improvements',
        items: [
          {
            title: 'Hub copy status stays accurate while data loads',
            body:
              "The hub-copy backup status no longer shows 'never synced' while the " +
              "underlying query is still resolving. A stalled hub copy is also now " +
              "aged correctly — it no longer shows as green (healthy) when the last " +
              "successful pull is overdue.",
          },
          {
            title: 'Inventory data loads without freezing the app',
            body:
              "The sales-rollup rebuild — which runs during inventory syncs — is now " +
              "broken into smaller yielding steps. Large datasets no longer cause the " +
              "application to pause or become unresponsive, and concurrent warm-up " +
              "requests are handled cleanly without duplicated work.",
          },
        ],
      },
      {
        label: 'FIXED',
        heading: 'Fixes',
        items: [
          {
            title: 'Local backup pruning now actually runs — keeps 3 days, never zeros out',
            body:
              "A bug was preventing the local backup prune from executing at all, " +
              "which could allow old backup files to accumulate indefinitely. Pruning " +
              "now runs correctly, retaining the most recent 3 days of backups and " +
              "removing older ones. The prune summary is also returned correctly and " +
              "filename matching has been tightened.",
          },
          {
            title: 'Kopia backup agent reports the real connection error',
            body:
              "When the Kopia off-site backup agent fails to connect to the " +
              "repository, it now logs the actual reason rather than a generic exit " +
              "code, making connectivity problems much easier to diagnose.",
          },
          {
            title: 'Monthly export is freeze-proof and alerts when a period is missing',
            body:
              "The automated monthly export process is now protected against freezes " +
              "during generation, and exports are serialised per period to prevent " +
              "conflicts. An alert is raised automatically if a month's export is " +
              "found to be missing, so nothing slips through unnoticed.",
          },
          {
            title: 'Hub Backups blocks restore from incomplete snapshots',
            body:
              "The Hub Backups page now prevents initiating a Kopia restore from " +
              "an incomplete snapshot. Only fully verified snapshots are offered for " +
              "restore, eliminating the risk of pushing partial data to a live site.",
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
