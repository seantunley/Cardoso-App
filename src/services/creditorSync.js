import sql from 'mssql';
import db from '../db/index.js';
import { getSagePool } from './batReconciliation.js';
import { logError } from '../lib/errorLog.js';
import { resolveSageQuery, getSageQuery } from './sage/queryRegistry.js';

// Default SQL for each Creditors source now lives in the central Sage query
// registry (src/services/sage/queryRegistry.js, keys 'creditor.*'). Re-exported
// here so the sync-settings route can still surface the shipped defaults.
export const DEFAULT_VENDOR_SQL     = getSageQuery('creditor.vendor').defaultSql;
export const DEFAULT_AP_INVOICE_SQL = getSageQuery('creditor.ap_invoice').defaultSql;
export const DEFAULT_AP_PAYMENT_SQL = getSageQuery('creditor.ap_payment').defaultSql;
export const DEFAULT_AP_UNPOSTED_SQL = getSageQuery('creditor.ap_unposted_payment').defaultSql;
export const DEFAULT_AP_UNPOSTED_INVOICE_SQL = getSageQuery('creditor.ap_unposted_invoice').defaultSql;
export const DEFAULT_PO_HEADER_SQL  = getSageQuery('creditor.po_header').defaultSql;
export const DEFAULT_PO_LINE_SQL    = getSageQuery('creditor.po_line').defaultSql;

function toYyyymmddInt(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return parseInt(`${y}${m}${day}`, 10);
}

function intToDateStr(n) {
  if (!n) return null;
  const s = String(n);
  return /^\d{8}$/.test(s) ? s.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : null;
}

export function getSyncSettings() {
  try {
    const row = db.prepare('SELECT * FROM creditor_sync_settings WHERE id = 1').get();
    return row || {};
  } catch (err) {
    console.error('[creditor-sync] read settings failed:', err.message);
    return {};
  }
}

export function setSyncSettings({
  vendor_sql_override,
  ap_invoice_sql_override,
  ap_payment_sql_override,
  ap_unposted_sql_override,
  ap_unposted_invoice_sql_override,
  po_header_sql_override,
  po_line_sql_override,
  history_months,
}) {
  try {
    const current = getSyncSettings();
    db.prepare(`
      UPDATE creditor_sync_settings SET
        vendor_sql_override      = COALESCE(?, vendor_sql_override),
        ap_invoice_sql_override  = COALESCE(?, ap_invoice_sql_override),
        ap_payment_sql_override  = COALESCE(?, ap_payment_sql_override),
        ap_unposted_sql_override = COALESCE(?, ap_unposted_sql_override),
        ap_unposted_invoice_sql_override = COALESCE(?, ap_unposted_invoice_sql_override),
        po_header_sql_override   = COALESCE(?, po_header_sql_override),
        po_line_sql_override     = COALESCE(?, po_line_sql_override),
        history_months           = COALESCE(?, history_months)
      WHERE id = 1
    `).run(
      vendor_sql_override      ?? null,
      ap_invoice_sql_override  ?? null,
      ap_payment_sql_override  ?? null,
      ap_unposted_sql_override ?? null,
      ap_unposted_invoice_sql_override ?? null,
      po_header_sql_override   ?? null,
      po_line_sql_override     ?? null,
      Number.isFinite(history_months) ? history_months : null,
    );
    return getSyncSettings();
  } catch (err) {
    logError('creditorSync.set_settings', err);
    throw err;
  }
}

export function getSyncMeta() {
  try {
    return db.prepare('SELECT last_synced_at, last_synced_to, rows_synced, last_cb_payment_capture, last_ap_payment_date FROM creditor_sync_meta WHERE id = 1').get() || {};
  } catch (err) {
    console.error('[creditor-sync] read meta failed:', err.message);
    return {};
  }
}

