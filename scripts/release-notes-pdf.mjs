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
      "insights feed, and a broad set of usability, performance and accuracy " +
      "improvements. Every figure is drawn from, and reconciles to, Sage.",
    sections: [
      {
        label: 'NEW',
        heading: 'New Modules & Features',
        items: [
          {
            title: 'Creditors module',
            body:
              "A complete new area for managing supplier accounts, fed from Sage " +
              "and refreshed automatically each night so the figures are always current.",
            details: [
              'Creditor Summary: outstanding balance per vendor with header totals and resizable columns.',
              'Creditor Search: drill into an individual supplier and its full payment history.',
              'Nightly Sage sync built on verified Sage column mappings (no guesswork), with a correct payment filter.',
              'A Settings tab to fine-tune the Sage query and how much history is loaded.',
              'A default filter that hides never-paid and zero-balance vendors, so the list shows who you actually trade with.',
              'Its own access permission and sidebar group.',
            ],
          },
          {
            title: 'Aged Creditors report',
            body:
              "A new report that ages every open supplier document the way Sage's " +
              "Aged Payables trial balance does, rather than dropping a whole balance into one period.",
            details: [
              'Sage monthly periods: Current, 1-30, 31-60, 61-90 and Over 90 days, aged by due date.',
              'Each document is placed individually, so a vendor correctly spans several periods.',
              'Reconciles to the live Sage open items, and downloads as a polished PDF or Excel workbook.',
              'Available consolidated and per branch at head office.',
            ],
          },
          {
            title: 'Aged Debtors, rebuilt on the Sage open-item ledger',
            body:
              "The customer aging report was rebuilt on a new open-item ledger synced " +
              "from Sage, so each invoice, credit note and debit note is aged individually " +
              "instead of approximating from a single balance.",
            details: [
              'Sage weekly periods: Current, 1-7, 8-14, 15-21 and Over 21 days, by document date.',
              'Customers in a national account roll up under the parent and inherit its sales rep and type.',
              'Reconciles to the live Sage open items rather than a balance that could drift.',
            ],
          },
          {
            title: 'Monthly Sales Figures report',
            body:
              "A new month-by-month view of posted invoices, credit notes and debit " +
              "notes with VAT shown separately, matching your existing Sage 'Sales Figures' report to the cent.",
            details: [
              'Ex-VAT, VAT and Inclusive columns for each document type, plus a Net line and grand totals.',
              'The current month is highlighted; exports to CSV and prints cleanly.',
              'At head office it can be viewed per branch and consolidated across the group.',
            ],
          },
          {
            title: 'Sales Commission reporting',
            body:
              "Monthly sales-commission reports that mirror your existing spreadsheet, " +
              "drawn directly from Sage, with automatic archiving and per-rep accuracy.",
            details: [
              'Sage-native queries that reproduce the operator spreadsheet (Sweets / Cig+Tob splits).',
              'Commission calculated on paid sales, with a clear per-rep breakdown of unpaid invoices.',
              'A clawback workflow for invoices unpaid across periods, floored at zero so a return never credits the rep.',
              'Automatic month-end archiving, bundled per site as PDFs and pushed to head office.',
              'A printed report with dedicated Unpaid Invoices and Clawback pages, and an admin query-override panel.',
            ],
          },
          {
            title: 'Inventory & sales analytics (Trends)',
            body:
              "New reporting that compares inventory and sales year over year, highlights " +
              "top sellers by season, and surfaces slow-moving stock, for a single site or the whole group.",
            details: [
              'Customer and Inventory views, with Mix and Movement sub-views.',
              'Top ten items per South African season, with commodity codes shown as names (Sweets / Cigarettes / Tobacco / Mixed).',
              'Dead-stock highlighting restricted to stock currently held, with a site filter.',
              'Inventory history extended to three calendar years for year-over-year comparison.',
            ],
          },
          {
            title: 'Reorder planning',
            body:
              "See exactly what to order and when: items at or below their reorder point, " +
              "grouped by supplier, with an exportable purchase sheet.",
            details: [
              'Click any item to view its sales trend and seasonality before ordering.',
            ],
          },
          {
            title: 'Inventory Movement & Stock Receipt Expiry',
            body: "Two new operational tools for stock control.",
            details: [
              'Inventory Movement shows how quickly stock is selling, flags dead stock, and rolls figures up across sites.',
              'Stock Receipt Expiry captures expiry dates against stock as it is received, kept in step with your Sage purchase orders (including reversed lines), to stay ahead of short-dated stock.',
            ],
          },
          {
            title: 'Reporting Dashboard & Insights',
            body:
              "A new at-a-glance home for reporting, plus a feed that surfaces what needs attention on its own.",
            details: [
              'Headline figures and a summary card per report, with a strip showing whether your Sage data is current.',
              'A ranked Insights feed: falling sales, customers buying less, dead stock building up, and large debtor exposure.',
              'Administrators can add their own no-code rules (for example, alert if revenue drops more than 10%).',
              'Summary cards for Aged Debtors and Aged Creditors, each opening the full report in one click.',
            ],
          },
          {
            title: 'Monthly Reports menu, with its own access control',
            body:
              "A new Monthly Reports area groups the Monthly Sales Figures and Sales " +
              "Commission reports together, behind a single permission so you decide who can see them.",
            details: [],
          },
          {
            title: 'Collections, price lists and account families',
            body: "Day-to-day tools to chase money and find the right account.",
            details: [
              'Collections worklists keep each rep on their assigned outstanding accounts, with bulk actions.',
              'A printable price list for quick reference.',
              'Linked customer accounts: sub-accounts now show their full account family from either side.',
              'A tool that tidies up Sage credit-note descriptions for cleaner records.',
            ],
          },
          {
            title: 'Downloadable reports & faster navigation',
            body:
              "Reports can now be shared and filed easily, and the whole application is quicker to move around.",
            details: [
              'Aged Debtors and Sales Rep Exposure download as a polished PDF or an Excel workbook that matches your on-screen filters.',
              'A command palette (Ctrl/Cmd-K) jumps to any page or report instantly.',
              'A notifications bell flags anything needing attention from anywhere in the app.',
              'Report filters are kept in the page link, so a view can be bookmarked or shared, and favourite views can be saved.',
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
              "Customer and creditor balances are now built directly from Sage's open " +
              "items, so on-screen totals match Sage to the cent.",
            details: [
              'Aging summary tiles on the Customer Balances and Creditor Balances screens that always match the filter applied.',
              'Location and Terms shown per customer, with a National / Standard account filter.',
            ],
          },
          {
            title: 'Branded, print-ready reports',
            body:
              "Every report now prints with your depot name and logo, fits the page " +
              "cleanly, and reads clearly in black and white, ready to share or file.",
            details: [],
          },
          {
            title: 'Clearer navigation and tidier screens',
            body:
              "Menus were reorganised into logical groups, the sidebar was tidied into " +
              "an account menu, and explanatory tooltips were added across the new modules.",
            details: [
              'Pagination now includes first/last page jumps and a go-to-page box for long lists.',
              'Summary tables support resizable columns and tidier layouts.',
              'Page headings share a single consistent style across the application.',
            ],
          },
          {
            title: 'Faster, smoother performance',
            body:
              "Reports and dashboards load noticeably faster, show tidy loading " +
              "placeholders instead of blank screens, and offer a one-click retry if something fails to load.",
            details: [
              'A dedicated frontend performance pass and several database query optimisations.',
              'Configurable data sync: administrators can tune how supplier data is retrieved and how much history is loaded.',
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
              "across the application, enforced centrally so it cannot drift back.",
            details: [],
          },
          {
            title: 'Problems are surfaced, not hidden',
            body:
              "Issues that previously went unreported are now raised clearly, with " +
              "system-log telemetry across modules, so they can be resolved sooner.",
            details: [
              'Several boot and runtime errors exposed when switching between single-site and head-office views were resolved.',
            ],
          },
          {
            title: 'Commission report accuracy',
            body:
              "The printed commission report now includes dedicated Unpaid Invoices and " +
              "Clawback pages; clawback no longer treats returns or credit notes as a " +
              "credit to the rep, and the commission-at-risk total adds up correctly.",
            details: [],
          },
          {
            title: 'Cleaner, correct report figures',
            body:
              "Balance, payment and aging figures were corrected across a number of " +
              "reports and screens so the headline and the detail always agree.",
            details: [
              'The customer pop-up shows only genuinely outstanding invoices and receipts; anything paid or matched off is no longer listed.',
              'Customers who have not traded in a long time are flagged dormant even at a zero balance.',
              'Corrected aging dates and bucket totals across the debtor and creditor reports, and aligned the dashboard debtor headline with the Customer Balances screen.',
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
