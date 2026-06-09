// v096 — carry the item description into the inventory sales cache.
//
// The dashboard "Top Items Sold" tile (and the Trends top-movers) can only show
// item descriptions when the item master (inventoryrecord) is populated, which
// it isn't on every install. The monthly sales aggregate query already joins
// ICITEM, so we capture ICITEM.[DESC] alongside the totals into this new column.
// Existing rows stay NULL until the next inventory sales sync refills the cache.
export default {
  version: 97,
  name: 'inventory_sales_cache_description',
  up(db) {
    const cols = db.prepare('PRAGMA table_info(inventory_sales_cache)').all().map((c) => c.name);
    if (!cols.includes('item_description')) {
      db.exec('ALTER TABLE inventory_sales_cache ADD COLUMN item_description TEXT');
    }
  },
};
