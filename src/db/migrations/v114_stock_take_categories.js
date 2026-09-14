import { ensureColumn } from './_helpers.js';

export default {
  version: 114,
  name: 'stock_take_categories',
  up(db) {
    // A count can be scoped to product groups — cigarettes only, or sweets and
    // tobacco — instead of the whole branch.
    //
    // Counting 709 stocked items in one go is a shutdown. Counting the
    // cigarettes on a Tuesday and the sweets on a Thursday is a routine, and a
    // routine is what actually finds shrinkage. The groups are Sage's own
    // categories (ICITEM.CATEGORY), so nothing has to be maintained twice.
    //
    // NULL means the whole branch, which is what every count opened before this
    // migration was.
    ensureColumn(db, 'stocktake_session', 'categories', 'TEXT');

    // Sage's category code is a few letters (20S, SWT, TOB). The description
    // from ICCATG is what a person recognises, so it is cached alongside.
    ensureColumn(db, 'stocktake_item', 'category_description', 'TEXT');
  },
};
