export default {
  version: 91,
  name: 'commission_vat_rate_15_default',
  up(db) {
    // Default the Sales Commission VAT divisor to 15% (the legal SA rate).
    // v082 seeded it at 0.14 to mirror the operator's historical spreadsheet
    // (receipt gross / 1.14). Move installs still on that old default to
    // 0.15 — only where the stored value is still ~0.14, so an operator who
    // deliberately set a different rate in Settings is left untouched.
    //
    // NOTE: this changes the receipts ex-VAT figure (÷1.15 instead of ÷1.14)
    // and therefore the cig/tob commission base — re-validate commission
    // totals against the operator's reference period after this lands.
    db.prepare('UPDATE commission_settings SET vat_rate = 0.15 WHERE ABS(vat_rate - 0.14) < 0.0005').run();
  },
};
