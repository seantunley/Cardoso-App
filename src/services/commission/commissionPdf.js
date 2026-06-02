// Server-side commission PDF builder. Same layout as the client-side
// jspdf code in src/pages/SalesCommission.jsx — sharing a file would
// require Node + browser jspdf to agree on imports, so we duplicate
// the layout intentionally. Changes to one MUST be mirrored in the
// other (operator-facing manual download and hub-archived PDF must
// look identical so an operator can't spot a divergence).

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { renderUnpaidPage, renderClawbackPage } from './commissionPdfSections.js';

function formatRand(n) {
  const v = Number.isFinite(Number(n)) ? Number(n) : 0;
  return `R ${v.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function formatPct(rate) {
  const v = Number.isFinite(Number(rate)) ? Number(rate) : 0;
  return `${(v * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

/**
 * @param {{
 *   depotName: string,
 *   report: {
 *     from: string, to: string,
 *     settings: { sweets_rate: number, cigtob_rate: number, reference_rate: number },
 *     reps: Array<any>, totals: any,
 *   },
 * }} args
 * @returns {Buffer}  the PDF bytes
 */
export function buildCommissionPdf({ depotName, report }) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const sweetsRate = report.settings?.sweets_rate ?? 0.015;
  const cigtobRate = report.settings?.cigtob_rate ?? 0.0017;
  const refRate = report.settings?.reference_rate ?? 0.01;
  const headerTitle = `Commission Sales Report — ${report.from} to ${report.to}`;

  let cursorY = 14;
  if (depotName) {
    doc.setFontSize(11);
    doc.setTextColor(80);
    doc.text(depotName, 14, 12);
    cursorY = 19;
  }
  doc.setFontSize(14);
  doc.setTextColor(0);
  doc.text(headerTitle, 14, cursorY);
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(
    `Sweets rate ${formatPct(sweetsRate)} · Cig+Tob rate ${formatPct(cigtobRate)} · Reference rate ${formatPct(refRate)}`,
    14, cursorY + 6,
  );

  autoTable(doc, {
    startY: cursorY + 12,
    head: [['Sales Person', 'Sweet Sales', 'Credits', 'Net Sweets', 'Customer Payment Total', 'Cig + Tob Base']],
    body: [
      ...report.reps.map(r => [
        r.sales_rep, formatRand(r.sweet_sales), formatRand(r.sweet_credits),
        formatRand(r.net_sweets), formatRand(r.customer_payments), formatRand(r.cig_tob_base),
      ]),
      ['TOTAL', formatRand(report.totals.sweet_sales), formatRand(report.totals.sweet_credits),
        formatRand(report.totals.net_sweets), formatRand(report.totals.customer_payments), formatRand(report.totals.cig_tob_base)],
    ],
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [33, 33, 33] },
    columnStyles: { 0: { fontStyle: 'bold' } },
  });

  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 8,
    head: [['Sales Person', 'Net Sweets', `Sweets ${formatPct(sweetsRate)}`, `Ref ${formatPct(refRate)}`, 'Cig + Tob Base', `Cig+Tob ${formatPct(cigtobRate)}`, 'Total']],
    body: [
      ...report.reps.map(r => [
        r.sales_rep, formatRand(r.net_sweets), formatRand(r.sweet_commission),
        formatRand(r.reference_commission), formatRand(r.cig_tob_base),
        formatRand(r.cigtob_commission), formatRand(r.total_commission),
      ]),
      ['TOTAL', formatRand(report.totals.net_sweets), formatRand(report.totals.sweet_commission),
        formatRand(report.totals.reference_commission), formatRand(report.totals.cig_tob_base),
        formatRand(report.totals.cigtob_commission), formatRand(report.totals.total_commission)],
    ],
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [33, 33, 33] },
  });

  // Page 2: unpaid invoices in the period. Page 3: clawback from the previous
  // period. Each is skipped (no blank page) when it has no rows.
  const prev = report.clawback_previous_period;
  const prevLabel = prev?.fromDate && prev?.toDate ? `${prev.fromDate} → ${prev.toDate}` : 'previous period';
  renderUnpaidPage(doc, autoTable, {
    depotName, periodLabel: `${report.from} to ${report.to}`,
    unpaid: report.unpaid_invoices, unpaidTotals: report.unpaid_totals, sweetsRate, refRate,
  });
  renderClawbackPage(doc, autoTable, {
    depotName, prevLabel, clawback: report.clawback, clawbackTotals: report.clawback_totals,
  });

  // jsPDF in Node returns the PDF via output('arraybuffer'); wrap in
  // a Node Buffer for the file/disk + HTTP-payload code that follows.
  return Buffer.from(doc.output('arraybuffer'));
}