// One transactional source — runs one Sage query and upserts its results.
// Each source-runner returns { rows, upserted } so the orchestrator can
// report a per-source summary even when one source fails (caught
// separately so a permission error on APTCR doesn't wipe vendor sync).
async function syncVendors(pool) {
  const queryText = resolveSageQuery('creditor.vendor');
  const result = await pool.request().query(queryText);
  const rows = result.recordset || [];

  const upsert = db.prepare(`
    INSERT INTO creditor (source_table, vendor_code, vendor_name, terms, contact, phone, email, is_active, synced_at)
    VALUES ('APVEN', ?, ?, ?, ?, ?, ?, ?, now_local())
    ON CONFLICT(source_table, vendor_code) DO UPDATE SET
      vendor_name = excluded.vendor_name,
      terms       = excluded.terms,
      contact     = excluded.contact,
      phone       = excluded.phone,
      email       = excluded.email,
      is_active   = excluded.is_active,
      synced_at   = now_local()
  `);

  let upserted = 0;
  const run = db.transaction(() => {
    for (const r of rows) {
      if (!r.vendor_code) continue;
      upsert.run(
        r.vendor_code,
        r.vendor_name || null,
        r.terms || null,
        r.contact || null,
        r.phone || null,
        r.email || null,
        r.is_active != null ? (r.is_active ? 1 : 0) : 1,
      );
      upserted++;
    }
  });
  run();
  return { rows: rows.length, upserted };
}

