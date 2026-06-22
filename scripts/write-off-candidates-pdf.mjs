// One-shot: pick customers to write off under a budget (greedy
// smallest-balance-first, full clear-outs only, stale-first tiebreak)
// and emit a PDF list to exports/ (gitignored — the report contains
// customer names + outstanding balances and must never be committed).
//
// Usage: node --env-file=.env.dev scripts/write-off-candidates-pdf.mjs [budget]
//        node --env-file=.env.dev scripts/write-off-candidates-pdf.mjs 1000
import 'dotenv/config';
import Database from 'better-sqlite3';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

const BUDGET = Number(process.argv[2]) || 1000;
const DB_PATH = process.env.DB_PATH || './database/cardoso.db';

const db = new Database(DB_PATH, { readonly: true });

const rows = db.prepare(`
  SELECT
    customer_number,
    customer_name,
    last_unpaid_invoice_1_date,
    CAST(REPLACE(REPLACE(COALESCE(outstanding_balance, '0'), ',', ''), ' ', '') AS REAL) AS bal_num
  FROM datarecord
`).all()
  .filter((r) => r.bal_num > 0)
  .sort((a, b) => {
    if (a.bal_num !== b.bal_num) return a.bal_num - b.bal_num;
    const ad = a.last_unpaid_invoice_1_date || '';
    const bd = b.last_unpaid_invoice_1_date || '';
    if (!ad && bd) return 1;
    if (ad && !bd) return -1;
    return ad.localeCompare(bd);
  });

let remaining = BUDGET;
const picked = [];
let stoppedAt = null;
for (const r of rows) {
  if (r.bal_num > remaining) { stoppedAt = r; break; }
  remaining -= r.bal_num;
  picked.push(r);
}
const totalCleared = picked.reduce((s, r) => s + r.bal_num, 0);

// ---- PDF ------------------------------------------------------------------
const doc = new jsPDF({ unit: 'mm', format: 'a4' });
const fmtR = (n) => `R ${(Number(n) || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = new Date().toISOString().slice(0, 10);

doc.setFontSize(14);
doc.text(`Write-off candidates — budget ${fmtR(BUDGET)}`, 14, 14);
doc.setFontSize(9);
doc.setTextColor(110);
doc.text(`Generated ${today}`, 14, 20);
doc.text(
  `Greedy smallest-balance first · full clear-outs only · stale (oldest last unpaid invoice) tiebreak`,
  14, 25,
);

doc.setTextColor(0);
doc.setFontSize(10);
doc.text(`Customers cleared:   ${picked.length}`, 14, 33);
doc.text(`Total written off:   ${fmtR(totalCleared)}`, 14, 38);
doc.text(`Budget remaining:    ${fmtR(remaining)}`, 14, 43);
if (stoppedAt) {
  doc.setTextColor(110);
  doc.setFontSize(8);
  doc.text(
    `Stopped at: ${(stoppedAt.customer_name || '').trim()} (${(stoppedAt.customer_number || '').trim()}) owes ${fmtR(stoppedAt.bal_num)} — exceeds remaining budget`,
    14, 49,
  );
}

autoTable(doc, {
  startY: 55,
  styles: { fontSize: 8, cellPadding: 1.5 },
  headStyles: { fillColor: [50, 50, 50] },
  head: [['#', 'Code', 'Customer', 'Last unpaid invoice', 'Balance']],
  body: picked.map((r, i) => [
    String(i + 1),
    (r.customer_number || '').trim(),
    (r.customer_name || '').trim(),
    r.last_unpaid_invoice_1_date || '—',
    fmtR(r.bal_num),
  ]),
  foot: [['', '', '', 'TOTAL', fmtR(totalCleared)]],
  footStyles: { fillColor: [220, 220, 220], textColor: 0, fontStyle: 'bold' },
  columnStyles: {
    0: { halign: 'right', cellWidth: 10 },
    1: { cellWidth: 22 },
    3: { cellWidth: 35 },
    4: { halign: 'right', cellWidth: 28 },
  },
});

// exports/ is gitignored — this report carries confidential AR data
// (customer names + outstanding balances) and must never be committed.
const outDir = 'exports';
mkdirSync(outDir, { recursive: true });
const outPath = path.join(
  outDir,
  `write-off-candidates-R${BUDGET}-${today}.pdf`,
);
writeFileSync(outPath, Buffer.from(doc.output('arraybuffer')));
console.log(`Wrote ${picked.length} customers (${fmtR(totalCleared)} of ${fmtR(BUDGET)}) → ${outPath}`);
