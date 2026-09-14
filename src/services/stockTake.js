// Stock take — barcode map and item lookup.
//
// SAGE IS READ-ONLY HERE. This module opens the Sage pool for SELECTs only
// (the item/unit master). Nothing in the stock take feature writes, updates or
// posts anything to Sage, now or later — barcodes and counts live in
// cardoso.db, and any correction to stock is keyed by a person in Sage itself.
//
// Why we own the barcodes: Sage 300 has no barcode column anywhere in the
// company database, and no item optional fields are defined, so there is
// nothing to read. The map is built here, one scan at a time.
import db from '../db/index.js';
import { getSagePool } from './batReconciliation.js';
import { resolveSageQuery } from './sage/queryRegistry.js';
import { logError } from '../lib/errorLog.js';

/**
 * Strip the noise a scanner adds and reject anything that is not a plausible
 * barcode. Keyboard-wedge (Bluetooth) scanners append Enter and sometimes a
 * stray tab or carriage return; camera reads are clean. Case is preserved
 * because Code 128 and Code 39 are case-sensitive — only whitespace and
 * control characters are removed.
 *
 * @param {unknown} raw
 * @returns {string} the cleaned barcode, or '' if it is not usable
 */
export function normaliseBarcode(raw) {
  const s = String(raw ?? '').replace(/[^!-~]/g, '');
  // 4 is below the shortest standard symbology (EAN-8) but short internal
  // codes exist; 48 is well past the longest Code 128 a scanner will emit.
  if (s.length < 4 || s.length > 48) return '';
  return s;
}

/**
 * The forms of a barcode that must all resolve to the same product.
 *
 * A UPC-A barcode is 12 digits. EAN-13 is the same number with a leading zero.
 * A phone camera usually reports it as UPC_A (12 digits) while a laser scanner
 * usually reports EAN_13 (13 digits, leading zero) — the SAME label read two
 * ways. If we stored one form and looked up the other, the second device would
 * call a mapped item "unknown" and a counter would map it a second time. So
 * every lookup tries both forms, and both are checked before saving.
 *
 * EAN-8 is a genuinely different, shorter symbology and is never padded.
 *
 * @param {string} barcode already through normaliseBarcode()
 * @returns {string[]} the barcode plus any equivalent form
 */
export function barcodeVariants(barcode) {
  const out = [barcode];
  if (/^\d{12}$/.test(barcode)) out.push(`0${barcode}`);
  else if (/^0\d{12}$/.test(barcode)) out.push(barcode.slice(1));
  return out;
}

function placeholders(n) {
  return new Array(n).fill('?').join(', ');
}

// ── Item/unit master, refreshed from Sage ───────────────────────────────────

/**
 * Refresh the local item/unit cache from Sage (SELECT only).
 *
 * Full replace inside one transaction: the master is a few thousand rows, and
 * a delta sync would leave items deleted in Sage behind for no gain.
 */
export async function syncItemsFromSage() {
  logError('stockTake.syncItems', new Error('Stock take item master sync starting — read-only SELECT against Sage (ICITEM + ICUNIT)'), {}, 'info');
  const pool = await getSagePool();
  const result = await pool.request().query(resolveSageQuery('stocktake.item_master'));
  const rows = result.recordset || [];
  if (!rows.length) {
    throw new Error('Sage returned no items for the stock take item master. The existing item list was left untouched rather than emptied. Check the Sage connection, then the "stocktake.item_master" query under Settings → Sage Queries.');
  }

  const insert = db.prepare(`
    INSERT INTO stocktake_item (item_number, unit, conversion, item_description, stock_unit, category, inactive, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, now_local())
    ON CONFLICT(item_number, unit) DO UPDATE SET
      conversion       = excluded.conversion,
      item_description = excluded.item_description,
      stock_unit       = excluded.stock_unit,
      category         = excluded.category,
      inactive         = excluded.inactive,
      synced_at        = now_local()
  `);

  const replaceAll = db.transaction((list) => {
    db.prepare('DELETE FROM stocktake_item').run();
    for (const r of list) {
      insert.run(
        String(r.item_number || '').trim(),
        String(r.unit || '').trim(),
        Number(r.conversion) || 1,
        r.item_description ?? null,
        r.stock_unit ?? null,
        r.category ?? null,
        Number(r.inactive) ? 1 : 0,
      );
    }
  });
  replaceAll(rows);

  // A barcode whose unit no longer exists in Sage is a real problem for a
  // counter, so count them here and let the UI say so out loud.
  const orphans = db.prepare(`
    SELECT COUNT(*) AS c FROM item_barcode b
    WHERE NOT EXISTS (
      SELECT 1 FROM stocktake_item i WHERE i.item_number = b.item_number AND i.unit = b.unit
    )
  `).get();

  logError('stockTake.syncItems', new Error(`Stock take item master sync finished: ${rows.length} item/unit rows cached from Sage`), { rows: rows.length, orphanBarcodes: orphans?.c ?? 0 }, 'info');
  return { rows: rows.length, orphanBarcodes: orphans?.c ?? 0 };
}

