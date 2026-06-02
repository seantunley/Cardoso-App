import { jsPDF } from 'jspdf';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

const ORANGE = [249, 115, 22];
const SLATE = [51, 65, 85];
const MUTED = [120, 120, 130];
const BG_BOX = [245, 245, 248];
const RULE = [220, 220, 226];

const M = { left: 18, right: 18, top: 18, bottom: 20 };
const PAGE_W = 210;
const PAGE_H = 297;
const CONTENT_W = PAGE_W - M.left - M.right;

const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
let y = M.top;

function setText(rgb, font = 'helvetica', style = 'normal', size = 10) {
  pdf.setTextColor(rgb[0], rgb[1], rgb[2]);
  pdf.setFont(font, style);
  pdf.setFontSize(size);
}

function newPageIfNeeded(needed) {
  if (y + needed > PAGE_H - M.bottom) {
    pdf.addPage();
    y = M.top;
    drawRunningHeader();
  }
}

function drawRunningHeader() {
  setText(MUTED, 'helvetica', 'normal', 8);
  pdf.text('Cardoso · Inventory Movement — Demand Forecast', M.left, 10);
  const pageNo = pdf.internal.getCurrentPageInfo().pageNumber;
  pdf.text(`Page ${pageNo}`, PAGE_W - M.right, 10, { align: 'right' });
  pdf.setDrawColor(RULE[0], RULE[1], RULE[2]);
  pdf.setLineWidth(0.2);
  pdf.line(M.left, 12, PAGE_W - M.right, 12);
  y = M.top;
}

function h1(text) {
  newPageIfNeeded(14);
  setText(SLATE, 'helvetica', 'bold', 20);
  pdf.text(text, M.left, y);
  y += 9;
  pdf.setDrawColor(ORANGE[0], ORANGE[1], ORANGE[2]);
  pdf.setLineWidth(0.7);
  pdf.line(M.left, y, M.left + 30, y);
  y += 6;
}

function h2(text) {
  newPageIfNeeded(12);
  y += 2;
  setText(ORANGE, 'helvetica', 'bold', 13);
  pdf.text(text, M.left, y);
  y += 6;
}

function h3(text) {
  newPageIfNeeded(8);
  setText(SLATE, 'helvetica', 'bold', 10.5);
  pdf.text(text, M.left, y);
  y += 5;
}

function body(text, opts = {}) {
  const maxW = opts.width ?? CONTENT_W;
  const indent = opts.indent ?? 0;
  setText(SLATE, 'helvetica', 'normal', 10);
  const lines = pdf.splitTextToSize(text, maxW - indent);
  for (const line of lines) {
    newPageIfNeeded(5);
    pdf.text(line, M.left + indent, y);
    y += 4.7;
  }
}

function bullet(text) {
  setText(SLATE, 'helvetica', 'normal', 10);
  const lines = pdf.splitTextToSize(text, CONTENT_W - 6);
  for (let i = 0; i < lines.length; i++) {
    newPageIfNeeded(5);
    if (i === 0) {
      setText(ORANGE, 'helvetica', 'bold', 10);
      pdf.text('•', M.left, y);
      setText(SLATE, 'helvetica', 'normal', 10);
    }
    pdf.text(lines[i], M.left + 5, y);
    y += 4.7;
  }
}

function spacer(mm = 3) {
  y += mm;
}

function formula(text, opts = {}) {
  setText(SLATE, 'courier', 'normal', 9.5);
  const lines = pdf.splitTextToSize(text, CONTENT_W - 8);
  const blockH = lines.length * 4.6 + 5;
  newPageIfNeeded(blockH + 1);
  pdf.setFillColor(BG_BOX[0], BG_BOX[1], BG_BOX[2]);
  pdf.setDrawColor(RULE[0], RULE[1], RULE[2]);
  pdf.setLineWidth(0.2);
  pdf.roundedRect(M.left, y, CONTENT_W, blockH, 1.5, 1.5, 'FD');
  let ty = y + 4.5;
  setText(opts.color ?? SLATE, 'courier', opts.bold ? 'bold' : 'normal', 9.5);
  for (const line of lines) {
    pdf.text(line, M.left + 3.5, ty);
    ty += 4.6;
  }
  y += blockH + 2.5;
}

