// JTI export — download filename builder.
//
// Pattern (locked from the supplied sample): JTI_Cardoso_Sales_<SITE>_<YYYYMMDD>.xlsx
// e.g. JTI_Cardoso_Sales_Ermelo_20260430.xlsx
//
//   <SITE>     = the install's site label (e.g. "Ermelo"). Hardcoded
//                per install — comes from a config value the route
//                handler resolves and passes in.
//   <YYYYMMDD> = the END date of the export's date range, in calendar
//                year/month/day order, no separators.
//
// Pure helper: no I/O, no formatting beyond what's strictly needed.
// Lives in its own module so the filename pattern can be tested
// without standing up the route. Any change to the pattern must be
// coordinated with the downstream pipeline (consumers may parse the
// filename for the date marker).

const ALLOWED_SITE_CHARS = /[^A-Za-z0-9 \-_.]/g;

/**
 * Sanitise the site label so the resulting filename is filesystem-
 * safe across the OSes that might receive this download (Windows,
 * macOS, Linux). Strips path separators and collapses spaces.
 * Defensive only — the site value comes from our own config, not
 * untrusted input, but cheap belt-and-braces.
 *
 * @param {string} site
 * @returns {string}
 */
export function sanitizeSiteLabel(site) {
  const raw = String(site == null ? '' : site).trim();
  if (!raw) return 'Unknown';
  // Replace each disallowed character with an underscore, then
  // collapse runs of whitespace + underscores. Keeps "Cape Town" →
  // "Cape Town" (space allowed) but turns "C/T" → "C_T" etc.
  const cleaned = raw.replace(ALLOWED_SITE_CHARS, '_').trim();
  return cleaned || 'Unknown';
}

/**
 * Format a Date (or YYYYMMDD integer) as the YYYYMMDD string used in
 * the filename. UTC-anchored to avoid the local-timezone "I selected
 * the 30th but the file says the 29th" surprise that happens when a
 * date picker hands you a midnight-UTC value and the server is in
 * a positive UTC offset.
 *
 * @param {Date | number | string} value  Date object, integer YYYYMMDD, or string YYYYMMDD
 * @returns {string}                      e.g. "20260430"
 * @throws {RangeError} when the value can't be coerced to a valid date
 */
export function formatYyyymmdd(value) {
  // Already-formatted integer: validate range and pass through.
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (value < 19000101 || value > 21001231) {
      throw new RangeError(`formatYyyymmdd: integer ${value} out of range YYYYMMDD`);
    }
    return String(value);
  }
  // Already-formatted string: trim and validate.
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{8}$/.test(trimmed)) return trimmed;
    // Fall through — try parsing as a date string
  }
  const d = value instanceof Date ? value : new Date(value);
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new RangeError(`formatYyyymmdd: cannot parse "${value}" as a date`);
  }
  // UTC components — see comment above on timezone defensiveness.
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

/**
 * Build the JTI export filename.
 *
 * @param {{ site: string, endDate: Date | number | string }} args
 * @returns {string}  e.g. "JTI_Cardoso_Sales_Ermelo_20260430.xlsx"
 */
export function buildJtiFilename({ site, endDate }) {
  if (endDate == null) throw new TypeError('buildJtiFilename: endDate is required');
  const safeSite = sanitizeSiteLabel(site);
  const dateStr = formatYyyymmdd(endDate);
  return `JTI_Cardoso_Sales_${safeSite}_${dateStr}.xlsx`;
}
