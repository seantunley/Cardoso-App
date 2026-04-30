// One-shot fix: replace `hsl(var(--phosphor))` (and the -dim/-glow variants)
// with `var(--phosphor)`. The double-wrap was producing invalid CSS that
// fell back to default (black) — see Layout.jsx brand square fix.
const fs = require('fs');
const path = require('path');

function walk(dir, files = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, files);
    else if (/\.(jsx|js|tsx|ts|css)$/i.test(e.name)) files.push(p);
  }
  return files;
}

const SRC = path.resolve('src');
const all = walk(SRC);
console.log('Scanning', all.length, 'files in', SRC);

const patterns = [
  { from: 'hsl(var(--phosphor))',      to: 'var(--phosphor)' },
  { from: 'hsl(var(--phosphor-dim))',  to: 'var(--phosphor-dim)' },
  { from: 'hsl(var(--phosphor-glow))', to: 'var(--phosphor-glow)' },
];

let totalReplaces = 0;
let touchedFiles = 0;
for (const f of all) {
  let s = fs.readFileSync(f, 'utf8');
  let count = 0;
  for (const { from, to } of patterns) {
    const parts = s.split(from);
    if (parts.length > 1) {
      count += parts.length - 1;
      s = parts.join(to);
    }
  }
  if (count > 0) {
    fs.writeFileSync(f, s);
    totalReplaces += count;
    touchedFiles++;
    console.log('Fixed', String(count).padStart(3), 'in', path.relative(process.cwd(), f));
  }
}
console.log('---');
console.log('Total:', totalReplaces, 'replacements across', touchedFiles, 'files');
