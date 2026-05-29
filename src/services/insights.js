// Proactive insights engine. Runs a set of cheap rule-based detectors over the
// data the app already syncs (monthly sales cache, per-line sales transactions,
// inventory, debtor balances) and returns a ranked feed of "things worth
// looking at" — sales declines, at-risk customers, dead-stock build-up, debtor
// exposure — so operators don't have to read every dashboard to spot trouble.
//
// Each detector is wrapped so one failing query can't sink the whole feed
// (failures are logged, never silently swallowed). Site-mode only: it reads the
// local sales cache, which the hub doesn't populate.
import db from '../db/index.js';
import { logError } from '../lib/errorLog.js';
import { getDeadStock } from './inventoryMovement.js';

const COMMODITY_LABELS = { '1': 'Sweets', '2': 'Cigarettes', '3': 'Tobacco', '4': 'Mixed' };
const pct = (cur, base) => (base > 0 ? ((cur - base) / base) * 100 : 0);
const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

export function computeInsights() {
  if (process.env.HUB_MODE === 'true') {
    return { generated_at: new Date().toISOString(), hub_mode: true, insights: [] };
  }

  const now = new Date();
  const lastM = ym(new Date(now.getFullYear(), now.getMonth() - 1, 1));   // last complete month
  const prevM = ym(new Date(now.getFullYear(), now.getMonth() - 2, 1));
  const prev3 = [1, 2, 3].map((i) => ym(new Date(now.getFullYear(), now.getMonth() - i, 1)));

  const insights = [];
  const add = (i) => insights.push(i);
  const detect = (name, fn) => {
    try { fn(); } catch (err) {
      console.error(`[insights] detector "${name}" failed:`, err.message);
      try { logError('insights.detector', err, { detector: name }, 'warn'); } catch { /* logged below via console already */ }
    }
  };

  // Shared pulls -------------------------------------------------------------
  // item -> { commodity, qty_on_hand, last_cost } (highest qty row per item)
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
    if (prev <= 0) return;
    const change = pct(last, prev);
    if (change <= -15) {
      add({
        id: 'revenue-decline', category: 'Sales', severity: change <= -30 ? 'high' : 'medium',
        title: `Revenue down ${Math.abs(change).toFixed(0)}% month-on-month`,
        detail: `R ${Math.round(last).toLocaleString('en-ZA')} in ${lastM} vs R ${Math.round(prev).toLocaleString('en-ZA')} in ${prevM}.`,
        value: Math.abs(change), link: '/Trends',
      });
    } else if (change >= 15) {
      add({
        id: 'revenue-up', category: 'Sales', severity: 'info',
        title: `Revenue up ${change.toFixed(0)}% month-on-month`,
        detail: `R ${Math.round(last).toLocaleString('en-ZA')} in ${lastM} vs R ${Math.round(prev).toLocaleString('en-ZA')} in ${prevM}.`,
        value: change, link: '/Trends',
      });
    }
  });

  // 2. Commodity-level decline ----------------------------------------------
  detect('commodity-shift', () => {
    const rows = db.prepare('SELECT item_number, period, revenue FROM inventory_sales_cache WHERE period IN (?, ?)').all(lastM, prevM);
    const byComm = new Map(); // commodity -> { last, prev }
    for (const r of rows) {
      const comm = itemMeta.get(r.item_number)?.commodity || 'Unknown';
      if (!byComm.has(comm)) byComm.set(comm, { last: 0, prev: 0 });
      byComm.get(comm)[r.period === lastM ? 'last' : 'prev'] += r.revenue || 0;
    }
    for (const [comm, v] of byComm) {
      if (v.prev < 5000) continue; // ignore immaterial commodities
      const change = pct(v.last, v.prev);
      if (change <= -20) {
        add({
          id: `commodity-decline-${comm}`, category: 'Sales', severity: 'medium',
          title: `${COMMODITY_LABELS[comm] || `Commodity ${comm}`} sales down ${Math.abs(change).toFixed(0)}%`,
          detail: `R ${Math.round(v.last).toLocaleString('en-ZA')} in ${lastM} vs R ${Math.round(v.prev).toLocaleString('en-ZA')} in ${prevM}.`,
          value: Math.abs(change), link: '/Trends',
        });
      }
    }
  });

  // 3. Top SKU decliners (last month vs prior 3-month average) --------------
  detect('sku-decliners', () => {
    const rows = db.prepare('SELECT item_number, period, revenue FROM inventory_sales_cache WHERE period IN (?, ?, ?, ?)')
      .all(lastM, ...prev3);
    const byItem = new Map(); // item -> { last, priorSum, priorN }
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
      if (baseline < 1000) continue; // material sellers only
      const change = pct(e.last, baseline);
      if (change <= -40) candidates.push({ item, drop: baseline - e.last, change, baseline, last: e.last });
    }
    candidates.sort((a, b) => b.drop - a.drop);
    for (const c of candidates.slice(0, 3)) {
      const name = desc.get(c.item)?.d || c.item;
      add({
        id: `sku-decline-${c.item}`, category: 'Sales', severity: 'medium',
        title: `${name} sales fell ${Math.abs(c.change).toFixed(0)}%`,
        detail: `R ${Math.round(c.last).toLocaleString('en-ZA')} last month vs a R ${Math.round(c.baseline).toLocaleString('en-ZA')}/mo baseline.`,
        value: c.drop, link: '/InventoryMovement',
      });
    }
  });

  // 4. At-risk customers: spend in last 30 days vs the prior 30 -------------
  detect('at-risk-customers', () => {
    const rows = db.prepare(`
      SELECT customer_code, MAX(customer_name) AS customer_name,
             SUM(CASE WHEN date(transaction_date) >= date(now_local(), '-30 days') THEN COALESCE(line_amount,0) ELSE 0 END) AS recent,
             SUM(CASE WHEN date(transaction_date) >= date(now_local(), '-60 days') AND date(transaction_date) < date(now_local(), '-30 days') THEN COALESCE(line_amount,0) ELSE 0 END) AS prior
      FROM inventory_sales_transactions
      WHERE date(transaction_date) >= date(now_local(), '-60 days') AND customer_code IS NOT NULL AND customer_code != ''
      GROUP BY customer_code
      HAVING prior >= 2000
    `).all();
    const dropped = rows.filter((r) => r.recent <= r.prior * 0.5).sort((a, b) => (b.prior - b.recent) - (a.prior - a.recent));
    if (dropped.length === 0) return;
    const top = dropped.slice(0, 5).map((r) => (r.customer_name || r.customer_code || '').trim()).filter(Boolean);
    add({
      id: 'at-risk-customers', category: 'Customers', severity: dropped.length >= 5 ? 'high' : 'medium',
      title: `${dropped.length} customer${dropped.length === 1 ? '' : 's'} buying less`,
      detail: `Spend at least halved vs the prior 30 days. e.g. ${top.join(', ')}.`,
      value: dropped.length, link: '/Collections',
    });
  });

  // 5. Dead-stock build-up ---------------------------------------------------
  detect('dead-stock', () => {
    const rows = getDeadStock({ thresholdDays: 90, minValue: 0, limit: 5000 });
    if (!rows.length) return;
    const capital = rows.reduce((s, r) => s + (r.capital_tied_up || 0), 0);
    if (capital < 10000) return;
    add({
      id: 'dead-stock', category: 'Inventory', severity: capital >= 100000 ? 'high' : 'medium',
      title: `R ${Math.round(capital).toLocaleString('en-ZA')} tied up in dead stock`,
      detail: `${rows.length} item${rows.length === 1 ? '' : 's'} with no sale in 90+ days.`,
      value: capital, link: '/InventoryMovement',
    });
  });

  // 6. Debtor exposure concentration ----------------------------------------
  detect('debtor-exposure', () => {
    const r = db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(outstanding_balance_num),0) AS total FROM datarecord WHERE outstanding_balance_num > 10000").get();
    if (!r || r.c === 0) return;
    add({
      id: 'debtor-exposure', category: 'Receivables', severity: 'low',
      title: `${r.c} customer${r.c === 1 ? '' : 's'} owe over R10,000`,
      detail: `R ${Math.round(r.total).toLocaleString('en-ZA')} concentrated in high-balance accounts.`,
      value: r.total, link: '/Reports?report=aged-debtors',
    });
  });

  // Rank: severity first, then magnitude.
  const rank = { high: 0, medium: 1, low: 2, info: 3 };
  insights.sort((a, b) => (rank[a.severity] - rank[b.severity]) || (b.value || 0) - (a.value || 0));

  return { generated_at: new Date().toISOString(), hub_mode: false, insights };
}
