// JTI export — settings (DB-backed defaults).
//
// The TownCity / Region / Country / Site label that pre-fill the
// JTI export form are stored per-install in the jti_settings table
// (created in migration v69). DB storage rather than env vars so an
// admin can change them from the JTI page's Defaults panel without
// a server restart.
//
// Four keys lived in this module: town_city, region, country,
// site_label. All optional — the export still works with blanks
// (the spreadsheet just won't have geographical metadata, and the
// filename will fall back to "Unknown" for the site).
//
// The helpers here are deliberately thin — they hide the (key,value)
// table shape so callers don't have to know it. Pass `db` as an
// explicit arg so tests can use an in-memory SQLite without a
// module-level shim.

export const JTI_SETTING_KEYS = ['town_city', 'region', 'country', 'site_label', 'query_override'];

/**
 * Read the current JTI settings as a plain object.
 *
 * `queryOverride` carries the operator-supplied SQL that replaces the
 * default jtiQuery.buildJtiSql when non-empty. Empty / missing means
 * "use the default" — keeping the toggle implicit avoids needing a
 * separate enable flag.
 *
 * @param {{ db: import('better-sqlite3').Database }} args
 * @returns {{
 *   townCity: string, region: string, country: string,
 *   siteLabel: string, queryOverride: string,
 * }}
 */
export function getJtiSettings({ db }) {
  if (!db) throw new TypeError('getJtiSettings: db is required');
  const rows = db.prepare(`SELECT key, value FROM jti_settings`).all();
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    townCity:      map.get('town_city')      || '',
    region:        map.get('region')         || '',
    country:       map.get('country')        || '',
    siteLabel:     map.get('site_label')     || '',
    queryOverride: map.get('query_override') || '',
  };
}

/**
 * Upsert one or more JTI settings. Only keys present in the input
 * are touched; passing `{ townCity: 'X' }` leaves region / country /
 * siteLabel untouched. To clear a value, pass it as an empty string.
 *
 * @param {{
 *   db: import('better-sqlite3').Database,
 *   townCity?: string, region?: string, country?: string,
 *   siteLabel?: string, queryOverride?: string,
 * }} args
 * @returns {{
 *   townCity: string, region: string, country: string,
 *   siteLabel: string, queryOverride: string,
 * }} the post-upsert state of all settings
 */
export function setJtiSettings({ db, townCity, region, country, siteLabel, queryOverride }) {
  if (!db) throw new TypeError('setJtiSettings: db is required');
  const upsert = db.prepare(`
    INSERT INTO jti_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `);
  const tx = db.transaction(() => {
    if (townCity !== undefined)      upsert.run('town_city',      String(townCity));
    if (region !== undefined)        upsert.run('region',         String(region));
    if (country !== undefined)       upsert.run('country',        String(country));
    if (siteLabel !== undefined)     upsert.run('site_label',     String(siteLabel));
    if (queryOverride !== undefined) upsert.run('query_override', String(queryOverride));
  });
  tx();
  return getJtiSettings({ db });
}
