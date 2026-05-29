// Shared "extra page" renderers for the commission PDF — the Unpaid-invoices
// page and the Clawback page. Both the server builder (commissionPdf.js) and
// the client builder (SalesCommission.jsx) import these so the two PDFs stay
// identical. This module deliberately does NOT import jsPDF/jspdf-autotable —
// the caller passes its own `doc` and `autoTable`, so the same code runs under
// Node and the browser without the two having to agree on a jspdf import.

function formatRand(n) {
  const v = Number.isFinite(Number(n)) ? Number(n) : 0;
  return `R ${v.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function formatPct(rate) {
  const v = Number.isFinite(Number(rate)) ? Number(rate) : 0;
  return `${(v * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;
}
function fmtDate(n) {
  if (!n) return '—';
  const s = String(n);
  return /^\d{8}$/.test(s) ? s.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : s;
}

const DARK = [33, 33, 33];
const FOOT = [60, 60, 60];

// Page header (depot + title + subtitle). Returns the Y to start tables at.
function pageHead(doc, { depotName, title, subtitle }) {
  let y = 14;
  if (depotName) {
    doc.setFontSize(10); doc.setTextColor(110);
    doc.text(depotName, 14, 11);
    y = 17;
  }
  doc.setFontSize(13); doc.setTextColor(0);
  doc.text(title, 14, y);
  if (subtitle) {
    doc.setFontSize(8.5); doc.setTextColor(120);
    const lines = doc.splitTextToSize(subtitle, 270);
    doc.text(lines, 14, y + 5);
    y += 5 + lines.length * 4;
  }
  doc.setTextColor(0);
  return y + 4;
}

const moneyCols = (idxs) => Object.fromEntries(idxs.map((i) => [i, { halign: 'right' }]));

/**
 * Unpaid sweets invoices page. No-op (no page added) when there are none.
 * @param {any} doc  jsPDF instance
 * @param {Function} autoTable  jspdf-autotable default export
 */
export function renderUnpaidPage(doc, autoTable, { depotName, periodLabel, unpaid, unpaidTotals, sweetsRate, refRate }) {
  if (!Array.isArray(unpaid) || unpaid.length === 0) return;
  doc.addPage();
  const startY = pageHead(doc, {
    depotName,
    title: `Unpaid Sweets Invoices — ${periodLabel}`,
    subtitle: "These invoices are counted in the commission totals but are still outstanding in AR. If any are still unpaid by the next commission period, the commission paid on them should be clawed back from that rep's next payout.",
  });

  // Per-rep summary
  autoTable(doc, {
    startY,
    head: [['Sales Person', 'Invoices', 'Net Sweets', 'Outstanding', `Sweets ${formatPct(sweetsRate)} at risk`, `Ref ${formatPct(refRate)}`]],
    body: [
      ...unpaid.map((r) => [
        r.sales_rep, String(r.invoice_count), formatRand(r.total_net_sweets), formatRand(r.total_outstanding),
        formatRand(r.at_risk_sweet_commission), formatRand(r.at_risk_reference_commission),
      ]),
      ['TOTAL', String(unpaidTotals?.invoice_count ?? ''), formatRand(unpaidTotals?.total_net_sweets),
        formatRand(unpaidTotals?.total_outstanding), formatRand(unpaidTotals?.at_risk_sweet_commission),
        formatRand(unpaidTotals?.at_risk_reference_commission)],
    ],
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: DARK },
    columnStyles: { 0: { fontStyle: 'bold' }, ...moneyCols([1, 2, 3, 4, 5]) },
    didParseCell: (d) => { if (d.section === 'body' && d.row.index === unpaid.length) d.cell.styles.fillColor = FOOT, d.cell.styles.textColor = 255; },
  });

  // Per-invoice detail (grouped by rep via a leading Rep column)
  const detail = [];
  for (const r of unpaid) {
    for (const inv of (r.invoices || [])) {
      detail.push([
        r.sales_rep, inv.invoice_number, fmtDate(inv.invoice_date),
        (inv.customer_name || '—') + (inv.customer_code ? `  (${inv.customer_code})` : ''),
        formatRand(inv.net_sweet_amount), formatRand(inv.original_amount), formatRand(inv.outstanding_amount),
      ]);
    }
  }
  if (detail.length) {
    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 6,
      head: [['Rep', 'Invoice', 'Date', 'Customer', 'Net Sweets', 'Invoice Total', 'Outstanding']],
      body: detail,
      styles: { fontSize: 7.5, cellPadding: 1.5 },
      headStyles: { fillColor: DARK },
      columnStyles: moneyCols([4, 5, 6]),
    });
  }
}

/**
 * Clawback page — previous-period unpaid invoices still unpaid today. No-op
 * when there are none.
 */
export function renderClawbackPage(doc, autoTable, { depotName, prevLabel, clawback, clawbackTotals }) {
  if (!Array.isArray(clawback) || clawback.length === 0) return;
  doc.addPage();
  const startY = pageHead(doc, {
    depotName,
    title: `Clawback — invoices from ${prevLabel} still unpaid`,
    subtitle: "These sweets invoices were unpaid at the end of the previous commission period and are still unpaid in AR today. The commission paid on them last period should be DEDUCTED from each rep's payout this period. Rates shown are those in force when the commission was originally paid.",
  });

  // Per-rep summary
  autoTable(doc, {
    startY,
    head: [['Sales Person', 'Invoices', 'Outstanding', 'Sweets Clawback', 'Ref Clawback']],
    body: [
      ...clawback.map((r) => [
        r.sales_rep, String(r.invoice_count), formatRand(r.total_outstanding),
        formatRand(r.total_sweet_commission_clawback), formatRand(r.total_reference_commission_clawback),
      ]),
      ['TOTAL', String(clawbackTotals?.invoice_count ?? ''), formatRand(clawbackTotals?.total_outstanding),
        formatRand(clawbackTotals?.total_sweet_commission_clawback), formatRand(clawbackTotals?.total_reference_commission_clawback)],
    ],
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: DARK },
    columnStyles: { 0: { fontStyle: 'bold' }, ...moneyCols([1, 2, 3, 4]) },
    didParseCell: (d) => { if (d.section === 'body' && d.row.index === clawback.length) d.cell.styles.fillColor = FOOT, d.cell.styles.textColor = 255; },
  });

  // Per-invoice detail
  const detail = [];
  for (const r of clawback) {
    for (const inv of (r.invoices || [])) {
      detail.push([
        r.sales_rep, inv.invoice_number, fmtDate(inv.invoice_date),
        (inv.customer_name || '—') + (inv.customer_code ? `  (${inv.customer_code})` : ''),
        formatRand(inv.net_sweet_amount), formatRand(inv.outstanding_amount),
        `${formatRand(inv.sweet_commission_clawback)}  @${formatPct(inv.sweets_rate_at_paid)}`,
        formatRand(inv.reference_commission_clawback),
      ]);
    }
  }
  if (detail.length) {
    autoTable(doc, {
      startY: doc.lastAutoTable.finalY + 6,
      head: [['Rep', 'Invoice', 'Date', 'Customer', 'Net Sweets', 'Outstanding', 'Sweets Clawback', 'Ref Clawback']],
      body: detail,
      styles: { fontSize: 7.5, cellPadding: 1.5 },
      headStyles: { fillColor: DARK },
      columnStyles: moneyCols([4, 5, 6, 7]),
    });
  }
}