function kvTable(rows, opts = {}) {
  const colW = opts.keyW ?? 55;
  const lineH = 5.6;
  const padX = 2.5;
  // measure heights for each row
  const heights = rows.map(([, v]) => {
    setText(SLATE, 'helvetica', 'normal', 9.5);
    const lines = pdf.splitTextToSize(String(v), CONTENT_W - colW - padX * 2);
    return Math.max(lineH, lines.length * 4.4 + 2);
  });
  const total = heights.reduce((a, b) => a + b, 0) + 4;
  newPageIfNeeded(total + 2);
  const startY = y;
  pdf.setDrawColor(RULE[0], RULE[1], RULE[2]);
  pdf.setLineWidth(0.2);
  pdf.rect(M.left, startY, CONTENT_W, total);
  let ry = startY;
  rows.forEach(([k, v], i) => {
    const rh = heights[i];
    if (i % 2 === 0) {
      pdf.setFillColor(250, 250, 252);
      pdf.rect(M.left, ry, CONTENT_W, rh, 'F');
    }
    pdf.line(M.left + colW, ry, M.left + colW, ry + rh);
    setText(SLATE, 'helvetica', 'bold', 9.5);
    pdf.text(String(k), M.left + padX, ry + 4);
    setText(SLATE, 'helvetica', 'normal', 9.5);
    const lines = pdf.splitTextToSize(String(v), CONTENT_W - colW - padX * 2);
    let ty = ry + 4;
    for (const line of lines) {
      pdf.text(line, M.left + colW + padX, ty);
      ty += 4.4;
    }
    if (i < rows.length - 1) {
      pdf.line(M.left, ry + rh, M.left + CONTENT_W, ry + rh);
    }
    ry += rh;
  });
  y = startY + total + 3;
}

// ── COVER PAGE ───────────────────────────────────────────────────────
pdf.setFillColor(ORANGE[0], ORANGE[1], ORANGE[2]);
pdf.rect(0, 0, PAGE_W, 38, 'F');
pdf.setTextColor(255, 255, 255);
pdf.setFont('helvetica', 'bold');
pdf.setFontSize(11);
pdf.text('CARDOSO · OPERATIONS', M.left, 16);
pdf.setFontSize(26);
pdf.text('Inventory Movement', M.left, 28);
pdf.setFontSize(16);
pdf.setFont('helvetica', 'normal');
pdf.text('Demand Forecast — Method & Worked Example', M.left, 34.5);

y = 60;
setText(SLATE, 'helvetica', 'bold', 14);
pdf.text('What this document covers', M.left, y);
y += 8;
setText(SLATE, 'helvetica', 'normal', 11);
const intro = pdf.splitTextToSize(
  'This is a reference for the Inventory Movement demand-forecast feature: where the data comes from, how each column is calculated, the configurable settings that drive the maths, and a fully worked example using a realistic item. Use it when you need to explain a number to a colleague or sanity-check the model.',
  CONTENT_W
);
for (const line of intro) { pdf.text(line, M.left, y); y += 5.5; }

y += 6;
setText(SLATE, 'helvetica', 'bold', 11);
pdf.text('Contents', M.left, y);
y += 6;
const toc = [
  '1.  Data sources and the sync pipeline',
  '2.  Per-item mathematical model',
  '3.  Worked example — item 53 (Peter Stuy Blue 20s)',
  '4.  Configurable parameters (Forecast Settings tab)',
  '5.  Column reference (matches table headings in the UI)',
  '6.  Edge cases and operational notes',
];
setText(SLATE, 'helvetica', 'normal', 10.5);
for (const t of toc) { pdf.text(t, M.left + 2, y); y += 5.5; }

y = PAGE_H - 30;
setText(MUTED, 'helvetica', 'normal', 8.5);
pdf.text(`Generated ${new Date().toISOString().slice(0, 10)} · Cardoso App · scripts/build-forecast-doc.mjs`, M.left, y);

// ── PAGE 2: DATA SOURCES ─────────────────────────────────────────────
pdf.addPage();
drawRunningHeader();

h1('1. Data sources and the sync pipeline');

