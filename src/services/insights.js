// Proactive insights engine. Runs cheap rule-based detectors over data the app
// already syncs (monthly sales cache, per-line sales transactions, inventory,
// debtor balances) and returns a ranked feed of "things worth looking at".
//
// Two layers:
//   1. Built-in detectors — curated, with tailored copy.
//   2. Custom rules — operator-defined thresholds (insight_rules table) on a
//      fixed METRIC_CATALOG of values the engine computes. The metric is a safe
//      enum (no stored SQL), so the no-code builder is injection-safe.
//
// Each detector is guarded so one failing query can't sink the whole feed
// (failures are logged, never silently swallowed). Site-mode only: it reads the
// local sales cache, which the hub doesn't populate.
import db from '../db/index.js';
import { logError } from '../lib/errorLog.js';
import { getDeadStock } from './inventoryMovement.js';

const COMMODITY_LABELS = { '1': 'Sweets', '2': 'Cigarettes', '3': 'Tobacco', '4': 'Mixed' };
const pct = (cur, base) => (base > 0 ? ((cur - base) / base) * 100 : 0);
const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const rZA = (n) => `R ${Math.round(Number(n) || 0).toLocaleString('en-ZA')}`;

// Metrics a custom rule can test. `unit` drives formatting + the builder UI.
export const METRIC_CATALOG = [
  { key: 'revenue_last_month', label: 'Revenue — last complete month', unit: 'rand' },
  { key: 'revenue_mom_pct', label: 'Revenue — month-on-month change', unit: 'pct' },
  { key: 'total_outstanding', label: 'Total outstanding (all debtors)', unit: 'rand' },
  { key: 'high_balance_debtor_count', label: 'Customers owing over R10,000', unit: 'count' },
  { key: 'dead_stock_capital', label: 'Capital tied up in dead stock', unit: 'rand' },
  { key: 'dead_stock_count', label: 'Dead-stock item count', unit: 'count' },
  { key: 'at_risk_customer_count', label: 'At-risk customers (spend halved)', unit: 'count' },
];
const METRIC_UNIT = Object.fromEntries(METRIC_CATALOG.map((m) => [m.key, m.unit]));
const fmtMetric = (key, v) => (METRIC_UNIT[key] === 'rand' ? rZA(v) : METRIC_UNIT[key] === 'pct' ? `${(Number(v) || 0).toFixed(1)}%` : String(Math.round(Number(v) || 0)));
const OPERATORS = { gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b };
const OP_LABEL = { gt: '>', gte: '≥', lt: '<', lte: '≤' };

// Short-lived cache. Insights aren't real-time — recomputing the full detector
// suite (a full inventory scan, several sales-cache scans, the transactions
// scan and dead-stock) on every dashboard/Insights load is wasteful. Cache for
// a few minutes; rule edits invalidate it so changes show immediately.
let _cache = null;
let _cacheAt = 0;
const INSIGHTS_TTL_MS = 5 * 60 * 1000;
function invalidateInsightsCache() { _cache = null; }

export function computeInsights() {
  const now = Date.now();
  if (_cache && now - _cacheAt < INSIGHTS_TTL_MS) return _cache;
  const result = buildInsights();
  _cache = result;
  _cacheAt = now;
  return result;
}

