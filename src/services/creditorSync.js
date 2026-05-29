import sql from 'mssql';
import db from '../db/index.js';
import { getSagePool } from './batReconciliation.js';
import { logError } from '../lib/errorLog.js';

// Sage 300 default SQL for each source. Operators can override any of
// these via creditor_sync_settings (the Settings page surfaces a textarea
// per source) — same pattern as stockReceipts and JTI. Column aliases
// must match exactly because the upsert maps by name.

// Column names below were verified directly against Sage 300 schema
// via INFORMATION_SCHEMA.COLUMNS — not guessed. Operator can still
// override any source through creditor_sync_settings if their Sage
// install has been customised.

export const DEFAULT_VENDOR_SQL = `
  SELECT
    LTRIM(RTRIM(VENDORID))  AS vendor_code,
    LTRIM(RTRIM(VENDNAME))  AS vendor_name,
    LTRIM(RTRIM(TERMSCODE)) AS terms,
    LTRIM(RTRIM(NAMECTAC))  AS contact,
    LTRIM(RTRIM(TEXTPHON1)) AS phone,
    LTRIM(RTRIM(EMAIL1))    AS email,
    CASE WHEN SWACTV = 1 THEN 1 ELSE 0 END AS is_active
  FROM APVEN
`;

export const DEFAULT_AP_INVOICE_SQL = `
  SELECT
    LTRIM(RTRIM(IDVEND))    AS vendor_code,
    LTRIM(RTRIM(IDINVC))    AS document_number,
    CAST(IDTRXTYPE AS varchar(10)) AS document_type,
    DATEINVC                AS document_date_int,
    DATEINVCDU              AS due_date_int,
    AMTINVCHC               AS original_amount,
    AMTDUEHC                AS outstanding_amount,
    LTRIM(RTRIM(IDPONBR))   AS reference
  FROM APOBL
  WHERE AMTDUEHC <> 0
`;

// CNTPAYMENT is the count of invoice allocations applied to this cheque
// (always >= 1 for a real payment row, NOT a "is-this-the-header" flag).
// AMTRMITHC > 0 is enough to keep cheques (and exclude reversals).
export const DEFAULT_AP_PAYMENT_SQL = `
  SELECT
    LTRIM(RTRIM(IDVEND))     AS vendor_code,
    LTRIM(RTRIM(IDRMIT))     AS payment_number,
    DATERMIT                 AS payment_date_int,
    LTRIM(RTRIM(PAYMCODE))   AS payment_method,
    AMTRMITHC                AS amount,
    LTRIM(RTRIM(TXTRMITREF)) AS reference,
    LTRIM(RTRIM(IDBANK))     AS bank_code
  FROM APTCR
  WHERE DATERMIT BETWEEN @from AND @to AND AMTRMITHC > 0
`;

// POPORH1 has no STATUS column — derive an operator-friendly label from
// ISCOMPLETE + ONHOLD. EXPARRIVAL is the expected arrival date.
// DOCTOTAL is the PO grand total.
export const DEFAULT_PO_HEADER_SQL = `
  SELECT
    LTRIM(RTRIM(PONUMBER))  AS po_number,
    LTRIM(RTRIM(VDCODE))    AS vendor_code,
    LTRIM(RTRIM(VDNAME))    AS vendor_name,
    DATE                    AS po_date_int,
    EXPARRIVAL              AS expected_date_int,
    CASE
      WHEN ISCOMPLETE = 1 THEN 'COMPLETE'
      WHEN ONHOLD     = 1 THEN 'ON HOLD'
      ELSE 'OPEN'
    END                     AS status,
    DOCTOTAL                AS total_amount
  FROM POPORH1
  WHERE DATE BETWEEN @from AND @to
`;