body('Every forecast number ultimately comes from Sage 300, pulled in by two cooperating jobs:');
spacer();
h3('Sync from Sage  (POST /api/inventory-movement/sync)');
body('Triggered by the "Sync from Sage" button on the Inventory Movement page. It runs two parallel queries against the live Sage OE shipment history (OESHDT, joined to ICITEM and ARCUS) for the trailing 24 months and writes the results into two local SQLite tables:');
spacer(1);
bullet('inventory_sales_cache — one row per item per month, with qty sold, revenue, order count, and last sale date.');
bullet('inventory_sales_transactions — every individual shipment line, used downstream for demand variability.');
spacer(2);
body('Revenue is taken directly from OESHDT.FAMTSALES (functional currency line total). Unit price for the per-line table is derived as FAMTSALES ÷ QTYSOLD. The first sync pulls 24 months so seasonality and dead-stock age work straight away; subsequent syncs are idempotent upserts.');
spacer();

h3('Recompute Forecast  (POST /api/inventory-movement/recompute-forecast)');
body('Triggered by the "Recompute" button on the Forecast tab. It reads the sales cache, transactions table, and inventoryrecord (current stock on hand), runs the model below for every item, and replaces all rows in inventory_forecast.');
spacer(2);
body('Items that no longer have both sales history and an inventory record are pruned, so the forecast view never shows obsolete SKUs with stale demand numbers.');

// ── PAGE 3: MATH ─────────────────────────────────────────────────────
pdf.addPage();
drawRunningHeader();

h1('2. Per-item mathematical model');

body('For each item with both sales history and a current inventory record, the recompute computes ten quantities. The order matters — later steps depend on earlier ones.');
spacer(2);

h3('Step 1 — Weighted moving averages of monthly qty');
formula('wma3 = (3·m1 + 2·m2 + 1·m3) ÷ 6\nwma6 = (6·m1 + 5·m2 + 4·m3 + 3·m4 + 2·m5 + 1·m6) ÷ 21\n\nm1 is the most recent COMPLETE month, m2 the one before, etc.\nThe current (partial) month is excluded — otherwise a fortnight\nof data masquerading as a full month would systematically\ndepress the forecast.');

h3('Step 2 — Seasonality index for this calendar month');
formula('seasonality = avg(qty for this month-of-year across history)\n              ÷ avg(qty for all months in history)\n\nReturns 1.00 (no effect) if the item has fewer than 12 months\nof complete history. Clamped to [0.10, 5.00] so a single\noutlier month cannot drive the whole forecast off a cliff.');

h3('Step 3 — Adjusted demand and daily demand');
formula('adjusted_demand = wma3 × seasonality       (qty per month)\ndaily_demand    = adjusted_demand ÷ days_in_current_month');

h3('Step 4 — Demand variability');
formula('std_dev = stddev of (daily qty sold)\n          taken across distinct days with sales\n          for this item, from inventory_sales_transactions');
body('If an item only sold on a single day in its history, std_dev defaults to 0 — i.e. safety stock collapses to 0. Safe default: under-promising on safety stock is more visible than over-promising.');

h3('Step 5 — Safety stock, reorder point, days of stock, order qty');
formula('z              = inverse-normal CDF of service_level\n                 (95% → 1.65, 99% → 2.33, 99.9% → 3.09)\nsafety_stock   = z × std_dev × √lead_time_days\nreorder_point  = daily_demand × lead_time_days + safety_stock\ndays_of_stock  = qty_on_hand ÷ daily_demand\nsuggested_qty  = (daily_demand × order_cycle_days)\n                 + safety_stock\n                 − qty_on_hand\n                 (then bumped up to min_order_qty if set)');

h3('Step 6 — ABC classification (by revenue)');
formula('Sort items by total revenue across all months. Walking the\nsorted list, items whose CUMULATIVE share of revenue is\n  ≤ 0.80   → "A"   (top 80% of turnover)\n  ≤ 0.95   → "B"   (next 15%)\n  > 0.95   → "C"   (final 5%)');
body('ABC uses ALL months including the current partial one — revenue ranking shouldn’t exclude the current month’s sales just because it isn’t finished yet.');

