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

  // Detail table — one row per customer, balance split across the period
  // columns. In hub all-sites mode the Site column disambiguates the same
  // customer code appearing at more than one site.
  const hub = !!report?.hub_mode;
  const lead = hub ? ['Code', 'Customer', 'Site', 'Rep', 'Type'] : ['Code', 'Customer', 'Rep', 'Type'];
  const numericStart = lead.length;
  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 8,
    styles: { fontSize: 7.5, cellPadding: 1.3 },
    headStyles: { fillColor: [50, 50, 50] },
    head: [[...lead, ...BUCKET_KEYS.map((k) => BUCKET_LABELS[k]), 'Total']],
    body: (report?.records || []).map((r) => [
      String(r.customer_number || '').trim(),
      String(r.customer_name || '').trim(),
      ...(hub ? [String(r.site_name || '').trim()] : []),
      String(r.sales_rep || '').trim(),
      String(r.account_type || '').trim(),
      ...BUCKET_KEYS.map((k) => fmtR(r.bucket_amounts?.[k])),
      fmtR(r.parsed_balance ?? r.outstanding_balance),
    ]),
    foot: [[
      'TOTAL', ...Array(lead.length - 1).fill(''),
      ...BUCKET_KEYS.map((k) => fmtR(buckets[k])),
      fmtR(report?.summary?.total_outstanding),
    ]],
    footStyles: { fillColor: [220, 220, 220], textColor: 0, fontStyle: 'bold' },
    columnStyles: Object.fromEntries(
      Array.from({ length: BUCKET_KEYS.length + 1 }, (_, i) => [numericStart + i, { halign: 'right' }]),
    ),
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
  // Number-format the bucket + total columns (after the 6 lead columns).
  for (let c = 7; c <= 6 + BUCKET_KEYS.length + 1; c++) detail.getColumn(c).numFmt = '#,##0.00';

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

// ── Sales by Vendor ──────────────────────────────────────────────────────────
// One wide sheet (Excel has no space premium, and it pivots well). By-month
// carries every month's ex-VAT + quantity (+ PY ex-VAT when comparing) — the
// detail the on-screen report omits; aggregate carries qty/ex/incl. Fed by the
// same buildSalesByVendorData object as the screen, so the download can't drift.
const SBV_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const sbvMonthLabel = (p) => `${SBV_MON[parseInt(String(p).slice(5, 7), 10) - 1]} '${String(p).slice(2, 4)}`;
const sbvPriorYear = (p) => `${parseInt(String(p).slice(0, 4), 10) - 1}${String(p).slice(4)}`;
const sbvYoy = (cur, py) => {
  const c = Number(cur) || 0, p = Number(py) || 0;
  if (!p) return c > 0 ? 'new' : '';
  return Number((((c - p) / p) * 100).toFixed(1));
};

// House styling: bold frozen header (+ frozen lead columns), per-column number
// formats inferred from the header text, sensible widths.
function sbvStyle(ws, leadCols) {
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.eachCell((c) => { c.border = { bottom: { style: 'thin' } }; });
  ws.views = [{ state: 'frozen', xSplit: leadCols, ySplit: 1 }];
  header.eachCell((cell, col) => {
    const h = String(cell.value || '').toLowerCase();
    const column = ws.getColumn(col);
    // The [$-409] (en-US) locale token forces a PERIOD decimal + comma thousands
    // regardless of the viewer's Excel locale (en-ZA would otherwise render a
    // comma decimal). Money is ZAR ("R " prefix); qty is a plain integer.
    if (h.includes('qty')) column.numFmt = '[$-409]#,##0';
    else if (h.includes('yoy')) column.numFmt = '[$-409]0.0"%"';
    else if (h.includes('ex') || h.includes('py') || h.includes('incl') || h.includes('vat')) column.numFmt = '[$-409]"R "#,##0.00';
    if (h === 'description') column.width = 34;
    else if (h === 'vendor' || h === 'site') column.width = 22;
    else if (h === 'item') column.width = 14;
    else column.width = Math.max(12, h.length + 2);
  });
}

// Flatten the report to per-item rows with current/prior-year ex-VAT, for the
// YoY dashboard. Works for by-month (totals), hub site_groups, or flat vendors.
function sbvFlattenItems(report) {
  const rows = [];
  const add = (siteName, vendor, it, cy, py) => rows.push({
    site: String(siteName || ''), vendor, item: it.item_number,
    desc: (it.item_description || '').trim(), cy: Number(cy) || 0, py: Number(py) || 0,
  });
  if (report?.bymonth) {
    for (const g of report.groups || []) for (const v of g.vendors || []) for (const it of v.items || [])
      add(g.site_name || g.site_id, v.vendor, it, it.total_ex, it.py_total_ex);
  } else if (Array.isArray(report?.site_groups)) {
    for (const g of report.site_groups) for (const v of g.vendors || []) for (const it of v.items || [])
      add(g.site_name || g.site_id, v.vendor, it, it.ex_vat, it.py_ex_vat);
  } else {
    for (const v of report?.vendors || []) for (const it of v.items || [])
      add('', v.vendor, it, it.ex_vat, it.py_ex_vat);
  }
  return rows.map((r) => ({ ...r, change: r.cy - r.py }));
}