export const DEFAULT_PO_LINE_SQL = `
  SELECT
    LTRIM(RTRIM(h.PONUMBER))  AS po_number,
    l.PORLSEQ                 AS line_no,
    LTRIM(RTRIM(l.ITEMNO))    AS item_number,
    LTRIM(RTRIM(l.ITEMDESC))  AS item_description,
    l.OQORDERED               AS qty_ordered,
    l.OQRECEIVED              AS qty_received,
    l.UNITCOST                AS unit_cost,
    l.EXTENDED                AS extended_cost
  FROM POPORH1 h
  INNER JOIN POPORL l ON l.PORHSEQ = h.PORHSEQ
  WHERE h.DATE BETWEEN @from AND @to
`;

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
        po_header_sql_override   = COALESCE(?, po_header_sql_override),
        po_line_sql_override     = COALESCE(?, po_line_sql_override),
        history_months           = COALESCE(?, history_months)
      WHERE id = 1
    `).run(
      vendor_sql_override     ?? null,
      ap_invoice_sql_override ?? null,
      ap_payment_sql_override ?? null,
      po_header_sql_override  ?? null,
      po_line_sql_override    ?? null,
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
    return db.prepare('SELECT last_synced_at, last_synced_to, rows_synced FROM creditor_sync_meta WHERE id = 1').get() || {};
  } catch (err) {
    console.error('[creditor-sync] read meta failed:', err.message);
    return {};
  }
}

// One transactional source — runs one Sage query and upserts its results.
// Each source-runner returns { rows, upserted } so the orchestrator can
// report a per-source summary even when one source fails (caught
// separately so a permission error on APTCR doesn't wipe vendor sync).
async function syncVendors(pool, settings) {
  const queryText = (settings.vendor_sql_override?.trim()) || DEFAULT_VENDOR_SQL;
  const result = await pool.request().query(queryText);
  const rows = result.recordset || [];

  const upsert = db.prepare(`
    INSERT INTO creditor (source_table, vendor_code, vendor_name, terms, contact, phone, email, is_active, synced_at)
    VALUES ('APVEN', ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(source_table, vendor_code) DO UPDATE SET
      vendor_name = excluded.vendor_name,
      terms       = excluded.terms,
      contact     = excluded.contact,
      phone       = excluded.phone,
      email       = excluded.email,
      is_active   = excluded.is_active,
      synced_at   = datetime('now')
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

async function syncApInvoices(pool, settings) {
  const queryText = (settings.ap_invoice_sql_override?.trim()) || DEFAULT_AP_INVOICE_SQL;
  const result = await pool.request().query(queryText);
  const rows = result.recordset || [];

  const upsert = db.prepare(`
    INSERT INTO creditor_ap_invoice (
      source_table, vendor_code, document_number, document_type,
      document_date, due_date, original_amount, outstanding_amount, reference, synced_at
    )
    VALUES ('APOBL', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(source_table, vendor_code, document_number) DO UPDATE SET
      document_type      = excluded.document_type,
      document_date      = excluded.document_date,
      due_date           = excluded.due_date,
      original_amount    = excluded.original_amount,
      outstanding_amount = excluded.outstanding_amount,
      reference          = excluded.reference,
      synced_at          = datetime('now')
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

async function syncApPayments(pool, settings, fromInt, toInt) {
  const queryText = (settings.ap_payment_sql_override?.trim()) || DEFAULT_AP_PAYMENT_SQL;
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
    VALUES ('APTCR', ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(source_table, vendor_code, payment_number) DO UPDATE SET
      payment_date   = excluded.payment_date,
      payment_method = excluded.payment_method,
      amount         = excluded.amount,
      reference      = excluded.reference,
      bank_code      = excluded.bank_code,
      synced_at      = datetime('now')
  `);

  let upserted = 0;
  const run = db.transaction(() => {
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

async function syncPos(pool, settings, fromInt, toInt) {
  // Two queries — header then lines. We upsert headers first, look up
  // their local ids, then upsert lines keyed by po_id.
  const hQuery = (settings.po_header_sql_override?.trim()) || DEFAULT_PO_HEADER_SQL;
  const lQuery = (settings.po_line_sql_override?.trim()) || DEFAULT_PO_LINE_SQL;

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
    VALUES ('POPORH1', ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(source_table, po_number) DO UPDATE SET
      vendor_code   = excluded.vendor_code,
      vendor_name   = excluded.vendor_name,
      po_date       = excluded.po_date,
      expected_date = excluded.expected_date,
      status        = excluded.status,
      total_amount  = excluded.total_amount,
      synced_at     = datetime('now')
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
  const run = db.transaction(() => {
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
  });
  run();
  return { headerRows: hRows.length, lineRows: lRows.length, headersUpserted, linesUpserted };
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
    ['vendors',     () => syncVendors(pool, settings)],
    ['ap_invoices', () => syncApInvoices(pool, settings)],
    ['ap_payments', () => syncApPayments(pool, settings, fromInt, toInt)],
    ['pos',         () => syncPos(pool, settings, fromInt, toInt)],
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
        last_synced_at = datetime('now'),
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
