// Canonical number / currency / date formatters. Several modules historically
// rolled their own (reports/lib.jsx fmtR, collections/utils formatCurrency,
// per-page formatNum/formatRand) — new code should import from here so the
// formatting stays consistent. Existing modules can migrate incrementally.

// Parse a possibly-formatted amount to a number. Handles the formats this app
// actually produces and accepts: SA "1 234,56" (space thousands, comma decimal —
// what formatAmount/en-ZA emits), "1,234.56" (comma thousands, dot decimal), EU
// "1.234,56", a bare "11710,66", and currency-prefixed "R 1 234,56".
//
// When both comma and dot appear, the right-most is the decimal separator and
// the other is thousands grouping. With a single separator type it's a decimal
// point only when it appears once with <=2 trailing digits ("11710,66", "1.5");
// otherwise it's thousands grouping ("1,234", "1.234.567"). SA users type
// grouping as spaces, so a lone comma is almost always the decimal.
export function parseAmount(value) {
  // A number is already a number — never run it through the separator-guessing
  // below, or a value with >2 decimal places (a computed amount, or a float
  // artifact like 0.1 + 0.2 = 0.30000000000000004) would have its fractional
  // part read as thousands grouping and balloon by orders of magnitude.
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  let s = String(value ?? "").trim();
  if (!s) return 0;
  s = s.replace(/[^\d.,-]/g, ""); // drop currency symbol, spaces, stray letters
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    const decimalSep = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
    const thousandsSep = decimalSep === "," ? "." : ",";
    s = s.split(thousandsSep).join("").replace(decimalSep, ".");
  } else if (hasComma || hasDot) {
    const sep = hasComma ? "," : ".";
    const parts = s.split(sep);
    s = (parts.length === 2 && parts[1].length <= 2) ? parts.join(".") : parts.join("");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

// "1234.5" -> "1,234.50" (no currency symbol; pair with a R prefix in the UI).
export function formatAmount(value) {
  return parseAmount(value).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Full Rand string, e.g. "R 1,234.50" (negative -> "-R 1,234.50").
export function formatRand(value) {
  const n = parseAmount(value);
  const abs = Math.abs(n).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-R ${abs}` : `R ${abs}`;
}

// Compact Rand for axis ticks / dense cells: "R 1.2M", "R 800K", "R 450".
export function formatRandCompact(value) {
  const n = Math.abs(parseAmount(value));
  if (n >= 1_000_000) return `R ${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `R ${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return `R ${n.toFixed(0)}`;
}

// Integer-ish count with thousands separators; null/NaN -> "—".
export function formatNum(value) {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-ZA", { maximumFractionDigits: 0 });
}

export function formatPct(value, digits = 1) {
  return `${(Number(value) || 0).toFixed(digits)}%`;
}

// Relative time for ISO timestamps. SQLite local-time strings ("YYYY-MM-DD
// HH:MM:SS") are stored in UTC+2; pass already-normalised ISO or epoch here.
export function timeAgo(iso) {
  if (!iso) return "";
  const normalised = /[+\-Z]\d{2}|Z$/.test(iso) ? iso : String(iso).replace(" ", "T") + "Z";
  const t = new Date(normalised).getTime();
  if (Number.isNaN(t)) return "";
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toLocaleDateString("en-ZA");
}
