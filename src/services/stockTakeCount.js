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

// ── Product groups ──────────────────────────────────────────────────────────

/**
 * The product groups a branch holds, as Sage classifies them, with how many
 * stocked items each covers so a supervisor can see the size of the job
 * before opening the count.
 */
export function listCategories(location) {
  const loc = String(location || '').trim();
  return db.prepare(`
    SELECT i.category,
           MAX(i.category_description) AS category_description,
           COUNT(DISTINCT i.item_number) AS items,
           COUNT(DISTINCT CASE WHEN o.qty_on_hand <> 0 THEN i.item_number END) AS stocked_items
    FROM stocktake_item i
    LEFT JOIN inventory_location_onhand o ON o.item_number = i.item_number AND (? = '' OR o.location = ?)
    WHERE i.category IS NOT NULL AND i.category <> ''
    GROUP BY i.category
    HAVING stocked_items > 0
    ORDER BY stocked_items DESC, i.category
  `).all(loc, loc);
}

/**
 * The commodities a branch holds stock in. Sage's coarse grouping — a
 * handful of numbered codes the business talks in, where CATEGORY is the
 * fine supplier/brand one. Sage has no description table for them, so the
 * code is shown with a couple of real item names as a hint at what it is.
 */
export function listCommodities(location) {
  const loc = String(location || '').trim();
  return db.prepare(`
    SELECT i.commodity,
           COUNT(DISTINCT i.item_number) AS items,
           COUNT(DISTINCT CASE WHEN o.qty_on_hand <> 0 THEN i.item_number END) AS stocked_items,
           MIN(NULLIF(TRIM(i.item_description), '')) AS sample_first,
           MAX(NULLIF(TRIM(i.item_description), '')) AS sample_last
    FROM stocktake_item i
    LEFT JOIN inventory_location_onhand o ON o.item_number = i.item_number AND (? = '' OR o.location = ?)
    WHERE i.commodity IS NOT NULL AND i.commodity <> ''
    GROUP BY i.commodity
    HAVING stocked_items > 0
    ORDER BY stocked_items DESC, i.commodity
  `).all(loc, loc);
}

/**
 * The vendors a branch holds stock from.
 *
 * item_vendor is filled by the Inventory Movement sync, not by this module,
 * so it can be empty on a site that has never run one. That is reported as an
 * empty list rather than an error — the screen says where it comes from.
 */
export function listVendors(location) {
  const loc = String(location || '').trim();
  return db.prepare(`
    SELECT v.vendor_code,
           MAX(v.vendor_name) AS vendor_name,
           COUNT(DISTINCT v.item_number) AS items,
           COUNT(DISTINCT CASE WHEN o.qty_on_hand <> 0 THEN v.item_number END) AS stocked_items
    FROM item_vendor v
    LEFT JOIN inventory_location_onhand o ON o.item_number = v.item_number AND (? = '' OR o.location = ?)
    WHERE v.vendor_code IS NOT NULL AND v.vendor_code <> ''
    GROUP BY v.vendor_code
    HAVING stocked_items > 0
    ORDER BY stocked_items DESC, vendor_name
  `).all(loc, loc);
}

/** The vendors a count covers, or null for all of them. */
export function sessionVendors(session) {
  if (!session?.vendors) return null;
  try {
    const list = JSON.parse(session.vendors);
    return Array.isArray(list) && list.length ? list : null;
  } catch {
    return null;
  }
}

/** The commodities a count covers, or null for all of them. */
export function sessionCommodities(session) {
  if (!session?.commodities) return null;
  try {
    const list = JSON.parse(session.commodities);
    return Array.isArray(list) && list.length ? list : null;
  } catch {
    return null;
  }
}

/** The groups a count covers, or null for the whole branch. */
export function sessionCategories(session) {
  if (!session?.categories) return null;
  try {
    const list = JSON.parse(session.categories);
    return Array.isArray(list) && list.length ? list : null;
  } catch {
    return null;
  }
}

// ── Sessions ────────────────────────────────────────────────────────────────