async function syncApInvoices(pool) {
  const queryText = resolveSageQuery('creditor.ap_invoice');
  const result = await pool.request().query(queryText);
  const rows = result.recordset || [];

  const upsert = db.prepare(`
    INSERT INTO creditor_ap_invoice (
      source_table, vendor_code, document_number, document_type,
      document_date, due_date, original_amount, outstanding_amount, reference, synced_at
    )
    VALUES ('APOBL', ?, ?, ?, ?, ?, ?, ?, ?, now_local())
    ON CONFLICT(source_table, vendor_code, document_number) DO UPDATE SET
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
    // APOBL is the AUTHORITATIVE open-balance set — clear and reload so
    // invoices that have been fully paid since the last sync are removed.
    db.prepare("DELETE FROM creditor_ap_invoice WHERE source_table = 'APOBL'").run();
    for (const r of rows) {
      if (!r.vendor_code || !r.document_number) continue;
      upsert.run(
        r.vendor_code,
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

async function syncApPayments(pool, fromInt, toInt) {
  const queryText = resolveSageQuery('creditor.ap_payment');
  const result = await pool.request()
    .input('from', sql.Int, fromInt)
    .input('to', sql.Int, toInt)
    .query(queryText);
  const rows = result.recordset || [];

  const upsert = db.prepare(`
    INSERT INTO creditor_ap_payment (
      source_table, vendor_code, payment_number, payment_date,
      payment_method, amount, reference, bank_code, synced_at
    )
    VALUES ('APTCR', ?, ?, ?, ?, ?, ?, ?, now_local())
    ON CONFLICT(source_table, vendor_code, payment_number) DO UPDATE SET
      payment_date   = excluded.payment_date,
      payment_method = excluded.payment_method,
      amount         = excluded.amount,
      reference      = excluded.reference,
      bank_code      = excluded.bank_code,
      synced_at      = now_local()
  `);

  let upserted = 0;
  const run = db.transaction(() => {
    // Reconcile reversals: a payment reversed/removed in Sage drops out of the
    // window result and would otherwise linger forever (upsert never deletes),
    // inflating YTD totals. Clear the synced payment-date window first, then
    // re-insert. The query already succeeded by this point (a failure throws
    // before this transaction runs), so an EMPTY result is authoritative —
    // "every payment in the window was reversed" — and must clear the window
    // too. Mirrors the APOBL clear-and-reload above; rows outside the window
    // are untouched. (Was guarded on rows.length, which left stale payments
    // whenever a window legitimately emptied out.)
    db.prepare("DELETE FROM creditor_ap_payment WHERE source_table = 'APTCR' AND payment_date >= ? AND payment_date <= ?")
      .run(intToDateStr(fromInt), intToDateStr(toInt));
    for (const r of rows) {
      if (!r.vendor_code || !r.payment_number) continue;
      upsert.run(
        r.vendor_code,
        r.payment_number,
        intToDateStr(r.payment_date_int),
        r.payment_method || null,
        Number(r.amount) || 0,
        r.reference || null,
        r.bank_code || null,
      );
      upserted++;
    }
  });
  run();
  return { rows: rows.length, upserted };
}

// Unposted AP payments — cheques captured in Payment Entry whose batch hasn't
// been posted (APBTA.POSTSEQNBR = 0, not deleted). Until accounts posts the
// batch, APOBL still shows the paid invoices as open, so the Creditor Balances
// page nets these amounts off each vendor's outstanding. FULL refresh every
// sync: the whole point of this table is "what is unposted RIGHT NOW" — rows
// must vanish the moment their batch posts (the payment then arrives through
// the normal posted-payment sync and APOBL reflects it).
async function syncUnpostedPayments(pool) {
  const queryText = resolveSageQuery('creditor.ap_unposted_payment');
  const result = await pool.request().query(queryText);
  const rows = result.recordset || [];

  const insert = db.prepare(`
    INSERT INTO creditor_ap_unposted_payment (
      vendor_code, payment_number, payment_date, amount,
      batch_number, batch_status, batch_description, synced_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, now_local())
  `);

  let inserted = 0;
  const run = db.transaction(() => {
    // The query succeeded by this point, so an empty result is authoritative:
    // "nothing is unposted" must clear the table (it usually does, right
    // after accounts catches up on posting).
    db.prepare('DELETE FROM creditor_ap_unposted_payment').run();
    for (const r of rows) {
      if (!r.vendor_code) continue;
      insert.run(
        r.vendor_code,
        r.payment_number || null,
        intToDateStr(r.payment_date_int),
        Number(r.amount) || 0,
        Number(r.batch_number) || null,
        Number(r.batch_status) || null,
        r.batch_description || null,
      );
      inserted++;
    }
  });
  run();
  return { rows: rows.length, inserted };
}

// Unposted AP invoices — the mirror of syncUnpostedPayments: vendor invoices
// captured in AP Invoice Entry whose batch hasn't posted. APOBL doesn't list
// them yet, so vendor outstanding is UNDERSTATED until posting (live data at
// build time: R44.65M across 17 ready-to-post batches). Amounts arrive signed
// (credit notes negative). Same FULL-refresh lifecycle: rows vanish when the
// batch posts and the invoice flows through the normal APOBL sync instead.
// Payment-capture recency — records the newest vendor-payment activity in
// each capture stage (cashbook + AP) into creditor_sync_meta, so the page can
// state "payments captured up to DATE". Payments that exist only at the bank
// are invisible to every Sage table; this line is how the operator knows the
// figures can't include them yet (live case: capture 42 days behind).
async function syncCaptureMeta(pool) {
  const queryText = resolveSageQuery('creditor.payment_capture_meta');
  const result = await pool.request().query(queryText);
  const row = (result.recordset || [])[0] || {};
  db.prepare(`
    UPDATE creditor_sync_meta SET
      last_cb_payment_capture = ?,
      last_ap_payment_date    = ?
    WHERE id = 1
  `).run(intToDateStr(row.last_cb_capture_int), intToDateStr(row.last_ap_payment_int));
  return { last_cb: intToDateStr(row.last_cb_capture_int), last_ap: intToDateStr(row.last_ap_payment_int) };
}

async function syncUnpostedInvoices(pool) {
  const queryText = resolveSageQuery('creditor.ap_unposted_invoice');
  const result = await pool.request().query(queryText);
  const rows = result.recordset || [];

  const insert = db.prepare(`
    INSERT INTO creditor_ap_unposted_invoice (
      vendor_code, invoice_number, doc_type, invoice_date, due_date,
      amount, batch_number, batch_status, synced_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, now_local())
  `);

  let inserted = 0;
  const run = db.transaction(() => {
    db.prepare('DELETE FROM creditor_ap_unposted_invoice').run();
    for (const r of rows) {
      if (!r.vendor_code) continue;
      insert.run(
        r.vendor_code,
        r.invoice_number || null,
        Number(r.doc_type) || null,
        intToDateStr(r.invoice_date_int),
        intToDateStr(r.due_date_int),
        Number(r.amount) || 0,
        Number(r.batch_number) || null,
        Number(r.batch_status) || null,
      );
      inserted++;
    }
  });
  run();
  return { rows: rows.length, inserted };
}

async function syncPos(pool, fromInt, toInt) {
  // Two queries — header then lines. We upsert headers first, look up
  // their local ids, then upsert lines keyed by po_id.
  const hQuery = resolveSageQuery('creditor.po_header');
  const lQuery = resolveSageQuery('creditor.po_line');

  const [hRes, lRes] = await Promise.all([
    pool.request().input('from', sql.Int, fromInt).input('to', sql.Int, toInt).query(hQuery),
    pool.request().input('from', sql.Int, fromInt).input('to', sql.Int, toInt).query(lQuery),
  ]);
  const hRows = hRes.recordset || [];
  const lRows = lRes.recordset || [];

  const upsertHeader = db.prepare(`
    INSERT INTO creditor_po_header (
      source_table, po_number, vendor_code, vendor_name,
      po_date, expected_date, status, total_amount, synced_at
    )
    VALUES ('POPORH1', ?, ?, ?, ?, ?, ?, ?, now_local())
    ON CONFLICT(source_table, po_number) DO UPDATE SET
      vendor_code   = excluded.vendor_code,
      vendor_name   = excluded.vendor_name,
      po_date       = excluded.po_date,
      expected_date = excluded.expected_date,
      status        = excluded.status,
      total_amount  = excluded.total_amount,
      synced_at     = now_local()
  `);

  const getHeaderId = db.prepare(
    "SELECT id FROM creditor_po_header WHERE source_table = 'POPORH1' AND po_number = ?"
  );

  const upsertLine = db.prepare(`
    INSERT INTO creditor_po_line (
      po_id, line_no, item_number, item_description,
      qty_ordered, qty_received, unit_cost, extended_cost
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(po_id, line_no) DO UPDATE SET
      item_number      = excluded.item_number,
      item_description = excluded.item_description,
      qty_ordered      = excluded.qty_ordered,
      qty_received     = excluded.qty_received,
      unit_cost        = excluded.unit_cost,
      extended_cost    = excluded.extended_cost
  `);

  let headersUpserted = 0;
  let linesUpserted = 0;
  let headersRemoved = 0;
  let linesRemoved = 0;
  const run = db.transaction(() => {
    // Stamp captured BEFORE upserting. Touched headers get synced_at >= it;
    // in-window headers left untouched (PO deleted in Sage) keep an older
    // synced_at and are reconciled away below. Both queries already succeeded
    // (a failure throws before this), so the synced set is authoritative for
    // the window. Same pattern as stockReceipts' phantom-line reconcile.
    const syncStamp = db.prepare('SELECT now_local() AS t').get().t;
    const fromStr = intToDateStr(fromInt);
    const toStr = intToDateStr(toInt);

    // Lines returned this run, grouped by PO, to prune lines removed from a
    // PO that otherwise survived.
    const lineNosByPo = new Map();
    for (const r of lRows) {
      if (!r.po_number) continue;
      if (!lineNosByPo.has(r.po_number)) lineNosByPo.set(r.po_number, new Set());
      lineNosByPo.get(r.po_number).add(r.line_no ?? 0);
    }

    for (const r of hRows) {
      if (!r.po_number) continue;
      upsertHeader.run(
        r.po_number,
        r.vendor_code || null,
        r.vendor_name || null,
        intToDateStr(r.po_date_int),
        intToDateStr(r.expected_date_int),
        r.status || null,
        Number(r.total_amount) || 0,
      );
      headersUpserted++;
    }
    for (const r of lRows) {
      if (!r.po_number) continue;
      const header = getHeaderId.get(r.po_number);
      if (!header) continue; // line for an out-of-window PO header — skip
      upsertLine.run(
        header.id,
        r.line_no ?? 0,
        r.item_number || null,
        r.item_description || null,
        Number(r.qty_ordered) || 0,
        Number(r.qty_received) || 0,
        Number(r.unit_cost) || 0,
        Number(r.extended_cost) || 0,
      );
      linesUpserted++;
    }

    // 1. Drop in-window PO headers that vanished from Sage — their lines
    //    first, since PRAGMA foreign_keys is off and won't cascade.
    const staleHeaderIds = db.prepare(
      "SELECT id FROM creditor_po_header WHERE source_table = 'POPORH1' AND po_date >= ? AND po_date <= ? AND (synced_at IS NULL OR synced_at < ?)"
    ).all(fromStr, toStr, syncStamp).map((h) => h.id);
    if (staleHeaderIds.length) {
      const ph = staleHeaderIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM creditor_po_line WHERE po_id IN (${ph})`).run(...staleHeaderIds);
      headersRemoved += db.prepare(`DELETE FROM creditor_po_header WHERE id IN (${ph})`).run(...staleHeaderIds).changes;
    }

    // 2. Prune lines removed from a PO that survived (its line dropped out of
    //    lRows). An empty keep-set means every line was deleted in Sage.
    for (const r of hRows) {
      if (!r.po_number) continue;
      const header = getHeaderId.get(r.po_number);
      if (!header) continue;
      const keep = lineNosByPo.get(r.po_number);
      if (keep && keep.size) {
        const ph = [...keep].map(() => '?').join(',');
        linesRemoved += db.prepare(`DELETE FROM creditor_po_line WHERE po_id = ? AND line_no NOT IN (${ph})`).run(header.id, ...keep).changes;
      } else {
        linesRemoved += db.prepare('DELETE FROM creditor_po_line WHERE po_id = ?').run(header.id).changes;
      }
    }
  });
  run();
  if (headersRemoved || linesRemoved) {
    console.log(`[creditor-sync] reconciled POs: ${headersRemoved} header(s) and ${linesRemoved} line(s) removed from Sage`);
  }
  return { headerRows: hRows.length, lineRows: lRows.length, headersUpserted, linesUpserted, headersRemoved, linesRemoved };
}

