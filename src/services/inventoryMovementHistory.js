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
  return db.prepare('SELECT * FROM inventory_movement_sync_settings WHERE id = 1').get() || { history_days: 30 };
}

export function getInventoryMovementSyncMeta() {
  return db.prepare('SELECT * FROM inventory_movement_sync_meta WHERE id = 1').get() || {};
}

// Background sync state. The bulk sync runs detached (the route returns at once
// and the UI polls), so a multi-minute pull never holds an HTTP request open —
// which the proxy was timing out as a 502.
let syncState = { running: false, scope: null, started_at: null, inserted: 0, error: null };
export function getSyncState() { return { ...syncState }; }

const BATCH = 5000;

// Window start: `history_days` back (default 30). The bulk sync only carries
// the recent window; everything older than this is the "opening balance"
// rollup on the stock card. Deeper history is pulled on-demand per item
// (syncItemMovementHistory).
function windowFromInt() {
  const days = Math.max(1, Number(getSettings().history_days) || 30);
  const d = new Date();
  d.setDate(d.getDate() - days);
  return toYyyymmddInt(d);
}

// Lazy-prepared so importing this module never runs before migrations.
let _insert;
function insertStmt() {
  return (_insert ||= db.prepare(`
    INSERT OR IGNORE INTO inventory_movement
      (source_table, item_number, location, acctset, transaction_date, fiscal_year, fiscal_period,
       dayend_seq, entry_seq, line_no, app, transtype, movement_type, doc_number,
       quantity, unit, stock_qty, cost, category, synced_at)
    VALUES ('ICHIST', @item_number, @location, @acctset, @transaction_date, @fiscal_year, @fiscal_period,
       @dayend_seq, @entry_seq, @line_no, @app, @transtype, @movement_type, @doc_number,
       @quantity, @unit, @stock_qty, @cost, @category, now_local())
  `));
}