function buildInsights() {
  if (process.env.HUB_MODE === 'true') {
    return { generated_at: new Date().toISOString(), hub_mode: true, insights: [], metrics: {} };
  }

  const now = new Date();
  const lastM = ym(new Date(now.getFullYear(), now.getMonth() - 1, 1));   // last complete month
  const prevM = ym(new Date(now.getFullYear(), now.getMonth() - 2, 1));
  const prev3 = [1, 2, 3].map((i) => ym(new Date(now.getFullYear(), now.getMonth() - i, 1)));

  const insights = [];
  const metrics = {}; // METRIC_CATALOG values, for custom-rule evaluation
  const add = (i) => insights.push(i);
  const detect = (name, fn) => {
    try { fn(); } catch (err) {
      console.error(`[insights] detector "${name}" failed:`, err.message);
      try { logError('insights.detector', err, { detector: name }, 'warn'); } catch { /* already logged to console */ }
    }
  };

  // item -> { commodity, qty } (highest qty row per item)
  const itemMeta = new Map();
  detect('item-meta', () => {
    const rows = db.prepare(`
      SELECT TRIM(item_number) AS item_number, TRIM(commodity) AS commodity,
             CAST(REPLACE(REPLACE(COALESCE(qty_on_hand,'0'),',',''),' ','') AS REAL) AS qty
      FROM inventoryrecord
    `).all();
    for (const r of rows) {
      if (!itemMeta.has(r.item_number) || r.qty > (itemMeta.get(r.item_number).qty || 0)) {
        itemMeta.set(r.item_number, { commodity: r.commodity, qty: r.qty });
      }
    }
  });

  // 1. Overall revenue: last complete month vs the month before -------------
  detect('revenue-trend', () => {
    const sum = db.prepare('SELECT COALESCE(SUM(revenue),0) AS rev FROM inventory_sales_cache WHERE period = ?');
    const last = sum.get(lastM).rev;
    const prev = sum.get(prevM).rev;
    metrics.revenue_last_month = last;
    metrics.revenue_mom_pct = prev > 0 ? pct(last, prev) : 0;
    if (prev <= 0) return;
    const change = metrics.revenue_mom_pct;
    if (change <= -15) {
      add({ id: 'revenue-decline', category: 'Sales', severity: change <= -30 ? 'high' : 'medium',
        title: `Revenue down ${Math.abs(change).toFixed(0)}% month-on-month`,
        detail: `${rZA(last)} in ${lastM} vs ${rZA(prev)} in ${prevM}.`, value: Math.abs(change), link: '/Trends' });
    } else if (change >= 15) {
      add({ id: 'revenue-up', category: 'Sales', severity: 'info',
        title: `Revenue up ${change.toFixed(0)}% month-on-month`,
        detail: `${rZA(last)} in ${lastM} vs ${rZA(prev)} in ${prevM}.`, value: change, link: '/Trends' });
    }
  });

  // 2. Commodity-level decline ----------------------------------------------
  detect('commodity-shift', () => {
    const rows = db.prepare('SELECT item_number, period, revenue FROM inventory_sales_cache WHERE period IN (?, ?)').all(lastM, prevM);
    const byComm = new Map();
    for (const r of rows) {
      const comm = itemMeta.get(r.item_number)?.commodity || 'Unknown';
      if (!byComm.has(comm)) byComm.set(comm, { last: 0, prev: 0 });
      byComm.get(comm)[r.period === lastM ? 'last' : 'prev'] += r.revenue || 0;
    }
    for (const [comm, v] of byComm) {
      if (v.prev < 5000) continue;
      const change = pct(v.last, v.prev);
      if (change <= -20) {
        add({ id: `commodity-decline-${comm}`, category: 'Sales', severity: 'medium',
          title: `${COMMODITY_LABELS[comm] || `Commodity ${comm}`} sales down ${Math.abs(change).toFixed(0)}%`,
          detail: `${rZA(v.last)} in ${lastM} vs ${rZA(v.prev)} in ${prevM}.`, value: Math.abs(change), link: '/Trends' });
      }
    }
  });

  // 3. Top SKU decliners (last month vs prior 3-month average) --------------
  detect('sku-decliners', () => {
    const rows = db.prepare('SELECT item_number, period, revenue FROM inventory_sales_cache WHERE period IN (?, ?, ?, ?)').all(lastM, ...prev3);
    const byItem = new Map();
    for (const r of rows) {
      if (!byItem.has(r.item_number)) byItem.set(r.item_number, { last: 0, priorSum: 0, priorN: 0 });
      const e = byItem.get(r.item_number);
      if (r.period === lastM) e.last += r.revenue || 0;
      else { e.priorSum += r.revenue || 0; e.priorN += 1; }
    }
    const desc = db.prepare('SELECT TRIM(item_description) AS d FROM inventoryrecord WHERE TRIM(item_number) = ? LIMIT 1');
    const candidates = [];
    for (const [item, e] of byItem) {
      const baseline = e.priorN ? e.priorSum / e.priorN : 0;
      if (baseline < 1000) continue;
      const change = pct(e.last, baseline);
      if (change <= -40) candidates.push({ item, drop: baseline - e.last, change, baseline, last: e.last });
    }
    candidates.sort((a, b) => b.drop - a.drop);
    for (const c of candidates.slice(0, 3)) {
      const name = desc.get(c.item)?.d || c.item;
      add({ id: `sku-decline-${c.item}`, category: 'Sales', severity: 'medium',
        title: `${name} sales fell ${Math.abs(c.change).toFixed(0)}%`,
        detail: `${rZA(c.last)} last month vs a ${rZA(c.baseline)}/mo baseline.`, value: c.drop, link: '/InventoryMovement' });
    }
  });

  // 4. At-risk customers: spend in last 30 days vs the prior 30 -------------
  detect('at-risk-customers', () => {
    // Compare the bare transaction_date column against precomputed cutoff
    // strings so SQLite can use idx_inv_txn_date — wrapping the column in
    // date() would force a full table scan of the (large) transactions table.
    const { d30, d60 } = db.prepare("SELECT date(now_local(), '-30 days') AS d30, date(now_local(), '-60 days') AS d60").get();
    const rows = db.prepare(`
      SELECT customer_code, MAX(customer_name) AS customer_name,
             SUM(CASE WHEN transaction_date >= @d30 THEN COALESCE(line_amount,0) ELSE 0 END) AS recent,
             SUM(CASE WHEN transaction_date >= @d60 AND transaction_date < @d30 THEN COALESCE(line_amount,0) ELSE 0 END) AS prior
      FROM inventory_sales_transactions
      WHERE transaction_date >= @d60 AND customer_code IS NOT NULL AND customer_code != ''
      GROUP BY customer_code HAVING prior >= 2000
    `).all({ d30, d60 });
    const dropped = rows.filter((r) => r.recent <= r.prior * 0.5).sort((a, b) => (b.prior - b.recent) - (a.prior - a.recent));
    metrics.at_risk_customer_count = dropped.length;
    if (dropped.length === 0) return;
    const top = dropped.slice(0, 5).map((r) => (r.customer_name || r.customer_code || '').trim()).filter(Boolean);
    add({ id: 'at-risk-customers', category: 'Customers', severity: dropped.length >= 5 ? 'high' : 'medium',
      title: `${dropped.length} customer${dropped.length === 1 ? '' : 's'} buying less`,
      detail: `Spend at least halved vs the prior 30 days. e.g. ${top.join(', ')}.`, value: dropped.length, link: '/Collections' });
  });

  // 5. Dead-stock build-up ---------------------------------------------------
  detect('dead-stock', () => {
    const rows = getDeadStock({ thresholdDays: 90, minValue: 0, limit: 5000 });
    const capital = rows.reduce((s, r) => s + (r.capital_tied_up || 0), 0);
    metrics.dead_stock_capital = capital;
    metrics.dead_stock_count = rows.length;
    if (capital < 10000) return;
    add({ id: 'dead-stock', category: 'Inventory', severity: capital >= 100000 ? 'high' : 'medium',
      title: `${rZA(capital)} tied up in dead stock`,
      detail: `${rows.length} item${rows.length === 1 ? '' : 's'} with no sale in 90+ days.`, value: capital, link: '/InventoryMovement' });
  });

  // 6. Debtor exposure -------------------------------------------------------
  detect('debtor-exposure', () => {
    const r = db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(outstanding_balance_num),0) AS hi FROM datarecord WHERE outstanding_balance_num > 10000").get();
    const all = db.prepare("SELECT COALESCE(SUM(outstanding_balance_num),0) AS total FROM datarecord WHERE outstanding_balance_num > 0").get();
    metrics.high_balance_debtor_count = r?.c || 0;
    metrics.total_outstanding = all?.total || 0;
    if (!r || r.c === 0) return;
    add({ id: 'debtor-exposure', category: 'Receivables', severity: 'low',
      title: `${r.c} customer${r.c === 1 ? '' : 's'} owe over R10,000`,
      detail: `${rZA(r.hi)} concentrated in high-balance accounts.`, value: r.hi, link: '/Reports?report=aged-debtors' });
  });

  // 7. Custom rules ----------------------------------------------------------
  detect('custom-rules', () => {
    const rules = db.prepare('SELECT * FROM insight_rules WHERE enabled = 1').all();
    for (const rule of rules) {
      const value = metrics[rule.metric];
      const op = OPERATORS[rule.operator];
      if (value == null || !op) continue;           // metric not computed / bad op
      if (!op(value, rule.threshold)) continue;       // condition not met
      const label = METRIC_CATALOG.find((m) => m.key === rule.metric)?.label || rule.metric;
      add({
        id: `rule-${rule.id}`, category: rule.category || 'Custom',
        severity: ['high', 'medium', 'low', 'info'].includes(rule.severity) ? rule.severity : 'medium',
        title: rule.name,
        detail: `${label} is ${fmtMetric(rule.metric, value)} (rule: ${OP_LABEL[rule.operator]} ${fmtMetric(rule.metric, rule.threshold)}).`,
        value: typeof value === 'number' ? Math.abs(value) : 0,
        link: '/Insights', custom: true,
      });
    }
  });

  const rank = { high: 0, medium: 1, low: 2, info: 3 };
  insights.sort((a, b) => (rank[a.severity] - rank[b.severity]) || (b.value || 0) - (a.value || 0));

  return { generated_at: new Date().toISOString(), hub_mode: false, insights, metrics };
}

