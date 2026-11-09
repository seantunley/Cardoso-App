// Removing a site from the hub must clear every table that holds data pulled
// from it; otherwise its sales, stock and debtors stay in the combined totals
// after the UI says it's gone. The two removal routes each kept their own list
// and both missed tables (sales rollups, debtors, creditors, item vendors…).
// The tables are read from the schema, so a new hub_* table keyed by site_id is
// covered without anyone remembering to add it here.
//
// Kept on purpose: the JTI and commission archives. They're copies of monthly
// files the site filed, not live figures, and nothing totals them across sites.
const KEEP = new Set(['hub_jti_archive', 'hub_commission_archive']);

/** Every hub_* table that holds per-site pulled data (has site_id), minus the kept archives. */
export function siteDataTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'hub\\_%' ESCAPE '\\'")
    .all()
    .map((r) => r.name)
    .filter((t) => !KEEP.has(t) && db.prepare(`PRAGMA table_info("${t}")`).all().some((c) => c.name === 'site_id'));
}

export function purgeSiteData(db, siteId) {
  const tables = siteDataTables(db);
  const counts = {};
  db.transaction(() => {
    // PO lines have no site_id; they hang off their header.
    if (tables.includes('hub_creditor_po_header')) {
      counts.hub_creditor_po_line = db.prepare(
        'DELETE FROM hub_creditor_po_line WHERE po_id IN (SELECT id FROM hub_creditor_po_header WHERE site_id = ?)'
      ).run(siteId).changes;
    }
    for (const t of tables) counts[t] = db.prepare(`DELETE FROM "${t}" WHERE site_id = ?`).run(siteId).changes;
    counts.hub_sites = db.prepare('DELETE FROM hub_sites WHERE id = ?').run(siteId).changes;
  })();
  return counts;
}
