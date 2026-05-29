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
  '2026-05-29': {
  product: 'Cardoso App',
  title: 'Product Update',
  date: '29 May 2026',
  intro:
    'This update introduces a new Creditors module, richer inventory and sales ' +
    'trend reporting, and improved sales-commission tracking — alongside a range ' +
    'of refinements and fixes across the application.',
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
    y += bodyLines.length * 4.8 + 4.5;
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

const slug = RELEASE.date.replace(/\s+/g, '-');
const outPath = path.join('docs', `release-notes-${slug}.pdf`);
writeFileSync(outPath, Buffer.from(doc.output('arraybuffer')));
console.log(`Wrote ${RELEASE.sections.length} sections → ${outPath}`);
