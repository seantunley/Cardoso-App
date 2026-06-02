import { ensureColumn } from './_helpers.js';

// Third admin-editable Sage SQL slot for the commission report:
//   unpaid_query_override — per-invoice list of sweets invoices in the
//                            period that are NOT fully paid (joined to
//                            AROBL.SWPAID = 0). Empty = use built-in
//                            default (see DEFAULT_COMMISSION_UNPAID_SQL).
export default {
  version: 88,
  name: 'commission_unpaid_override',
  up(db) {
    ensureColumn(db, 'commission_settings', 'unpaid_query_override', 'TEXT');
  },
};
