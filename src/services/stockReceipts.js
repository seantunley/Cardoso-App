import sql from 'mssql';
import db from '../db/index.js';
import { getSagePool } from './batReconciliation.js';
import { logAudit } from '../lib/audit.js';

// Default SQL for Sage 300 PO Receipt of Goods. Operators can override
// this via the stock_receipt_settings table (same pattern as the JTI
// SQL override). The query must return columns aliased exactly as shown
// — the sync logic maps by name.
export const DEFAULT_RECEIPT_SQL = `
  SELECT
    LTRIM(RTRIM(h.RCPNUMBER))  AS receipt_number,
    LTRIM(RTRIM(h.VDCODE))     AS supplier_code,
    LTRIM(RTRIM(h.VDNAME))     AS supplier_name,
    h.DTRCPDATE                AS receipt_date_int,
    d.RCPLINE                  AS line_no,
    LTRIM(RTRIM(d.ITEMNO))     AS item_number,
    LTRIM(RTRIM(d.ITEMDESC))   AS item_description,
    d.RQRECEIVED               AS qty_received,
    LTRIM(RTRIM(d.RCPUNIT))    AS uom,
    d.RCPCOST                  AS unit_cost
  FROM POPORH1 h
  INNER JOIN POPORL d ON d.RCPNUMBER = h.RCPNUMBER
  WHERE h.DTRCPDATE BETWEEN @from AND @to
  ORDER BY h.DTRCPDATE DESC, h.RCPNUMBER, d.RCPLINE
`;

function toYyyymmdd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export { normaliseIsoDate } from '../lib/normaliseIsoDate.js';

function intToDateStr(n) {
  if (!n) return null;
  const s = String(n);
  return /^\d{8}$/.test(s) ? s.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : null;
}

export function getReceiptSqlOverride() {
  try {
    const row = db.prepare("SELECT value FROM hub_settings WHERE key = 'stock_receipt_sql_override'").get();
    return row?.value || null;
  } catch (err) {
    console.error('[stock-receipts] Failed to read SQL override:', err.message);
    return null;
  }
}

