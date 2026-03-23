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

export function formatAppDate(value) {
  const parsed = parseAppDate(value);
  if (!parsed) return "-";

  return new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed);
}

export function formatAppDateLong(value) {
  const parsed = parseAppDate(value);
  if (!parsed) return "-";

  return new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(parsed);
}