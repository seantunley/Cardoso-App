import sql from 'mssql';
import db from '../db/index.js';
import { getSagePool } from './batReconciliation.js';
import { logError } from '../lib/errorLog.js';

// Sage 300 stores per-unit prices in ICPRICP keyed by (item, price list,
// unit of measure). Each (item, price list) combination typically has
// two rows — the real selling price plus a zeroed sibling — so MAX is
// used to collapse them. ICPRIC alone (the price-list header) does not
// hold the displayed selling price.

// Latest supplier per item, identical to the definition used by
// Inventory Movement / Dead Stock / Forecast so the dropdown values
// always agree. Sourced from local stock_receipt rows.
export function getSuppliers() {
  return db.prepare(`
    SELECT DISTINCT TRIM(sr.supplier_name) AS supplier_name
    FROM stock_receipt sr
    JOIN stock_receipt_line srl ON srl.receipt_id = sr.id
    WHERE sr.supplier_name IS NOT NULL
      AND TRIM(sr.supplier_name) != ''
    ORDER BY 1
  `).all().map(r => r.supplier_name);
}

// ── Exclusions ────────────────────────────────────────────────────
// Item-code patterns that should never appear on a customer price list
// (e.g. internal stock codes, samples, JT-prefixed manufacturer codes).
// Patterns use `*` as a wildcard which we convert to a regex.

export function getExclusions() {
  return db.prepare(`
    SELECT id, pattern, note, created_at, created_by
    FROM price_list_exclusions
    ORDER BY pattern
  `).all();
}

export function addExclusion({ pattern, note, createdBy }) {
  const clean = String(pattern || '').trim().toUpperCase();
  if (!clean) throw new Error('Pattern is required');
  if (clean.length > 50) throw new Error('Pattern must be 50 characters or less');
  try {
    db.prepare(`
      INSERT INTO price_list_exclusions (pattern, note, created_by)
      VALUES (?, ?, ?)
      ON CONFLICT(pattern) DO UPDATE SET
        note = excluded.note,
        created_at = price_list_exclusions.created_at
    `).run(clean, note || null, createdBy || null);
    return db.prepare('SELECT * FROM price_list_exclusions WHERE pattern = ?').get(clean);
  } catch (err) {
    logError('pricing.exclusion_create', err, { pattern: clean });
    throw err;
  }
}

export function deleteExclusion(id) {
  try {
    const r = db.prepare('DELETE FROM price_list_exclusions WHERE id = ?').run(id);
    return r.changes > 0;
  } catch (err) {
    logError('pricing.exclusion_delete', err, { id });
    throw err;
  }
}

// A pattern can be one of:
//   1. Numeric range:  "4000-4999"  (matches any item_number that parses
//      to an integer in [4000, 4999])
//   2. Wildcard glob:  "JT*", "4069", "Z?9" (* = any chars, ? = one char)
//   3. Plain exact:    "9999"
function patternToMatcher(pattern) {
  const trimmed = String(pattern).trim();

  // Numeric range
  const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
  if (rangeMatch) {
    let lo = parseInt(rangeMatch[1], 10);
    let hi = parseInt(rangeMatch[2], 10);
    if (lo > hi) [lo, hi] = [hi, lo];
    return (itemNumber) => {
      const n = parseInt(itemNumber, 10);
      // Reject items whose first non-digit prefix breaks the parse —
      // e.g. "JT123" should never match a numeric range even though
      // parseInt would return NaN here. Belt and braces.
      return !Number.isNaN(n) && /^\d+$/.test(String(itemNumber).trim()) && n >= lo && n <= hi;
    };
  }

  // Glob with * and ? wildcards. Escape every regex special except those,
  // then translate them. Anchored to a full match.
  const escaped = trimmed
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const regex = new RegExp(`^${escaped}$`, 'i');
  return (itemNumber) => regex.test(itemNumber);
}

function loadExclusionMatcher() {
  const patterns = db.prepare('SELECT pattern FROM price_list_exclusions').all().map(r => r.pattern);
  if (patterns.length === 0) return () => false;
  const matchers = patterns.map(patternToMatcher);
  return (itemNumber) => matchers.some(m => m(itemNumber));
}

function itemsForSupplier(supplier) {
  return new Set(db.prepare(`
    SELECT item_number FROM (
      SELECT TRIM(srl.item_number) AS item_number,
             TRIM(sr.supplier_name) AS supplier_name,
             ROW_NUMBER() OVER (PARTITION BY TRIM(srl.item_number) ORDER BY sr.receipt_date DESC) AS rn
      FROM stock_receipt_line srl
      JOIN stock_receipt sr ON sr.id = srl.receipt_id
      WHERE TRIM(COALESCE(sr.supplier_name, '')) != ''
    ) WHERE rn = 1 AND supplier_name = ?
  `).all(supplier).map(r => r.item_number));
}

export async function getPriceLists() {
  try {
    const pool = await getSagePool();
    const r = await pool.request().query(`
      SELECT
        LTRIM(RTRIM(PRICELIST)) AS code,
        COUNT(DISTINCT ITEMNO)  AS item_count
      FROM ICPRICP
      WHERE LTRIM(RTRIM(PRICELIST)) <> ''
        AND UNITPRICE > 0
      GROUP BY LTRIM(RTRIM(PRICELIST))
      ORDER BY 1
    `);
    return r.recordset;
  } catch (err) {
    logError('pricing.lists', err);
    throw err;
  }
}

export async function getPriceListItems({ priceList, commodity, supplier }) {
  try {
  // Supplier filter is applied locally because Sage doesn't hold the
  // item-to-supplier mapping we use (it comes from the local
  // stock_receipt table). Build the set first; if empty, short-circuit.
  let supplierSet = null;
  if (supplier) {
    supplierSet = itemsForSupplier(supplier);
    if (supplierSet.size === 0) return [];
  }

  const pool = await getSagePool();
  const req = pool.request().input('list', sql.VarChar(6), priceList);
  let where = "p.PRICELIST = @list AND p.UNITPRICE > 0";
  if (commodity) {
    req.input('cmd', sql.VarChar(16), commodity);
    where += " AND LTRIM(RTRIM(i.COMMODIM)) = @cmd";
  }
  // DESC is a reserved word — wrap with brackets.
  const r = await req.query(`
    SELECT
      LTRIM(RTRIM(i.ITEMNO))    AS item_number,
      LTRIM(RTRIM(i.[DESC]))    AS item_description,
      LTRIM(RTRIM(i.COMMODIM))  AS commodity,
      LTRIM(RTRIM(p.QTYUNIT))   AS uom,
      MAX(p.UNITPRICE)          AS price
    FROM ICPRICP p
    INNER JOIN ICITEM i ON i.ITEMNO = p.ITEMNO
    WHERE ${where}
    GROUP BY
      LTRIM(RTRIM(i.ITEMNO)),
      LTRIM(RTRIM(i.[DESC])),
      LTRIM(RTRIM(i.COMMODIM)),
      LTRIM(RTRIM(p.QTYUNIT))
    ORDER BY LTRIM(RTRIM(i.ITEMNO))
  `);
  let rows = r.recordset;
  if (supplierSet) rows = rows.filter(row => supplierSet.has(row.item_number));
  // Exclusion patterns are applied last so they also catch items
  // already narrowed by supplier or commodity filters.
  const isExcluded = loadExclusionMatcher();
  rows = rows.filter(row => !isExcluded(row.item_number));
  return rows;
  } catch (err) {
    logError('pricing.items', err, { priceList, commodity, supplier });
    throw err;
  }
}
