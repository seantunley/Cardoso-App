import { ensureColumn, ensureTable } from './_helpers.js';

export default {
  // Admin-only Sage SQL overrides for the commission report. Same
  // pattern as jti_settings.query_override (v69) — non-empty means
  // "use this verbatim against Sage instead of the built-in default".
  //
  // Two columns because commission runs TWO separate queries:
  //   sales_query_override   — OESHDT-based sweet sales + credits
  //   receipts_query_override — AROBP-based customer payments
  // Each is independently overridable. Empty = use default.
  version: 85,
  name: 'commission_sql_overrides',
  up(db) {
    ensureColumn(db, 'commission_settings', 'sales_query_override',    'TEXT');
    ensureColumn(db, 'commission_settings', 'receipts_query_override', 'TEXT');
  },
};
