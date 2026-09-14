import { ensureColumn } from './_helpers.js';

export default {
  version: 115,
  name: 'stock_take_commodities',
  up(db) {
    // A count can also be scoped by commodity, alongside category.
    //
    // Sage carries two independent ways of slicing the same stock, and the
    // branch uses both. ICITEM.CATEGORY is the fine one — supplier and brand
    // lines, 93 of them at Ermelo (BEACON SLABS, NESTLE CHOCOLATES, PACKET 20
    // CIGARETTES). ICITEM.COMMODIM is the coarse one, a handful of numbered
    // groups the business actually talks in; the commission rules already rely
    // on it ("sweets" is COMMODIM = 1).
    //
    // Neither replaces the other, so a count can be scoped by either, and an
    // item is in the count if it matches ANY of what was picked.
    ensureColumn(db, 'stocktake_item', 'commodity', 'TEXT');
    ensureColumn(db, 'stocktake_session', 'commodities', 'TEXT');
  },
};