/**
 * Open a count.
 *
 * The expected quantities are snapshotted here, once. Measuring variance
 * against live on-hand would mean the target moves while people are still
 * walking the aisles — every sale during the count would read as a shortfall.
 *
 * A count can cover the whole branch, or only certain product groups —
 * cigarettes on a Tuesday, sweets on a Thursday. Counting everything at once
 * is a shutdown; counting a group at a time is a routine, and a routine is
 * what actually finds shrinkage.
 *
 * Product groups and commodities are two independent ways Sage slices the
 * same stock, and the branch uses both. Picking from either narrows the
 * count; an item is in it if it matches ANY of what was picked, because each
 * chip names a slice of stock rather than a condition to combine.
 *
 * @param {{ name: string, location: string, categories?: string[], commodities?: string[], vendors?: string[], thresholdQty?: number, thresholdValue?: number, notes?: string, user: string }} args
 */
export function openSession({ name, location, categories, commodities, vendors, thresholdQty, thresholdValue, notes, user }) {
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

  const groups = Array.isArray(categories)
    ? [...new Set(categories.map((c) => String(c || '').trim()).filter(Boolean))]
    : [];
  if (groups.length) {
    const known = db.prepare(`SELECT DISTINCT category FROM stocktake_item WHERE category IN (${placeholders(groups.length)})`).all(...groups).map((r) => r.category);
    const unknown = groups.filter((g) => !known.includes(g));
    if (unknown.length) {
      throw new Error(`Sage has no product group called ${unknown.join(', ')}. Refresh the item list, then choose from the groups it offers.`);
    }
  }
  const commodityList = Array.isArray(commodities)
    ? [...new Set(commodities.map((c) => String(c || '').trim()).filter(Boolean))]
    : [];
  if (commodityList.length) {
    const known = db.prepare(`SELECT DISTINCT commodity FROM stocktake_item WHERE commodity IN (${placeholders(commodityList.length)})`).all(...commodityList).map((r) => r.commodity);
    const unknown = commodityList.filter((c) => !known.includes(c));
    if (unknown.length) {
      throw new Error(`Sage has no commodity ${unknown.join(', ')}. Refresh the item list, then choose from the commodities it offers.`);
    }
  }

  const vendorList = Array.isArray(vendors)
    ? [...new Set(vendors.map((v) => String(v || '').trim()).filter(Boolean))]
    : [];
  if (vendorList.length) {
    const known = db.prepare(`SELECT DISTINCT vendor_code FROM item_vendor WHERE vendor_code IN (${placeholders(vendorList.length)})`).all(...vendorList).map((r) => r.vendor_code);
    const unknown = vendorList.filter((v) => !known.includes(v));
    if (unknown.length) {
      throw new Error(`No item at this branch is attributed to vendor ${unknown.join(', ')}. The item-to-vendor list comes from the Inventory Movement sync — run that if it is out of date.`);
    }
  }

  // Any axis narrows the count, and an item qualifies on ANY match.
  const scopeParts = [];
  const scopeParams = [];
  if (groups.length) {
    scopeParts.push(`category IN (${placeholders(groups.length)})`);
    scopeParams.push(...groups);
  }
  if (commodityList.length) {
    scopeParts.push(`commodity IN (${placeholders(commodityList.length)})`);
    scopeParams.push(...commodityList);
  }
  if (vendorList.length) {
    scopeParts.push(`item_number IN (SELECT item_number FROM item_vendor WHERE vendor_code IN (${placeholders(vendorList.length)}))`);
    scopeParams.push(...vendorList);
  }
  const categoryFilter = scopeParts.length
    ? ` AND item_number IN (SELECT item_number FROM stocktake_item WHERE ${scopeParts.join(' OR ')})`
    : '';

  const create = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO stocktake_session (name, location, status, categories, commodities, vendors, threshold_qty, threshold_value, opened_by, opened_date, notes)
      VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, now_local(), ?)
    `).run(label, loc, groups.length ? JSON.stringify(groups) : null, commodityList.length ? JSON.stringify(commodityList) : null, vendorList.length ? JSON.stringify(vendorList) : null, qty, value, String(user || 'unknown'), String(notes || '').trim() || null);
    const sessionId = Number(info.lastInsertRowid);
    const copied = db.prepare(`
      INSERT INTO stocktake_session_snapshot (session_id, item_number, qty_on_hand, total_cost)
      SELECT ?, item_number, qty_on_hand, total_cost
      FROM inventory_location_onhand
      WHERE location = ?${categoryFilter}
    `).run(sessionId, loc, ...scopeParams);
    // Every aisle the branch has, ready to be claimed. A counter cannot add
    // one, so a count opened before the branch has a zone list has nothing to
    // count — zones_created is reported so the screen can say so plainly.
    const zonesCreated = db.prepare(`
      INSERT INTO stocktake_zone (session_id, location_zone_id, name, status, created_by, created_date)
      SELECT ?, id, name, 'open', ?, now_local()
      FROM stocktake_location_zone
      WHERE location = ? AND active = 1
      ORDER BY sort_order, name
    `).run(sessionId, String(user || 'unknown'), loc);
    return { sessionId, snapshotRows: copied.changes, zonesCreated: zonesCreated.changes };
  });

  const { sessionId, snapshotRows, zonesCreated } = create();
  return { ...getSession(sessionId), snapshot_rows: snapshotRows, zones_created: zonesCreated, category_list: groups, commodity_list: commodityList, vendor_list: vendorList };
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

// ── The branch's standing zone list ─────────────────────────────────────────
//
// Zones used to be typed by the counter. That fills up with "Aisle 3",
// "aisle3" and "asile 3" within two counts, and then the same rack looks like
// three different places and nothing compares month to month. The aisles of a
// branch are a fixed fact about the building, so a supervisor sets them up
// once and every count reuses them.

/** The aisles and shelves a branch has. Retired ones are kept, not deleted. */
export function listLocationZones(location, { includeInactive = false } = {}) {
  const loc = String(location || '').trim();
  return db.prepare(`
    SELECT z.*, (SELECT COUNT(*) FROM stocktake_zone s WHERE s.location_zone_id = z.id) AS used_in_counts
    FROM stocktake_location_zone z
    WHERE z.location = ? ${includeInactive ? '' : 'AND z.active = 1'}
    ORDER BY z.sort_order, z.name
  `).all(loc);
}

/**
 * Add an aisle to a branch's list. Supervisors only — enforced by the route.
 *
 * If a count is open at that branch the zone is added to it straight away,
 * because the usual reason for adding one is that somebody is standing in
 * front of a rack nobody listed.
 *
 * @param {{ location: string, name: string, user: string }} args
 */
export function addLocationZone({ location, name, user }) {
  const loc = String(location || '').trim();
  const label = String(name || '').trim().replace(/\s+/g, ' ');
  if (!loc) throw new Error('A zone has to belong to a branch.');
  if (!label) throw new Error('The zone needs a name — the aisle or shelf as people at the branch call it.');
  if (label.length > 60) throw new Error('That zone name is too long. Keep it to the aisle or shelf, under 60 characters.');

  const clash = db.prepare('SELECT * FROM stocktake_location_zone WHERE location = ? AND LOWER(name) = LOWER(?)').get(loc, label);
  if (clash) {
    if (!clash.active) {
      db.prepare('UPDATE stocktake_location_zone SET active = 1 WHERE id = ?').run(clash.id);
      return { ...db.prepare('SELECT * FROM stocktake_location_zone WHERE id = ?').get(clash.id), reactivated: true };
    }
    throw new Error(`${loc} already has a zone called "${clash.name}". Two zones with near-identical names is exactly what the list is there to prevent.`);
  }

  const next = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 10 AS n FROM stocktake_location_zone WHERE location = ?').get(loc).n;
  const info = db.prepare(`
    INSERT INTO stocktake_location_zone (location, name, active, sort_order, created_by, created_date)
    VALUES (?, ?, 1, ?, ?, now_local())
  `).run(loc, label, next, String(user || 'unknown'));
  const zone = db.prepare('SELECT * FROM stocktake_location_zone WHERE id = ?').get(Number(info.lastInsertRowid));

  const open = db.prepare("SELECT id FROM stocktake_session WHERE location = ? AND status = 'open'").get(loc);
  if (open) {
    db.prepare(`
      INSERT INTO stocktake_zone (session_id, location_zone_id, name, status, created_by, created_date)
      VALUES (?, ?, ?, 'open', ?, now_local())
    `).run(open.id, zone.id, zone.name, String(user || 'unknown'));
  }
  return { ...zone, added_to_open_count: Boolean(open) };
}

/**
 * Retire a zone, or bring it back. Never deleted: counts already done name it,
 * and a report that cannot say where something was counted is worth less.
 */
export function setLocationZoneActive({ id, active, user }) {
  const zone = db.prepare('SELECT * FROM stocktake_location_zone WHERE id = ?').get(id);
  if (!zone) throw new Error(`Zone #${id} is not on any branch's list.`);
  db.prepare('UPDATE stocktake_location_zone SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  return { ...db.prepare('SELECT * FROM stocktake_location_zone WHERE id = ?').get(id), changed_by: String(user || 'unknown') };
}

