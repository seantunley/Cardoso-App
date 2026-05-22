/** @param {unknown} value */
export function parseAppDate(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const str = String(value).trim();
  if (!str) return null;

  // ISO timestamps like 2026-03-17T10:45:12.123Z
  if (str.includes("T")) {
    const d = new Date(str);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // SQLite CURRENT_TIMESTAMP format: YYYY-MM-DD HH:MM:SS
  // Treat as UTC
  const normalized = str.replace(" ", "T") + "Z";
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Intl.DateTimeFormat instances are expensive to construct (cf. V8 ICU
// initialisation) but cheap to .format() with. Hoist them so per-row
// callers in tables don't allocate a fresh formatter on every render.
const APP_DATE_FMT = new Intl.DateTimeFormat("en-ZA", {
  timeZone: "Africa/Johannesburg",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const APP_DATE_LONG_FMT = new Intl.DateTimeFormat("en-ZA", {
  timeZone: "Africa/Johannesburg",
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** @param {unknown} value */
export function formatAppDate(value) {
  const parsed = parseAppDate(value);
  if (!parsed) return "-";
  return APP_DATE_FMT.format(parsed);
}

/** @param {unknown} value */
export function formatAppDateLong(value) {
  const parsed = parseAppDate(value);
  if (!parsed) return "-";
  return APP_DATE_LONG_FMT.format(parsed);
}
