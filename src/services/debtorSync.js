import db from '../db/index.js';
import { getSagePool } from './batReconciliation.js';
import { logError } from '../lib/errorLog.js';
import { resolveSageQuery, getSageQuery } from './sage/queryRegistry.js';

// AR open-item sync — pulls the customer open documents Sage exposes in AROBL
// into debtor_ar_invoice, so the Aged Debtors report can age each document
// individually by its due date (the Sage way). Mirrors services/creditorSync.js
// (which does the same for AP/APOBL), but AR-only: customer master data
// (name, sales rep, account type, terms) already lives in datarecord, so this
// service only carries the open documents.
//
// Column names below were verified directly against the live Sage 300 AROBL
// schema (INFORMATION_SCHEMA.COLUMNS) — not guessed. Operators can still
// override the whole query through debtor_sync_settings.ar_invoice_sql_override
// if their install has been customised.
//
// AR vs AP column differences (AROBL vs APOBL):
//   - customer key  IDCUST       (AP used IDVEND)
//   - due date      DATEDUE      (AP used DATEINVCDU)
//   - doc type      TRXTYPEID    (AP used IDTRXTYPE) — smallint
//   - reference     IDORDERNBR   (AP used IDPONBR)
//   - amounts AMTINVCHC / AMTDUEHC and DATEINVC match the AP side.
// The default AR open-item query now lives in the central Sage query registry
// (src/services/sage/queryRegistry.js, key 'debtor.ar_invoice'). Re-exported
// here so the sync-settings route can still surface the shipped default.
export const DEFAULT_AR_INVOICE_SQL = getSageQuery('debtor.ar_invoice').defaultSql;

function intToDateStr(n) {
  if (!n) return null;
  const s = String(n);
  return /^\d{8}$/.test(s) ? s.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : null;
}

export function getSyncSettings() {
  try {
    return db.prepare('SELECT * FROM debtor_sync_settings WHERE id = 1').get() || {};
  } catch (err) {
    console.error('[debtor-sync] read settings failed:', err.message);
    return {};
  }
}

export function setSyncSettings({ ar_invoice_sql_override, history_months }) {
  try {
    db.prepare(`
      UPDATE debtor_sync_settings SET
        ar_invoice_sql_override = COALESCE(?, ar_invoice_sql_override),
        history_months          = COALESCE(?, history_months)
      WHERE id = 1
    `).run(
      ar_invoice_sql_override ?? null,
      Number.isFinite(history_months) ? history_months : null,
    );
    return getSyncSettings();
  } catch (err) {
    logError('debtorSync.set_settings', err);
    throw err;
  }
}

export function getSyncMeta() {
  try {
    return db.prepare('SELECT last_synced_at, last_synced_to, rows_synced FROM debtor_sync_meta WHERE id = 1').get() || {};
  } catch (err) {
    console.error('[debtor-sync] read meta failed:', err.message);
    return {};
  }
}

// One transactional source — runs the AROBL query and reloads the open-item
// set. AROBL is the AUTHORITATIVE open-balance set, so we clear and reload:
// documents fully paid since the last sync drop out of the query result and
// must be removed here too (the query already succeeded by this point, so an
// empty result is authoritative — "no open AR documents"). Mirrors APOBL.
async function syncArInvoices(pool) {
  const queryText = resolveSageQuery('debtor.ar_invoice');
  const result = await pool.request().query(queryText);
  const rows = result.recordset || [];

  const upsert = db.prepare(`
    INSERT INTO debtor_ar_invoice (
      source_table, customer_code, reporting_account, document_number, document_type,
      document_date, due_date, original_amount, outstanding_amount, reference, synced_at
    )
    VALUES ('AROBL', ?, ?, ?, ?, ?, ?, ?, ?, ?, now_local())
    ON CONFLICT(source_table, customer_code, document_number) DO UPDATE SET
      reporting_account  = excluded.reporting_account,
      document_type      = excluded.document_type,
      document_date      = excluded.document_date,
      due_date           = excluded.due_date,
      original_amount    = excluded.original_amount,
      outstanding_amount = excluded.outstanding_amount,
      reference          = excluded.reference,
      synced_at          = now_local()
  `);

  let upserted = 0;
  const run = db.transaction(() => {
    db.prepare("DELETE FROM debtor_ar_invoice WHERE source_table = 'AROBL'").run();
    for (const r of rows) {
      if (!r.customer_code || !r.document_number) continue;
      upsert.run(
        r.customer_code,
        // Fall back to the customer's own code when it isn't a national member,
        // so every row carries a reporting account to age + join on.
        String(r.reporting_account || r.customer_code).trim(),
        r.document_number,
        r.document_type || null,
        intToDateStr(r.document_date_int),
        intToDateStr(r.due_date_int),
        Number(r.original_amount) || 0,
        Number(r.outstanding_amount) || 0,
        r.reference || null,
      );
      upserted++;
    }
  });
  run();
  return { rows: rows.length, upserted };
}

// Top-level orchestrator. Per-source try/catch so a Sage permission gap is
// reported rather than taking down the process. Returns a summary the route +
// UI can show.
export async function syncDebtorsFromSage() {
  logError('debtorSync.run', new Error('debtorSync.run starting'), {}, 'info');

  const pool = await getSagePool();
  const summary = { sources: {} };

  for (const [source, fn] of [
    ['ar_invoices', () => syncArInvoices(pool)],
  ]) {
    try {
      summary.sources[source] = await fn();
    } catch (err) {
      logError(`debtorSync.${source}`, err);
      summary.sources[source] = { error: err.message };
    }
  }

  // The AR open-item source is required: it's the authoritative open set the
  // ledger is rebuilt from. If it errored (bad override, missing AROBL grant,
  // Sage down) the per-source catch above swallowed it — but we must NOT stamp a
  // fresh last_synced_at, or the stale ledger would look freshly synced and both
  // the manual route (ok:true) and the scheduled job would report success.
  // Throw so the failure surfaces (route → error, scheduler → failed job) and
  // the success timestamp is skipped.
  const arResult = summary.sources.ar_invoices;
  if (!arResult || arResult.error) {
    const msg = arResult?.error || 'AR open-item sync did not run';
    logError('debtorSync.run', new Error(`debtor sync failed: ${msg}`), summary, 'warn');
    throw new Error(`Debtor AR open-item sync failed: ${msg}`);
  }

  try {
    const totalRows = Object.values(summary.sources).reduce((acc, s) => acc + (Number(s.rows) || 0), 0);
    db.prepare(`
      UPDATE debtor_sync_meta SET
        last_synced_at = now_local(),
        last_synced_to = date(now_local()),
        rows_synced    = ?
      WHERE id = 1
    `).run(totalRows);
  } catch (err) {
    logError('debtorSync.update_meta', err, {}, 'warn');
  }

  logError('debtorSync.run', new Error('debtorSync.run completed'), summary, 'info');
  return summary;
}