// Update each vendor's last_receipt_date and last_payment_date from the
// just-synced data. Cheap aggregate, runs at the end so the summary page
// has fresh activity timestamps without a join on every render.
function refreshVendorActivity() {
  db.transaction(() => {
    db.prepare(`
      UPDATE creditor SET last_payment_date = (
        SELECT MAX(payment_date) FROM creditor_ap_payment
        WHERE creditor_ap_payment.vendor_code = creditor.vendor_code
      )
    `).run();
    db.prepare(`
      UPDATE creditor SET last_receipt_date = (
        SELECT MAX(receipt_date) FROM stock_receipt
        WHERE TRIM(stock_receipt.supplier_code) = TRIM(creditor.vendor_code)
      )
    `).run();
  })();
}

// Top-level orchestrator. Pulls every source in sequence, captures
// per-source errors so a Sage permission gap on one table doesn't take
// down the rest of the sync. Returns a summary the route + UI can show.
export async function syncCreditorsFromSage({ fromDate, toDate } = {}) {
  logError('creditorSync.run', new Error('creditorSync.run starting'), { fromDate, toDate }, 'info');

  const settings = getSyncSettings();
  const historyMonths = Number(settings.history_months) || 24;
  const now = new Date();
  const to = toDate || now;
  const from = fromDate || new Date(now.getFullYear(), now.getMonth() - historyMonths, 1);
  const fromInt = toYyyymmddInt(from);
  const toInt = toYyyymmddInt(to);

  const pool = await getSagePool();
  const summary = { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), sources: {} };

  for (const [source, fn] of [
    ['vendors',           () => syncVendors(pool)],
    ['ap_invoices',       () => syncApInvoices(pool)],
    ['ap_payments',       () => syncApPayments(pool, fromInt, toInt)],
    ['unposted_payments', () => syncUnpostedPayments(pool)],
    ['unposted_invoices', () => syncUnpostedInvoices(pool)],
    ['capture_meta',      () => syncCaptureMeta(pool)],
    ['pos',               () => syncPos(pool, fromInt, toInt)],
  ]) {
    try {
      summary.sources[source] = await fn();
    } catch (err) {
      logError(`creditorSync.${source}`, err);
      summary.sources[source] = { error: err.message };
    }
  }

  try {
    refreshVendorActivity();
  } catch (err) {
    logError('creditorSync.refresh_activity', err);
  }

  try {
    const totalRows = Object.values(summary.sources)
      .reduce((acc, s) => acc + (Number(s.rows) || 0) + (Number(s.headerRows) || 0) + (Number(s.lineRows) || 0), 0);
    db.prepare(`
      UPDATE creditor_sync_meta SET
        last_synced_at = now_local(),
        last_synced_to = ?,
        rows_synced    = ?
      WHERE id = 1
    `).run(summary.to, totalRows);
  } catch (err) {
    logError('creditorSync.update_meta', err, {}, 'warn');
  }

  logError('creditorSync.run', new Error('creditorSync.run completed'), summary, 'info');
  return summary;
}