// ── PAGE 4: WORKED EXAMPLE ───────────────────────────────────────────
pdf.addPage();
drawRunningHeader();

h1('3. Worked example — item 53 (Peter Stuy Blue 20s)');

body('Suppose tonight’s recompute runs on 2026-05-28 (May has 31 days). Item 53 has the following recent monthly aggregates in inventory_sales_cache, with the same calendar month one year ago shown for the seasonality calc:');
spacer(1);
kvTable([
  ['2026-04 (m1)', '3,643 units sold, R 1,444,919 revenue'],
  ['2026-03 (m2)', '2,052 units sold, R 812,927 revenue'],
  ['2026-02 (m3)', '1,556 units sold, R 606,797 revenue'],
  ['2026-01 (m4)', '1,459 units sold, R 557,207 revenue'],
  ['2026-05 same month last year (2025-05)', '3,800 units sold'],
  ['Mean of all 24 months on file', '2,650 units / month'],
], { keyW: 78 });

h3('Step 1 — WMA3');
formula('wma3 = (3 × 3643) + (2 × 2052) + (1 × 1556)\n       ────────────────────────────────────────\n                       6\n     = (10929 + 4104 + 1556) ÷ 6\n     = 16589 ÷ 6\n     ≈ 2765 units / month');

h3('Step 2 — Seasonality for May');
formula('seasonality = avg(qty for May across history) ÷ avg(all months)\n            = 3800 ÷ 2650\n            ≈ 1.43            (May runs 43% above average)');

h3('Step 3 — Adjusted and daily demand');
formula('adjusted_demand = 2765 × 1.43  ≈ 3954 units / month\ndaily_demand    = 3954 ÷ 31     ≈ 127.5 units / day');

h3('Step 4 — Demand variability');
body('Suppose the per-day std dev computed from inventory_sales_transactions for this item is 31 units/day.');
formula('std_dev = 31 units / day');

h3('Step 5 — Reorder point, days of stock, order qty');
body('Forecast Settings (global): lead_time = 7 days, order_cycle = 14 days, service_level = 0.95 (z = 1.65), min_order_qty = 0. Current qty_on_hand = 1,229.');
formula('safety_stock  = 1.65 × 31 × √7\n              ≈ 1.65 × 31 × 2.646\n              ≈ 135.4\n\nreorder_point = (127.5 × 7) + 135.4\n              ≈ 892.5 + 135.4\n              ≈ 1028\n\ndays_of_stock = 1229 ÷ 127.5\n              ≈ 9.6 days       (UI shows "10d", amber band)\n\nsuggested_qty = (127.5 × 14) + 135.4 − 1229\n              ≈ 1785 + 135.4 − 1229\n              ≈ 691 units      (order ~700 to cover one cycle)');

h3('What an operator does with this');
body('Days of stock (9.6d) is just inside the lead-time window (7d) — meaning if you place the order today and it takes a week to arrive, you finish the week with about 2 days of cover left. Suggested order qty of ~691 units covers one full order cycle plus the 135-unit safety buffer that absorbs daily demand variability at the chosen 95% service level.');

// ── PAGE 5: SETTINGS ─────────────────────────────────────────────────
pdf.addPage();
drawRunningHeader();

h1('4. Configurable parameters');

body('Set globally on the Forecast Settings tab (Settings → Forecast). Stored in inventory_forecast_config with item_number = "__global__". Per-item overrides are supported — insert an additional row keyed by item_number.');
spacer(2);

kvTable([
  ['lead_time_days   (default 7)', 'Days between placing an order with the supplier and the stock landing on the floor. Drives both the reorder point and the safety-stock denominator (√lead_time). Pull it shorter only if your suppliers are consistently faster than 7 days — over-promising lead time means under-ordered safety stock.'],
  ['order_cycle_days (default 14)', 'How often you place an order with this supplier. The suggested order quantity is sized to last one full cycle plus the safety buffer. Shorten if you can reorder more often and want to hold less stock; lengthen if you only order monthly.'],
  ['service_level    (default 0.95)', 'Target probability of NOT stocking out before the next delivery. 0.95 → z = 1.65, 0.99 → z = 2.33, 0.999 → z = 3.09. Raising it widens safety stock; tying up more capital but reducing missed-sale risk for A-class items.'],
  ['min_order_qty    (default 0)', 'Pack/case-size floor. If the math says order 23 units but the supplier only ships in cases of 50, set this to 50 and the suggested qty will round up. Suggested orders of zero are NOT bumped — only non-zero suggestions get padded.'],
], { keyW: 65 });

