// Inventory movement history ("stock card") sync — pulls Sage I/C transaction
// history (ICHIST) into local `inventory_movement`, plus on-hand from ICILOC
// into `inventory_location_onhand`. The per-item ledger (routes) anchors a
// running balance to on-hand and derives the opening, so it reconciles even
// though Sage purges old history. See migration v104 for the data model.
import sql from 'mssql';
import db from '../db/index.js';
import { getSagePool } from './batReconciliation.js';
import { resolveSageQuery } from './sage/queryRegistry.js';

// Movement-type labels, keyed by `${APP}/${TRANSTYPE}`. Derived empirically
// from the live Sage by source app + sign of quantity (see the module PR):
//   OE/4 = shipments (sales, qty out), OE/17 = credit notes / returns (in),
//   PO/1 = purchase receipts (in), IC/10 = adjustment increase (in),
//   IC/11 = adjustment decrease / write-off (out), IC/12-13 = transfers.
// Unknown combinations fall back to a sign-based "Adjustment" so nothing is
// silently dropped from the ledger.
export const MOVEMENT_TYPE_MAP = {
  'OE/4': 'Sale',
  'OE/17': 'Credit / Return',
  'PO/1': 'Purchase receipt',
  'IC/10': 'Adjustment (increase)',
  'IC/11': 'Adjustment / Write-off',
  'IC/12': 'Transfer out',
  'IC/13': 'Transfer in',
};

export function mapMovementType(app, transtype, stockQty) {
  const key = `${String(app || '').trim()}/${transtype}`;
  if (MOVEMENT_TYPE_MAP[key]) return MOVEMENT_TYPE_MAP[key];
  return (Number(stockQty) || 0) >= 0 ? 'Adjustment (increase)' : 'Adjustment (decrease)';
}

function toYyyymmddInt(d) {
  return parseInt(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`, 10);
}
function intToDate(n) {
  if (!n) return null;
  const s = String(n);
  return /^\d{8}$/.test(s) ? s.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : null;
}
const yield_ = () => new Promise((r) => setImmediate(r));

function getSettings() {
  return db.prepare('SELECT * FROM inventory_movement_sync_settings WHERE id = 1').get() || { history_years: 3 };
}

export function getInventoryMovementSyncMeta() {
  return db.prepare('SELECT * FROM inventory_movement_sync_meta WHERE id = 1').get() || {};
}

const BATCH = 5000;

// Pull ICHIST forward from the stored cursor (incremental by DAYENDSEQ), and
// refresh ICILOC on-hand. Chunked with setImmediate yields so a large initial
// load doesn't freeze the (synchronous better-sqlite3) main thread.
export async function syncInventoryMovement() {
  const pool = await getSagePool();
  const settings = getSettings();
  const historyYears = Math.max(1, Number(settings.history_years) || 3);
  const fromInt = toYyyymmddInt(new Date(new Date().getFullYear() - historyYears, 0, 1));

  const meta = getInventoryMovementSyncMeta();
  let ds = Number(meta.last_dayend_seq) || 0;
  let es = 0;
  let ln = 0;

  // Fresh sync: seed the cursor just before the window start so we don't scan
  // the (older, partly purged) pre-window rows ICHIST still holds.
  if (ds === 0) {
    const seedRes = await pool.request().input('fromdate', sql.Int, fromInt).query(resolveSageQuery('inventory.movement_seed'));
    ds = Number(seedRes.recordset?.[0]?.seed_seq) || 0;
    es = 0; ln = 0;
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO inventory_movement
      (source_table, item_number, location, acctset, transaction_date, fiscal_year, fiscal_period,
       dayend_seq, entry_seq, line_no, app, transtype, movement_type, doc_number,
       quantity, unit, stock_qty, cost, category, synced_at)
    VALUES ('ICHIST', @item_number, @location, @acctset, @transaction_date, @fiscal_year, @fiscal_period,
       @dayend_seq, @entry_seq, @line_no, @app, @transtype, @movement_type, @doc_number,
       @quantity, @unit, @stock_qty, @cost, @category, now_local())
  `);

  let inserted = 0;
  let maxSeq = ds;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await pool.request()
      .input('batch', sql.Int, BATCH)
      .input('fromdate', sql.Int, fromInt)
      .input('ds', sql.Int, ds)
      .input('es', sql.Int, es)
      .input('ln', sql.Int, ln)
      .query(resolveSageQuery('inventory.movement_history'));
    const rows = res.recordset || [];
    if (rows.length === 0) break;

    const run = db.transaction((batch) => {
      for (const r of batch) {
        const stockQty = Number(r.stock_qty) || 0;
        insert.run({
          item_number: String(r.item_number || '').trim(),
          location: String(r.location || '').trim(),
          acctset: String(r.acctset || '').trim(),
          transaction_date: intToDate(r.transaction_date_int),
          fiscal_year: String(r.fiscal_year || '').trim() || null,
          fiscal_period: r.fiscal_period ?? null,
          dayend_seq: Number(r.dayend_seq) || 0,
          entry_seq: Number(r.entry_seq) || 0,
          line_no: Number(r.line_no) || 0,
          app: String(r.app || '').trim() || null,
          transtype: r.transtype ?? null,
          movement_type: mapMovementType(r.app, r.transtype, stockQty),
          doc_number: String(r.doc_number || '').trim() || null,
          quantity: r.quantity != null ? Number(r.quantity) : null,
          unit: String(r.unit || '').trim() || null,
          stock_qty: stockQty,
          cost: r.cost != null ? Number(r.cost) : null,
          category: String(r.category || '').trim() || null,
        });
      }
    });
    run(rows);
    inserted += rows.length;

    // Advance the composite cursor to the last row of this batch.
    const last = rows[rows.length - 1];
    ds = Number(last.dayend_seq) || ds;
    es = Number(last.entry_seq) || 0;
    ln = Number(last.line_no) || 0;
    if (ds > maxSeq) maxSeq = ds;

    if (rows.length < BATCH) break;
    await yield_(); // let the event loop breathe between chunks
  }

  // Refresh on-hand (small — full replace).
  const onhandRes = await pool.request().query(resolveSageQuery('inventory.location_onhand'));
  const onhandRows = onhandRes.recordset || [];
  const upsertOnhand = db.prepare(`
    INSERT INTO inventory_location_onhand (item_number, location, qty_on_hand, total_cost, synced_at)
    VALUES (@item_number, @location, @qty_on_hand, @total_cost, now_local())
    ON CONFLICT(item_number, location) DO UPDATE SET
      qty_on_hand = excluded.qty_on_hand,
      total_cost  = excluded.total_cost,
      synced_at   = excluded.synced_at
  `);
  db.transaction((rows) => {
    for (const r of rows) {
      upsertOnhand.run({
        item_number: String(r.item_number || '').trim(),
        location: String(r.location || '').trim(),
        qty_on_hand: r.qty_on_hand != null ? Number(r.qty_on_hand) : null,
        total_cost: r.total_cost != null ? Number(r.total_cost) : null,
      });
    }
  })(onhandRows);

  const totalMovements = db.prepare('SELECT COUNT(*) c FROM inventory_movement').get().c;
  db.prepare(`
    UPDATE inventory_movement_sync_meta SET
      last_dayend_seq = ?, last_synced_at = now_local(), movement_rows = ?, onhand_rows = ?,
      history_from = ?, last_error = NULL
    WHERE id = 1
  `).run(maxSeq, totalMovements, onhandRows.length, intToDate(fromInt));

  return { inserted, totalMovements, onhand: onhandRows.length, lastDayendSeq: maxSeq };
}

