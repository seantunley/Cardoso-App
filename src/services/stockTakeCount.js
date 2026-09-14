// Stock take — counting sessions, zones, scans and variance.
//
// SAGE IS READ-ONLY. Nothing in here opens a Sage connection at all: the
// expected quantities come from `inventory_location_onhand`, which the
// Inventory Movement sync fills from Sage. A count produces a variance report
// and stops there. A person keys any correction in Sage, deliberately, because
// one mis-keyed adjustment is what put items 106, 110 and 4010 at Polokwane
// tens of thousands of rand out on cost.
import db from '../db/index.js';
import { normaliseBarcode, barcodeVariants } from './stockTake.js';

const OPEN = 'open';
const CLOSED = 'closed';
const SUBMITTED = 'submitted';

function nowLocal() {
  return db.prepare('SELECT now_local() AS t').get().t;
}

function placeholders(n) {
  return new Array(n).fill('?').join(', ');
}

// ── Sessions ────────────────────────────────────────────────────────────────

/**
 * Open a count.
 *
 * The expected quantities are snapshotted here, once. Measuring variance
 * against live on-hand would mean the target moves while people are still
 * walking the aisles — every sale during the count would read as a shortfall.
 *
 * @param {{ name: string, location: string, thresholdQty?: number, thresholdValue?: number, notes?: string, user: string }} args
 */
export function openSession({ name, location, thresholdQty, thresholdValue, notes, user }) {
  const label = String(name || '').trim();
  const loc = String(location || '').trim();
  if (!label) throw new Error('The count needs a name, so people can tell it apart from the last one.');
  if (!loc) throw new Error('The count needs a location. That is the Sage branch whose stock is being counted.');

  const clash = db.prepare("SELECT id, name FROM stocktake_session WHERE location = ? AND status = 'open'").get(loc);
  if (clash) {
    throw new Error(`There is already an open count at ${loc}: "${clash.name}" (#${clash.id}). Close that one before opening another, or two counts will fight over the same shelves.`);
  }

  const qty = Number.isFinite(Number(thresholdQty)) ? Number(thresholdQty) : 1;
  const value = Number.isFinite(Number(thresholdValue)) ? Number(thresholdValue) : 500;
  if (qty < 0 || value < 0) throw new Error('A recount threshold cannot be negative.');

  const create = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO stocktake_session (name, location, status, threshold_qty, threshold_value, opened_by, opened_date, notes)
      VALUES (?, ?, 'open', ?, ?, ?, now_local(), ?)
    `).run(label, loc, qty, value, String(user || 'unknown'), String(notes || '').trim() || null);
    const sessionId = Number(info.lastInsertRowid);
    const copied = db.prepare(`
      INSERT INTO stocktake_session_snapshot (session_id, item_number, qty_on_hand, total_cost)
      SELECT ?, item_number, qty_on_hand, total_cost
      FROM inventory_location_onhand
      WHERE location = ?
    `).run(sessionId, loc);
    return { sessionId, snapshotRows: copied.changes };
  });

  const { sessionId, snapshotRows } = create();
  return { ...getSession(sessionId), snapshot_rows: snapshotRows };
}

export function getSession(id) {
  return db.prepare('SELECT * FROM stocktake_session WHERE id = ?').get(id) || null;
}

/** Counts, newest first. Counters use this to find the one they are on. */
export function listSessions({ status = '', location = '', limit = 50 } = {}) {
  const params = [];
  let where = 'WHERE 1=1';
  if (status) { where += ' AND s.status = ?'; params.push(status); }
  if (location) { where += ' AND s.location = ?'; params.push(location); }
  params.push(Math.max(1, Math.min(Number(limit) || 50, 500)));
  return db.prepare(`
    SELECT s.*,
           (SELECT COUNT(*) FROM stocktake_zone z WHERE z.session_id = s.id) AS zones,
           (SELECT COUNT(*) FROM stocktake_zone z WHERE z.session_id = s.id AND z.status = 'submitted') AS zones_submitted,
           (SELECT COUNT(*) FROM stocktake_scan c WHERE c.session_id = s.id AND c.voided = 0) AS scans
    FROM stocktake_session s
    ${where}
    ORDER BY s.id DESC
    LIMIT ?
  `).all(...params);
}

/**
 * Close a count. Supervisor only — enforced by the route's permission guard.
 *
 * Outstanding recounts do not silently pass: the caller must say it means to
 * close anyway, and what was outstanding is written into the session notes so
 * the report is honest about it later.
 *
 * @param {{ id: number, user: string, force?: boolean }} args
 */
export function closeSession({ id, user, force = false }) {
  const session = getSession(id);
  if (!session) throw new Error(`Count #${id} does not exist.`);
  if (session.status === CLOSED) throw new Error(`Count "${session.name}" was already closed by ${session.closed_by || 'someone'} on ${session.closed_date}.`);

  const openZones = db.prepare("SELECT COUNT(*) AS c FROM stocktake_zone WHERE session_id = ? AND status <> 'submitted'").get(id).c;
  const outstanding = varianceRows(id).filter((r) => r.recount_required && !r.recount_done).length;

  if ((openZones || outstanding) && !force) {
    const parts = [];
    if (openZones) parts.push(`${openZones} zone(s) have not been submitted`);
    if (outstanding) parts.push(`${outstanding} item(s) are over the recount threshold and have not been recounted`);
    const err = new Error(`This count is not finished: ${parts.join(', ')}. Confirm that you want to close it anyway — the report will record what was outstanding.`);
    /** @type {any} */ (err).code = 'COUNT_NOT_FINISHED';
    /** @type {any} */ (err).openZones = openZones;
    /** @type {any} */ (err).outstandingRecounts = outstanding;
    throw err;
  }

  const trail = (openZones || outstanding)
    ? `Closed with ${openZones} zone(s) not submitted and ${outstanding} item(s) awaiting recount.`
    : null;
  db.prepare(`
    UPDATE stocktake_session
    SET status = 'closed', closed_by = ?, closed_date = now_local(),
        notes = TRIM(COALESCE(notes, '') || CASE WHEN ? IS NULL THEN '' ELSE char(10) || ? END)
    WHERE id = ?
  `).run(String(user || 'unknown'), trail, trail, id);
  return { ...getSession(id), closed_with_open_zones: openZones, closed_with_outstanding_recounts: outstanding };
}