// ── Custom-rule CRUD (used by the no-code rule builder) ─────────────────────
export function listRules() {
  return db.prepare('SELECT * FROM insight_rules ORDER BY enabled DESC, name').all();
}

function validateRule(body) {
  const name = String(body?.name || '').trim();
  const metric = String(body?.metric || '').trim();
  const operator = String(body?.operator || '').trim();
  const threshold = Number(body?.threshold);
  const severity = ['high', 'medium', 'low', 'info'].includes(body?.severity) ? body.severity : 'medium';
  const category = String(body?.category || 'Custom').trim() || 'Custom';
  if (!name) throw new Error('Rule name is required');
  if (!METRIC_CATALOG.some((m) => m.key === metric)) throw new Error('Unknown metric');
  if (!OPERATORS[operator]) throw new Error('Invalid operator');
  if (!Number.isFinite(threshold)) throw new Error('Threshold must be a number');
  return { name, metric, operator, threshold, severity, category };
}

export function createRule(body, createdBy) {
  const r = validateRule(body);
  const info = db.prepare(`
    INSERT INTO insight_rules (name, metric, operator, threshold, severity, category, created_by)
    VALUES (@name, @metric, @operator, @threshold, @severity, @category, @createdBy)
  `).run({ ...r, createdBy: createdBy || null });
  invalidateInsightsCache();
  return db.prepare('SELECT * FROM insight_rules WHERE id = ?').get(info.lastInsertRowid);
}

export function updateRule(id, body) {
  const existing = db.prepare('SELECT * FROM insight_rules WHERE id = ?').get(id);
  if (!existing) throw new Error('Rule not found');
  // Allow a plain enabled-toggle without re-validating every field.
  if (body && Object.keys(body).length === 1 && 'enabled' in body) {
    db.prepare("UPDATE insight_rules SET enabled = ?, updated_at = now_local() WHERE id = ?").run(body.enabled ? 1 : 0, id);
  } else {
    const r = validateRule(body);
    const enabled = body.enabled == null ? existing.enabled : (body.enabled ? 1 : 0);
    db.prepare(`
      UPDATE insight_rules SET name=@name, metric=@metric, operator=@operator, threshold=@threshold,
        severity=@severity, category=@category, enabled=@enabled, updated_at = now_local() WHERE id=@id
    `).run({ ...r, enabled, id });
  }
  invalidateInsightsCache();
  return db.prepare('SELECT * FROM insight_rules WHERE id = ?').get(id);
}

export function deleteRule(id) {
  const changes = db.prepare('DELETE FROM insight_rules WHERE id = ?').run(id).changes;
  invalidateInsightsCache();
  return changes;
}