// ── Zones within one count ──────────────────────────────────────────────────

/**
 * Take an aisle. One owner at a time: two people on the same rack is a double
 * count, and a double count reads exactly like a genuine surplus.
 *
 * A counter can only claim what the supervisor has listed — there is no way to
 * invent a zone from the counting screen.
 *
 * @param {{ zoneId: number, user: string, assignTo?: string, isSupervisor?: boolean }} args
 */
export function claimZone({ zoneId, user, assignTo, isSupervisor = false }) {
  const zone = db.prepare('SELECT * FROM stocktake_zone WHERE id = ?').get(zoneId);
  if (!zone) throw new Error(`Zone #${zoneId} does not exist.`);
  requireOpenSession(zone.session_id);
  if (zone.status === SUBMITTED) {
    throw new Error(`"${zone.name}" has been handed in by ${zone.submitted_by || 'someone'}. Ask a supervisor to reopen it if there is more to count.`);
  }
  // Only a supervisor hands a zone to somebody else.
  const owner = isSupervisor && assignTo ? String(assignTo).trim() : String(user || 'unknown');
  if (zone.assigned_to && zone.assigned_to !== owner && !isSupervisor) {
    throw new Error(`"${zone.name}" is already being counted by ${zone.assigned_to}. Take a different aisle, or ask them to hand it in first.`);
  }
  db.prepare('UPDATE stocktake_zone SET assigned_to = ? WHERE id = ?').run(owner, zoneId);
  return db.prepare('SELECT * FROM stocktake_zone WHERE id = ?').get(zoneId);
}