/** Last sync time, cache size, map size, and how much of the held stock is covered. */
export function getStockTakeMeta() {
  const item = db.prepare('SELECT COUNT(*) AS units, COUNT(DISTINCT item_number) AS items, MAX(synced_at) AS synced_at FROM stocktake_item').get();
  const map = db.prepare('SELECT COUNT(*) AS barcodes, COUNT(DISTINCT item_number) AS items FROM item_barcode').get();
  // The coverage that matters: items actually holding stock somewhere, because
  // those are the ones a counter will walk past.
  const coverage = db.prepare(`
    SELECT
      COUNT(*) AS stocked_items,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM item_barcode b WHERE b.item_number = o.item_number) THEN 1 ELSE 0 END) AS stocked_items_mapped
    FROM (SELECT DISTINCT item_number FROM inventory_location_onhand WHERE qty_on_hand <> 0) o
  `).get();
  const locations = db.prepare(`
    SELECT location, COUNT(*) AS items
    FROM inventory_location_onhand
    WHERE qty_on_hand <> 0
    GROUP BY location
    ORDER BY location
  `).all();

  return {
    items_cached: item?.items ?? 0,
    item_units_cached: item?.units ?? 0,
    items_synced_at: item?.synced_at ?? null,
    barcodes_mapped: map?.barcodes ?? 0,
    items_with_barcode: map?.items ?? 0,
    stocked_items: coverage?.stocked_items ?? 0,
    stocked_items_mapped: coverage?.stocked_items_mapped ?? 0,
    locations,
  };
}

// ── Lookup ──────────────────────────────────────────────────────────────────

/** Every unit Sage knows for an item, so the operator can pick the pack size. */
export function getItemUnits(itemNumber) {
  return db.prepare(`
    SELECT item_number, unit, conversion, item_description, stock_unit, category
    FROM stocktake_item
    WHERE item_number = ?
    ORDER BY conversion, unit
  `).all(String(itemNumber || '').trim());
}

/**
 * Resolve a scanned barcode.
 *
 * Always returns an answer. `found: false` means "not mapped yet", which is a
 * normal, expected state while the map is being built — not an error.
 *
 * @param {{ barcode: string, location?: string }} args
 */
export function lookupBarcode({ barcode, location }) {
  const clean = normaliseBarcode(barcode);
  if (!clean) {
    return {
      found: false,
      barcode: String(barcode ?? '').trim(),
      reason: 'invalid',
      message: 'That does not look like a barcode. Scan it again, or type the number printed under the bars.',
    };
  }

  const variants = barcodeVariants(clean);
  const row = db.prepare(`
    SELECT b.id, b.barcode, b.item_number, b.unit, b.created_by, b.created_date,
           i.conversion, i.item_description, i.stock_unit, i.category
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
      message: 'This barcode is not on the map yet. Choose the item and the pack size it belongs to.',
    };
  }

  // The unit may have been removed from Sage since it was mapped. Say so,
  // rather than silently treating the conversion as 1.
  const unitGone = row.conversion == null;
  const conversion = unitGone ? 1 : Number(row.conversion) || 1;

  const loc = String(location || '').trim();
  const onhand = loc
    ? db.prepare('SELECT qty_on_hand, total_cost FROM inventory_location_onhand WHERE item_number = ? AND location = ?').get(row.item_number, loc)
    : null;
  const qtyOnHand = onhand ? Number(onhand.qty_on_hand) || 0 : 0;
  const totalCost = onhand ? Number(onhand.total_cost) || 0 : 0;

  return {
    found: true,
    barcode: clean,
    id: row.id,
    item_number: row.item_number,
    item_description: row.item_description ?? null,
    unit: row.unit,
    conversion,
    stock_unit: row.stock_unit ?? null,
    category: row.category ?? null,
    mapped_by: row.created_by ?? null,
    mapped_date: row.created_date ?? null,
    unit_missing_in_sage: unitGone,
    unit_warning: unitGone
      ? `Sage no longer lists the unit "${row.unit}" for item ${row.item_number}. Re-map this barcode to a current unit before counting with it.`
      : null,
    location: loc || null,
    // On-hand is held in the STOCKING unit, so show it in the scanned unit
    // too — "4 cartons" is what the person holding the box needs to read.
    qty_on_hand: loc ? qtyOnHand : null,
    qty_on_hand_in_unit: loc ? qtyOnHand / conversion : null,
    average_cost: loc && qtyOnHand ? totalCost / qtyOnHand : null,
  };
}

// ── Editing the map ─────────────────────────────────────────────────────────

/**
 * Map a barcode to an item and unit, or re-point one that already exists.
 *
 * Re-pointing is deliberate and allowed: the first person to map a barcode can
 * get the pack size wrong, and fixing it must not need a database admin. The
 * caller audits the change.
 *
 * @param {{ barcode: string, itemNumber: string, unit: string, user?: string, allowRemap?: boolean }} args
 */
export function saveBarcode({ barcode, itemNumber, unit, user, allowRemap = false }) {
  const clean = normaliseBarcode(barcode);
  if (!clean) throw new Error('That barcode is not usable. Once spaces are removed it must be between 4 and 48 characters.');
  const item = String(itemNumber || '').trim();
  const u = String(unit || '').trim();
  if (!item) throw new Error('No item was chosen for this barcode.');
  if (!u) throw new Error('No unit (pack size) was chosen for this barcode. A carton and a single carry different barcodes and must map to different units.');

  const known = db.prepare('SELECT conversion FROM stocktake_item WHERE item_number = ? AND unit = ?').get(item, u);
  if (!known) {
    throw new Error(`Sage does not list the unit "${u}" for item ${item}. Pick a unit from that item's own list, or refresh the item list from Sage if the unit was added recently.`);
  }

  const variants = barcodeVariants(clean);
  const existing = db.prepare(`
    SELECT id, barcode, item_number, unit FROM item_barcode
    WHERE barcode IN (${placeholders(variants.length)})
    LIMIT 1
  `).get(...variants);

  if (existing && !allowRemap) {
    if (existing.item_number === item && existing.unit === u) {
      return { ok: true, changed: false, id: existing.id, barcode: existing.barcode, item_number: item, unit: u };
    }
    const err = new Error(`Barcode ${clean} is already mapped to item ${existing.item_number} (${existing.unit}). Confirm the change to re-point it to item ${item} (${u}).`);
    // Surfaced by the route as a 409 so the screen can offer "re-point".
    /** @type {any} */ (err).code = 'BARCODE_IN_USE';
    /** @type {any} */ (err).existing = existing;
    throw err;
  }

  const who = String(user || 'unknown');
  if (existing) {
    db.prepare('UPDATE item_barcode SET item_number = ?, unit = ?, updated_by = ?, updated_date = now_local() WHERE id = ?')
      .run(item, u, who, existing.id);
    return { ok: true, changed: true, remapped: true, id: existing.id, barcode: existing.barcode, item_number: item, unit: u, previous: existing };
  }

  const info = db.prepare(`
    INSERT INTO item_barcode (barcode, item_number, unit, created_by, created_date, updated_by, updated_date)
    VALUES (?, ?, ?, ?, now_local(), ?, now_local())
  `).run(clean, item, u, who, who);
  return { ok: true, changed: true, remapped: false, id: Number(info.lastInsertRowid), barcode: clean, item_number: item, unit: u };
}

