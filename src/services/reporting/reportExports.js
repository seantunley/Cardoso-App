// PDF + Excel export builders for the reporting dashboard.
//
// These take the SAME report objects produced by buildAgedDebtorsReport /
// buildRepExposureReport in src/routes/reporting.js, so a download always
// matches what's on screen. PDF uses jsPDF + autoTable (mirrors
// src/services/commission/commissionPdf.js); Excel uses ExcelJS (mirrors
// src/services/jti/jtiSpreadsheet.js).
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import ExcelJS from 'exceljs';

const BUCKET_KEYS = ['current', '7-13', '14-20', '21+', 'unknown'];
const BUCKET_LABELS = {
  current: 'Current (<7d)',
  '7-13': '7–13 days',
  '14-20': '14–20 days',
  '21+': '21+ days',
  unknown: 'Undated',
};

const fmtR = (n) => `R ${(Number(n) || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num2 = (n) => Number((Number(n) || 0).toFixed(2));
const dateOnly = (iso) => String(iso || new Date().toISOString()).slice(0, 10);

// ── Aged Debtors ───────────────────────────────────────────────────────────

export function buildAgedDebtorsPdf(report) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const buckets = report?.summary?.buckets || {};
  const counts = report?.summary?.bucket_counts || {};

  doc.setFontSize(14);
  doc.setTextColor(0);
  doc.text('Aged Debtors', 14, 16);
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(`${report?.site_name || ''} · generated ${dateOnly(report?.generated_at)}`, 14, 22);
  doc.text(
    `${report?.summary?.total_customers || 0} customers · ${fmtR(report?.summary?.total_outstanding)} outstanding · min balance ${fmtR(report?.min_balance)}`,
    14,
    27,
  );
  if (report?.truncated) {
    doc.setTextColor(176, 124, 24);
    doc.text(`Note: list truncated at ${report.truncated_at} rows.`, 14, 32);
  }

  // Aging summary table
  autoTable(doc, {
    startY: 38,
    styles: { fontSize: 8, cellPadding: 1.6 },
    headStyles: { fillColor: [33, 33, 33] },
    head: [['Bucket', 'Customers', 'Outstanding']],
    body: BUCKET_KEYS.map((k) => [BUCKET_LABELS[k], String(counts[k] || 0), fmtR(buckets[k])]),
    foot: [['TOTAL', String(report?.summary?.total_customers || 0), fmtR(report?.summary?.total_outstanding)]],
    footStyles: { fillColor: [220, 220, 220], textColor: 0, fontStyle: 'bold' },
  });

  // Detail table
  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 8,
    styles: { fontSize: 7.5, cellPadding: 1.3 },
    headStyles: { fillColor: [50, 50, 50] },
    head: [['Code', 'Customer', 'Rep', 'Type', 'Age (d)', 'Bucket', 'Balance']],
    body: (report?.records || []).map((r) => [
      String(r.customer_number || '').trim(),
      String(r.customer_name || '').trim(),
      String(r.sales_rep || '').trim(),
      String(r.account_type || '').trim(),
      r.age_days == null ? '—' : String(r.age_days),
      BUCKET_LABELS[r.bucket] || r.bucket || '',
      fmtR(r.parsed_balance ?? r.outstanding_balance),
    ]),
    columnStyles: { 6: { halign: 'right' } },
  });

  return Buffer.from(doc.output('arraybuffer'));
}

export async function buildAgedDebtorsXlsx(report) {
  const wb = new ExcelJS.Workbook();

  const summary = wb.addWorksheet('Summary');
  summary.addRow(['Aged Debtors']);
  summary.addRow([report?.site_name || '', `generated ${dateOnly(report?.generated_at)}`]);
  summary.addRow([]);
  summary.addRow(['Bucket', 'Customers', 'Outstanding']);
  const buckets = report?.summary?.buckets || {};
  const counts = report?.summary?.bucket_counts || {};
  for (const k of BUCKET_KEYS) summary.addRow([BUCKET_LABELS[k], counts[k] || 0, num2(buckets[k])]);
  summary.addRow(['TOTAL', report?.summary?.total_customers || 0, num2(report?.summary?.total_outstanding)]);

  const detail = wb.addWorksheet('Detail');
  detail.addRow(['Code', 'Customer', 'Rep', 'Type', 'Site', 'Age (days)', 'Bucket', 'Balance']);
  for (const r of report?.records || []) {
    detail.addRow([
      String(r.customer_number || '').trim(),
      String(r.customer_name || '').trim(),
      String(r.sales_rep || '').trim(),
      String(r.account_type || '').trim(),
      String(r.site_name || '').trim(),
      r.age_days == null ? null : r.age_days,
      BUCKET_LABELS[r.bucket] || r.bucket || '',
      num2(r.parsed_balance ?? r.outstanding_balance),
    ]);
  }
  detail.getColumn(8).numFmt = '#,##0.00';

  return await wb.xlsx.writeBuffer();
}

// ── Rep Exposure ─────────────────────────────────────────────────────────────

export function buildRepExposurePdf(report) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });

  doc.setFontSize(14);
  doc.setTextColor(0);
  doc.text('Sales Rep Exposure', 14, 16);
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(`${report?.site_name || ''} · generated ${dateOnly(report?.generated_at)}`, 14, 22);
  doc.text(
    `${report?.summary?.total_reps || 0} reps · ${report?.summary?.total_customers || 0} customers · ${fmtR(report?.summary?.total_outstanding)} outstanding`,
    14,
    27,
  );

  autoTable(doc, {
    startY: 34,
    styles: { fontSize: 8, cellPadding: 1.6 },
    headStyles: { fillColor: [33, 33, 33] },
    head: [['Sales Rep', 'Customers', 'Red', 'Orange', 'Green', 'Outstanding']],
    body: (report?.reps || []).map((r) => [
      r.sales_rep || '',
      String(r.customer_count || 0),
      String(r.flag_counts?.red || 0),
      String(r.flag_counts?.orange || 0),
      String(r.flag_counts?.green || 0),
      fmtR(r.total_outstanding),
    ]),
    foot: [[
      'TOTAL',
      String(report?.summary?.total_customers || 0),
      String(report?.summary?.total_red || 0),
      String(report?.summary?.total_orange || 0),
      '',
      fmtR(report?.summary?.total_outstanding),
    ]],
    footStyles: { fillColor: [220, 220, 220], textColor: 0, fontStyle: 'bold' },
    columnStyles: { 5: { halign: 'right' } },
  });

  return Buffer.from(doc.output('arraybuffer'));
}

export async function buildRepExposureXlsx(report) {
  const wb = new ExcelJS.Workbook();

  const reps = wb.addWorksheet('Rep Exposure');
  reps.addRow(['Sales Rep', 'Customers', 'Red', 'Orange', 'Green', 'Outstanding']);
  for (const r of report?.reps || []) {
    reps.addRow([
      r.sales_rep || '',
      r.customer_count || 0,
      r.flag_counts?.red || 0,
      r.flag_counts?.orange || 0,
      r.flag_counts?.green || 0,
      num2(r.total_outstanding),
    ]);
  }
  reps.addRow(['TOTAL', report?.summary?.total_customers || 0, report?.summary?.total_red || 0, report?.summary?.total_orange || 0, '', num2(report?.summary?.total_outstanding)]);
  reps.getColumn(6).numFmt = '#,##0.00';

  // Top customers per rep, flattened.
  const top = wb.addWorksheet('Top Customers');
  top.addRow(['Sales Rep', 'Code', 'Customer', 'Type', 'Flag', 'Outstanding']);
  for (const r of report?.reps || []) {
    for (const c of r.top_customers || []) {
      top.addRow([
        r.sales_rep || '',
        String(c.customer_number || '').trim(),
        String(c.customer_name || '').trim(),
        c.account_type || '',
        c.flag_color || 'none',
        num2(c.outstanding_balance),
      ]);
    }
  }
  top.getColumn(6).numFmt = '#,##0.00';

  return await wb.xlsx.writeBuffer();
}
