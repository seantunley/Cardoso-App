export default {
  version: 103,
  name: 'creditor_capture_meta',
  up(db) {
    // "How far behind is payment capture?" — operator request. The unposted
    // adjustments (v101/v102) can only reflect what accounts has CAPTURED;
    // payments that exist only at the bank are invisible to every Sage table
    // (live case: vendor payments last captured 30 Apr, surfaced 42 days
    // later). These columns record, per sync, the newest vendor-payment
    // activity in each stage so the page can state it plainly.
    const cols = db.prepare(`PRAGMA table_info(creditor_sync_meta)`).all().map((c) => c.name);
    if (!cols.includes('last_cb_payment_capture')) {
      db.exec(`ALTER TABLE creditor_sync_meta ADD COLUMN last_cb_payment_capture TEXT`);
    }
    if (!cols.includes('last_ap_payment_date')) {
      db.exec(`ALTER TABLE creditor_sync_meta ADD COLUMN last_ap_payment_date TEXT`);
    }
  },
};
