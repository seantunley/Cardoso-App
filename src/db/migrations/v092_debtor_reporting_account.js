// Carry the REPORTING ACCOUNT on the AR open-item ledger.
//
// The customer sync (datarecord) rolls national-account members up under their
// national account and hides the child rows. The AR ledger, however, stores the
// raw child IDCUST — so without a reporting account the Aged Debtors report
// would age each child invoice as its own unnamed row and couldn't inherit the
// national account's rep/type. This column carries the reporting account
// (ARCUS.IDNATACCT for a member, else the customer's own code) so the report
// ages + joins on it, matching Customer Balances. Populated by debtorSync.js;
// existing rows default to customer_code until the next sync.
export default {
  version: 92,
  name: 'debtor_reporting_account',
  up(db) {
    const hasCol = (table, col) =>
      db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);

    if (!hasCol('debtor_ar_invoice', 'reporting_account')) {
      db.exec('ALTER TABLE debtor_ar_invoice ADD COLUMN reporting_account TEXT;');
      db.exec('UPDATE debtor_ar_invoice SET reporting_account = customer_code WHERE reporting_account IS NULL;');
      db.exec('CREATE INDEX IF NOT EXISTS idx_debtor_ar_invoice_reporting ON debtor_ar_invoice(reporting_account, due_date);');
    }
    if (!hasCol('hub_debtor_ar_invoice', 'reporting_account')) {
      db.exec('ALTER TABLE hub_debtor_ar_invoice ADD COLUMN reporting_account TEXT;');
      db.exec('UPDATE hub_debtor_ar_invoice SET reporting_account = customer_code WHERE reporting_account IS NULL;');
    }
  },
};