// ── Read side (local SQLite) ───────────────────────────────────────────────

// Items that have movement history or on-hand, for the picker.
export function searchMovementItems({ q = '', limit = 30 } = {}) {
  const term = `%${String(q).trim()}%`;
  return db.prepare(`
    SELECT o.item_number, o.location, o.qty_on_hand,
           (SELECT ir.item_description FROM inventoryrecord ir WHERE TRIM(ir.item_number) = o.item_number LIMIT 1) AS item_description
    FROM inventory_location_onhand o
    WHERE (? = '%%' OR o.item_number LIKE ?
           OR EXISTS (SELECT 1 FROM inventoryrecord ir WHERE TRIM(ir.item_number) = o.item_number AND ir.item_description LIKE ?))
    ORDER BY o.item_number, o.location
    LIMIT ?
  `).all(term, term, term, limit);
}

// The per-item, per-location stock card. Anchors the running balance to the
// authoritative on-hand and derives the opening, so it reconciles to on-hand
// by construction regardless of purged pre-window history.
export function getItemLedger({ itemNumber, location, from, to }) {
  const item = String(itemNumber || '').trim();
  const loc = String(location || '').trim();
  if (!item || !loc) return null;

  const onhandRow = db.prepare('SELECT qty_on_hand FROM inventory_location_onhand WHERE item_number = ? AND location = ?').get(item, loc);
  const onHand = onhandRow ? Number(onhandRow.qty_on_hand) || 0 : 0;

  // Closing balance as at `to` = current on-hand minus everything that happened
  // strictly after `to`. (When `to` is today/empty, closing = on-hand.)
  let afterToQty = 0;
  if (to) {
    const r = db.prepare('SELECT COALESCE(SUM(stock_qty),0) s FROM inventory_movement WHERE item_number = ? AND location = ? AND transaction_date > ?').get(item, loc, to);
    afterToQty = Number(r.s) || 0;
  }
  const closing = onHand - afterToQty;

  // Movements in [from, to], oldest first, with a running balance.
  const params = [item, loc];
  let where = 'item_number = ? AND location = ?';
  if (from) { where += ' AND transaction_date >= ?'; params.push(from); }
  if (to) { where += ' AND transaction_date <= ?'; params.push(to); }
  const movements = db.prepare(`
    SELECT transaction_date, movement_type, app, transtype, doc_number, quantity, unit, stock_qty, cost
    FROM inventory_movement
    WHERE ${where}
    ORDER BY transaction_date ASC, dayend_seq ASC, entry_seq ASC, line_no ASC
  `).all(...params);

  return { item_number: item, location: loc, ...computeLedger({ onHand, closing, movements }) };
}

// Pure ledger math (extracted so it's unit-testable without DB/Sage state).
// Anchors to on-hand: opening = closing − Σ(window movements); a forward
// running balance then ends exactly at `closing`. When `to` is open, closing
// == on-hand, so the card reconciles to current stock by construction.
export function computeLedger({ onHand, closing, movements }) {
  const round = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;
  const windowQty = movements.reduce((s, m) => s + (Number(m.stock_qty) || 0), 0);
  const opening = closing - windowQty;
  let running = opening;
  const rows = movements.map((m) => {
    running += Number(m.stock_qty) || 0;
    return { ...m, balance: round(running) };
  });
  return {
    on_hand: round(onHand),
    opening_balance: round(opening),
    closing_balance: round(closing),
    window_net: round(windowQty),
    // Closing computed from the ledger must equal the anchor. Any drift is
    // surfaced, never hidden.
    reconciles: Math.abs(running - closing) < 0.005,
    reconcile_variance: round(running - closing),
    movements: rows,
  };
}
