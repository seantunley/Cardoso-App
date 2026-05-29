import sql from 'mssql';
import db from '../db/index.js';
import { getSagePool } from './batReconciliation.js';

function toYyyymmdd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export async function syncSalesFromSage({ fromDate, toDate } = {}) {
  const pool = await getSagePool();
  const now = new Date();
  const to = toDate || now;
  // Default window: from Jan 1 of (current year - 3) so the cache
  // covers three FULL prior calendar years plus the current year-to-date.
  // Was 24 months back (rolling) which left the oldest year visibly
  // truncated on year-over-year charts (e.g. 2024 starting in May 2024
  // for runs done in 2026). The ON CONFLICT upsert keeps repeated runs
  // idempotent so the wider scan only costs Sage I/O on the initial
  // sync; subsequent nightly runs upsert the same window cheaply.
  const from = fromDate || new Date(now.getFullYear() - 3, 0, 1);

  const fromInt = parseInt(toYyyymmdd(from), 10);
  const toInt = parseInt(toYyyymmdd(to), 10);

  // Two parallel Sage queries: monthly aggregates for the dashboard,
  // and per-transaction rows for forecasting drill-through.
  const [aggResult, txnResult] = await Promise.all([
    pool.request()
      .input('from', sql.Int, fromInt)
      .input('to', sql.Int, toInt)
      .query(`
        SELECT
          LTRIM(RTRIM(OESHDT.ITEM))         AS item_number,
          FORMAT(CAST(CAST(OESHDT.TRANDATE AS VARCHAR(8)) AS DATE), 'yyyy-MM') AS period,
          SUM(OESHDT.QTYSOLD)               AS qty_sold,
          SUM(OESHDT.FAMTSALES)             AS revenue,
          COUNT(*)                           AS order_count,
          MAX(OESHDT.TRANDATE)              AS last_sale_int
        FROM OESHDT
        INNER JOIN ICITEM ON OESHDT.ITEM = ICITEM.ITEMNO
        WHERE OESHDT.TRANDATE BETWEEN @from AND @to
          AND OESHDT.QTYSOLD > 0
        GROUP BY LTRIM(RTRIM(OESHDT.ITEM)),
                 FORMAT(CAST(CAST(OESHDT.TRANDATE AS VARCHAR(8)) AS DATE), 'yyyy-MM')
        ORDER BY item_number, period
      `),
    pool.request()
      .input('from', sql.Int, fromInt)
      .input('to', sql.Int, toInt)
      .query(`
        SELECT
          LTRIM(RTRIM(OESHDT.ITEM))         AS item_number,
          OESHDT.TRANDATE                   AS transaction_date_int,
          LTRIM(RTRIM(OESHDT.TRANNUM))      AS order_number,
          LTRIM(RTRIM(OESHDT.CUSTOMER))     AS customer_code,
          LTRIM(RTRIM(ARCUS.NAMECUST))      AS customer_name,
          OESHDT.QTYSOLD                    AS qty_sold,
          CASE WHEN OESHDT.QTYSOLD > 0 THEN OESHDT.FAMTSALES / OESHDT.QTYSOLD ELSE NULL END AS unit_price,
          OESHDT.FAMTSALES                  AS line_amount
        FROM OESHDT
        INNER JOIN ICITEM ON OESHDT.ITEM = ICITEM.ITEMNO
        LEFT JOIN ARCUS ON OESHDT.CUSTOMER = ARCUS.IDCUST
        WHERE OESHDT.TRANDATE BETWEEN @from AND @to
          AND OESHDT.QTYSOLD > 0
        ORDER BY OESHDT.TRANDATE DESC, OESHDT.ITEM
      `),
  ]);

  const aggRows = aggResult.recordset || [];
  const txnRows = txnResult.recordset || [];

  function intToDate(n) {
    if (!n) return null;
    const s = String(n);
    return /^\d{8}$/.test(s) ? s.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : null;
  }

  const updateMeta = (count) => {
    try {
      db.prepare(`
        UPDATE inventory_sales_sync_meta SET
          last_synced_at = datetime('now'),
          last_synced_to = ?,
          rows_synced = ?
        WHERE id = 1
      `).run(`${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, '0')}-${String(to.getDate()).padStart(2, '0')}`, count);
    } catch (e) {
      console.error('[inventory-movement] Failed to update sync meta:', e.message);
    }
  };

  // Monthly aggregates → inventory_sales_cache (upsert)
  const upsertAgg = db.prepare(`
    INSERT INTO inventory_sales_cache (item_number, period, qty_sold, revenue, order_count, last_sale_date)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_number, period) DO UPDATE SET
      qty_sold = excluded.qty_sold,
      revenue = excluded.revenue,
      order_count = excluded.order_count,
      last_sale_date = CASE
        WHEN excluded.last_sale_date > inventory_sales_cache.last_sale_date
          THEN excluded.last_sale_date
        ELSE inventory_sales_cache.last_sale_date
      END
  `);

  // Per-transaction rows → inventory_sales_transactions (replace window)
  const insertTxn = db.prepare(`
    INSERT INTO inventory_sales_transactions
      (item_number, transaction_date, order_number, customer_code, customer_name, qty_sold, unit_price, line_amount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const fromDateStr = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`;
  const toDateStr = `${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, '0')}-${String(to.getDate()).padStart(2, '0')}`;

  db.transaction(() => {
    for (const r of aggRows) {
      upsertAgg.run(
        r.item_number,
        r.period,
        r.qty_sold || 0,
        Math.round((r.revenue || 0) * 100) / 100,
        r.order_count || 0,
        intToDate(r.last_sale_int),
      );
    }
    // Replace transaction rows for the synced window to avoid duplicates.
    db.prepare('DELETE FROM inventory_sales_transactions WHERE transaction_date >= ? AND transaction_date <= ?').run(fromDateStr, toDateStr);
    for (const r of txnRows) {
      insertTxn.run(
        r.item_number,
        intToDate(r.transaction_date_int),
        r.order_number || null,
        r.customer_code || null,
        r.customer_name || null,
        r.qty_sold || 0,
        r.unit_price != null ? Math.round(r.unit_price * 100) / 100 : null,
        r.line_amount != null ? Math.round(r.line_amount * 100) / 100 : null,
      );
    }
  })();

  updateMeta(aggRows.length);
  return { synced: aggRows.length, transactions: txnRows.length };
}

export function getSyncMeta() {
  return db.prepare('SELECT * FROM inventory_sales_sync_meta WHERE id = 1').get() || {};
}

export function getTopMovers({ from, to, limit = 50, commodity, supplier } = {}) {
  // Aggregate from inventory_sales_transactions (per-day rows) so any
  // date range works — including a single week. The from/to inputs are
  // YYYY-MM-DD; YYYY-MM is accepted for backwards compat and expanded
  // to the first/last day of that month.
  const expandFrom = (v) => v && v.length === 7 ? `${v}-01` : v;
  const expandTo = (v) => {
    if (!v) return v;
    if (v.length !== 7) return v;
    const [y, m] = v.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    return `${v}-${String(last).padStart(2, '0')}`;
  };
  const fromDate = expandFrom(from);
  const toDate = expandTo(to);

  let txnWhere = 'WHERE 1=1';
  const params = [];
  if (fromDate) { txnWhere += ' AND t.transaction_date >= ?'; params.push(fromDate); }
  if (toDate) { txnWhere += ' AND t.transaction_date <= ?'; params.push(toDate); }

  // When a commodity filter is active, use INNER JOIN so only items
  // matching that commodity appear. Without a filter, LEFT JOIN
  // preserves items that have sales data but no inventory record.
  let irFilter = '';
  const joinType = commodity ? 'INNER JOIN' : 'LEFT JOIN';
  if (commodity) { irFilter = 'WHERE TRIM(commodity) = ?'; params.push(commodity); }

  // Supplier filter — INNER JOIN against the latest-supplier subquery
  // and constrain. When no supplier is chosen, omit the join entirely
  // so items without receipt history still appear.
  const supplierJoin = supplier
    ? `INNER JOIN (${LATEST_SUPPLIER_SQL}) sp ON sp.item_number = agg.item_number AND sp.supplier_name = ?`
    : '';
  if (supplier) params.push(supplier);

  params.push(limit);

  return db.prepare(`
    SELECT
      agg.item_number,
      ir.item_description,
      ir.commodity,
      ir.qty_on_hand,
      ir.last_cost,
      ir.price,
      ir.stocking_uom,
      agg.total_qty_sold,
      agg.total_revenue,
      agg.total_orders,
      agg.last_sale_date
    FROM (
      SELECT
        t.item_number,
        SUM(t.qty_sold)              AS total_qty_sold,
        SUM(t.line_amount)           AS total_revenue,
        COUNT(*)                     AS total_orders,
        MAX(t.transaction_date)      AS last_sale_date
      FROM inventory_sales_transactions t
      ${txnWhere}
      GROUP BY t.item_number
    ) agg
    ${joinType} (
      SELECT TRIM(item_number)      AS item_number,
             TRIM(item_description) AS item_description,
             TRIM(commodity)        AS commodity,
             TRIM(qty_on_hand)      AS qty_on_hand,
             TRIM(last_cost)        AS last_cost,
             TRIM(price)            AS price,
             TRIM(stocking_uom)     AS stocking_uom,
             ROW_NUMBER() OVER (PARTITION BY TRIM(item_number) ORDER BY updated_date DESC) AS rn
      FROM inventoryrecord
      ${irFilter}
    ) ir ON ir.item_number = agg.item_number AND ir.rn = 1
    ${supplierJoin}
    ORDER BY agg.total_qty_sold DESC
    LIMIT ?
  `).all(...params);
}

export function getItemTrend({ itemNumber, from, to } = {}) {
  // Accept YYYY-MM-DD (from the day-precision selector) and slice to
  // YYYY-MM so the monthly-cache filter still matches. YYYY-MM passes
  // through unchanged.
  const monthOf = (v) => v ? v.slice(0, 7) : v;
  const fromMo = monthOf(from);
  const toMo = monthOf(to);

  let where = 'WHERE sc.item_number = ?';
  const params = [itemNumber];
  if (fromMo) { where += ' AND sc.period >= ?'; params.push(fromMo); }
  if (toMo) { where += ' AND sc.period <= ?'; params.push(toMo); }

  return db.prepare(`
    SELECT
      sc.period,
      sc.qty_sold,
      sc.revenue,
      sc.order_count,
      sc.last_sale_date
    FROM inventory_sales_cache sc
    ${where}
    ORDER BY sc.period ASC
  `).all(...params);
}

export function getDeadStock({ thresholdDays = 90, minValue = 0, limit = 100, commodity, supplier } = {}) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - thresholdDays);
  const cutoff = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, '0')}-${String(cutoffDate.getDate()).padStart(2, '0')}`;

  // Placeholders in the SQL appear in this order: supplier (in JOIN),
  // cutoff, minValue, commodity (in WHERE), limit. Push them to match.
  const params = [];
  const supplierJoin = supplier
    ? `INNER JOIN (${LATEST_SUPPLIER_SQL}) sp ON sp.item_number = ir.item_number AND sp.supplier_name = ?`
    : '';
  if (supplier) params.push(supplier);
  params.push(cutoff, minValue);
  const commodityFilter = commodity ? 'AND ir.commodity = ?' : '';
  if (commodity) params.push(commodity);
  params.push(limit);

  return db.prepare(`
    SELECT
      ir.item_number,
      ir.item_description,
      ir.commodity,
      ir.qty_num   AS qty_on_hand,
      ir.cost_num  AS last_cost,
      ir.price,
      ir.stocking_uom,
      COALESCE(sale.last_sale_date, 'never') AS last_sale_date,
      CASE
        WHEN sale.last_sale_date IS NULL THEN 999999
        ELSE CAST(julianday('now') - julianday(sale.last_sale_date) AS INTEGER)
      END AS days_since_sale,
      ROUND(ir.qty_num * ir.cost_num, 2) AS capital_tied_up
    FROM (
      SELECT TRIM(item_number) AS item_number,
             TRIM(item_description) AS item_description,
             TRIM(commodity) AS commodity,
             TRIM(qty_on_hand) AS qty_on_hand,
             TRIM(last_cost) AS last_cost,
             TRIM(price) AS price,
             TRIM(stocking_uom) AS stocking_uom,
             CAST(REPLACE(REPLACE(COALESCE(qty_on_hand, '0'), ',', ''), ' ', '') AS REAL) AS qty_num,
             CAST(REPLACE(REPLACE(COALESCE(last_cost, '0'), ',', ''), ' ', '') AS REAL) AS cost_num,
             ROW_NUMBER() OVER (PARTITION BY TRIM(item_number) ORDER BY updated_date DESC) AS rn
      FROM inventoryrecord
    ) ir
    LEFT JOIN (
      SELECT item_number, MAX(last_sale_date) AS last_sale_date
      FROM inventory_sales_cache
      GROUP BY item_number
    ) sale ON sale.item_number = ir.item_number
    ${supplierJoin}
    WHERE ir.rn = 1
      AND ir.qty_num > 0
      AND (sale.last_sale_date IS NULL OR sale.last_sale_date < ?)
      AND ROUND(ir.qty_num * ir.cost_num, 2) >= ?
      ${commodityFilter}
    ORDER BY capital_tied_up DESC
    LIMIT ?
  `).all(...params);
}

export function getCommodities() {
  return db.prepare(
    "SELECT DISTINCT TRIM(commodity) AS commodity FROM inventoryrecord WHERE commodity IS NOT NULL AND TRIM(commodity) != '' ORDER BY 1"
  ).all().map(r => r.commodity);
}

// Distinct supplier names sourced from Sage PO receipts. Used to populate
// the supplier filter dropdown on Top Movers and Dead Stock. Only suppliers
// that have actually shipped at least one item (qty > 0) are returned, so
// dropdowns don't fill up with stale or test vendor rows.
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

// Latest supplier per item, derived from the most recent receipt date.
// Pulled into its own helper because both Top Movers and Dead Stock need
// the same definition; if we ever switch to "preferred supplier" from
// Sage ICITEM directly, this is the one place to change.
const LATEST_SUPPLIER_SQL = `
  SELECT item_number, supplier_name FROM (
    SELECT TRIM(srl.item_number) AS item_number,
           TRIM(sr.supplier_name) AS supplier_name,
           ROW_NUMBER() OVER (PARTITION BY TRIM(srl.item_number) ORDER BY sr.receipt_date DESC) AS rn
    FROM stock_receipt_line srl
    JOIN stock_receipt sr ON sr.id = srl.receipt_id
    WHERE TRIM(COALESCE(sr.supplier_name, '')) != ''
  ) WHERE rn = 1
