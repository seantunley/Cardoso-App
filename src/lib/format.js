// Canonical number / currency / date formatters. Several modules historically
// rolled their own (reports/lib.jsx fmtR, collections/utils formatCurrency,
// per-page formatNum/formatRand) — new code should import from here so the
// formatting stays consistent. Existing modules can migrate incrementally.

// Parse a possibly-formatted amount ("1,234.50", "R 1 234") to a number.
export function parseAmount(value) {
  const n = parseFloat(String(value ?? "").replace(/[,\s]/g, "").replace(/[^0-9.\-]/g, ""));
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
