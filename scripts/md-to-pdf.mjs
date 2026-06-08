// Render a Markdown document into a branded, professional A4 PDF using jsPDF
// (the same engine the report exports use). Not a generic CommonMark renderer —
// it handles exactly the constructs our docs use: #/##/### headings, paragraphs
// with **bold** / *italic*, `-` bullets, GFM | tables |, > blockquotes, and ---
// rules. Emoji in headings are stripped (the built-in fonts can't render them).
//
//   node scripts/md-to-pdf.mjs <input.md> <output.pdf> "Doc kind label"
//
import { readFileSync, writeFileSync } from 'fs';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

const [, , inPath, outPath, kindLabel = 'Document'] = process.argv;
if (!inPath || !outPath) { console.error('usage: md-to-pdf <in.md> <out.pdf> [label]'); process.exit(1); }

// ---- brand ----
const ORANGE = [221, 122, 33];
const INK = [28, 28, 30];
const MUTED = [110, 112, 116];
const RULE = [223, 224, 226];
const LIGHT = [247, 246, 244];

// ---- page geometry (A4, points) ----
const PW = 595.28, PH = 841.89;
const M = { l: 54, r: 54, t: 64, b: 56 };
const CW = PW - M.l - M.r;

// ---- logo (read PNG IHDR for aspect) ----
const logoBuf = readFileSync('public/cardoso-logo-orange.png');
const logoData = 'data:image/png;base64,' + logoBuf.toString('base64');
const logoW0 = logoBuf.readUInt32BE(16), logoH0 = logoBuf.readUInt32BE(20);

const doc = new jsPDF({ unit: 'pt', format: 'a4' });
let y = M.t;
let page = 1;

const stripEmoji = (s) => s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/gu, '').replace(/\s{2,}/g, ' ').trim();

function footer() {
  doc.setDrawColor(...RULE); doc.setLineWidth(0.5);
  doc.line(M.l, PH - M.b + 14, PW - M.r, PH - M.b + 14);
  doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED);
  doc.text('Cardoso  ·  Confidential', M.l, PH - M.b + 26);
  doc.text(`Page ${page}`, PW - M.r, PH - M.b + 26, { align: 'right' });
}

function newPage() { footer(); doc.addPage(); page += 1; y = M.t; }
function need(h) { if (y + h > PH - M.b) newPage(); }

function wrap(text, font, size) {
  doc.setFont('helvetica', font).setFontSize(size);
  return doc.splitTextToSize(text, CW);
}

