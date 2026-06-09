// v095 — unified Sage query override store.
//
// Before this, operator SQL overrides lived in five different places:
// debtor_sync_settings / creditor_sync_settings / commission_settings columns,
// plus key/value rows in hub_settings (stock receipts) and jti_settings (JTI).
// This table consolidates them, keyed by the central registry's query key
// (src/services/sage/queryRegistry.js), and copies any existing overrides
// across so nothing is lost. The registry reads/writes this table from here on;
// the old columns/rows are left untouched (dead) for rollback safety.
export default {
  version: 95,
  name: 'sage_query_override',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sage_query_override (
        query_key   TEXT PRIMARY KEY,
        sql_text    TEXT NOT NULL,
        updated_by  INTEGER,
        updated_at  TEXT
      )
    `);

    // Copy each existing override into the unified table, keyed by registry key.
    // Best-effort per source: a store may not exist on every install (e.g. a
    // site that never configured JTI), and only non-empty overrides are moved.
    const insert = db.prepare(
      `INSERT OR IGNORE INTO sage_query_override (query_key, sql_text) VALUES (?, ?)`,
    );
    const copy = (key, selectSql) => {
      try {
        const v = db.prepare(selectSql).get()?.v;
        if (v && String(v).trim().length > 0) insert.run(key, String(v));
      } catch {
        /* source table/column absent on this install — nothing to copy */
      }
    };

    copy('debtor.ar_invoice',      'SELECT ar_invoice_sql_override AS v FROM debtor_sync_settings WHERE id = 1');
    copy('creditor.vendor',        'SELECT vendor_sql_override AS v FROM creditor_sync_settings WHERE id = 1');
    copy('creditor.ap_invoice',    'SELECT ap_invoice_sql_override AS v FROM creditor_sync_settings WHERE id = 1');
    copy('creditor.ap_payment',    'SELECT ap_payment_sql_override AS v FROM creditor_sync_settings WHERE id = 1');
    copy('creditor.po_header',     'SELECT po_header_sql_override AS v FROM creditor_sync_settings WHERE id = 1');
    copy('creditor.po_line',       'SELECT po_line_sql_override AS v FROM creditor_sync_settings WHERE id = 1');
    copy('commission.sales',       'SELECT sales_query_override AS v FROM commission_settings WHERE id = 1');
    copy('commission.receipts',    'SELECT receipts_query_override AS v FROM commission_settings WHERE id = 1');
    copy('commission.unpaid',      'SELECT unpaid_query_override AS v FROM commission_settings WHERE id = 1');
    copy('stock_receipts.receipt', "SELECT value AS v FROM hub_settings WHERE key = 'stock_receipt_sql_override'");
    copy('jti.export',             "SELECT value AS v FROM jti_settings WHERE key = 'query_override'");
  },
};
