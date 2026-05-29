import db from '../db/index.js';
import { logError } from '../lib/errorLog.js';

const Z_SCORES = { 0.90: 1.28, 0.95: 1.65, 0.97: 1.88, 0.99: 2.33 };

function zScore(serviceLevel) {
  if (Z_SCORES[serviceLevel]) return Z_SCORES[serviceLevel];
  const sorted = Object.entries(Z_SCORES).sort((a, b) => Math.abs(a[0] - serviceLevel) - Math.abs(b[0] - serviceLevel));
  return sorted[0][1];
}

function getConfig(itemNumber) {
  const item = itemNumber ? db.prepare('SELECT * FROM inventory_forecast_config WHERE item_number = ?').get(itemNumber) : null;
  const global = db.prepare("SELECT * FROM inventory_forecast_config WHERE item_number = '__global__'").get();
  return {
    lead_time_days: item?.lead_time_days ?? global?.lead_time_days ?? 7,
    order_cycle_days: item?.order_cycle_days ?? global?.order_cycle_days ?? 14,
    service_level: item?.service_level ?? global?.service_level ?? 0.95,
    min_order_qty: item?.min_order_qty ?? global?.min_order_qty ?? 0,
  };
}

export function computeAllForecasts() {
  logError('inventoryForecast.run', new Error('inventoryForecast.run starting'), {}, 'info');
  try {
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentPeriod = `${now.getFullYear()}-${String(currentMonth).padStart(2, '0')}`;

  const items = db.prepare(`
    SELECT DISTINCT sc.item_number
    FROM inventory_sales_cache sc
    INNER JOIN inventoryrecord ir ON TRIM(ir.item_number) = sc.item_number
  `).all();

  const allMonthly = db.prepare(`
    SELECT item_number, period, qty_sold, revenue
    FROM inventory_sales_cache
    ORDER BY item_number, period DESC
  `).all();

  // Exclude the current (partial) month from moving average inputs.
  // A partial month getting top weight systematically depresses the
  // forecast, especially early in the month. The currentPeriod filter
  // ensures only complete months drive the weighted average.
  const monthlyByItem = new Map();
  for (const r of allMonthly) {
    if (r.period === currentPeriod) continue;
    if (!monthlyByItem.has(r.item_number)) monthlyByItem.set(r.item_number, []);
    monthlyByItem.get(r.item_number).push(r);
  }

  // ABC uses all months including the current partial one (revenue
  // ranking shouldn't exclude current-month sales).
  const totalRevenue = allMonthly.reduce((s, r) => s + (r.revenue || 0), 0);
  const revenueByItem = new Map();
  for (const r of allMonthly) {
    revenueByItem.set(r.item_number, (revenueByItem.get(r.item_number) || 0) + (r.revenue || 0));
  }

  // Seasonality uses complete months only — a partial current month
  // would depress the index for this calendar month (especially early
  // in the month), underestimating adjusted demand.
  const seasonalByItem = new Map();
  for (const r of allMonthly) {
    if (r.period === currentPeriod) continue;
    if (!seasonalByItem.has(r.item_number)) seasonalByItem.set(r.item_number, []);
    seasonalByItem.get(r.item_number).push(r);
  }

  const sortedByRevenue = [...revenueByItem.entries()].sort((a, b) => b[1] - a[1]);
  const abcMap = new Map();
  let cumulative = 0;
  for (const [item, rev] of sortedByRevenue) {
    cumulative += rev;
    const share = totalRevenue > 0 ? cumulative / totalRevenue : 1;
    abcMap.set(item, share <= 0.80 ? 'A' : share <= 0.95 ? 'B' : 'C');
  }

  let stdDevByItem = new Map();
  try {
    const rows = db.prepare(`
      SELECT item_number,
             COUNT(DISTINCT transaction_date) AS days_with_sales,
             SUM(qty_sold) AS total_qty
      FROM inventory_sales_transactions
      GROUP BY item_number
    `).all();
    for (const r of rows) {
      if (r.days_with_sales > 1) {
        const dailyAvg = r.total_qty / r.days_with_sales;
        const varRows = db.prepare(`
          SELECT SUM((daily_qty - ?) * (daily_qty - ?)) / ? AS variance
          FROM (
            SELECT SUM(qty_sold) AS daily_qty
            FROM inventory_sales_transactions
            WHERE item_number = ?
            GROUP BY transaction_date
          )
        `).get(dailyAvg, dailyAvg, r.days_with_sales, r.item_number);
        stdDevByItem.set(r.item_number, Math.sqrt(Math.max(0, varRows?.variance || 0)));
      }
    }
  } catch (err) {
    console.error('[forecast] Failed to compute demand std dev — safety stock will default to 0:', err.message);
  }

  const inventoryMap = new Map();
  try {
    const invRows = db.prepare(`
      SELECT TRIM(item_number) AS item_number,
             CAST(REPLACE(REPLACE(COALESCE(qty_on_hand, '0'), ',', ''), ' ', '') AS REAL) AS qty_on_hand
      FROM inventoryrecord
    `).all();
    for (const r of invRows) {
      if (!inventoryMap.has(r.item_number) || r.qty_on_hand > inventoryMap.get(r.item_number)) {
        inventoryMap.set(r.item_number, r.qty_on_hand);
      }
    }
  } catch (err) {
    console.error('[forecast] Failed to read inventory qty — days_of_stock will be null:', err.message);
  }

  const upsert = db.prepare(`
    INSERT INTO inventory_forecast (
      item_number, avg_daily_demand, demand_std_dev,
      weighted_avg_3m, weighted_avg_6m,
      seasonality_index, adjusted_demand,
      safety_stock, reorder_point, days_of_stock, suggested_order_qty,
      abc_class, computed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(item_number) DO UPDATE SET
      avg_daily_demand=excluded.avg_daily_demand,
      demand_std_dev=excluded.demand_std_dev,
      weighted_avg_3m=excluded.weighted_avg_3m,
      weighted_avg_6m=excluded.weighted_avg_6m,
      seasonality_index=excluded.seasonality_index,
      adjusted_demand=excluded.adjusted_demand,
      safety_stock=excluded.safety_stock,
      reorder_point=excluded.reorder_point,
      days_of_stock=excluded.days_of_stock,
      suggested_order_qty=excluded.suggested_order_qty,
      abc_class=excluded.abc_class,
      computed_at=excluded.computed_at
  `);

  let computed = 0;
  const daysInMonth = new Date(now.getFullYear(), currentMonth, 0).getDate();

  const validItems = new Set();

  db.transaction(() => {
    for (const { item_number } of items) {
      const months = monthlyByItem.get(item_number) || [];
      if (months.length === 0) continue;

      const config = getConfig(item_number);

      // Weighted moving averages (most recent first in the array)
      const wma3 = weightedAvg(months.slice(0, 3), [3, 2, 1]);
      const wma6 = weightedAvg(months.slice(0, 6), [6, 5, 4, 3, 2, 1]);

      // Seasonality index
      const seasonality = computeSeasonality(seasonalByItem.get(item_number) || months, currentMonth);

      // Adjusted monthly demand
      const adjustedMonthly = (wma3 || 0) * seasonality;
      const dailyDemand = adjustedMonthly / daysInMonth;

      // Overall average daily demand (for reference)
      const totalQty = months.reduce((s, m) => s + (m.qty_sold || 0), 0);
      const totalMonths = months.length;
      const avgDaily = totalMonths > 0 ? totalQty / (totalMonths * 30) : 0;

      // Standard deviation of daily demand
      const stdDev = stdDevByItem.get(item_number) || 0;

      // Safety stock
      const z = zScore(config.service_level);
      const safetyStock = z * stdDev * Math.sqrt(config.lead_time_days);

      // Reorder point
      const reorderPoint = dailyDemand * config.lead_time_days + safetyStock;

      // Days of stock
      const qtyOnHand = inventoryMap.get(item_number) || 0;
      const daysOfStock = dailyDemand > 0 ? qtyOnHand / dailyDemand : null;

      // Suggested order qty
      let suggestedQty = (dailyDemand * config.order_cycle_days) + safetyStock - qtyOnHand;
      suggestedQty = Math.max(0, suggestedQty);
      if (suggestedQty > 0 && config.min_order_qty > 0) {
        suggestedQty = Math.max(suggestedQty, config.min_order_qty);
      }

      upsert.run(
        item_number,
        round2(avgDaily),
        round2(stdDev),
        round2(wma3),
        round2(wma6),
        round2(seasonality),
        round2(adjustedMonthly),
        round2(safetyStock),
        round2(reorderPoint),
        daysOfStock != null ? round1(daysOfStock) : null,
        round1(suggestedQty),
        abcMap.get(item_number) || 'C',
      );
      validItems.add(item_number);
      computed++;
    }

    // Prune forecast rows for items no longer in scope (removed from
    // inventory or no sales history). Without this, stale rows
    // accumulate and operators see obsolete SKUs with outdated
    // demand/reorder values.
    const existing = db.prepare('SELECT item_number FROM inventory_forecast').all();
    for (const { item_number } of existing) {
      if (!validItems.has(item_number)) {
        db.prepare('DELETE FROM inventory_forecast WHERE item_number = ?').run(item_number);
      }
    }
  })();

  logError('inventoryForecast.run', new Error(`inventoryForecast.run completed: ${computed} items`), { computed }, 'info');
  return { computed };
  } catch (err) {
    logError('inventoryForecast.run', err);
    throw err;
  }
}

