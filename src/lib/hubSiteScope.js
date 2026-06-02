// Per-user hub site allow-list — shared by routers that live outside hub.js
// (which keeps its own closure copy of this logic). Mirrors hub.js exactly:
//
//   hub_user_allowed_sites maps email -> site_slug
//     - no rows for the email  => unrestricted (returns null)
//     - >= 1 row               => restricted to those sites (Set of hub_sites.id)
//
// Role does NOT short-circuit — an admin who set an allow-list for themselves
// is scoped to it. site_id columns on hub tables hold hub_sites.id.
import db from '../db/index.js';

export function getAllowedSiteIds(req, res) {
  if (res?.locals && 'allowedSiteIds' in res.locals) return res.locals.allowedSiteIds;
  let result = null; // null = unrestricted
  const email = req?.currentUser?.email;
  if (email) {
    try {
      const slugs = db.prepare('SELECT site_slug FROM hub_user_allowed_sites WHERE email = ?')
        .all(email).map((r) => r.site_slug);
      if (slugs.length > 0) {
        const ph = slugs.map(() => '?').join(',');
        const ids = db.prepare(`SELECT id FROM hub_sites WHERE slug IN (${ph})`).all(...slugs).map((r) => r.id);
        result = new Set(ids);
      }
    } catch { /* tables missing on fresh installs — treat as unrestricted */ }
  }
  if (res?.locals) res.locals.allowedSiteIds = result;
  return result;
}

// `{ sql, params }` to AND into a WHERE clause restricting `column` to the
// user's allowed sites. Unrestricted -> empty; empty allow-list -> ` AND 1=0`
// (see nothing, not everything).
export function siteIdFilter(req, res, column = 'site_id') {
  const allowed = getAllowedSiteIds(req, res);
  if (allowed === null) return { sql: '', params: [] };
  if (allowed.size === 0) return { sql: ' AND 1=0', params: [] };
  const list = [...allowed];
  return { sql: ` AND ${column} IN (${list.map(() => '?').join(',')})`, params: list };
}

// True if the user may see this site id (tolerates id/string forms).
export function isSiteAllowed(req, res, siteId) {
  const allowed = getAllowedSiteIds(req, res);
  if (allowed === null) return true;
  return allowed.has(siteId) || allowed.has(Number(siteId)) || allowed.has(String(siteId));
}
