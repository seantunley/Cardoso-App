// Build a customer-facing "Product Roadmap" PDF.
//
// Uses the SAME visual template as scripts/release-notes-pdf.mjs (navy header
// band, labelled sections, page footer) so customer documents stay consistent.
// Curated, customer-language content — edit ROADMAP, then run:
//
//   node scripts/roadmap-pdf.mjs
//
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { jsPDF } from 'jspdf';

const ROADMAP = {
  product: 'Cardoso App',
  title: 'Product Roadmap',
  date: 'June 2026',
  intro:
    'Where we are taking Cardoso next, organised into three horizons. Dates are ' +
    'planning targets, confirmed with you sprint by sprint — this is a living ' +
    'plan, not a fixed contract. Throughout, our guiding principles hold: Sage ' +
    'is the source of truth, nothing fails silently, and a figure shown in one ' +
    'place agrees everywhere.',
  sections: [
    {
      label: 'NOW',
      heading: 'Now · June – July',
      items: [
        {
          title: 'Multi-site reporting at the Hub',
          body:
            'Bring the new Sage-faithful reports — Aged Debtors, Aged Creditors ' +
            'and Monthly Sales Figures — fully live at head office, with each ' +
            'branch synced down and shown both per branch and consolidated. One ' +
            'reconciled view of receivables, payables and sales across every depot.',
        },
        {
          title: 'Operational visibility',
          body:
            'A single screen showing every background process — Sage syncs, ' +
            'backups, reconciliation, exports — with status, last run and last ' +
            'error, and one-click retry. See at a glance that the overnight runs ' +
            'completed, and fix anything that did not.',
        },
        {
          title: 'Proactive alerts',
          body:
            'Automatic notification when a critical job fails — a sync, a backup, ' +
            'a reconciliation — so problems are known within minutes rather than ' +
            'discovered days later.',
        },
      ],
    },
    {
      label: 'NEXT',
      heading: 'Next · July – August',
      items: [
        {
          title: 'Transparent access control',
          body:
            'A clear view of why a user can or cannot see something, a preview of ' +
            'a user’s access before saving, and an exportable permission matrix — ' +
            'so access questions are answered in minutes.',
        },
        {
          title: 'Data-quality monitoring',
          body:
            'Automated nightly checks that surface duplicates, missing fields and ' +
            'Sage-vs-Cardoso mismatches, with a simple queue of issues to review — ' +
            'catching data problems before they reach a report.',
        },
        {
          title: 'Saved views',
          body:
            'Let each user save their preferred report and reconciliation filters, ' +
            'with optional shared team presets, for faster day-to-day work.',
        },
      ],
    },
    {
      label: 'LATER',
      heading: 'Later · August – September',
      items: [
        {
          title: 'Performance monitoring',
          body:
            'Visibility into how quickly key screens and exports respond, so slow ' +
            'points are identified and improved before they affect the team.',
        },
        {
          title: 'Configuration safety',
          body:
            'A safe, secret-redacted view of the system configuration, with ' +
            'warnings for risky combinations and clear “restart required” flags — ' +
            'reducing the chance of a change causing an outage.',
        },
        {
          title: 'Incident timeline',
          body:
            'A single, time-ordered view of deploys, job events, alerts and manual ' +
            'actions, so any issue can be understood and reviewed quickly.',
        },
      ],
    },
  ],
};

// ---- Theme (matches release-notes-pdf.mjs) --------------------------------
const NAVY = [27, 38, 59];
const SLATE = [90, 100, 115];
const HAIR = [222, 226, 232];
const INK = [33, 37, 41];
const LABEL_COLORS = {
  NOW: [22, 122, 80],
  NEXT: [37, 99, 162],
  LATER: [120, 110, 92],
};

const doc = new jsPDF({ unit: 'mm', format: 'a4' });
const W = doc.internal.pageSize.getWidth();
const H = doc.internal.pageSize.getHeight();
const M = 18;
const contentW = W - M * 2;

doc.setFillColor(...NAVY);
doc.rect(0, 0, W, 32, 'F');
doc.setTextColor(255);
doc.setFont('helvetica', 'bold');
doc.setFontSize(18);
doc.text(ROADMAP.product, M, 16);
doc.setFont('helvetica', 'normal');
doc.setFontSize(11);
doc.setTextColor(205, 212, 222);
doc.text(ROADMAP.title, M, 24);
doc.setFontSize(10);
doc.text(ROADMAP.date, W - M, 24, { align: 'right' });

let y = 44;
doc.setTextColor(...SLATE);
doc.setFont('helvetica', 'normal');
doc.setFontSize(10.5);
const introLines = doc.splitTextToSize(ROADMAP.intro, contentW);
doc.text(introLines, M, y);
y += introLines.length * 5.2 + 6;

const bottom = H - 18;
const ensure = (needed) => { if (y + needed > bottom) { doc.addPage(); y = 22; } };

for (const section of ROADMAP.sections) {
  ensure(18);
  const lc = LABEL_COLORS[section.label] || SLATE;

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

const pages = doc.getNumberOfPages();
for (let p = 1; p <= pages; p++) {
  doc.setPage(p);
  doc.setDrawColor(...HAIR);
  doc.setLineWidth(0.3);
  doc.line(M, H - 12, W - M, H - 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...SLATE);
  doc.text(`${ROADMAP.product} · ${ROADMAP.title}`, M, H - 7);
  doc.text(`Page ${p} of ${pages}`, W - M, H - 7, { align: 'right' });
}

const outPath = path.join('docs', 'Cardoso-Product-Roadmap-June-2026.pdf');
writeFileSync(outPath, Buffer.from(doc.output('arraybuffer')));
console.log(`Wrote ${ROADMAP.sections.length} sections → ${outPath}`);