function weightedAvg(months, weights) {
  if (months.length === 0) return 0;
  let sum = 0;
  let wSum = 0;
  for (let i = 0; i < months.length && i < weights.length; i++) {
    sum += (months[i].qty_sold || 0) * weights[i];
    wSum += weights[i];
  }
  return wSum > 0 ? sum / wSum : 0;
}

function computeSeasonality(months, targetMonth) {
  if (months.length < 12) return 1.0;

  const byCalMonth = new Map();
  for (const m of months) {
    const calMonth = parseInt(m.period.split('-')[1], 10);
    if (!byCalMonth.has(calMonth)) byCalMonth.set(calMonth, []);
    byCalMonth.get(calMonth).push(m.qty_sold || 0);
  }

  const overallAvg = months.reduce((s, m) => s + (m.qty_sold || 0), 0) / months.length;
  if (overallAvg <= 0) return 1.0;

  const targetValues = byCalMonth.get(targetMonth) || [];
  if (targetValues.length === 0) return 1.0;

  const targetAvg = targetValues.reduce((s, v) => s + v, 0) / targetValues.length;
  const index = targetAvg / overallAvg;

  return Math.max(0.1, Math.min(5.0, index));
}

function round2(v) { return v != null ? Math.round(v * 100) / 100 : null; }
function round1(v) { return v != null ? Math.round(v * 10) / 10 : null; }

