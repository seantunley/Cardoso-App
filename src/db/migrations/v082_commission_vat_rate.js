import { ensureColumn, ensureTable } from './_helpers.js';

export default {
  version: 82,
  name: 'commission_vat_rate',
  up(db) {
    // VAT divisor for the Sales Commission report. Operator's spreadsheet
    // strips VAT off the AROBP receipt total (gross / 1.14) — make that
    // configurable so when the SA VAT rate moves (currently 15% legally
    // but operator's historical formula uses 14%) an admin can adjust it
    // without a code deploy. Default 0.14 matches the existing report.
    ensureColumn(db, 'commission_settings', 'vat_rate', 'REAL NOT NULL DEFAULT 0.14');
  },
};
