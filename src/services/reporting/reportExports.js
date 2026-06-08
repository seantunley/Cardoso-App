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
import { AR_SCHEME, AP_SCHEME } from '../aging.js';

// Aged Debtors uses the AR (weekly) scheme; Aged Creditors the AP (monthly)
// scheme. Keys + labels come from the engine so they never drift.
const BUCKET_KEYS = AR_SCHEME.keys;
const BUCKET_LABELS = AR_SCHEME.labels;

const fmtR = (n) => `R ${(Number(n) || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num2 = (n) => Number((Number(n) || 0).toFixed(2));
const dateOnly = (iso) => String(iso || new Date().toISOString()).slice(0, 10);

// ── Aged Debtors ───────────────────────────────────────────────────────────

export function buildAgedDebtorsPdf(report) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const buckets = report?.summary?.buckets || {};
  const counts = report?.summary?.bucket_counts || {};

  doc.setFontSize(14);
  doc.setTextColor(0);
  doc.text('Aged Debtors', 14, 14);
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(`${report?.site_name || ''} · generated ${dateOnly(report?.generated_at)}`, 14, 20);
  doc.text(
    `${report?.summary?.total_customers || 0} customers · ${fmtR(report?.summary?.total_outstanding)} outstanding · min balance ${fmtR(report?.min_balance)}`,
    14,
    25,
  );

  // Aging summary table
  autoTable(doc, {
    startY: 31,
    styles: { fontSize: 8, cellPadding: 1.6 },
    headStyles: { fillColor: [33, 33, 33] },
    head: [['Bucket', 'Customers', 'Outstanding']],
    body: BUCKET_KEYS.map((k) => [BUCKET_LABELS[k], String(counts[k] || 0), fmtR(buckets[k])]),
    foot: [['TOTAL', String(report?.summary?.total_customers || 0), fmtR(report?.summary?.total_outstanding)]],
    footStyles: { fillColor: [220, 220, 220], textColor: 0, fontStyle: 'bold' },
  });

  // Detail table — one row per customer, balance split across the period columns.
  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 8,
    styles: { fontSize: 7.5, cellPadding: 1.3 },
    headStyles: { fillColor: [50, 50, 50] },
    head: [['Code', 'Customer', 'Rep', 'Type', ...BUCKET_KEYS.map((k) => BUCKET_LABELS[k]), 'Total']],
    body: (report?.records || []).map((r) => [
      String(r.customer_number || '').trim(),
      String(r.customer_name || '').trim(),
      String(r.sales_rep || '').trim(),
      String(r.account_type || '').trim(),
      ...BUCKET_KEYS.map((k) => fmtR(r.bucket_amounts?.[k])),
      fmtR(r.parsed_balance ?? r.outstanding_balance),
    ]),
    foot: [[
      'TOTAL', '', '', '',
      ...BUCKET_KEYS.map((k) => fmtR(buckets[k])),
      fmtR(report?.summary?.total_outstanding),
    ]],
    footStyles: { fillColor: [220, 220, 220], textColor: 0, fontStyle: 'bold' },
    columnStyles: Object.fromEntries([4, 5, 6, 7, 8, 9].map((i) => [i, { halign: 'right' }])),
  });

  return Buffer.from(doc.output('arraybuffer'));
}

export async function buildAgedDebtorsXlsx(report) {
  const wb = new ExcelJS.Workbook();
  const buckets = report?.summary?.buckets || {};
  const counts = report?.summary?.bucket_counts || {};

  const summary = wb.addWorksheet('Summary');
  summary.addRow(['Aged Debtors']);
  summary.addRow([report?.site_name || '', `generated ${dateOnly(report?.generated_at)}`]);
  summary.addRow([]);
  summary.addRow(['Bucket', 'Customers', 'Outstanding']);
  for (const k of BUCKET_KEYS) summary.addRow([BUCKET_LABELS[k], counts[k] || 0, num2(buckets[k])]);
  summary.addRow(['TOTAL', report?.summary?.total_customers || 0, num2(report?.summary?.total_outstanding)]);

  const detail = wb.addWorksheet('Detail');
  detail.addRow(['Code', 'Customer', 'Rep', 'Type', 'Terms', 'Site', ...BUCKET_KEYS.map((k) => BUCKET_LABELS[k]), 'Total']);
  for (const r of report?.records || []) {
    detail.addRow([
      String(r.customer_number || '').trim(),
      String(r.customer_name || '').trim(),
      String(r.sales_rep || '').trim(),
      String(r.account_type || '').trim(),
      String(r.terms || '').trim(),
      String(r.site_name || '').trim(),
      ...BUCKET_KEYS.map((k) => num2(r.bucket_amounts?.[k])),
      num2(r.parsed_balance ?? r.outstanding_balance),
    ]);
  }
  // Number-format the bucket + total columns (G..L).
  for (let c = 7; c <= 12; c++) detail.getColumn(c).numFmt = '#,##0.00';

  return await wb.xlsx.writeBuffer();
}

// ── Aged Creditors ───────────────────────────────────────────────────────────
// Columnar per-bucket layout (the Sage Aged Trial Balance shape): every vendor
// shows its balance distributed across the aging periods, not a single bucket.

const DATED_BUCKET_KEYS = AP_SCHEME.keys;
const CREDITOR_LABELS = AP_SCHEME.labels;

export function buildAgedCreditorsPdf(report) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const buckets = report?.summary?.buckets || {};
  const counts = report?.summary?.bucket_counts || {};

  doc.setFontSize(14);
  doc.setTextColor(0);
  doc.text('Aged Creditors', 14, 14);
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(`${report?.site_name || ''} · generated ${dateOnly(report?.generated_at)}`, 14, 20);
  doc.text(
    `${report?.summary?.total_vendors || 0} vendors · ${fmtR(report?.summary?.total_outstanding)} outstanding`,
    14,
    25,
  );

  // Aging summary table
  autoTable(doc, {
    startY: 31,
    styles: { fontSize: 8, cellPadding: 1.6 },
    headStyles: { fillColor: [33, 33, 33] },
    head: [['Bucket', 'Vendors', 'Outstanding']],
    body: DATED_BUCKET_KEYS.map((k) => [CREDITOR_LABELS[k], String(counts[k] || 0), fmtR(buckets[k])]),
    foot: [['TOTAL', String(report?.summary?.total_vendors || 0), fmtR(report?.summary?.total_outstanding)]],
    footStyles: { fillColor: [220, 220, 220], textColor: 0, fontStyle: 'bold' },
  });

  // Detail table — one row per vendor, balance split across the period
  // columns. In hub all-sites mode the Site column disambiguates the same
  // vendor code appearing at more than one site.
  const hub = !!report?.hub_mode;
  const lead = hub ? ['Code', 'Vendor', 'Site', 'Terms'] : ['Code', 'Vendor', 'Terms'];
  const numericStart = lead.length;
  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 8,
    styles: { fontSize: 7.5, cellPadding: 1.3 },
    headStyles: { fillColor: [50, 50, 50] },
    head: [[...lead, ...DATED_BUCKET_KEYS.map((k) => CREDITOR_LABELS[k]), 'Total']],
    body: (report?.records || []).map((r) => [
      String(r.vendor_code || '').trim(),
      String(r.vendor_name || '').trim(),
      ...(hub ? [String(r.site_name || '').trim()] : []),
      String(r.terms || '').trim(),
      ...DATED_BUCKET_KEYS.map((k) => fmtR(r.bucket_amounts?.[k])),
      fmtR(r.parsed_balance),
    ]),
    foot: [[
      'TOTAL', ...Array(lead.length - 1).fill(''),
      ...DATED_BUCKET_KEYS.map((k) => fmtR(buckets[k])),
      fmtR(report?.summary?.total_outstanding),
    ]],
    footStyles: { fillColor: [220, 220, 220], textColor: 0, fontStyle: 'bold' },
    columnStyles: Object.fromEntries(
      Array.from({ length: DATED_BUCKET_KEYS.length + 1 }, (_, i) => [numericStart + i, { halign: 'right' }]),
    ),
  });

  return Buffer.from(doc.output('arraybuffer'));
}

export async function buildAgedCreditorsXlsx(report) {
  const wb = new ExcelJS.Workbook();
  const buckets = report?.summary?.buckets || {};
  const counts = report?.summary?.bucket_counts || {};

  const summary = wb.addWorksheet('Summary');
  summary.addRow(['Aged Creditors']);
  summary.addRow([report?.site_name || '', `generated ${dateOnly(report?.generated_at)}`]);
  summary.addRow([]);
  summary.addRow(['Bucket', 'Vendors', 'Outstanding']);
  for (const k of DATED_BUCKET_KEYS) summary.addRow([CREDITOR_LABELS[k], counts[k] || 0, num2(buckets[k])]);
  summary.addRow(['TOTAL', report?.summary?.total_vendors || 0, num2(report?.summary?.total_outstanding)]);

  const detail = wb.addWorksheet('Detail');
  detail.addRow(['Code', 'Vendor', 'Terms', 'Site', ...DATED_BUCKET_KEYS.map((k) => CREDITOR_LABELS[k]), 'Total']);
  for (const r of report?.records || []) {
    detail.addRow([
      String(r.vendor_code || '').trim(),
      String(r.vendor_name || '').trim(),
      String(r.terms || '').trim(),
      String(r.site_name || '').trim(),
      ...DATED_BUCKET_KEYS.map((k) => num2(r.bucket_amounts?.[k])),
      num2(r.parsed_balance),
    ]);
  }
  // Number-format the bucket + total columns (after the 4 lead columns).
  for (let c = 5; c <= 4 + DATED_BUCKET_KEYS.length + 1; c++) detail.getColumn(c).numFmt = '#,##0.00';

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