export function getForecastList({ sortField = 'days_of_stock', sortDir = 'asc', abcFilter, limit = 200, commodity, supplier }) {
  let where = 'WHERE 1=1';
  const params = [];
  if (abcFilter && abcFilter !== 'all') { where += ' AND f.abc_class = ?'; params.push(abcFilter); }
  if (commodity && commodity !== 'all') { where += ' AND ir.commodity = ?'; params.push(commodity); }

  // Supplier filter — same latest-receipt definition used by Top Movers
  // and Dead Stock. INNER JOIN drops items that have never been received.
  const supplierJoin = supplier && supplier !== 'all'
    ? `INNER JOIN (
        SELECT item_number, supplier_name FROM (
          SELECT TRIM(srl.item_number) AS item_number,
                 TRIM(sr.supplier_name) AS supplier_name,
                 ROW_NUMBER() OVER (PARTITION BY TRIM(srl.item_number) ORDER BY sr.receipt_date DESC) AS rn
          FROM stock_receipt_line srl
          JOIN stock_receipt sr ON sr.id = srl.receipt_id
          WHERE TRIM(COALESCE(sr.supplier_name, '')) != ''
        ) WHERE rn = 1
      ) sp ON sp.item_number = f.item_number AND sp.supplier_name = ?`
    : '';
  if (supplier && supplier !== 'all') params.push(supplier);

  const safeLimit = Math.max(1, Math.min(limit, 1000));
  params.push(safeLimit);

  const validSorts = ['days_of_stock', 'suggested_order_qty', 'adjusted_demand', 'avg_daily_demand', 'reorder_point', 'abc_class', 'item_number'];
  const col = validSorts.includes(sortField) ? `f.${sortField}` : 'f.days_of_stock';
  const dir = sortDir === 'desc' ? 'DESC' : 'ASC';
  const nulls = dir === 'ASC' ? 'NULLS LAST' : 'NULLS FIRST';

  return db.prepare(`
    SELECT
      f.*,
      ir.item_description,
      ir.commodity,
      CAST(REPLACE(REPLACE(COALESCE(ir.qty_on_hand, '0'), ',', ''), ' ', '') AS REAL) AS qty_on_hand,
      ir.price
    FROM inventory_forecast f
    LEFT JOIN (
      SELECT TRIM(item_number) AS item_number,
             TRIM(item_description) AS item_description,
             TRIM(commodity) AS commodity,
             qty_on_hand,
             TRIM(price) AS price,
             ROW_NUMBER() OVER (PARTITION BY TRIM(item_number) ORDER BY updated_date DESC) AS rn
      FROM inventoryrecord
    ) ir ON ir.item_number = f.item_number AND ir.rn = 1
    ${supplierJoin}
    ${where}
    ORDER BY ${col} ${dir} ${nulls}
    LIMIT ?
  `).all(...params);
}

