import sql from 'mssql';
import db from '../db/index.js';
import { getSagePool } from './batReconciliation.js';
import { resolveSageQuery } from './sage/queryRegistry.js';
import { trackOp } from '../lib/mainThreadWatch.js';
import { logError } from '../lib/errorLog.js';

function toYyyymmdd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// Bulk-write rows to SQLite in batches, yielding the event loop between each.
//
// better-sqlite3 is synchronous, so ONE transaction over a very large set
// (3 years of per-line sales = hundreds of thousands / millions of rows) holds
// the event loop start-to-finish. On high-volume sites that froze the main
// thread for 15-20s — every API call and page hung, AND node-cron (which ticks
// on the same loop) was starved through the 04:00 window so the nightly syncs
// never even fired (they showed "never" in the schedule, the vendor map never
// filled, and the site looked permanently stale). See lib/mainThreadWatch.js.
//
// Batching each write into its own small transaction with a setImmediate yield
// between keeps every blocking burst sub-second, so the loop and the scheduler
// keep breathing. Each `trackOp` tags the burst so any residual freeze is
// attributed instead of "(none registered)". Callers ingest into a scratch
// staging table and then swap it into the live table in one transaction (see
// syncSalesFromSage), so a partial or failed batch run is never exposed to a
// reader and the window replace stays atomic.
async function writeRowsBatched(label, rows, applyRow, batchSize = 2000) {
  const writeBatch = db.transaction((batch) => { for (const r of batch) applyRow(r); });
  for (let i = 0; i < rows.length; i += batchSize) {
    const done = trackOp(`${label} ${Math.min(i + batchSize, rows.length)}/${rows.length}`);
    try { writeBatch(rows.slice(i, i + batchSize)); }
    finally { done(); }
    // Hand the event loop back so heartbeats, timers and node-cron can run.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Per-process guard for the sales sync. The sync ingests into shared scratch
// staging tables and then swaps them into the live tables (see below). Two
// concurrent runs — e.g. the manual /api/inventory-movement/sync route firing
// while the nightly/boot catch-up runner is mid-flight — would clobber each
// other's staging (both use the same staging tables in the one shared DB) and
// could interleave the swap, leaving garbled/duplicated rows in the
// constraint-free inventory_sales_transactions so rollups/forecasts mis-count.
// Coalesce concurrent callers onto the single in-flight run instead. (Every
// caller uses the default window; a future custom-window caller must not run
// concurrently — it would receive this run's result.)
let inFlightSalesSync = null;
export function syncSalesFromSage(opts = {}) {
  if (inFlightSalesSync) return inFlightSalesSync;
  inFlightSalesSync = _syncSalesFromSage(opts).finally(() => { inFlightSalesSync = null; });
  return inFlightSalesSync;
}

// Resolve once any in-flight sales sync has fully completed — INCLUDING its
// final post-swap rollup rebuild. Used by the reporting warm-on-read path so it
// never races a running sync: rather than kick off its own rebuild against
// pre/mid-swap transaction data, it waits for the sync (which rebuilds the
// rollups against the freshly-swapped data as its last step) and then finds the
// rollups already populated. Swallows a sync failure — the warm path re-checks
// emptiness and can still rebuild if the sync left the rollups empty.
export function awaitInFlightSalesSync() {
  return (inFlightSalesSync || Promise.resolve()).catch(() => {});
}

async function _syncSalesFromSage({ fromDate, toDate } = {}) {
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
      .query(resolveSageQuery('inventory.sales_agg')),
    pool.request()
      .input('from', sql.Int, fromInt)
      .input('to', sql.Int, toInt)
      .query(resolveSageQuery('inventory.sales_txn')),
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
          last_synced_at = now_local(),
          last_synced_to = ?,
          rows_synced = ?
        WHERE id = 1
      `).run(`${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, '0')}-${String(to.getDate()).padStart(2, '0')}`, count);
    } catch (e) {
      console.error('[inventory-movement] Failed to update sync meta:', e.message);
    }
  };

  // Stage-then-atomic-swap (see the swap block below). The slow per-row
  // transform+insert runs against scratch staging tables so it never touches the
  // live tables until the swap. These are MAIN-DB (file-backed) tables, NOT TEMP:
  // db/index.js sets PRAGMA temp_store=MEMORY, so TEMP staging would hold the
  // whole multi-year set in RAM — on top of the already fully-materialized
  // txnRows — and could OOM a high-volume site before the swap. File-backed
  // staging spills to disk instead, so the rebuild no longer depends on enough
  // RAM for the entire sales history. stage_sales_agg carries a PK so a stray
  // duplicate (item, period) from Sage collapses here, last-wins, as the old
  // upsert did; stage_sales_txn has no key (transaction lines are not unique).
  // DROP up front clears any table a prior crash left behind.
  db.exec(`
    DROP TABLE IF EXISTS stage_sales_agg;
    DROP TABLE IF EXISTS stage_sales_txn;
    CREATE TABLE stage_sales_agg (item_number, period, qty_sold, revenue, order_count, last_sale_date, item_description, PRIMARY KEY (item_number, period));
    CREATE TABLE stage_sales_txn (item_number, transaction_date, order_number, customer_code, customer_name, qty_sold, unit_price, line_amount);
  `);
  const stageAgg = db.prepare(`
    INSERT OR REPLACE INTO stage_sales_agg (item_number, period, qty_sold, revenue, order_count, last_sale_date, item_description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const stageTxn = db.prepare(`
    INSERT INTO stage_sales_txn
      (item_number, transaction_date, order_number, customer_code, customer_name, qty_sold, unit_price, line_amount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const fromDateStr = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`;
  const toDateStr = `${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, '0')}-${String(to.getDate()).padStart(2, '0')}`;
  const fromPeriod = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}`;
  const toPeriod = `${to.getFullYear()}-${String(to.getMonth() + 1).padStart(2, '0')}`;

  try {
    // Ingest into the staging tables in yielding batches — the slow part, kept off
    // the live tables and out of a single blocking transaction. A NOT NULL
    // violation from an odd Sage row, or a crash here, fails BEFORE the swap and
    // leaves the live window untouched.
    await writeRowsBatched('inventory-sales-sync:stage-agg', aggRows, (r) => {
      stageAgg.run(
        r.item_number,
        r.period,
        r.qty_sold || 0,
        Math.round((r.revenue || 0) * 100) / 100,
        r.order_count || 0,
        intToDate(r.last_sale_int),
        r.item_description || null,
      );
    });
    await writeRowsBatched('inventory-sales-sync:stage-txn', txnRows, (r) => {
      stageTxn.run(
        r.item_number,
        intToDate(r.transaction_date_int),
        r.order_number || null,
        r.customer_code || null,
        r.customer_name || null,
        r.qty_sold || 0,
        r.unit_price != null ? Math.round(r.unit_price * 100) / 100 : null,
        r.line_amount != null ? Math.round(r.line_amount * 100) / 100 : null,
      );
    });

    // Atomic swap: clear each window and copy the fully-staged rows into the live
    // tables in ONE transaction (a C-level INSERT...SELECT, far cheaper than the
    // per-row JS loop). Both tables swap together so cache and transaction detail
    // can never be read inconsistently, and the replace is all-or-nothing — if
    // anything above failed, the live window was never touched. Reconcile
    // deletions: item-months/days that dropped out of the staged set are removed
    // by the window clear; rows outside the window are untouched.
    const doneSwap = trackOp('inventory-sales-sync:swap');
    try {
      db.transaction(() => {
        db.prepare('DELETE FROM inventory_sales_cache WHERE period >= ? AND period <= ?').run(fromPeriod, toPeriod);
        db.prepare(`INSERT INTO inventory_sales_cache (item_number, period, qty_sold, revenue, order_count, last_sale_date, item_description)
                    SELECT item_number, period, qty_sold, revenue, order_count, last_sale_date, item_description FROM stage_sales_agg`).run();
        db.prepare('DELETE FROM inventory_sales_transactions WHERE transaction_date >= ? AND transaction_date <= ?').run(fromDateStr, toDateStr);
        db.prepare(`INSERT INTO inventory_sales_transactions (item_number, transaction_date, order_number, customer_code, customer_name, qty_sold, unit_price, line_amount)
                    SELECT item_number, transaction_date, order_number, customer_code, customer_name, qty_sold, unit_price, line_amount FROM stage_sales_txn`).run();
      })();
    } finally { doneSwap(); }
  } finally {
    // Always drop the file-backed scratch tables — even if staging or the swap
    // threw (e.g. an unexpected null item/date from Sage) — so a full multi-year
    // duplicate of the sales window can't linger in the live DB (and its backups)
    // until the next sync. The up-front DROP also clears anything a hard crash
    // left behind that bypassed this finally.
    db.exec('DROP TABLE IF EXISTS stage_sales_agg; DROP TABLE IF EXISTS stage_sales_txn;');
  }

  // Precompute the monthly item/customer sales rollups the hub pulls, so the
  // /api/reporting/inventory-*-sales endpoints serve a cheap indexed SELECT
  // instead of re-aggregating 24 months on every hub request — that on-demand
  // aggregation froze the site's (synchronous) event loop and timed out the
  // hub's health/KPIs fetches, flip-flopping the site tile Offline.
  // The rollup rebuild chunks per month with a yield between (see the function),
  // so it no longer freezes the loop; it self-tracks each chunk for the freeze
  // forensics. Best-effort — a rollup hiccup must not fail the whole sales sync.
  let rollupOk = true;
  try { await rebuildInventorySalesRollups(); }
  catch (e) { rollupOk = false; console.warn('[inventory.sales_rollup] rebuild failed:', e.message); }
  // Advance the freshness stamp AFTER the rollups are rebuilt+swapped, and ONLY
  // if the rebuild succeeded. The hub gates its inventory-*-sales delete-and-
  // replace on this stamp (+ rollup row counts):
  //  - Stamping BEFORE the rebuild leaves a window — now observable because the
  //    chunked rebuild yields, whereas the old monolithic one froze the loop and
  //    served no reads — where the stamp reads "fresh" while the rollups are
  //    still last-sync's.
  //  - Stamping after a FAILED rebuild is just as wrong: the rollups are stale
  //    (the atomic swap never happened) yet the stamp would advertise them as
  //    the new dataset, so the hub replaces its data from stale rollups.
  // Holding the stamp back on failure keeps the hub on its prior data and lets
  // the nightly-sync-stale alert surface that the rollups didn't refresh, rather
  // than silently shipping stale ones. The transaction data itself is already
  // committed (staging swap above); only the derived-rollup freshness is held.
  if (rollupOk) {
    updateMeta(aggRows.length);
  } else {
    console.warn('[inventory.sales] freshness stamp held back — rollup rebuild failed; hub keeps prior data until the next successful sync');
  }
  // Refresh the item -> vendor master (Sage ICITMV) alongside sales so vendor
  // attribution in Sales-by-Vendor / supplier filters stays current. Best-effort
  // — a vendor-map hiccup must not fail the sales sync.
  let itemVendors = 0;
  {
    const done = trackOp('inventory-sales-sync:item-vendors');
    try { itemVendors = (await syncItemVendors()).synced; }
    catch (e) {
      console.error('[inventory.item_vendor] sync failed — vendor attribution will be stale:', e.message);
      // Surface it, don't just log to console — Sales-by-Vendor shows "(No vendor)"
      // for everything when this fails, and that should be diagnosable.
      try { logError('inventory.item_vendor_sync', e, { note: 'Sales-by-Vendor vendor map not refreshed' }); } catch { /* never fail the sales sync */ }
    }
    finally { done(); }
  }
  return { synced: aggRows.length, transactions: txnRows.length, itemVendors };
}

// Sync the item -> primary-vendor map from Sage ICITMV (the item/vendor table).
// One row per item (lowest VENDTYPE = preferred vendor), keyed to the AP vendor
// code so vendor identity matches creditors. Full refresh (~2.4k rows): clear
// and re-insert so retired item/vendor links drop out. This is the single source
// of truth for an item's vendor, replacing the old "latest stock receipt" guess.
export async function syncItemVendors() {
  const pool = await getSagePool();
  const result = await pool.request().query(resolveSageQuery('inventory.item_vendor'));
  const rows = result.recordset || [];
  const insert = db.prepare('INSERT OR REPLACE INTO item_vendor (item_number, vendor_code, vendor_name, synced_at) VALUES (?, ?, ?, now_local())');
  db.transaction(() => {
    db.prepare('DELETE FROM item_vendor').run();
    for (const r of rows) {
      const item = String(r.item_number || '').trim();
      if (!item) continue;
      insert.run(item, String(r.vendor_code || '').trim() || null, String(r.vendor_name || '').trim() || null);
    }
  })();
  return { synced: rows.length };
}

// EXCL_INTER_BRANCH mirrors the fragment in routes/reporting.js — exclude
// inter-branch transfer "customers" (matched by name) from sales figures.
const EXCL_INTER_BRANCH = "(LOWER(COALESCE(customer_name,'')) LIKE '%inter branch%' OR LOWER(COALESCE(customer_name,'')) LIKE '%inter-branch%' OR LOWER(COALESCE(customer_name,'')) LIKE '%interbranch%')";

// Rebuild the precomputed monthly sales rollups the hub pulls. Runs once per
// inventory-sales sync — NOT per hub request — so the reporting endpoints stay
// cheap indexed SELECTs and never freeze the site's event loop. Single source of
// the aggregation; see migration v099.
//
// Window matches the sales-transaction sync (3 prior calendar years + YTD), NOT
// a trailing 24 months: the hub Sales-by-Vendor report takes arbitrary date
// ranges and a prior-year comparison that shifts back another year, so a shorter
// rollup would make historical hub totals silently under-report vs the
// transaction-backed site report.
// Build the ordered list of 'YYYY-MM' periods from Jan of (thisYear-3) through
// the current month (inclusive) — the same 3-full-years + YTD window the sync
// and the old single-pass rebuild covered.
function rollupPeriods(now = new Date()) {
  const periods = [];
  let y = now.getFullYear() - 3;
  let m = 1;
  const endY = now.getFullYear();
  const endM = now.getMonth() + 1;
  while (y < endY || (y === endY && m <= endM)) {
    periods.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return periods;
}

// First day of the month AFTER `period` ('YYYY-MM'), as 'YYYY-MM-DD' — the
// exclusive upper bound for that period's transaction_date range.
function nextPeriodStart(period) {
  let [y, m] = period.split('-').map(Number);
  m += 1;
  if (m > 12) { m = 1; y += 1; }
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

// Serialize rebuilds by CHAINING each call after the previous one settles, then
// running its OWN fresh _rebuild. The rebuild now yields between period chunks
// (async), so two overlapping callers — the nightly sync and a hub warm-on-read
// (routes/reporting.js), or two hub requests — would otherwise interleave on the
// shared stage_* tables and corrupt each other's staging.
//
// Chaining, NOT coalescing: coalescing onto one in-flight run would let the
// rebuild the nightly sync kicks off AFTER its atomic swap simply await an
// EARLIER rebuild that began pre-swap — leaving the rollups computed from stale/
// pre-swap transaction data, with no fresh rebuild until the next nightly sync.
// Chaining guarantees the sync's post-swap call runs its own rebuild against the
// swapped data. Each caller gets its own run's promise, so a failure still
// reaches the reporting route's catch → 500.
let rollupRebuildTail = Promise.resolve();
export function rebuildInventorySalesRollups() {
  const run = () => _rebuildInventorySalesRollups();
  const mine = rollupRebuildTail.then(run, run);
  rollupRebuildTail = mine.catch(() => {}); // keep the chain alive past a failure
  return mine;
}

async function _rebuildInventorySalesRollups() {
  // Was ONE monolithic db.transaction (DELETE + INSERT...SELECT aggregating the
  // whole multi-million-row inventory_sales_transactions) — a single synchronous
  // 15-20s block that hard-froze the event loop nightly at 02:00, dropping
  // node-cron ticks (see lib/mainThreadWatch.js markers, and the JTI monthly
  // export it starved). Now chunked per calendar month into file-backed staging
  // with a setImmediate yield between periods, so each burst is sub-second and
  // the loop (heartbeat, timers, node-cron, API) keeps breathing. The live
  // tables are only touched by the fast final swap of the already-aggregated
  // rows — the same stage-then-atomic-swap shape syncSalesFromSage uses above.
  const periods = rollupPeriods();

  db.exec(`
    DROP TABLE IF EXISTS stage_item_rollup;
    DROP TABLE IF EXISTS stage_customer_rollup;
    DROP TABLE IF EXISTS stage_item_desc;
    CREATE TABLE stage_item_rollup (item_number, period, qty_sold, revenue, item_description);
    CREATE TABLE stage_customer_rollup (customer_code, period, revenue, qty, customer_name);
    CREATE TABLE stage_item_desc (item_number PRIMARY KEY, item_description);
  `);
  try {
    // Precompute the item -> description map ONCE (cache preferred, item master
    // as fallback — matches the old COALESCE(MAX(ic), MAX(ir))). Doing it here,
    // not per-period, keeps each period's item aggregation a cheap indexed join
    // instead of re-scanning the cache + item master for all 40+ periods.
    db.prepare(`
      INSERT OR REPLACE INTO stage_item_desc (item_number, item_description)
      SELECT TRIM(item_number), MAX(item_description)
      FROM inventory_sales_cache
      WHERE item_description IS NOT NULL AND TRIM(item_description) <> ''
      GROUP BY TRIM(item_number)
    `).run();
    // Fill items with no cache description from the item master. INSERT OR IGNORE
    // keeps the cache-preferred precedence (won't overwrite a cache hit).
    db.prepare(`
      INSERT OR IGNORE INTO stage_item_desc (item_number, item_description)
      SELECT TRIM(item_number), MAX(item_description)
      FROM inventoryrecord
      WHERE item_description IS NOT NULL AND TRIM(item_description) <> ''
      GROUP BY TRIM(item_number)
    `).run();

    // Per-period aggregations. The transaction_date range uses
    // idx_inventory_sales_transactions_date (v074), so all periods together scan
    // the fact table about once — NOT once per period. period is a constant for
    // the chunk, so GROUP BY is on the entity only.
    const stageItem = db.prepare(`
      INSERT INTO stage_item_rollup (item_number, period, qty_sold, revenue, item_description)
      SELECT TRIM(t.item_number), ?, SUM(t.qty_sold), SUM(t.line_amount), MAX(sd.item_description)
      FROM inventory_sales_transactions t
      LEFT JOIN stage_item_desc sd ON sd.item_number = TRIM(t.item_number)
      WHERE t.transaction_date >= ? AND t.transaction_date < ? AND NOT ${EXCL_INTER_BRANCH}
      GROUP BY TRIM(t.item_number)
    `);
    const stageCustomer = db.prepare(`
      INSERT INTO stage_customer_rollup (customer_code, period, revenue, qty, customer_name)
      SELECT TRIM(customer_code), ?, SUM(line_amount), SUM(qty_sold), MAX(customer_name)
      FROM inventory_sales_transactions
      WHERE transaction_date >= ? AND transaction_date < ?
        AND customer_code IS NOT NULL AND TRIM(customer_code) <> ''
        AND NOT ${EXCL_INTER_BRANCH}
      GROUP BY TRIM(customer_code)
    `);
    const stagePeriod = db.transaction((period, start, end) => {
      stageItem.run(period, start, end);
      stageCustomer.run(period, start, end);
    });

    for (const period of periods) {
      const done = trackOp(`inventory-sales-sync:rebuild-rollups ${period}`);
      try { stagePeriod(period, `${period}-01`, nextPeriodStart(period)); }
      finally { done(); }
      // Hand the loop back so heartbeats, timers and node-cron can run between
      // months — this is what stops the nightly freeze.
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Atomic swap: the rollup tables are small (aggregated to entity × month),
    // so clearing and copying the fully-staged rows is a sub-second write — the
    // only moment the live tables are locked. All-or-nothing, so a reader (or
    // the hub pull) never sees a half-rebuilt rollup.
    const doneSwap = trackOp('inventory-sales-sync:rebuild-rollups:swap');
    try {
      db.transaction(() => {
        db.prepare('DELETE FROM inventory_item_sales_rollup').run();
        db.prepare(`INSERT INTO inventory_item_sales_rollup (item_number, period, qty_sold, revenue, item_description)
                    SELECT item_number, period, qty_sold, revenue, item_description FROM stage_item_rollup`).run();
        db.prepare('DELETE FROM inventory_customer_sales_rollup').run();
        db.prepare(`INSERT INTO inventory_customer_sales_rollup (customer_code, period, revenue, qty, customer_name)
                    SELECT customer_code, period, revenue, qty, customer_name FROM stage_customer_rollup`).run();
      })();
    } finally { doneSwap(); }
  } finally {
    // Always drop the scratch tables, even if staging or the swap threw, so a
    // full aggregated duplicate can't linger in the live DB (and its backups).
    db.exec('DROP TABLE IF EXISTS stage_item_rollup; DROP TABLE IF EXISTS stage_customer_rollup; DROP TABLE IF EXISTS stage_item_desc;');
  }
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

// Distinct vendor names from the item/vendor master (Sage ICITMV). Populates the
// supplier filter dropdown on Top Movers and Dead Stock — the same source as
// Sales by Vendor, so vendor attribution is consistent across reports.
export function getSuppliers() {
  return db.prepare(`
    SELECT DISTINCT TRIM(vendor_name) AS supplier_name
    FROM item_vendor
    WHERE TRIM(COALESCE(vendor_name, '')) != ''
    ORDER BY 1
  `).all().map(r => r.supplier_name);
}

// Item -> vendor, from the ICITMV-backed item/vendor master (synced by
// syncItemVendors). Aliased to supplier_name so the Top Movers / Dead Stock
// joins below are unchanged. Replaces the old "latest stock receipt" inference,
// which missed items never received and could name a transient distributor
// instead of the actual vendor.
const LATEST_SUPPLIER_SQL = `
  SELECT item_number, vendor_name AS supplier_name
  FROM item_vendor
  WHERE TRIM(COALESCE(vendor_name, '')) != ''
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