// Dashboard sheet: precomputed Top-10 YoY movers + steps to build a PivotChart.
// ExcelJS can't emit pivot tables/charts/slicers, so we compute the insight and
// leave the Data sheet pivot-ready for a 3-click PivotChart + vendor slicer.
function sbvBuildDashboard(wb, report, isHub) {
  const dash = wb.addWorksheet('Dashboard');
  dash.getColumn(1).width = 14; dash.getColumn(2).width = 36; dash.getColumn(3).width = 22;
  if (isHub) dash.getColumn(4).width = 18;
  dash.addRow(['Sales by Vendor — Dashboard']).font = { bold: true, size: 14 };
  dash.addRow([`Ex-VAT · ZAR · ${report?.compare ? 'YoY vs prior year' : 'no prior-year comparison'}`]).font = { italic: true };
  dash.addRow([]);

  if (report?.compare) {
    const lead = ['Item', 'Description', 'Vendor', ...(isHub ? ['Site'] : [])];
    const head = [...lead, 'This year', 'Last year', 'Change', 'YoY %'];
    const moneyStart = lead.length + 1;
    const flat = sbvFlattenItems(report);
    const ups = flat.filter((r) => r.change > 0).sort((a, b) => b.change - a.change).slice(0, 10);
    const downs = flat.filter((r) => r.change < 0).sort((a, b) => a.change - b.change).slice(0, 10);
    const section = (label, list) => {
      dash.addRow([label]).font = { bold: true, size: 12 };
      dash.addRow(head).font = { bold: true };
      for (const r of list) dash.addRow([r.item, r.desc, r.vendor, ...(isHub ? [r.site] : []), num2(r.cy), num2(r.py), num2(r.change), sbvYoy(r.cy, r.py)]);
      dash.addRow([]);
    };
    section('Top 10 biggest YoY increases (by item)', ups);
    section('Top 10 biggest YoY drops (by item)', downs);
    for (let c = moneyStart; c <= moneyStart + 2; c++) dash.getColumn(c).numFmt = '[$-409]"R "#,##0.00';
    dash.getColumn(moneyStart + 3).numFmt = '[$-409]0.0"%"';
  } else {
    dash.addRow(['Turn on “Compare prior year” before exporting to populate the YoY movers.']);
  }

  dash.addRow([]);
  dash.addRow(['Build a PivotChart + vendor slicer (the Data sheet is ready):']).font = { bold: true, size: 12 };
  [
    '1. Open the “Data” sheet and click any cell inside the table.',
    '2. Insert ▸ PivotChart — Excel picks the “SalesData” table automatically.',
    '3. Axis = Month; Legend/Rows = Vendor then Item; Values = Sum of Ex-VAT (add PY Ex-VAT / Qty as needed).',
    '4. Insert ▸ Slicer ▸ tick Vendor — that is your selectable-by-vendor control.',
  ].forEach((s) => dash.addRow([s]));
}