// Inline **bold** / *italic* aware paragraph renderer with word wrap.
function richText(md, { size = 10, lh = 14, color = INK, indent = 0, gap = 6 } = {}) {
  const x0 = M.l + indent, maxW = CW - indent;
  // tokenize into runs
  const runs = [];
  let rest = md, m;
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`)/;
  while ((m = re.exec(rest))) {
    if (m.index > 0) runs.push({ t: rest.slice(0, m.index), b: false, i: false });
    if (m[2] != null) runs.push({ t: m[2], b: true, i: false });
    else if (m[3] != null) runs.push({ t: m[3], b: false, i: true });
    else runs.push({ t: m[4], b: false, i: false });
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) runs.push({ t: rest, b: false, i: false });
  // word-wrap across runs
  doc.setFontSize(size).setTextColor(...color);
  let x = x0; need(lh);
  const space = () => { doc.setFont('helvetica', 'normal'); return doc.getTextWidth(' '); };
  for (const run of runs) {
    const style = run.b ? 'bold' : run.i ? 'italic' : 'normal';
    const words = run.t.split(/(\s+)/).filter((w) => w !== '');
    for (const w of words) {
      if (/^\s+$/.test(w)) { x += space(); continue; }
      doc.setFont('helvetica', style);
      const ww = doc.getTextWidth(w);
      if (x + ww > x0 + maxW) { y += lh; need(lh); x = x0; }
      doc.text(w, x, y); x += ww;
    }
  }
  y += lh + gap;
}

function h1Cover(text) {
  // logo
  const lh = 34, lw = (logoW0 / logoH0) * lh;
  doc.addImage(logoData, 'PNG', M.l, y, lw, lh);
  y += lh + 22;
  doc.setFont('helvetica', 'bold').setFontSize(26).setTextColor(...INK);
  for (const line of wrap(stripEmoji(text), 'bold', 26)) { need(30); doc.text(line, M.l, y); y += 30; }
  doc.setDrawColor(...ORANGE); doc.setLineWidth(2.5);
  doc.line(M.l, y - 6, M.l + 54, y - 6);
  y += 16;
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...MUTED);
  doc.text(kindLabel.toUpperCase(), M.l, y); y += 16;
}

function h2(text) {
  y += 10; need(30);
  doc.setFillColor(...ORANGE); doc.rect(M.l, y - 9, 4, 13, 'F');
  doc.setFont('helvetica', 'bold').setFontSize(13.5).setTextColor(...INK);
  for (const line of wrap(stripEmoji(text), 'bold', 13.5)) { need(18); doc.text(line, M.l + 12, y); y += 18; }
  y += 4;
}

function h3(text) {
  y += 4; need(18);
  doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...ORANGE);
  doc.text(stripEmoji(text), M.l, y); y += 15;
}

function bullet(md) {
  need(14);
  doc.setFillColor(...ORANGE); doc.circle(M.l + 4, y - 3, 1.6, 'F');
  richText(md, { indent: 16, gap: 3 });
}

function hr() { y += 4; need(10); doc.setDrawColor(...RULE); doc.setLineWidth(0.5); doc.line(M.l, y, PW - M.r, y); y += 12; }

function quote(md) {
  need(16);
  const top = y - 10;
  richText(md, { indent: 14, color: MUTED, gap: 4 });
  doc.setDrawColor(...ORANGE); doc.setLineWidth(2); doc.line(M.l + 2, top, M.l + 2, y - 12);
}

function table(head, rows) {
  autoTable(doc, {
    startY: y + 2,
    head: [head], body: rows,
    margin: { left: M.l, right: M.r },
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 5, textColor: INK, lineColor: RULE, lineWidth: 0.5 },
    headStyles: { fillColor: ORANGE, textColor: [255, 255, 255], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: LIGHT },
    didDrawPage: () => {},
  });
  y = doc.lastAutoTable.finalY + 12;
}

// ---- parse markdown into blocks ----
const lines = readFileSync(inPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
let i = 0, firstH1 = true, para = [];
const flushPara = () => { if (para.length) { richText(para.join(' ')); para = []; } };

while (i < lines.length) {
  const ln = lines[i];
  if (/^\s*$/.test(ln)) { flushPara(); i++; continue; }
  if (/^#\s+/.test(ln)) { flushPara(); const t = ln.replace(/^#\s+/, ''); if (firstH1) { h1Cover(t); firstH1 = false; } else h2(t); i++; continue; }
  if (/^##\s+/.test(ln)) { flushPara(); h2(ln.replace(/^##\s+/, '')); i++; continue; }
  if (/^###\s+/.test(ln)) { flushPara(); h3(ln.replace(/^###\s+/, '')); i++; continue; }
  if (/^---\s*$/.test(ln)) { flushPara(); hr(); i++; continue; }
  if (/^>\s?/.test(ln)) { flushPara(); quote(ln.replace(/^>\s?/, '')); i++; continue; }
  if (/^[-*]\s+/.test(ln)) { flushPara(); bullet(ln.replace(/^[-*]\s+/, '')); i++; continue; }
  if (/^\|/.test(ln)) {
    flushPara();
    const tbl = [];
    while (i < lines.length && /^\|/.test(lines[i])) { tbl.push(lines[i]); i++; }
    const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const head = cells(tbl[0]);
    const body = tbl.slice(2).map((r) => cells(r).map((c) => c.replace(/\*\*/g, '')));
    table(head, body);
    continue;
  }
  // paragraph line (italic-only line e.g. footer)
  para.push(ln.trim());
  i++;
}
flushPara();
footer();

writeFileSync(outPath, Buffer.from(doc.output('arraybuffer')));
console.log('wrote', outPath, '(' + page + ' pages)');