// ── PAGE 6: COLUMN REFERENCE ─────────────────────────────────────────
pdf.addPage();
drawRunningHeader();

h1('5. Column reference (Forecast tab)');

body('These mirror the tooltip text you see when you hover the column headings on the Forecast tab.');
spacer(2);

kvTable([
  ['Item', 'Sage item number, trimmed of trailing spaces to match the sales cache.'],
  ['Description', 'Item description from Sage inventoryrecord (most recent variant per item).'],
  ['ABC', 'Pareto class by revenue. A = top 80% of revenue, B = next 15%, C = remaining 5%. Used for prioritising stock attention.'],
  ['On Hand', 'Current qty on hand from Sage inventoryrecord. Where an item has multiple location rows, the highest qty wins.'],
  ['Daily Demand', 'Historical reference: total qty ÷ (months × 30). Plain average across the whole window. Compare against Adj Demand/Mo to spot trend changes.'],
  ['Adj Demand/Mo', 'What the model expects you to sell THIS month. = WMA3 × Seasonality.'],
  ['Season', 'Seasonality index for the current calendar month. 1.00 = no effect; >1 = busier than average; <1 = quieter. Defaults to 1.00 if less than 12 months history. Clamped to [0.10, 5.00].'],
  ['Reorder Pt', 'When On Hand drops to this number, place an order today. = (daily demand × lead time days) + safety stock.'],
  ['Days of Stock', 'Runway at the current sell rate. = On Hand ÷ daily demand. Colour coding: red <7d, amber <14d, yellow <30d, green ≥30d.'],
  ['Order Qty', 'Suggested order size to cover one order cycle plus variability. = (daily demand × order cycle days) + safety stock − On Hand. Bumped to min order qty if set.'],
], { keyW: 38 });

// ── PAGE 7: EDGE CASES ───────────────────────────────────────────────
pdf.addPage();
drawRunningHeader();

h1('6. Edge cases and operational notes');

bullet('Items with no Sage sales in the last 24 months get no forecast row — they fall under Dead Stock instead. The recompute prunes anything that no longer joins to both sales history and inventoryrecord, so the table never shows ghost SKUs.');
bullet('Less than 12 months of history → seasonality silently defaults to 1.00 (no seasonal adjustment). The adjusted demand is then just wma3, which is fine for a recently introduced item.');
bullet('Items with a single sales day in history get std_dev = 0 → safety stock = 0 → reorder point = daily_demand × lead_time. Treat single-day items with caution: their variability is unknown, not zero.');
bullet('The current partial month is excluded from wma3, wma6, and the seasonality input set. It IS included in ABC revenue ranking — A-class shouldn’t drop a tier just because the month is mid-flight.');
bullet('Daily demand can momentarily look low on the first day or two of a new month (wma3 picks up the just-completed month). This is expected, not a bug.');
bullet('Suggested order qty of 0 means "you have more than one cycle of stock plus the safety buffer". Don’t place an order based on this row — wait until on-hand drifts toward the reorder point.');
bullet('Days of stock urgency colours are independent of lead time. An item with 12 days of stock and a 14-day lead time still shows amber, but you should treat that as red — it WILL stock out before the next delivery if you don’t order today.');
bullet('The model assumes the past 24 months are a reasonable guide to the next month. For items affected by promotions, supplier changes, or one-off events, treat the suggested order qty as a starting point and apply judgement.');

spacer(6);
setText(MUTED, 'helvetica', 'italic', 9);
pdf.text('End of document.', M.left, y);

// ── SAVE ─────────────────────────────────────────────────────────────
const out = resolve('docs/inventory-movement-forecasting.pdf');
const ab = pdf.output('arraybuffer');
writeFileSync(out, Buffer.from(ab));
console.log(`Wrote ${out} (${pdf.internal.getNumberOfPages()} pages)`);