export async function buildSalesByVendorXlsx(report) {
  const wb = new ExcelJS.Workbook();
  const compare = !!report?.compare;
  // Empty tables aren't valid in Excel — keep at least one (blank) row.
  const tableRows = (rows, width) => (rows.length ? rows : [Array(width).fill(null)]);

  if (report?.bymonth) {
    const isHub = !!report.hub;
    const months = report.months || [];
    const lead = [...(isHub ? ['Site'] : []), 'Vendor', 'Item', 'Description'];
    sbvBuildDashboard(wb, report, isHub);

    // Data — tidy/long, one row per item per month. Excel Table → pivot-ready.
    const data = wb.addWorksheet('Data');
    const dataCols = [...lead, 'Month', 'Ex-VAT', 'Qty', ...(compare ? ['PY Ex-VAT', 'PY Qty'] : [])];
    const dataRows = [];
    for (const g of report.groups || []) {
      for (const v of g.vendors || []) {
        for (const it of v.items || []) {
          for (const m of months) {
            const ex = num2(it.cells?.[m] || 0), qty = Number(it.qty_cells?.[m] || 0);
            const pyEx = num2(it.py_cells?.[m] || 0), pyQty = Number(it.py_qty_cells?.[m] || 0);
            if (!ex && !qty && !pyEx && !pyQty) continue; // don't pad the pivot source with empty months
            dataRows.push([
              ...(isHub ? [String(g.site_name || g.site_id || '')] : []),
              v.vendor, it.item_number, (it.item_description || '').trim(),
              m, ex, qty, ...(compare ? [pyEx, pyQty] : []),
            ]);
          }
        }
      }
    }
    data.addTable({
      name: 'SalesData', ref: 'A1', headerRow: true,
      style: { theme: 'TableStyleMedium2', showRowStripes: true },
      columns: dataCols.map((c) => ({ name: c, filterButton: true })),
      rows: tableRows(dataRows, dataCols.length),
    });
    sbvStyle(data, lead.length);

    // Totals — per-item period totals + grand, kept off the Data sheet.
    const totals = wb.addWorksheet('Totals');
    totals.addRow([...lead, 'Total ex-VAT', 'Total qty', ...(compare ? ['PY ex-VAT', 'PY qty', 'YoY %'] : [])]);
    let gEx = 0, gQty = 0, gPy = 0, gPyQty = 0;
    for (const g of report.groups || []) {
      for (const v of g.vendors || []) {
        for (const it of v.items || []) {
          totals.addRow([
            ...(isHub ? [String(g.site_name || g.site_id || '')] : []),
            v.vendor, it.item_number, (it.item_description || '').trim(),
            num2(it.total_ex), Number(it.total_qty || 0),
            ...(compare ? [num2(it.py_total_ex), Number(it.py_total_qty || 0), sbvYoy(it.total_ex, it.py_total_ex)] : []),
          ]);
          gEx += Number(it.total_ex) || 0; gQty += Number(it.total_qty) || 0; gPy += Number(it.py_total_ex) || 0; gPyQty += Number(it.py_total_qty) || 0;
        }
      }
    }
    totals.addRow([
      ...(isHub ? [''] : []), 'GRAND TOTAL', '', '',
      num2(gEx), gQty, ...(compare ? [num2(gPy), gPyQty, sbvYoy(gEx, gPy)] : []),
    ]).font = { bold: true };
    sbvStyle(totals, lead.length);
    return await wb.xlsx.writeBuffer();
  }

  // ── Aggregate (no month dimension) — Dashboard + Data table + Totals. ──
  const isHub = Array.isArray(report?.site_groups);
  const lead = [...(isHub ? ['Site'] : []), 'Vendor', 'Item', 'Description'];
  sbvBuildDashboard(wb, report, isHub);

  const data = wb.addWorksheet('Data');
  const dataCols = [...lead, 'Qty', ...(compare ? ['PY Qty'] : []), 'Ex-VAT', ...(compare ? ['PY Ex-VAT'] : []), 'Incl-VAT', ...(compare ? ['YoY %'] : [])];
  const dataRows = [];
  let gQty = 0, gPyQty = 0, gEx = 0, gPyEx = 0, gIncl = 0;
  const collect = (vendors, siteName) => {
    for (const v of vendors || []) for (const it of v.items || []) {
      dataRows.push([
        ...(isHub ? [String(siteName || '')] : []),
        v.vendor, it.item_number, (it.item_description || '').trim(),
        Number(it.qty || 0), ...(compare ? [Number(it.py_qty || 0)] : []),
        num2(it.ex_vat), ...(compare ? [num2(it.py_ex_vat)] : []),
        num2(it.incl_vat), ...(compare ? [sbvYoy(it.ex_vat, it.py_ex_vat)] : []),
      ]);
      gQty += Number(it.qty) || 0; gPyQty += Number(it.py_qty) || 0;
      gEx += Number(it.ex_vat) || 0; gPyEx += Number(it.py_ex_vat) || 0; gIncl += Number(it.incl_vat) || 0;
    }
  };
  if (isHub) for (const g of report.site_groups) collect(g.vendors, g.site_name || g.site_id);
  else collect(report.vendors);
  data.addTable({
    name: 'SalesData', ref: 'A1', headerRow: true,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: dataCols.map((c) => ({ name: c, filterButton: true })),
    rows: tableRows(dataRows, dataCols.length),
  });
  sbvStyle(data, lead.length);

  const totals = wb.addWorksheet('Totals');
  totals.addRow(['Metric', 'Qty', ...(compare ? ['PY Qty'] : []), 'Ex-VAT', ...(compare ? ['PY Ex-VAT'] : []), 'Incl-VAT', ...(compare ? ['YoY %'] : [])]);
  totals.addRow([
    'GRAND TOTAL', gQty, ...(compare ? [gPyQty] : []),
    num2(gEx), ...(compare ? [num2(gPyEx)] : []),
    num2(gIncl), ...(compare ? [sbvYoy(gEx, gPyEx)] : []),
  ]).font = { bold: true };
  sbvStyle(totals, 1);
  return await wb.xlsx.writeBuffer();
}
