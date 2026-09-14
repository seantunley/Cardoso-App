import { ensureColumn } from './_helpers.js';

export default {
  version: 116,
  name: 'stock_take_vendors',
  up(db) {
    // A count can also be scoped by vendor — count everything from JTI, or
    // everything from Beacon, in one pass.
    //
    // This is the way a count most often gets asked for in practice: a rep is
    // coming in, or a supplier's figures are being queried, and what is wanted
    // is that supplier's stock rather than an aisle or a product group.
    //
    // No new Sage query for it. item_vendor already holds the primary vendor
    // per item (from ICITMV, lowest VENDTYPE) and is kept current by the
    // Inventory Movement sync, and its vendor_code is the AP code, so a count
    // scoped this way lines up with creditors.
    ensureColumn(db, 'stocktake_session', 'vendors', 'TEXT');
  },
};