function requireOpenSession(sessionId) {
  const session = getSession(sessionId);
  if (!session) throw new Error(`Count #${sessionId} does not exist.`);
  if (session.status !== OPEN) throw new Error(`Count "${session.name}" is closed. Nothing more can be added to it.`);
  return session;
}

// ── Zones ───────────────────────────────────────────────────────────────────

/**
 * Claim an aisle or shelf. Free text, because no two branches lay out the same
 * and a fixed list would be wrong everywhere.
 *
 * One owner per zone: two people on the same rack is a double count, and a
 * double count looks exactly like a genuine surplus.
 *
 * @param {{ sessionId: number, name: string, user: string, assignTo?: string }} args
 */
export function createZone({ sessionId, name, user, assignTo }) {
  requireOpenSession(sessionId);
  const label = String(name || '').trim();
  if (!label) throw new Error('The zone needs a name — the aisle or shelf you are about to count, in your own words.');

  const existing = db.prepare('SELECT * FROM stocktake_zone WHERE session_id = ? AND LOWER(name) = LOWER(?)').get(sessionId, label);
  if (existing) {
    if (existing.assigned_to && existing.assigned_to !== (assignTo || user)) {
      throw new Error(`"${existing.name}" is already being counted by ${existing.assigned_to}. Pick a different aisle, or ask them to submit it first.`);
    }
    return existing;
  }
  const info = db.prepare(`
    INSERT INTO stocktake_zone (session_id, name, assigned_to, status, created_by, created_date)
    VALUES (?, ?, ?, 'open', ?, now_local())
  `).run(sessionId, label, String(assignTo || user || '').trim() || null, String(user || 'unknown'));
  return db.prepare('SELECT * FROM stocktake_zone WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function listZones(sessionId) {
  return db.prepare(`
    SELECT z.*,
           (SELECT COUNT(*) FROM stocktake_scan c WHERE c.zone_id = z.id AND c.voided = 0) AS scans,
           (SELECT COUNT(DISTINCT c.item_number) FROM stocktake_scan c WHERE c.zone_id = z.id AND c.voided = 0) AS items,
           (SELECT MAX(c.received_at) FROM stocktake_scan c WHERE c.zone_id = z.id) AS last_scan_at
    FROM stocktake_zone z
    WHERE z.session_id = ?
    ORDER BY z.name
  `).all(sessionId);
}

/** Hand a zone in. Reopening is deliberate, and only a supervisor may do it. */
export function submitZone({ zoneId, user }) {
  const zone = db.prepare('SELECT * FROM stocktake_zone WHERE id = ?').get(zoneId);
  if (!zone) throw new Error(`Zone #${zoneId} does not exist.`);
  requireOpenSession(zone.session_id);
  if (zone.status === SUBMITTED) return zone;
  db.prepare("UPDATE stocktake_zone SET status = 'submitted', submitted_by = ?, submitted_date = now_local() WHERE id = ?")
    .run(String(user || 'unknown'), zoneId);
  return db.prepare('SELECT * FROM stocktake_zone WHERE id = ?').get(zoneId);
}

export function reopenZone({ zoneId, user }) {
  const zone = db.prepare('SELECT * FROM stocktake_zone WHERE id = ?').get(zoneId);
  if (!zone) throw new Error(`Zone #${zoneId} does not exist.`);
  requireOpenSession(zone.session_id);
  db.prepare("UPDATE stocktake_zone SET status = 'open', submitted_by = NULL, submitted_date = NULL WHERE id = ?").run(zoneId);
  return { ...db.prepare('SELECT * FROM stocktake_zone WHERE id = ?').get(zoneId), reopened_by: String(user || 'unknown') };
}

// ── Scans ───────────────────────────────────────────────────────────────────

/**
 * Resolve a barcode for counting — WITHOUT the expected quantity or the cost.
 *
 * This is the blind-counting rule in the API rather than only on the screen:
 * a counter who can see "expected 340" hands back 340. The supervisor's
 * variance view is the only place those numbers appear.
 *
 * @param {{ barcode: string }} args
 */
export function resolveForCount({ barcode }) {
  const clean = normaliseBarcode(barcode);
  if (!clean) {
    return { found: false, barcode: String(barcode ?? '').trim(), reason: 'invalid', message: 'That does not look like a barcode. Scan it again, or type the number printed under the bars.' };
  }
  const variants = barcodeVariants(clean);
  const row = db.prepare(`
    SELECT b.barcode, b.item_number, b.unit, i.conversion, i.item_description, i.stock_unit
    FROM item_barcode b
    LEFT JOIN stocktake_item i ON i.item_number = b.item_number AND i.unit = b.unit
    WHERE b.barcode IN (${placeholders(variants.length)})
    LIMIT 1
  `).get(...variants);

  if (!row) {
    return {
      found: false,
      barcode: clean,
      reason: 'unmapped',
      message: 'This barcode is not on the map. Enter the quantity anyway — it is recorded against the barcode and the supervisor sorts out which item it is — or map it now if you know.',
    };
  }
  return {
    found: true,
    barcode: clean,
    item_number: row.item_number,
    item_description: row.item_description ?? null,
    unit: row.unit,
    conversion: row.conversion == null ? 1 : Number(row.conversion) || 1,
    stock_unit: row.stock_unit ?? null,
    unit_missing_in_sage: row.conversion == null,
  };
}

/**
 * Record scans.
 *
 * Takes a batch because phones queue offline and hand over a backlog when the
 * Wi-Fi comes back. Each scan carries a client_id generated on the device, so
 * a retried batch is ignored rather than counted twice — the retry is the
 * normal case in a warehouse, not the exception.
 *
 * A scan whose barcode is unmapped is still stored, with item_number NULL.
 * Losing a count because the map has a hole would be worse than the hole.
 *
 * @param {{ sessionId: number, zoneId: number, scans: any[], user: string }} args
 */
export function recordScans({ sessionId, zoneId, scans, user }) {
  requireOpenSession(sessionId);
  const zone = db.prepare('SELECT * FROM stocktake_zone WHERE id = ? AND session_id = ?').get(zoneId, sessionId);
  if (!zone) throw new Error(`Zone #${zoneId} is not part of count #${sessionId}.`);
  if (zone.status === SUBMITTED) {
    throw new Error(`"${zone.name}" was submitted by ${zone.submitted_by || 'someone'} and no longer takes scans. Ask a supervisor to reopen it.`);
  }
  if (!Array.isArray(scans) || scans.length === 0) throw new Error('No scans were sent.');
  if (scans.length > 500) throw new Error('Too many scans in one batch. Send at most 500 at a time.');

  const who = String(user || 'unknown');
  const insert = db.prepare(`
    INSERT OR IGNORE INTO stocktake_scan
      (client_id, session_id, zone_id, pass, barcode, item_number, unit, conversion, qty, stock_qty, counted_by, counted_at, received_at, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now_local(), ?)
  `);

  const accepted = [];
  const duplicates = [];
  const rejected = [];

  const run = db.transaction((list) => {
    for (const s of list) {
      const clientId = String(s?.client_id || '').trim();
      if (!clientId) { rejected.push({ client_id: null, reason: 'Every scan must carry a client_id so a repeated send is not counted twice.' }); continue; }

      const qty = Number(s?.qty);
      if (!Number.isFinite(qty) || qty === 0) { rejected.push({ client_id: clientId, reason: 'The quantity must be a number and cannot be zero.' }); continue; }

      const pass = Number(s?.pass) === 2 ? 2 : 1;
      const itemNumber = String(s?.item_number || '').trim() || null;
      const barcode = String(s?.barcode || '').trim() || null;
      if (!itemNumber && !barcode) { rejected.push({ client_id: clientId, reason: 'A scan needs either an item or the barcode that was scanned.' }); continue; }

      // A recount must be done by someone other than whoever counted it first.
      // That is the whole point of a recount, so it is refused here rather
      // than left to the screen to police.
      if (pass === 2 && itemNumber) {
        const sameHand = db.prepare(`
          SELECT 1 FROM stocktake_scan
          WHERE session_id = ? AND item_number = ? AND pass = 1 AND voided = 0 AND counted_by = ?
          LIMIT 1
        `).get(sessionId, itemNumber, who);
        if (sameHand) {
          rejected.push({ client_id: clientId, reason: `You counted item ${itemNumber} the first time. A recount has to be done by someone else — that is what makes it a check.` });
          continue;
        }
      }

      // The conversion is taken from the item master, never from the device:
      // a phone that has been offline for an hour may be working off a stale
      // pack size, and the stocking-unit quantity has to be right.
      let unit = String(s?.unit || '').trim() || null;
      let conversion = 1;
      if (itemNumber && unit) {
        const known = db.prepare('SELECT conversion FROM stocktake_item WHERE item_number = ? AND unit = ?').get(itemNumber, unit);
        if (!known) { rejected.push({ client_id: clientId, reason: `Sage does not list the unit "${unit}" for item ${itemNumber}. Refresh the item list and scan it again.` }); continue; }
        conversion = Number(known.conversion) || 1;
      } else if (itemNumber) {
        const only = db.prepare('SELECT unit, conversion FROM stocktake_item WHERE item_number = ? ORDER BY conversion LIMIT 1').get(itemNumber);
        if (only) { unit = only.unit; conversion = Number(only.conversion) || 1; }
      }

      const info = insert.run(
        clientId, sessionId, zoneId, pass, barcode, itemNumber, unit, conversion,
        qty, qty * conversion, who, String(s?.counted_at || '').trim() || null,
        String(s?.note || '').trim() || null,
      );
      if (info.changes === 0) duplicates.push(clientId);
      else accepted.push(clientId);
    }
  });
  run(scans);

  return { accepted, duplicates, rejected, accepted_count: accepted.length, duplicate_count: duplicates.length, rejected_count: rejected.length };
}

/** The scans in one zone, newest first — what the counter sees as they work. */
export function listZoneScans({ zoneId, limit = 200 }) {
  return db.prepare(`
    SELECT c.id, c.client_id, c.barcode, c.item_number, c.unit, c.qty, c.stock_qty, c.pass,
           c.counted_by, c.received_at, c.voided, c.note, i.item_description
    FROM stocktake_scan c
    LEFT JOIN stocktake_item i ON i.item_number = c.item_number AND i.unit = c.unit
    WHERE c.zone_id = ?
    ORDER BY c.id DESC
    LIMIT ?
  `).all(zoneId, Math.max(1, Math.min(Number(limit) || 200, 1000)));
}

/**
 * Undo a scan. The row stays and is marked voided, because "who counted what,
 * and what did they take back" is the audit trail of the whole exercise.
 */
export function voidScan({ scanId, user }) {
  const scan = db.prepare('SELECT * FROM stocktake_scan WHERE id = ?').get(scanId);
  if (!scan) throw new Error(`Scan #${scanId} does not exist.`);
  requireOpenSession(scan.session_id);
  if (scan.voided) return scan;
  db.prepare('UPDATE stocktake_scan SET voided = 1, voided_by = ?, voided_date = now_local() WHERE id = ?')
    .run(String(user || 'unknown'), scanId);
  return db.prepare('SELECT * FROM stocktake_scan WHERE id = ?').get(scanId);
}

// ── Variance (supervisor only) ──────────────────────────────────────────────

/**
 * Counted against expected, per item.
 *
 * The counted figure is the SECOND pass where one exists, because a recount
 * supersedes the first count — that is what it is for. Where none exists it is
 * the first pass. Both are shown so the supervisor can see the two numbers
 * that disagreed.
 *
 * Items in the snapshot that nobody counted are included with a count of zero:
 * stock that should be there and was never found is the single most important
 * line in the report, and leaving it out would hide it.
 *
 * @param {number} sessionId
 */
export function varianceRows(sessionId) {
  const session = getSession(sessionId);
  if (!session) throw new Error(`Count #${sessionId} does not exist.`);

  const rows = db.prepare(`
    WITH counted AS (
      SELECT item_number,
             SUM(CASE WHEN pass = 1 THEN stock_qty ELSE 0 END) AS pass1_qty,
             SUM(CASE WHEN pass = 2 THEN stock_qty ELSE 0 END) AS pass2_qty,
             SUM(CASE WHEN pass = 2 THEN 1 ELSE 0 END)         AS pass2_scans,
             COUNT(DISTINCT zone_id)                           AS zone_count,
             COUNT(*)                                          AS scan_count
      FROM stocktake_scan
      WHERE session_id = ? AND voided = 0 AND item_number IS NOT NULL
      GROUP BY item_number
    ),
    universe AS (
      SELECT item_number FROM counted
      UNION
      SELECT item_number FROM stocktake_session_snapshot WHERE session_id = ?
    )
    SELECT u.item_number,
           i.item_description,
           i.stock_unit,
           COALESCE(c.pass1_qty, 0)   AS pass1_qty,
           COALESCE(c.pass2_qty, 0)   AS pass2_qty,
           COALESCE(c.pass2_scans, 0) AS pass2_scans,
           COALESCE(c.zone_count, 0)  AS zone_count,
           COALESCE(c.scan_count, 0)  AS scan_count,
           COALESCE(s.qty_on_hand, 0) AS expected_qty,
           COALESCE(s.total_cost, 0)  AS expected_cost,
           CASE WHEN s.item_number IS NULL THEN 1 ELSE 0 END AS not_in_snapshot
    FROM universe u
    LEFT JOIN counted c ON c.item_number = u.item_number
    LEFT JOIN stocktake_session_snapshot s ON s.session_id = ? AND s.item_number = u.item_number
    LEFT JOIN (SELECT item_number, MAX(item_description) AS item_description, MAX(stock_unit) AS stock_unit
               FROM stocktake_item GROUP BY item_number) i ON i.item_number = u.item_number
  `).all(sessionId, sessionId, sessionId);

  const thresholdQty = Number(session.threshold_qty) || 0;
  const thresholdValue = Number(session.threshold_value) || 0;

  return rows.map((r) => {
    const recountDone = r.pass2_scans > 0;
    const countedQty = recountDone ? r.pass2_qty : r.pass1_qty;
    const diffQty = countedQty - r.expected_qty;
    // Average cost from the snapshot, so the variance is valued at what the
    // stock was carried at when the count opened.
    const unitCost = r.expected_qty ? r.expected_cost / r.expected_qty : 0;
    const diffValue = diffQty * unitCost;
    const overThreshold = Math.abs(diffQty) >= thresholdQty || Math.abs(diffValue) >= thresholdValue;
    return {
      ...r,
      counted_qty: countedQty,
      unit_cost: unitCost,
      diff_qty: diffQty,
      diff_value: diffValue,
      recount_done: recountDone,
      // A variance only needs a recount if something was actually counted or
      // expected — an item with nothing on either side is not a finding.
      recount_required: overThreshold && (r.scan_count > 0 || r.expected_qty !== 0),
      counted_in_multiple_zones: r.zone_count > 1,
      never_counted: r.scan_count === 0,
    };
  });
}

/** The variance, filtered and sorted the way a supervisor reads it. */
export function getVariance(sessionId, { filter = 'all' } = {}) {
  const all = varianceRows(sessionId);
  const filtered = all.filter((r) => {
    if (filter === 'recount') return r.recount_required && !r.recount_done;
    if (filter === 'differences') return r.diff_qty !== 0;
    if (filter === 'never_counted') return r.never_counted && r.expected_qty !== 0;
    if (filter === 'unexpected') return r.not_in_snapshot === 1;
    return true;
  });
  // Biggest money difference first — that is the order they get acted on in.
  filtered.sort((a, b) => Math.abs(b.diff_value) - Math.abs(a.diff_value) || Math.abs(b.diff_qty) - Math.abs(a.diff_qty));

  const totals = all.reduce((acc, r) => {
    acc.items += 1;
    if (r.diff_qty !== 0) acc.items_with_difference += 1;
    if (r.recount_required && !r.recount_done) acc.recounts_outstanding += 1;
    if (r.never_counted && r.expected_qty !== 0) acc.never_counted += 1;
    if (r.diff_value > 0) acc.surplus_value += r.diff_value;
    if (r.diff_value < 0) acc.shortfall_value += r.diff_value;
    return acc;
  }, { items: 0, items_with_difference: 0, recounts_outstanding: 0, never_counted: 0, surplus_value: 0, shortfall_value: 0 });
  totals.net_value = totals.surplus_value + totals.shortfall_value;

  return { session: getSession(sessionId), totals, rows: filtered, shown: filtered.length, of: all.length };
}

/**
 * The items a counter has been sent back to recount.
 *
 * Deliberately carries no quantity — not the expected figure and not what was
 * counted the first time. The recount stays blind, or it is not a check.
 */
export function listRecountItems(sessionId) {
  return varianceRows(sessionId)
    .filter((r) => r.recount_required && !r.recount_done)
    .map((r) => ({
      item_number: r.item_number,
      item_description: r.item_description,
      stock_unit: r.stock_unit,
      first_counted_by: db.prepare(`
        SELECT GROUP_CONCAT(DISTINCT counted_by) AS who
        FROM stocktake_scan WHERE session_id = ? AND item_number = ? AND pass = 1 AND voided = 0
      `).get(sessionId, r.item_number)?.who || null,
    }))
    .sort((a, b) => String(a.item_description || a.item_number).localeCompare(String(b.item_description || b.item_number)));
}

/** Scans whose barcode was never mapped — the supervisor's tidy-up list. */
export function listUnresolvedScans(sessionId) {
  return db.prepare(`
    SELECT c.id, c.barcode, c.qty, c.counted_by, c.received_at, c.note, z.name AS zone_name
    FROM stocktake_scan c
    JOIN stocktake_zone z ON z.id = c.zone_id
    WHERE c.session_id = ? AND c.voided = 0 AND c.item_number IS NULL
    ORDER BY c.id DESC
  `).all(sessionId);
}

/**
 * Attach an unmapped scan to an item once someone works out what it was.
 * Mapping the barcode itself is a separate, deliberate act on the Map screen.
 */
export function resolveScan({ scanId, itemNumber, unit, user }) {
  const scan = db.prepare('SELECT * FROM stocktake_scan WHERE id = ?').get(scanId);
  if (!scan) throw new Error(`Scan #${scanId} does not exist.`);
  requireOpenSession(scan.session_id);
  const item = String(itemNumber || '').trim();
  const u = String(unit || '').trim();
  const known = db.prepare('SELECT conversion FROM stocktake_item WHERE item_number = ? AND unit = ?').get(item, u);
  if (!known) throw new Error(`Sage does not list the unit "${u}" for item ${item}.`);
  const conversion = Number(known.conversion) || 1;
  db.prepare(`
    UPDATE stocktake_scan
    SET item_number = ?, unit = ?, conversion = ?, stock_qty = qty * ?,
        note = TRIM(COALESCE(note, '') || ' [resolved by ' || ? || ']')
    WHERE id = ?
  `).run(item, u, conversion, conversion, String(user || 'unknown'), scanId);
  return db.prepare('SELECT * FROM stocktake_scan WHERE id = ?').get(scanId);
}

export { OPEN, CLOSED, SUBMITTED };