/**
 * Give a zone back so somebody else can take it.
 *
 * Without this, a counter who claims an aisle and then goes home locks it for
 * everyone. Scans already made stay where they are — only the claim is
 * released.
 *
 * @param {{ zoneId: number, user: string, isSupervisor?: boolean }} args
 */
export function releaseZone({ zoneId, user, isSupervisor = false }) {
  const zone = db.prepare('SELECT * FROM stocktake_zone WHERE id = ?').get(zoneId);
  if (!zone) throw new Error(`Zone #${zoneId} does not exist.`);
  requireOpenSession(zone.session_id);
  if (zone.assigned_to && zone.assigned_to !== String(user || '') && !isSupervisor) {
    throw new Error(`"${zone.name}" belongs to ${zone.assigned_to}. Only they or a supervisor can give it back.`);
  }
  db.prepare('UPDATE stocktake_zone SET assigned_to = NULL WHERE id = ?').run(zoneId);
  return db.prepare('SELECT * FROM stocktake_zone WHERE id = ?').get(zoneId);
}

export function listZones(sessionId) {
  return db.prepare(`
    SELECT z.*,
           (SELECT COUNT(*) FROM stocktake_scan c WHERE c.zone_id = z.id AND c.voided = 0) AS scans,
           (SELECT COUNT(DISTINCT c.item_number) FROM stocktake_scan c WHERE c.zone_id = z.id AND c.voided = 0) AS items,
           (SELECT MAX(c.received_at) FROM stocktake_scan c WHERE c.zone_id = z.id) AS last_scan_at
    FROM stocktake_zone z
    LEFT JOIN stocktake_location_zone lz ON lz.id = z.location_zone_id
    WHERE z.session_id = ?
    ORDER BY COALESCE(lz.sort_order, 999999), z.name
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
 * Find an item by number or name, for counting.
 *
 * Labels get torn, frosted, or printed badly, and some stock never had a
 * barcode. Without this a counter is stuck in front of a rack they cannot
 * record, which is how counts end up on scraps of paper.
 *
 * Blind, like everything else a counter touches: no quantity, no cost. It is
 * a separate function from the barcode map's item search, which deliberately
 * DOES return on-hand for the supervisor.
 *
 * @param {{ q: string, sessionId?: number, limit?: number }} args
 */
export function searchItemsForCount({ q, sessionId, limit = 25 }) {
  const term = String(q || '').trim();
  if (term.length < 2) return [];
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 100));

  // A count scoped to cigarettes should not offer sweets: showing the whole
  // catalogue is how something gets counted into the wrong count.
  const session = sessionId ? getSession(sessionId) : null;
  const groups = session ? sessionCategories(session) : null;
  const commodityList = session ? sessionCommodities(session) : null;
  const scope = [];
  const scopeParams = [];
  if (groups) { scope.push(`i.category IN (${placeholders(groups.length)})`); scopeParams.push(...groups); }
  if (commodityList) { scope.push(`i.commodity IN (${placeholders(commodityList.length)})`); scopeParams.push(...commodityList); }
  const vendorList = session ? sessionVendors(session) : null;
  if (vendorList) {
    scope.push(`i.item_number IN (SELECT item_number FROM item_vendor WHERE vendor_code IN (${placeholders(vendorList.length)}))`);
    scopeParams.push(...vendorList);
  }
  const groupFilter = scope.length ? ` AND (${scope.join(' OR ')})` : '';

  return db.prepare(`
    SELECT i.item_number,
           MAX(i.item_description) AS item_description,
           MAX(i.stock_unit)       AS stock_unit,
           MAX(i.category)         AS category,
           COUNT(*)                AS unit_count,
           MAX(CASE WHEN b.id IS NULL THEN 0 ELSE 1 END) AS has_barcode
    FROM stocktake_item i
    LEFT JOIN item_barcode b ON b.item_number = i.item_number
    WHERE (i.item_number LIKE ? OR i.item_description LIKE ?)${groupFilter}
    GROUP BY i.item_number
    ORDER BY (CASE WHEN i.item_number = ? THEN 0 ELSE 1 END), i.item_number
    LIMIT ?
  `).all(`%${term}%`, `%${term}%`, ...scopeParams, term, safeLimit);
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
      // Either is enough: a scanned label with no item yet (the supervisor
      // resolves it later), or an item picked by name because the label would
      // not scan.
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


// ── Per-zone reporting ──────────────────────────────────────────────────────
//
// A word on what a zone CAN be compared against. Sage holds stock per branch,
// not per shelf — there is no ICILOC row for "Aisle 3" — so there is no such
// thing as an expected quantity for a zone, and therefore no per-zone
// variance. What a zone can honestly report is what it counted and what that
// is worth, plus which items it shares with another zone. Variance stays a
// whole-branch figure, which is the only level Sage can answer at.

/** Unit cost as the snapshot carried it, so zone values and variance agree. */
const SNAPSHOT_UNIT_COST = `COALESCE(sn.total_cost / NULLIF(sn.qty_on_hand, 0), 0)`;

/** What every zone in a count has done: scans, items, quantity and value. */
export function getZoneSummary(sessionId) {
  const rows = db.prepare(`
    SELECT z.id, z.name, z.assigned_to, z.status, z.submitted_by, z.submitted_date,
           COUNT(c.id)                                    AS scans,
           COUNT(DISTINCT c.item_number)                  AS items,
           COALESCE(SUM(c.stock_qty), 0)                  AS counted_qty,
           COALESCE(SUM(c.stock_qty * ${SNAPSHOT_UNIT_COST}), 0) AS counted_value,
           SUM(CASE WHEN c.id IS NOT NULL AND c.item_number IS NULL THEN 1 ELSE 0 END) AS unmapped_scans,
           SUM(CASE WHEN c.pass = 2 THEN 1 ELSE 0 END)     AS recount_scans,
           MAX(c.received_at)                             AS last_scan_at
    FROM stocktake_zone z
    LEFT JOIN stocktake_scan c ON c.zone_id = z.id AND c.voided = 0
    LEFT JOIN stocktake_session_snapshot sn ON sn.session_id = z.session_id AND sn.item_number = c.item_number
    LEFT JOIN stocktake_location_zone lz ON lz.id = z.location_zone_id
    WHERE z.session_id = ?
    GROUP BY z.id
    ORDER BY COALESCE(MAX(lz.sort_order), 999999), z.name
  `).all(sessionId);

  // Items this zone counted that another zone also counted. Not an error on
  // its own — stock is genuinely split across racks — but it is the first
  // thing to look at when a count comes back high.
  const shared = db.prepare(`
    SELECT c.zone_id, COUNT(DISTINCT c.item_number) AS n
    FROM stocktake_scan c
    WHERE c.session_id = ? AND c.voided = 0 AND c.item_number IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM stocktake_scan o
        WHERE o.session_id = c.session_id AND o.voided = 0
          AND o.item_number = c.item_number AND o.zone_id <> c.zone_id
      )
    GROUP BY c.zone_id
  `).all(sessionId);
  const sharedBy = new Map(shared.map((r) => [r.zone_id, r.n]));

  return rows.map((r) => ({ ...r, items_also_in_another_zone: sharedBy.get(r.id) || 0 }));
}

/**
 * The items one zone counted.
 *
 * The expected quantity shown is the whole BRANCH figure, not the zone's.
 * Sage cannot say how much of it should sit on one particular rack. It is
 * shown so a supervisor can see whether a zone found most of the holding
 * or a fraction of it.
 */
export function getZoneItems({ sessionId, zoneId }) {
  return db.prepare(`
    SELECT c.item_number,
           MAX(i.item_description)        AS item_description,
           MAX(i.stock_unit)              AS stock_unit,
           MAX(c.barcode)                 AS barcode,
           SUM(c.stock_qty)               AS zone_qty,
           SUM(c.stock_qty * ${SNAPSHOT_UNIT_COST}) AS zone_value,
           COUNT(*)                       AS scans,
           MAX(sn.qty_on_hand)            AS branch_expected_qty,
           GROUP_CONCAT(DISTINCT c.counted_by) AS counted_by,
           (SELECT GROUP_CONCAT(DISTINCT z2.name)
              FROM stocktake_scan o JOIN stocktake_zone z2 ON z2.id = o.zone_id
             WHERE o.session_id = c.session_id AND o.voided = 0
               AND o.item_number = c.item_number AND o.zone_id <> c.zone_id) AS other_zones
    FROM stocktake_scan c
    LEFT JOIN stocktake_session_snapshot sn ON sn.session_id = c.session_id AND sn.item_number = c.item_number
    LEFT JOIN (SELECT item_number, MAX(item_description) AS item_description, MAX(stock_unit) AS stock_unit
                 FROM stocktake_item GROUP BY item_number) i ON i.item_number = c.item_number
    WHERE c.session_id = ? AND c.zone_id = ? AND c.voided = 0
    GROUP BY c.item_number
    ORDER BY zone_value DESC
  `).all(sessionId, zoneId);
}

/** Which zones found an item, and how much each of them found. */
export function getItemZoneSplit({ sessionId, itemNumber }) {
  return db.prepare(`
    SELECT z.name AS zone_name, c.pass, SUM(c.stock_qty) AS qty,
           GROUP_CONCAT(DISTINCT c.counted_by) AS counted_by
    FROM stocktake_scan c
    JOIN stocktake_zone z ON z.id = c.zone_id
    WHERE c.session_id = ? AND c.item_number = ? AND c.voided = 0
    GROUP BY z.id, c.pass
    ORDER BY z.name, c.pass
  `).all(sessionId, itemNumber);
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