/** Remove one mapping. Returns the row that was removed, so it can be audited. */
export function deleteBarcode(id) {
  const row = db.prepare('SELECT id, barcode, item_number, unit FROM item_barcode WHERE id = ?').get(id);
  if (!row) return null;
  db.prepare('DELETE FROM item_barcode WHERE id = ?').run(id);
  return row;
}

/** The map, newest first, optionally filtered by barcode, item number or description. */
export function listBarcodes({ search = '', limit = 200 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 200, 2000));
  const q = String(search || '').trim();
  const params = [];
  let where = '';
  if (q) {
    where = 'WHERE (b.barcode LIKE ? OR b.item_number LIKE ? OR i.item_description LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  params.push(safeLimit);
  return db.prepare(`
    SELECT b.id, b.barcode, b.item_number, b.unit, b.created_by, b.created_date, b.updated_by, b.updated_date,
           i.item_description, i.conversion, i.stock_unit
    FROM item_barcode b
    LEFT JOIN stocktake_item i ON i.item_number = b.item_number AND i.unit = b.unit
    ${where}
    ORDER BY b.id DESC
    LIMIT ?
  `).all(...params);
}

/**
 * Find items to map a barcode to. Items the branch actually holds sort first —
 * the thing in the counter's hand is almost always stock on the floor.
 */
export function searchItems({ q = '', location = '', limit = 30 } = {}) {
  const term = String(q || '').trim();
  if (term.length < 2) return [];
  const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 200));
  const loc = String(location || '').trim();
  return db.prepare(`
    SELECT i.item_number,
           MAX(i.item_description) AS item_description,
           MAX(i.stock_unit)       AS stock_unit,
           MAX(i.category)         AS category,
           COUNT(*)                AS unit_count,
           COALESCE(MAX(o.qty_on_hand), 0) AS qty_on_hand,
           MAX(CASE WHEN b.id IS NULL THEN 0 ELSE 1 END) AS has_barcode
    FROM stocktake_item i
    LEFT JOIN inventory_location_onhand o
      ON o.item_number = i.item_number AND (? = '' OR o.location = ?)
    LEFT JOIN item_barcode b ON b.item_number = i.item_number
    WHERE i.item_number LIKE ? OR i.item_description LIKE ?
    GROUP BY i.item_number
    ORDER BY (CASE WHEN COALESCE(MAX(o.qty_on_hand), 0) <> 0 THEN 0 ELSE 1 END),
             (CASE WHEN i.item_number = ? THEN 0 ELSE 1 END),
             i.item_number
    LIMIT ?
  `).all(loc, loc, `%${term}%`, `%${term}%`, term, safeLimit);
}
