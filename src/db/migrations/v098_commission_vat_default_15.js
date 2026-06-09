// v098 — move the commission VAT divisor default from 14% to 15%.
//
// 15% is the current South African VAT rate; the divisor strips VAT off AR
// receipts before the commission base is computed. Existing installs are bumped
// ONLY where the rate is still the exact legacy default (0.14). An exact match
// is used deliberately rather than a tolerance band: the Settings form accepts
// arbitrary decimal percentages, so any operator-configured value near 14%
// (e.g. 14.04%) must be left exactly as configured, not silently rewritten.
export default {
  version: 98,
  name: 'commission_vat_default_15',
  up(db) {
    db.prepare('UPDATE commission_settings SET vat_rate = 0.15 WHERE vat_rate = 0.14').run();
  },
};