// Items that need ordering now: forecast rows with a positive suggested order
// qty (qty on hand already below the order-up-to level). Enriched with the
// latest supplier (LEFT JOIN, so items never received still surface under
// "— No supplier") and ordered supplier-first for a purchase worklist.
export function getReorderPlan({ commodity, supplier } = {}) {
  let where = 'WHERE f.suggested_order_qty > 0';
  const params = [];
  if (commodity && commodity !== 'all') { where += ' AND ir.commodity = ?'; params.push(commodity); }
  if (supplier && supplier !== 'all') { where += " AND COALESCE(sp.supplier_name, '') = ?"; params.push(supplier); }

  return db.prepare(`
    SELECT
      f.item_number,
      f.abc_class,
      f.adjusted_demand,
      f.reorder_point,
      f.days_of_stock,
      f.suggested_order_qty,
      ir.item_description,
      ir.commodity,
      CAST(REPLACE(REPLACE(COALESCE(ir.qty_on_hand, '0'), ',', ''), ' ', '') AS REAL) AS qty_on_hand,
      ir.price,
      COALESCE(sp.supplier_name, '— No supplier') AS supplier_name
    FROM inventory_forecast f
    LEFT JOIN (
      SELECT TRIM(item_number) AS item_number,
             TRIM(item_description) AS item_description,
             TRIM(commodity) AS commodity,
             qty_on_hand,
             TRIM(price) AS price,
             ROW_NUMBER() OVER (PARTITION BY TRIM(item_number) ORDER BY updated_date DESC) AS rn
      FROM inventoryrecord
    ) ir ON ir.item_number = f.item_number AND ir.rn = 1
    LEFT JOIN (
      SELECT item_number, supplier_name FROM (
        SELECT TRIM(srl.item_number) AS item_number,
               TRIM(sr.supplier_name) AS supplier_name,
               ROW_NUMBER() OVER (PARTITION BY TRIM(srl.item_number) ORDER BY sr.receipt_date DESC) AS rn
        FROM stock_receipt_line srl
        JOIN stock_receipt sr ON sr.id = srl.receipt_id
        WHERE TRIM(COALESCE(sr.supplier_name, '')) != ''
      ) WHERE rn = 1
    ) sp ON sp.item_number = f.item_number
    ${where}
    ORDER BY supplier_name ASC, f.days_of_stock ASC NULLS LAST
  `).all(...params);
}

export function getForecastConfig() {
  return db.prepare("SELECT * FROM inventory_forecast_config WHERE item_number = '__global__'").get() || {
    lead_time_days: 7, order_cycle_days: 14, service_level: 0.95, min_order_qty: 0,
  };
}

export function updateForecastConfig({ leadTimeDays, orderCycleDays, serviceLevel, minOrderQty }) {
  try {
    db.prepare(`
      UPDATE inventory_forecast_config SET
        lead_time_days = COALESCE(?, lead_time_days),
        order_cycle_days = COALESCE(?, order_cycle_days),
        service_level = COALESCE(?, service_level),
        min_order_qty = COALESCE(?, min_order_qty)
      WHERE item_number = '__global__'
    `).run(
      leadTimeDays != null ? parseInt(leadTimeDays, 10) : null,
      orderCycleDays != null ? parseInt(orderCycleDays, 10) : null,
      serviceLevel != null ? parseFloat(serviceLevel) : null,
      minOrderQty != null ? parseFloat(minOrderQty) : null,
    );
  } catch (err) {
    logError('inventoryForecast.config_update', err, { leadTimeDays, orderCycleDays, serviceLevel, minOrderQty });
    throw err;
  }
}

export function getItemSeasonality(itemNumber) {
  const months = db.prepare(`
    SELECT period, qty_sold
    FROM inventory_sales_cache
    WHERE item_number = ?
    ORDER BY period ASC
  `).all(itemNumber);

  if (months.length < 12) return { hasData: false, profile: [] };

  const byCalMonth = new Map();
  for (const m of months) {
    const calMonth = parseInt(m.period.split('-')[1], 10);
    if (!byCalMonth.has(calMonth)) byCalMonth.set(calMonth, []);
    byCalMonth.get(calMonth).push(m.qty_sold || 0);
  }

  const overallAvg = months.reduce((s, m) => s + (m.qty_sold || 0), 0) / months.length;
  const profile = [];
  for (let m = 1; m <= 12; m++) {
    const values = byCalMonth.get(m) || [];
    const monthAvg = values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
    profile.push({
      month: m,
      label: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1],
      avg_qty: Math.round(monthAvg),
      index: overallAvg > 0 ? Math.round((monthAvg / overallAvg) * 100) / 100 : 1.0,
    });
  }

  return { hasData: true, profile };
}