export function setReceiptSqlOverride(sqlText) {
  db.prepare(`
    INSERT INTO hub_settings (key, value) VALUES ('stock_receipt_sql_override', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(sqlText || '');
}

export async function syncReceiptsFromSage({ fromDate, toDate } = {}) {
  const pool = await getSagePool();
  const now = new Date();
  const to = toDate || now;
  const from = fromDate || new Date(now.getFullYear(), now.getMonth() - 6, 1);

  const fromInt = parseInt(toYyyymmdd(from), 10);
  const toInt = parseInt(toYyyymmdd(to), 10);

  const override = getReceiptSqlOverride();
  const queryText = (override && override.trim()) || DEFAULT_RECEIPT_SQL;

  const result = await pool.request()
    .input('from', sql.Int, fromInt)
    .input('to', sql.Int, toInt)
    .query(queryText);

  const rows = result.recordset || [];

  const upsertReceipt = db.prepare(`
    INSERT INTO stock_receipt (source_table, receipt_number, supplier_code, supplier_name, receipt_date, updated_date)
    VALUES ('POPORH1', ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(site_id, source_table, receipt_number) DO UPDATE SET
      supplier_code = excluded.supplier_code,
      supplier_name = excluded.supplier_name,
      receipt_date = excluded.receipt_date,
      updated_date = datetime('now')
  `);

  const upsertLine = db.prepare(`
    INSERT INTO stock_receipt_line (receipt_id, line_no, item_number, item_description, qty_received, uom, unit_cost, updated_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(receipt_id, line_no, item_number) DO UPDATE SET
      item_description = excluded.item_description,
      qty_received = excluded.qty_received,
      uom = excluded.uom,
      unit_cost = excluded.unit_cost,
      updated_date = datetime('now')
  `);

  const getReceiptId = db.prepare(
    "SELECT id FROM stock_receipt WHERE site_id = '' AND source_table = 'POPORH1' AND receipt_number = ?"
  );

  const seenReceipts = new Set();
  let linesUpserted = 0;

  const insertAll = db.transaction(() => {
    for (const r of rows) {
      const receiptDate = intToDateStr(r.receipt_date_int);
      upsertReceipt.run(
        r.receipt_number,
        r.supplier_code || null,
        r.supplier_name || null,
        receiptDate,
      );
      const receipt = getReceiptId.get(r.receipt_number);
      if (!receipt) {
        console.error(`[stock-receipts] Receipt ${r.receipt_number} upserted but lookup returned null — line skipped`);
        continue;
      }
      seenReceipts.add(r.receipt_number);
      upsertLine.run(
        receipt.id,
        r.line_no ?? 0,
        r.item_number,
        r.item_description || null,
        r.qty_received != null ? String(r.qty_received) : null,
        r.uom || null,
        r.unit_cost != null ? String(r.unit_cost) : null,
      );
      linesUpserted++;
    }
  });
  insertAll();

  try {
    db.prepare(`
      INSERT INTO hub_settings (key, value) VALUES ('stock_receipt_last_synced', datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = datetime('now')
    `).run();
  } catch (err) {
    console.error('[stock-receipts] Failed to update sync timestamp:', err.message);
  }

  return { rows: rows.length, receiptsUpserted: seenReceipts.size, linesUpserted };
}

export function getSyncMeta() {
  try {
    const row = db.prepare("SELECT value FROM hub_settings WHERE key = 'stock_receipt_last_synced'").get();
    return { last_synced_at: row?.value || null };
  } catch (err) {
    console.error('[stock-receipts] Failed to read sync meta:', err.message);
    return { last_synced_at: null };
  }
}

export function listReceiptLines({ search, missingExpiry, limit = 200 }) {
  const where = [];
  const params = [];
  if (search) {
    where.push('(sr.receipt_number LIKE ? OR srl.item_number LIKE ? OR srl.item_description LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (missingExpiry) {
    where.push('COALESCE(e.expiry_count, 0) = 0');
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const safeLimit = Math.max(1, Math.min(limit, 1000));
  params.push(safeLimit);

  return db.prepare(`
    SELECT
      sr.id AS receipt_id, sr.receipt_number, sr.supplier_name, sr.receipt_date,
      srl.id AS receipt_line_id, srl.line_no, srl.item_number, srl.item_description,
      srl.qty_received, srl.uom, srl.unit_cost,
      COALESCE(e.expiry_count, 0) AS expiry_count
    FROM stock_receipt_line srl
    JOIN stock_receipt sr ON sr.id = srl.receipt_id
    LEFT JOIN (
      SELECT receipt_line_id, COUNT(*) AS expiry_count
      FROM stock_receipt_line_expiry
      GROUP BY receipt_line_id
    ) e ON e.receipt_line_id = srl.id
    ${whereSql}
    ORDER BY sr.receipt_date DESC, sr.id DESC, srl.line_no ASC
    LIMIT ?
  `).all(...params);
}

export function getLineWithExpiries(receiptLineId) {
  const line = db.prepare(`
    SELECT srl.*, sr.receipt_number, sr.receipt_date, sr.supplier_name
    FROM stock_receipt_line srl
    JOIN stock_receipt sr ON sr.id = srl.receipt_id
    WHERE srl.id = ?
  `).get(receiptLineId);
  if (!line) return null;

  const expiries = db.prepare(`
    SELECT id, receipt_line_id, expiry_date, qty_at_expiry, entered_by, entry_source, notes, created_date
    FROM stock_receipt_line_expiry
    WHERE receipt_line_id = ?
    ORDER BY expiry_date ASC, id ASC
  `).all(receiptLineId);

  return { line, expiries };
}

export function addExpiry({ receiptLineId, expiryDate, qtyAtExpiry, notes, enteredBy, req }) {
  const line = db.prepare('SELECT id FROM stock_receipt_line WHERE id = ?').get(receiptLineId);
  if (!line) throw new Error('Receipt line not found');

  const result = db.prepare(`
    INSERT INTO stock_receipt_line_expiry (receipt_line_id, expiry_date, qty_at_expiry, entered_by, entry_source, notes)
    VALUES (?, ?, ?, ?, 'manual', ?)
  `).run(receiptLineId, expiryDate, qtyAtExpiry || null, enteredBy, notes || null);

  const created = db.prepare('SELECT * FROM stock_receipt_line_expiry WHERE id = ?').get(result.lastInsertRowid);

  logAudit({
    req,
    action: 'stock_receipt_add_expiry',
    resourceType: 'system',
    resourceId: `receipt_line:${receiptLineId}`,
    resourceName: `Expiry ${expiryDate} on line ${receiptLineId}`,
    details: `Qty: ${qtyAtExpiry || '—'}`,
    changes: { after: { expiry_date: expiryDate, qty_at_expiry: qtyAtExpiry, notes } },
  });

  return created;
}
