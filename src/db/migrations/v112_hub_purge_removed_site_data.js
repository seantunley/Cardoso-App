// One-off clean-up on the hub: data left behind by sites removed before #609.
//
// Delete site / Forget used to clear only some hub tables, so a removed
// branch's sales rollups, debtors, creditors and more stayed in the combined
// totals. #609 fixed removal going forward; this clears what earlier removals
// left, with the same purgeSiteData() (JTI/commission archives are kept).
//
// Leftovers are site_ids found in hub tables with no hub_sites row. Guards so
// this can never touch a live site's data:
//  - does nothing when hub_sites is empty (a site install, or a hub that hasn't
//    registered its sites), since then every id would look removed;
//  - an id matching any site's id OR slug is kept, in case a table keys by slug;
//  - logs each removed id and row counts.
import { purgeSiteData, siteDataTables } from '../../hub/purgeSiteData.js';

export default {
  version: 112,
  name: 'hub_purge_removed_site_data',
  up(db) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hub_sites'").get()) return;
    const sites = db.prepare('SELECT id, slug FROM hub_sites').all();
    if (sites.length === 0) return;
    const known = new Set(sites.flatMap((s) => [s.id, s.slug]).filter(Boolean).map(String));

    const leftover = new Set();
    for (const t of siteDataTables(db)) {
      for (const { site_id: id } of db.prepare(`SELECT DISTINCT site_id FROM "${t}" WHERE site_id IS NOT NULL`).all()) {
        if (!known.has(String(id))) leftover.add(id);
      }
    }
    for (const id of leftover) {
      const counts = purgeSiteData(db, id);
      const removed = Object.entries(counts).filter(([, n]) => n).map(([t, n]) => `${n} ${t}`).join(', ');
      console.log(`[migration v112] Hub: removed data left behind by removed site '${id}' (no longer in hub_sites): ${removed || 'no rows'}.`);
    }
  },
};