`;

export function getItemTransactions({ itemNumber, from, to, limit = 500 }) {
  let where = 'WHERE t.item_number = ?';
  const params = [itemNumber];
  if (from) { where += ' AND t.transaction_date >= ?'; params.push(from); }
  if (to) { where += ' AND t.transaction_date <= ?'; params.push(to); }
  const safeLimit = Math.max(1, Math.min(limit, 5000));
  params.push(safeLimit);

  return db.prepare(`
    SELECT
      t.transaction_date, t.order_number, t.customer_code, t.customer_name,
      t.qty_sold, t.unit_price, t.line_amount
    FROM inventory_sales_transactions t
    ${where}
    ORDER BY t.transaction_date DESC, t.id DESC
    LIMIT ?
  `).all(...params);
}

export function getItemStats({ itemNumber }) {
  const row = db.prepare(`
    SELECT
      COUNT(*)                AS total_transactions,
      SUM(qty_sold)           AS total_qty,
      ROUND(AVG(qty_sold), 2) AS avg_qty_per_txn,
      MIN(transaction_date)   AS first_sale,
      MAX(transaction_date)   AS last_sale,
      COUNT(DISTINCT customer_code) AS unique_customers,
      ROUND(
        CASE WHEN COUNT(*) > 1
          THEN CAST(julianday(MAX(transaction_date)) - julianday(MIN(transaction_date)) AS REAL) / (COUNT(*) - 1)
          ELSE NULL
        END, 1
      ) AS avg_days_between_sales
    FROM inventory_sales_transactions
    WHERE item_number = ?
  `).get(itemNumber);
  return row || {};
}