// Returns the number of rows ACTUALLY inserted — INSERT OR IGNORE drops
// duplicates (re-fetched cursor-boundary rows, bulk/per-item overlap), and
// counting fetched rows instead would inflate every "N new movements" figure.
function insertBatch(rows) {
  const stmt = insertStmt();
  let inserted = 0;
  db.transaction((batch) => {
    for (const r of batch) {
      const stockQty = Number(r.stock_qty) || 0;
      const info = stmt.run({
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
      inserted += info.changes;
    }
  })(rows);
  return inserted;
}

// Advance the paging cursor from a batch's last row, null-safely (`|| prev`
// would wedge the loop on a legitimate 0). Throws if a FULL batch failed to
// move the cursor — that means ≥BATCH rows share one (ds, es, ln) tuple and
// the inclusive >= predicate would refetch the same page forever; surfacing
// the stall beats spinning silently.
function advanceCursor(rows, cur) {
  const last = rows[rows.length - 1];
  const next = {
    ds: last.dayend_seq != null ? Number(last.dayend_seq) : cur.ds,
    es: last.entry_seq != null ? Number(last.entry_seq) : cur.es,
    ln: last.line_no != null ? Number(last.line_no) : cur.ln,
  };
  if (rows.length >= BATCH && next.ds === cur.ds && next.es === cur.es && next.ln === cur.ln) {
    throw new Error(
      `Movement sync stalled: a full batch of ${BATCH} ICHIST rows shares cursor (DAYENDSEQ ${cur.ds}, ENTRYSEQ ${cur.es}, LINENO ${cur.ln}). ` +
      `No rows were lost (everything fetched so far is saved), but the sync cannot page past this point — raise the batch size or investigate ICHIST.`,
    );
  }
  return next;
}

// Bulk sync: ICHIST forward from the stored cursor (incremental by DAYENDSEQ),
// only the recent `history_days` window, plus a full ICILOC on-hand refresh.
// Chunked with setImmediate yields + periodic progress persistence so a large
// load neither freezes the main thread nor loses progress on a restart.
export async function syncInventoryMovement() {
  if (syncState.running) return { skipped: true, running: true };
  syncState = { running: true, scope: 'bulk', started_at: new Date().toISOString(), inserted: 0, error: null };
  try {
    const pool = await getSagePool();
    const fromInt = windowFromInt();

    const meta = getInventoryMovementSyncMeta();
    let ds = Number(meta.last_dayend_seq) || 0;
    let es = 0;
    let ln = 0;
    if (ds === 0) {
      const seedRes = await pool.request().input('fromdate', sql.Int, fromInt).query(resolveSageQuery('inventory.movement_seed'));
      ds = Number(seedRes.recordset?.[0]?.seed_seq) || 0;
    }

    let inserted = 0;
    let maxSeq = ds;
    let sinceSave = 0;
    const persist = () => db.prepare(
      `UPDATE inventory_movement_sync_meta SET last_dayend_seq = ?, movement_rows = (SELECT COUNT(*) FROM inventory_movement) WHERE id = 1`
    ).run(maxSeq);

    while (true) {
      const res = await pool.request()
        .input('batch', sql.Int, BATCH)
        .input('fromdate', sql.Int, fromInt)
        .input('ds', sql.Int, ds).input('es', sql.Int, es).input('ln', sql.Int, ln)
        .query(resolveSageQuery('inventory.movement_history'));
      const rows = res.recordset || [];
      if (rows.length === 0) break;

      inserted += insertBatch(rows);
      syncState.inserted = inserted;

      ({ ds, es, ln } = advanceCursor(rows, { ds, es, ln }));
      if (ds > maxSeq) maxSeq = ds;

      if (++sinceSave >= 5) { persist(); sinceSave = 0; } // durable + pollable
      if (rows.length < BATCH) break;
      await yield_();
    }

    // Refresh on-hand: full REPLACE in one transaction, not an upsert. The
    // ICILOC query omits zero rows, so an item that sold out since the last
    // sync simply stops appearing — an upsert would leave its old quantity
    // behind and every ledger for it would anchor to a stale number forever.
    // A missing row now correctly means on-hand 0.
    const onhandRes = await pool.request().query(resolveSageQuery('inventory.location_onhand'));
    const onhandRows = onhandRes.recordset || [];
    const insertOnhand = db.prepare(`
      INSERT INTO inventory_location_onhand (item_number, location, qty_on_hand, total_cost, synced_at)
      VALUES (@item_number, @location, @qty_on_hand, @total_cost, now_local())
      ON CONFLICT(item_number, location) DO UPDATE SET
        qty_on_hand = excluded.qty_on_hand, total_cost = excluded.total_cost, synced_at = excluded.synced_at
    `);
    db.transaction((rows) => {
      db.prepare('DELETE FROM inventory_location_onhand').run();
      for (const r of rows) {
        insertOnhand.run({
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
  } catch (e) {
    try { db.prepare('UPDATE inventory_movement_sync_meta SET last_error = ? WHERE id = 1').run(e.message); } catch { /* ignore */ }
    syncState.error = e.message;
    throw e;
  } finally {
    syncState.running = false;
  }
}

// On-demand deep history for ONE item/location — cheap (a single item is index-
// seeked) so it runs inline. Lets the operator pull a specific item back as far
// as Sage holds, beyond the recent bulk window.
export async function syncItemMovementHistory({ itemNumber, location }) {
  const item = String(itemNumber || '').trim();
  const loc = String(location || '').trim();
  if (!item || !loc) throw new Error('item and location are required');
  const pool = await getSagePool();
  let ds = 0, es = 0, ln = 0, inserted = 0;
  while (true) {
    const res = await pool.request()
      .input('batch', sql.Int, BATCH)
      .input('item', sql.VarChar, item)
      .input('location', sql.VarChar, loc)
      .input('fromdate', sql.Int, 19000101) // all available history for this item
      .input('ds', sql.Int, ds).input('es', sql.Int, es).input('ln', sql.Int, ln)
      .query(resolveSageQuery('inventory.movement_history_item'));
    const rows = res.recordset || [];
    if (rows.length === 0) break;
    inserted += insertBatch(rows);
    ({ ds, es, ln } = advanceCursor(rows, { ds, es, ln }));
    if (rows.length < BATCH) break;
    await yield_();
  }
  // Keep the total fresh for the meta display.
  try {
    const total = db.prepare('SELECT COUNT(*) c FROM inventory_movement').get().c;
    db.prepare('UPDATE inventory_movement_sync_meta SET movement_rows = ? WHERE id = 1').run(total);
  } catch { /* ignore */ }
  const earliest = db.prepare('SELECT MIN(transaction_date) d FROM inventory_movement WHERE item_number = ? AND location = ?').get(item, loc);
  return { inserted, item_number: item, location: loc, earliest: earliest?.d || null };
}

// ── Read side (local SQLite) ───────────────────────────────────────────────

// Items that have movement history or on-hand, for the picker. The UNION with
// inventory_movement keeps sold-out items findable: on-hand is a full replace
// of ICILOC's non-zero rows, so an item at 0 has no on-hand row but its
// history is still worth viewing (shown as on hand 0).
export function searchMovementItems({ q = '', limit = 30 } = {}) {
  const term = `%${String(q).trim()}%`;
  return db.prepare(`
    WITH items AS (
      SELECT item_number, location FROM inventory_location_onhand
      UNION
      SELECT DISTINCT item_number, location FROM inventory_movement
    )
    SELECT i.item_number, i.location, COALESCE(o.qty_on_hand, 0) AS qty_on_hand,
           (SELECT ir.item_description FROM inventoryrecord ir WHERE TRIM(ir.item_number) = i.item_number LIMIT 1) AS item_description
    FROM items i
    LEFT JOIN inventory_location_onhand o ON o.item_number = i.item_number AND o.location = i.location
    WHERE (? = '%%' OR i.item_number LIKE ?
           OR EXISTS (SELECT 1 FROM inventoryrecord ir WHERE TRIM(ir.item_number) = i.item_number AND ir.item_description LIKE ?))
    ORDER BY i.item_number, i.location
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
  // Unknown item/location → null so the route can 404, instead of fabricating
  // a plausible-looking ledger anchored to 0. A missing on-hand row alone is
  // NOT unknown — sold-out items have no row (on-hand full replace) but real
  // history.
  const hasHistory = db.prepare('SELECT 1 AS x FROM inventory_movement WHERE item_number = ? AND location = ? LIMIT 1').get(item, loc);
  if (!onhandRow && !hasHistory) return null;
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

  // History-coverage facts so the UI can warn when the requested window
  // reaches back past what's synced: the bulk sync only carries the recent
  // window (meta.history_from); anything older is only present after a
  // per-item deep sync (then item_earliest < history_from). Without the
  // warning, a "From" before coverage silently folds the missing movements
  // into the opening balance — a wrong number presented as a balance.
  const metaRow = getInventoryMovementSyncMeta();
  const earliestRow = db.prepare('SELECT MIN(transaction_date) d FROM inventory_movement WHERE item_number = ? AND location = ?').get(item, loc);

  return {
    item_number: item,
    location: loc,
    history_from: metaRow.history_from || null,
    item_earliest: earliestRow?.d || null,
    ...computeLedger({ onHand, closing, movements }),
  };
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
    // Internal-arithmetic check ONLY: opening is DERIVED from closing, so
    // running == closing holds by construction and this can only catch float
    // drift in the summation — it can NOT detect missing movements or a stale
    // on-hand anchor (those fold silently into the derived opening). The UI
    // labels this "anchored", not "verified", for that reason; coverage gaps
    // are surfaced separately via history_from/item_earliest.
    reconciles: Math.abs(running - closing) < 0.005,
    reconcile_variance: round(running - closing),
    movements: rows,
  };
}
