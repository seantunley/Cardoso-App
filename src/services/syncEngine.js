/**
 * Sync engine — extracted from server.js (US-009).
 *
 * Exports runConnectionImport, acquireSyncLock, releaseSyncLock, activeSyncs.
 */

import sql from 'mssql';
import db from '../db/index.js';
import { decryptPassword } from './encryption.js';
import { trackOp } from '../lib/mainThreadWatch.js';
import { buildSqlServerConfig } from './mssqlSecurity.js';
import { buildStatements } from '../db/statements.js';
import { noteBalanceClearedBySync } from './collectionsService.js';
import { getMappedOrFallbackValue, firstDefined, buildFieldPatch, buildDynamicLocalFieldsPatch } from '../fieldRegistry.js';
import { sanitizeForSqlite, parseJsonSafely, stringifyJsonSafely, expandDataRecord } from '../helpers.js';
import { applyAutoFlagRulesToRecord } from './autoFlag.js';
import { logError } from '../lib/errorLog.js';
import { describeSqlError } from '../lib/errorDescribe.js';

// ── Statements prepared once at module level (not per-sync) ────────────────
const stmts = buildStatements(db);

// ── Sync-specific prepared statements: lazy-prepared on first sync ────────
// These reference tables (specifically `flag_snapshots`, added in migration
// v41) that may not exist when this module is imported. The import chain
// `server → scheduler → syncEngine` runs before `initSchema/runMigrations`
// in server.js, so eager-preparing here boot-fails on a site upgrading
// from a pre-v41 database. Lazy-prepare instead — the first call inside
// runConnectionImport happens long after migrations complete, and each
// statement is then cached for the lifetime of the process.
const _syncStmts = {};

// Customers written per transaction in the customer sync; the event loop is
// handed back between batches so the server stays responsive.
const SYNC_WRITE_BATCH = 200;

// ── Customers no longer returned by Sage ──────────────────────────────────
// The customer query returns every Sage customer, so one that drops out was
// deleted in Sage or rolled into a national account (whose family row now
// carries its balance). The app used to keep the old balance forever — and
// for national-account members that counted the money twice, so totals stopped
// matching Sage's Aged Trial Balance. Their balance, aging and open-invoice
// list are cleared; the record itself (flags, notes, history) is kept, and its
// synced_at stays at the last time Sage returned it. A customer that comes
// back is simply updated by the next sync.
//
// Guard against a broken query or a half-answering Sage: if Sage suddenly
// returns noticeably FEWER customers than the last successful sync did
// (previousCount — the connection's record_count), nothing is cleared and the
// run says why. Compared with the previous run rather than with how many stale
// records exist, so a site with a large backlog (years of customers rolled into
// national accounts) is still cleaned up on its first run. Without a previous
// count (legacy multi-table connections), fall back to a cap on the share.
export const MISSING_CUSTOMER_GUARD = { maxDrop: 0.2, maxShare: 0.2, alwaysAllow: 50 };
const isZeroMoney = (v) => v == null || String(v).trim() === '' || Number(String(v).replace(/[,\s]/g, '')) === 0;

export function clearMissingCustomers(sourceName, seenSourceIds, syncTimestamp, previousCount = null) {
  const live = db.prepare(`
    SELECT id, source_id, outstanding_balance, age_current, age_7_days, age_14_days, age_21_days, age_analysis, unpaid_invoices
    FROM datarecord WHERE source_table = ?
  `).all(sourceName);
  const missing = live.filter((r) => {
    const id = String(r.source_id ?? '').trim();
    return id !== '' && !seenSourceIds.has(id);
  });
  if (missing.length === 0) return { missing: 0, cleared: 0 };
  if (seenSourceIds.size === 0) {
    return { missing: missing.length, cleared: 0, clearSkipped: 'Sage returned no customers at all, so nothing was cleared.' };
  }
  const seen = seenSourceIds.size;
  if (previousCount > 0) {
    const drop = previousCount - seen;
    if (drop > Math.max(MISSING_CUSTOMER_GUARD.alwaysAllow, previousCount * MISSING_CUSTOMER_GUARD.maxDrop)) {
      return {
        missing: missing.length, cleared: 0,
        clearSkipped: `Sage returned ${seen} customers, ${Math.round((1 - seen / previousCount) * 100)}% fewer than the ${previousCount} in the last successful sync — that looks like a query or Sage problem rather than real deletions, so the ${missing.length} missing customers' balances were left as they were for this run. Check the connection's sync query. If Sage keeps returning this many, the next sync treats them as removed and clears them; any customer that reappears gets its real balance back on the following sync.`,
      };
    }
  } else {
    const limit = Math.max(MISSING_CUSTOMER_GUARD.alwaysAllow, Math.floor(live.length * MISSING_CUSTOMER_GUARD.maxShare));
    if (missing.length > limit) {
      return {
        missing: missing.length, cleared: 0,
        clearSkipped: `${missing.length} of ${live.length} customers were missing from Sage's results — more than the ${limit} allowed in one run, so this looks like a query or Sage problem rather than real deletions. Their balances were left as they were; check the connection's sync query.`,
      };
    }
  }
  const toClear = missing.filter((r) => [r.outstanding_balance, r.age_current, r.age_7_days, r.age_14_days, r.age_21_days].some((v) => !isZeroMoney(v))
    || String(r.age_analysis ?? '').trim() !== ''
    || !['', '[]'].includes(String(r.unpaid_invoices ?? '').trim()));
  const clear = db.prepare(`
    UPDATE datarecord
    SET outstanding_balance = '0', age_current = '0', age_7_days = '0', age_14_days = '0', age_21_days = '0',
        age_analysis = '', unpaid_invoices = '[]', updated_date = ?
    WHERE id = ?
  `);
  db.transaction(() => {
    for (const r of toClear) {
      clear.run(syncTimestamp, r.id);
      noteBalanceClearedBySync(r.id); // not a payment: keep Collections from logging "Paid in full"
    }
  })();
  return { missing: missing.length, cleared: toClear.length };
}

// One plain-English line for the connection status, the sync history and the
// "Sync now" result — replaces "Import completed - N records added", which
// reported the number of rows Sage returned no matter what actually changed.
export function describeSyncResult(t) {
  const n = (x) => Number(x || 0).toLocaleString('en-ZA');
  const parts = [];
  if (t.customersFetched) {
    parts.push(`${n(t.customersFetched)} customer rows from Sage: ${n(t.inserted)} new, ${n(t.updated)} updated, ${n(t.unchanged)} unchanged`);
    if (t.cleared) parts.push(`${n(t.cleared)} no longer in Sage (balances cleared)`);
    if (t.duplicates) parts.push(`${n(t.duplicates)} duplicate rows skipped`);
  }
  if (t.itemsFetched) parts.push(`${n(t.itemsFetched)} stock items from Sage`);
  let msg = parts.length ? `Synced ${parts.join(', ')}.` : 'Synced — Sage returned no rows.';
  for (const note of t.notes || []) msg += ` ${note}`;
  return msg;
}
function getSyncStmt(key) {
  if (_syncStmts[key]) return _syncStmts[key];
  _syncStmts[key] = db.prepare(_SYNC_SQL[key]);
  return _syncStmts[key];
}
const _SYNC_SQL = {
  syncUpdateRecord: `
    UPDATE datarecord
    SET
      created_by = ?,
      customer_number = ?,
      customer_name = ?,
      age_analysis = ?,
      age_current = ?,
      age_7_days = ?,
      age_14_days = ?,
      age_21_days = ?,
      outstanding_balance = ?,
      source_id = ?,
      source_table = ?,
      data = ?,
      local_fields = ?,
      unpaid_invoices = ?,
      receipts = ?,
      terms = ?,
      sales_rep = ?,
      account_type = ?,
      flag_color = ?,
      flag_reason = ?,
      flag_created_by = ?,
      note = ?,
      custom_field_1 = ?,
      custom_field_2 = ?,
      custom_field_3 = ?,
      synced_at = ?,
      updated_date = ?
    WHERE id = ?
  `,
  syncInsertRecord: `
    INSERT INTO datarecord (
      created_by,
      customer_number,
      customer_name,
      age_analysis,
      age_current,
      age_7_days,
      age_14_days,
      age_21_days,
      outstanding_balance,
      source_id,
      source_table,
      data,
      local_fields,
      unpaid_invoices,
      receipts,
      terms,
      sales_rep,
      account_type,
      note,
      custom_field_1,
      custom_field_2,
      custom_field_3,
      synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  syncUpsertInventory: `
    INSERT INTO inventoryrecord (source_table, item_number, item_description, qty_on_hand, last_cost, price_list, price, stocking_uom, commodity, inventory_value, updated_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_table, item_number) DO UPDATE SET
      item_description=excluded.item_description,
      qty_on_hand=excluded.qty_on_hand,
      last_cost=excluded.last_cost,
      price_list=excluded.price_list,
      price=excluded.price,
      stocking_uom=excluded.stocking_uom,
      commodity=excluded.commodity,
      inventory_value=excluded.inventory_value,
      updated_date=excluded.updated_date
  `,
  syncUpdateRecordFlag: `UPDATE datarecord SET flag_color = ?, flag_reason = ?, auto_flagged = ?, flag_source = 'auto' WHERE id = ?`,
  // Bumps only updated_date — used when an auto-flag change lands on a row whose
  // main data UPDATE was skipped as a no-op, so the hub's incremental pull
  // (updated_date > since) still sees the flag change (SYNC-2 follow-up).
  syncTouchUpdatedDate: `UPDATE datarecord SET updated_date = ? WHERE id = ?`,
  findFlagSnapshot: `
    SELECT flag_color, flag_reason, flag_created_by, flag_source, auto_flagged, note
    FROM flag_snapshots WHERE customer_number = ? LIMIT 1
  `,
  restoreFlagSnapshot: `
    UPDATE datarecord SET flag_color = ?, flag_reason = ?, flag_created_by = ?, flag_source = ?, auto_flagged = ?, note = ? WHERE id = ?
  `,
  deleteFlagSnapshot: `DELETE FROM flag_snapshots WHERE customer_number = ?`,
};

// ── Transient SQL Server failures ─────────────────────────────────────────
// A Sage box over a site VPN/Tailscale link regularly drops a connection or
// misses the timeout once, then answers fine seconds later. Failing the whole
// sync on that (and, before the scheduler fix, stopping syncing for good) made
// the engine look broken. Retry those errors a couple of times with a pause;
// anything else (bad login, bad query) fails straight away.
const TRANSIENT_SQL_CODES = new Set(['ETIMEOUT', 'ETIMEDOUT', 'ESOCKET', 'ECONNCLOSED', 'ECONNRESET', 'ECONNREFUSED', 'ENOTOPEN', 'EHOSTUNREACH']);
export function isTransientSqlError(err) {
  const codes = [err?.code, err?.originalError?.code, err?.originalError?.info?.code, err?.cause?.code];
  return codes.some((c) => c && TRANSIENT_SQL_CODES.has(c));
}
// Pauses before the 2nd and 3rd attempt. Exported so tests can shorten them.
export const sqlRetry = { delaysMs: [5000, 15000] };
async function withSqlRetry(label, fn, { isShuttingDown } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const delay = sqlRetry.delaysMs[attempt];
      if (!isTransientSqlError(err) || delay === undefined || (isShuttingDown && isShuttingDown())) throw err;
      console.warn(`[sync] ${label} failed with a temporary SQL Server error (${err.code || err.originalError?.code}): ${err.message} — retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 2} of ${sqlRetry.delaysMs.length + 1}).`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      // Shutdown can start during the pause — don't open another Sage connection then.
      if (isShuttingDown && isShuttingDown()) throw err;
    }
  }
}

const activeSyncs = new Set();

function acquireSyncLock(connectionId) {
  const key = String(connectionId);
  if (activeSyncs.has(key)) return false;
  activeSyncs.add(key);
  return true;
}

function releaseSyncLock(connectionId) {
  activeSyncs.delete(String(connectionId));
}

/**
 * True when re-running the per-record UPDATE for an existing datarecord would
 * change none of the columns it controls — i.e. the only effect of the write
 * would be to bump synced_at / updated_date. `upd` is the object of new column
 * values the sync loop computed; compared against the stored row as strings
 * (null/undefined → '') because datarecord columns are TEXT and `upd` is already
 * coerced. Skipping these no-op writes is SYNC-2: it stops every tick from
 * bumping updated_date on every row, which made the hub re-pull the whole set.
 * Exported for unit testing.
 */
export function isNoOpDataUpdate(existing, upd) {
  for (const k of Object.keys(upd)) {
    if (String(existing[k] ?? '') !== String(upd[k] ?? '')) return false;
  }
  return true;
}

/**
 * True when applying `autoFlag` to `existing` would actually change the row's
 * flag (colour, reason, or the auto_flagged bit) — `autoFlag` null means "no
 * rule matches", which is a change only if the row was previously auto-flagged.
 * Used to decide whether a flag write on a no-op-skipped row needs an
 * updated_date bump so the hub picks it up. Exported for unit testing.
 */
export function autoFlagWouldChange(existing, autoFlag) {
  if (autoFlag) {
    return String(existing.flag_color ?? '') !== String(autoFlag.flag_color ?? '')
      || String(existing.flag_reason ?? '') !== String(autoFlag.flag_reason ?? '')
      || !existing.auto_flagged;
  }
  return !!existing.auto_flagged;
}

async function runConnectionImport(connectionId, { isShuttingDown } = {}) {
  let pool;
  let syncRunId = null;

  if (isShuttingDown && isShuttingDown()) {
    return {
      success: false,
      skipped: true,
      message: 'Server is shutting down',
    };
  }

  if (!acquireSyncLock(connectionId)) {
    return {
      success: false,
      skipped: true,
      message: `Import already running for connection ${connectionId}`,
    };
  }

  try {
    const connConfig = db.prepare(`SELECT * FROM databaseconnection WHERE id = ?`).get(connectionId);

    if (!connConfig) {
      throw new Error('Connection not found');
    }

    // BAT-only connections must NEVER feed datarecord — they're accessed live
    // by the BAT module's own pool. Refuse the import even if invoked manually.
    if (connConfig.is_bat_only) {
      // A refusal, not a connection failure: flagged so the catch below doesn't
      // park the (healthy) BAT connection in 'error' — the BAT module's Sage
      // fallback only picks 'active' connections.
      throw Object.assign(new Error('This connection is marked BAT-only and cannot be synced into the local customer database. Untick "BAT-only" on the connection if you want it to feed customer search.'), { code: 'BAT_ONLY', statusCode: 400 });
    }

    syncRunId = db.prepare(`
      INSERT INTO syncrun (connection_id, started_at, status)
      VALUES (?, ?, 'running')
    `).run(connectionId, new Date().toISOString()).lastInsertRowid;

    const useEncryption = connConfig.use_encryption != null
      ? Boolean(Number(connConfig.use_encryption))
      : null;
    const sqlConfig = buildSqlServerConfig({
      user: connConfig.username,
      password: decryptPassword(connConfig.encrypted_password),
      server: connConfig.host,
      database: connConfig.database_name,
      port: connConfig.port,
      useEncryption,
    });

    // Own pool — NOT sql.connect()/the global pool. Two connections importing
    // concurrently would otherwise share one global pool keyed to whichever
    // connected first, and this import's finally{ pool.close() } would tear down
    // the other's in-flight queries (CRIT-1).
    pool = await withSqlRetry(`connect to ${connConfig.host}/${connConfig.database_name}`,
      () => new sql.ConnectionPool(sqlConfig).connect(), { isShuttingDown });

    // ── Query mode (new) vs legacy table-config mode ──────────────────────────
    const syncQuery = connConfig.sync_query ? connConfig.sync_query.trim() : null;
    const queryIndexField = connConfig.query_index_field ? connConfig.query_index_field.trim() : null;
    const queryFieldMappings = parseJsonSafely(connConfig.query_field_mappings, {});

    // Legacy fallback
    const tableConfigs = parseJsonSafely(connConfig.table_configs, []);
    const allFieldMappings = parseJsonSafely(connConfig.field_mappings, {});
    const isPerTableMappings = Object.keys(allFieldMappings).length > 0 &&
      Object.values(allFieldMappings).every(
        (v) => v && typeof v === 'object' && !v.sourceField
      );

    let importedCount = 0;
    // What this run actually did, across every query/table (see describeSyncResult).
    const totals = { customersFetched: 0, customers: 0, inserted: 0, updated: 0, unchanged: 0, duplicates: 0, cleared: 0, itemsFetched: 0, notes: [] };

    // Hot-path write statements lazy-prepared on first call (see _SYNC_SQL
    // at the top of this file). Aliased locally so the call sites below
    // stay readable. The first-call cost is one prepare; everything after
    // hits the cached statement.
    const updateExistingRecord = getSyncStmt('syncUpdateRecord');
    const insertNewRecord = getSyncStmt('syncInsertRecord');

    const inventoryMappingConfig = {
      item_number:      { fallbacks: ['item_number', 'Item Number', 'ItemNumber', 'ITEM_NUMBER', 'ItemNo', 'ITEMNO', 'item_no'] },
      item_description: { fallbacks: ['item_description', 'Item Description', 'ItemDescription', 'ITEM_DESCRIPTION', 'Description', 'DESC', 'ItemDesc', 'ItemName'] },
      qty_on_hand:      { fallbacks: ['qty_on_hand', 'Qty on Hand', 'QtyOnHand', 'QTY_ON_HAND', 'Quantity', 'QTY', 'OnHand', 'QTYONHAND', 'TotalLiveQtyOnHand'] },
      last_cost:        { fallbacks: ['last_cost', 'Last Cost', 'LastCost', 'LAST_COST', 'Cost', 'COST', 'RECENTCOST', 'LowestRecentCost'] },
      price_list:       { fallbacks: ['price_list', 'Price List', 'PriceList', 'PRICE_LIST', 'Pricelist', 'PRICELIST'] },
      price:            { fallbacks: ['price', 'Price', 'PRICE', 'SellPrice', 'UnitPrice', 'UNITPRICE', 'HighestUnitPrice'] },
      stocking_uom:     { fallbacks: ['stocking_uom', 'StockingUnitOfMeasure', 'Stocking Unit of measure', 'Stocking Unit', 'StockingUOM', 'UOM', 'STOCKUNIT', 'stk_uom'] },
      commodity:        { fallbacks: ['commodity', 'CommodityNumber', 'Commodity', 'COMMODITY', 'Category', 'ItemCategory'] },
      inventory_value:  { fallbacks: ['inventory_value', 'InventoryValue', 'TotalInventoryValueAtCost', 'TotalValue', 'inventory_value_at_cost'] },
    };

    const upsertInventoryRecord = getSyncStmt('syncUpsertInventory');

    const runInventoryRows = (rows, sourceName, mappings = {}) => {
      const syncTimestamp = new Date().toISOString();
      const writeInventory = db.transaction((rowsToWrite) => {
        for (const row of rowsToWrite) {
          const itemNumber = String(
            getMappedOrFallbackValue(row, mappings, 'item_number', inventoryMappingConfig.item_number.fallbacks) || ''
          );
          if (!itemNumber) continue;
          upsertInventoryRecord.run(
            sourceName,
            itemNumber,
            String(getMappedOrFallbackValue(row, mappings, 'item_description', inventoryMappingConfig.item_description.fallbacks) || ''),
            String(getMappedOrFallbackValue(row, mappings, 'qty_on_hand', inventoryMappingConfig.qty_on_hand.fallbacks) || ''),
            String(getMappedOrFallbackValue(row, mappings, 'last_cost', inventoryMappingConfig.last_cost.fallbacks) || ''),
            String(getMappedOrFallbackValue(row, mappings, 'price_list', inventoryMappingConfig.price_list.fallbacks) || ''),
            String(getMappedOrFallbackValue(row, mappings, 'price', inventoryMappingConfig.price.fallbacks) || ''),
            String(getMappedOrFallbackValue(row, mappings, 'stocking_uom', inventoryMappingConfig.stocking_uom.fallbacks) || ''),
            String(getMappedOrFallbackValue(row, mappings, 'commodity', inventoryMappingConfig.commodity.fallbacks) || ''),
            String(getMappedOrFallbackValue(row, mappings, 'inventory_value', inventoryMappingConfig.inventory_value.fallbacks) || ''),
            syncTimestamp
          );
        }
      });
      writeInventory(rows);
    };

    // record_snapshots writes were dropped — the table had no readers and was
    // adding ~600 MB/month of dead JSON to cardoso.db. The table itself is
    // kept around (no destructive migration) but is no longer written to.

    // Shared write-rows helper used by both query mode and legacy table mode
    // previousCount: customers the last successful sync saw (query mode only) —
    // the baseline for the missing-customer guard.
    const runWriteRows = async (rows, sourceName, mappings, indexField, previousCount = null) => {
      // Keyed lookup — load only this batch's source_ids, not the full table.
      // Runs INSIDE each batch's transaction (see writeRowsTransaction), so the
      // existing values a batch writes back (flags, notes…) are read in the same
      // synchronous step — a user edit made between batches is never clobbered.
      const existingMap = new Map();
      const customerNumberMap = new Map();
      const loadExisting = (batch) => {
        existingMap.clear();
        customerNumberMap.clear();
        const incomingIds = batch
          .map((row) => String(firstDefined(getMappedOrFallbackValue(row, mappings, 'customer_number', [indexField, 'id']), row[indexField], row.id, '')).trim())
          .filter(Boolean);
        if (incomingIds.length > 0) {
          // Deduplicate incoming IDs to avoid excessive SQL placeholders
          const uniqueIds = [...new Set(incomingIds)];
          const placeholders = uniqueIds.map(() => '?').join(',');
          const keyedRows = db.prepare(`
            SELECT id, created_by, source_id, source_table, customer_number, customer_name,
                   age_analysis, age_current, age_7_days, age_14_days, age_21_days,
                   note, local_fields, flag_color, flag_reason, flag_created_by, data,
                   outstanding_balance, terms, sales_rep, account_type, unpaid_invoices, receipts,
                   auto_flagged, flag_source, custom_field_1, custom_field_2, custom_field_3
            FROM datarecord
            WHERE source_table = ? AND (
              TRIM(source_id) IN (${placeholders})
              OR TRIM(customer_number) IN (${placeholders})
            )
          `).all(sourceName, ...uniqueIds, ...uniqueIds);
          for (const r of keyedRows) {
            // Index by both keys so the per-row fallbacks below become Map
            // hits instead of full table scans (TRIM(...) is non-sargable).
            if (r.source_id) existingMap.set(`${r.source_table}::${String(r.source_id).trim()}`, r);
            if (r.customer_number) customerNumberMap.set(String(r.customer_number).trim(), r);
          }
        }
      };

      const syncTimestamp = new Date().toISOString();

      // Load active auto-flag rules once for the entire sync batch
      const activeAutoFlagRules = stmts.activeAutoFlagRules.all();

      // Flag-snapshot helpers — lazy-prepared (see _SYNC_SQL). These hit
      // the `flag_snapshots` table which migration v41 creates; lazy
      // because syncEngine.js is imported before initSchema runs in
      // server.js, so eager prepares boot-fail on pre-v41 upgrades.
      const updateRecordFlag = getSyncStmt('syncUpdateRecordFlag');
      const touchUpdatedDate = getSyncStmt('syncTouchUpdatedDate');
      const findFlagSnapshot = getSyncStmt('findFlagSnapshot');
      const restoreFlag = getSyncStmt('restoreFlagSnapshot');
      const deleteFlagSnapshot = getSyncStmt('deleteFlagSnapshot');

      let diagLogged = false;
      let syncUpdated = 0;
      let syncInserted = 0;
      let syncSkipped = 0; // existing rows whose data was unchanged (SYNC-2 no-op skip)
      const seenSourceIds = new Set();
      const writeRowsTransaction = db.transaction((rowsToWrite) => {
        loadExisting(rowsToWrite);
        for (const row of rowsToWrite) {
          const sourceId = String(
            firstDefined(
              getMappedOrFallbackValue(row, mappings, 'customer_number', [indexField, 'id']),
              row[indexField],
              row.id,
              ''
            )
          ).trim();

          // Skip duplicate rows from the same MSSQL result set
          if (seenSourceIds.has(sourceId)) {
            if (!diagLogged) console.log(`[sync-dedup] Skipping duplicate source_id in result set: ${sourceId}`);
            continue;
          }
          seenSourceIds.add(sourceId);

          let existing = existingMap.get(`${sourceName}::${sourceId}`);
          // Fallbacks now hit the in-memory customerNumberMap built once
          // up-front, instead of two non-sargable TRIM(...) full table scans
          // per row. The original initial SELECT was extended to fetch the
          // customer_number variants in the same pass.
          if (!existing && sourceId) {
            existing = customerNumberMap.get(sourceId) || null;
          }
          const mappedPatch = buildFieldPatch(existing, row, mappings, indexField);
          const dynamicLocalFieldsPatch = buildDynamicLocalFieldsPatch(existing, row, mappings);

          // Log field-mapping diagnostics for the first row of each sync
          if (!diagLogged) {
            diagLogged = true;
            const rowKeys = Object.keys(row);
            console.log(`[sync-diag] First row keys (${rowKeys.length}):`, rowKeys.join(', '));
            console.log(`[sync-diag] row.account_type =`, JSON.stringify(row.account_type), '| row.sales_rep =', JSON.stringify(row.sales_rep), '| row.salesperson_code =', JSON.stringify(row.salesperson_code));
            console.log(`[sync-diag] mappedPatch.account_type =`, JSON.stringify(mappedPatch.account_type), '| mappedPatch.sales_rep =', JSON.stringify(mappedPatch.sales_rep));
            console.log(`[sync-diag] mappings keys:`, Object.keys(mappings || {}).join(', ') || '(none)');
          }
          const dataJson = JSON.stringify(row);

          const existingLocalFields = parseJsonSafely(existing?.local_fields, {});
          const mergedLocalFields = { ...existingLocalFields, ...dynamicLocalFieldsPatch };

          const baseRecordData = sanitizeForSqlite({
            source_id: String(sourceId || ''),
            source_table: sourceName,
            data: dataJson,
            synced_at: syncTimestamp,
            created_by: 'import',
            local_fields: stringifyJsonSafely(mergedLocalFields),
            ...mappedPatch,
          });

          if (existing) {
            const keepExistingIfIncomingBlank = (incomingValue, existingValue) => {
              if (incomingValue !== undefined && incomingValue !== null && String(incomingValue).trim() !== '') {
                return String(incomingValue);
              }
              return String(existingValue ?? '');
            };

            // Every column the UPDATE controls (flag_* are re-written as the
            // existing values, so they never differ and aren't compared).
            const upd = {
              created_by:          baseRecordData.created_by,
              customer_number:     String(baseRecordData.customer_number ?? existing.customer_number ?? ''),
              customer_name:       String(baseRecordData.customer_name ?? existing.customer_name ?? ''),
              age_analysis:        String(baseRecordData.age_analysis ?? existing.age_analysis ?? ''),
              age_current:         String(baseRecordData.age_current ?? existing.age_current ?? ''),
              age_7_days:          String(baseRecordData.age_7_days ?? existing.age_7_days ?? ''),
              age_14_days:         String(baseRecordData.age_14_days ?? existing.age_14_days ?? ''),
              age_21_days:         String(baseRecordData.age_21_days ?? existing.age_21_days ?? ''),
              outstanding_balance: String(baseRecordData.outstanding_balance ?? existing.outstanding_balance ?? ''),
              source_id:           baseRecordData.source_id,
              source_table:        baseRecordData.source_table,
              data:                baseRecordData.data,
              local_fields:        String(baseRecordData.local_fields ?? stringifyJsonSafely(existingLocalFields)),
              unpaid_invoices:     baseRecordData.unpaid_invoices ?? existing.unpaid_invoices ?? '[]',
              receipts:            baseRecordData.receipts ?? existing.receipts ?? '[]',
              terms:               String(baseRecordData.terms ?? existing.terms ?? ''),
              sales_rep:           keepExistingIfIncomingBlank(baseRecordData.sales_rep, existing.sales_rep),
              account_type:        keepExistingIfIncomingBlank(baseRecordData.account_type, existing.account_type),
              note:                String(baseRecordData.note ?? existing.note ?? ''),
              custom_field_1:      baseRecordData.custom_field_1 ?? existing.custom_field_1 ?? null,
              custom_field_2:      baseRecordData.custom_field_2 ?? existing.custom_field_2 ?? null,
              custom_field_3:      baseRecordData.custom_field_3 ?? existing.custom_field_3 ?? null,
            };

            // SYNC-2: when nothing the UPDATE controls actually changed, skip the
            // write. Otherwise every 30-min tick re-UPDATEs every unchanged row,
            // bumping updated_date — which makes the hub re-download the ENTIRE
            // record set on its next incremental pull (it filters on updated_date).
            const noOp = isNoOpDataUpdate(existing, upd);
            if (noOp) {
              syncSkipped++;
            } else {
              syncUpdated++;
              updateExistingRecord.run(
                upd.created_by, upd.customer_number, upd.customer_name, upd.age_analysis,
                upd.age_current, upd.age_7_days, upd.age_14_days, upd.age_21_days,
                upd.outstanding_balance, upd.source_id, upd.source_table, upd.data,
                upd.local_fields, upd.unpaid_invoices, upd.receipts, upd.terms,
                upd.sales_rep, upd.account_type,
                existing.flag_color, existing.flag_reason, existing.flag_created_by,
                upd.note, upd.custom_field_1, upd.custom_field_2, upd.custom_field_3,
                baseRecordData.synced_at, syncTimestamp, existing.id
              );
            }
             // Apply auto-flag rules only if the record was NOT manually flagged by a user
             // (manually flagged = has a flag AND auto_flagged is 0 AND flag_created_by is set)
             const manuallyFlagged = existing.flag_color && !existing.auto_flagged && existing.flag_created_by;
             // With no active rules, still visit rows that carry an auto-flag so
             // disabling the LAST rule clears its flags too (no rule matches).
             if (!manuallyFlagged && (activeAutoFlagRules.length > 0 || existing.auto_flagged)) {
               const autoFlag = activeAutoFlagRules.length > 0
                 ? applyAutoFlagRulesToRecord(expandDataRecord({ ...existing, ...baseRecordData }), activeAutoFlagRules)
                 : null;
               // Only write when the flag actually changes. (auto_flagged used to be
               // missing from the existing-row SELECT, so every matching row was
               // rewritten and re-sent to the hub every sync, and stale auto-flags
               // were never cleared.)
               if (autoFlagWouldChange(existing, autoFlag)) {
                 if (autoFlag) {
                   // Flag it (or update the auto-flag if the rule result changed)
                   updateRecordFlag.run(autoFlag.flag_color, autoFlag.flag_reason, 1, existing.id);
                 } else {
                   // Rule no longer matches — clear the auto-flag
                   updateRecordFlag.run(null, null, 0, existing.id);
                 }
                 // updateRecordFlag writes only flag_*/auto_flagged, NOT updated_date.
                 // When the main data UPDATE above was skipped as a no-op, bump
                 // updated_date so the hub's incremental pull (updated_date > since)
                 // still picks up the flag change.
                 if (noOp) touchUpdatedDate.run(syncTimestamp, existing.id);
               }
             }
          } else {
            syncInserted++;
            const insertResult = insertNewRecord.run(
              baseRecordData.created_by,
              String(baseRecordData.customer_number ?? ''),
              String(baseRecordData.customer_name ?? ''),
              String(baseRecordData.age_analysis ?? ''),
              String(baseRecordData.age_current ?? ''),
              String(baseRecordData.age_7_days ?? ''),
              String(baseRecordData.age_14_days ?? ''),
              String(baseRecordData.age_21_days ?? ''),
              String(baseRecordData.outstanding_balance ?? ''),
              baseRecordData.source_id,
              baseRecordData.source_table,
              baseRecordData.data,
              String(baseRecordData.local_fields ?? '{}'),
              baseRecordData.unpaid_invoices ?? '[]',
              baseRecordData.receipts ?? '[]',
              String(baseRecordData.terms ?? ''),
              String(baseRecordData.sales_rep ?? ''),
              String(baseRecordData.account_type ?? ''),
              String(baseRecordData.note ?? ''),
              baseRecordData.custom_field_1 ?? null,
              baseRecordData.custom_field_2 ?? null,
              baseRecordData.custom_field_3 ?? null,
              baseRecordData.synced_at
            );
            // We already have every column we just wrote — no need to
            // round-trip the DB to read it back. On a 5K-record initial
            // sync this saves 5K SELECTs (one per insert). Build the
            // record from baseRecordData + the new id, but FIRST seed
            // the SQLite-backed defaults so auto-flag rules that condition
            // on those fields behave the same as they would after a
            // SELECT * round-trip.
            //
            // schema.js datarecord defaults:
            //   flag_color  TEXT  DEFAULT 'none'
            //   auto_flagged INT  DEFAULT 0
            //   local_fields TEXT DEFAULT '{}'
            //   flag_source  TEXT DEFAULT NULL
            //   created_date / updated_date  TEXT DEFAULT CURRENT_TIMESTAMP
            //
            // Without these, a rule like `flag_color is_empty` or
            // `auto_flagged equals 0` evaluates differently for fresh
            // rows (undefined → empty / not-equal-to-'0') vs the same row
            // re-evaluated on a subsequent sync ('none' / '0' from the DB).
            // Spread `baseRecordData` AFTER so any column the connector
            // actually wrote wins over the default.
            const nowIso = new Date().toISOString();
            const newRecord = {
              flag_color: 'none',
              auto_flagged: 0,
              local_fields: '{}',
              flag_source: null,
              created_date: nowIso,
              updated_date: nowIso,
              ...baseRecordData,
              id: insertResult.lastInsertRowid,
            };

            // Restore preserved flags from a previous clear-data operation
            const customerNum = String(baseRecordData.customer_number ?? '');
            const savedFlag = customerNum ? findFlagSnapshot.get(customerNum) : null;
            if (savedFlag && newRecord) {
              restoreFlag.run(
                savedFlag.flag_color, savedFlag.flag_reason, savedFlag.flag_created_by,
                savedFlag.flag_source, savedFlag.auto_flagged || 0, savedFlag.note,
                newRecord.id
              );
              deleteFlagSnapshot.run(customerNum);
            } else if (activeAutoFlagRules.length > 0 && newRecord) {
              // Only apply auto-flag rules if no preserved flag was restored
              const autoFlag = applyAutoFlagRulesToRecord(expandDataRecord(newRecord), activeAutoFlagRules);
              if (autoFlag) {
                updateRecordFlag.run(autoFlag.flag_color, autoFlag.flag_reason, 1, newRecord.id);
              }
            }
          }
        }
      });

      // Small transactions with a yield between them. One transaction over every
      // customer (~7k rows, each JSON-stringified, parsed and rule-checked) held
      // the event loop for seconds and is a likely cause of 15-30s freezes.
      // Trade-off (approved): mid-sync, some customers may show new data and
      // others old for a few seconds.
      for (let i = 0; i < rows.length; i += SYNC_WRITE_BATCH) {
        const done = trackOp(`customer-sync ${sourceName} ${Math.min(i + SYNC_WRITE_BATCH, rows.length)}/${rows.length}`);
        try { writeRowsTransaction(rows.slice(i, i + SYNC_WRITE_BATCH)); }
        finally { done(); }
        await new Promise((resolve) => setImmediate(resolve));
      }
      console.log(`[sync-stats] ${sourceName}: ${rows.length} incoming rows, ${seenSourceIds.size} unique, ${syncUpdated} updated, ${syncInserted} inserted, ${syncSkipped} unchanged (no-op), ${rows.length - seenSourceIds.size} duplicate rows skipped`);

      const missing = clearMissingCustomers(sourceName, seenSourceIds, syncTimestamp, previousCount);
      if (missing.clearSkipped) {
        const note = `Did not clear customers missing from Sage for ${connConfig.name}: ${missing.clearSkipped}`;
        totals.notes.push(note);
        try { logError('sync.missing_customers_guard', new Error(note), { connection_id: connectionId, source_table: sourceName, missing: missing.missing }, 'warn'); }
        catch (e) { console.error('[sync.missing_customers_guard.log] failed', e.message); }
      }
      totals.customersFetched += rows.length;
      totals.customers += seenSourceIds.size;
      totals.inserted += syncInserted;
      totals.updated += syncUpdated;
      totals.unchanged += syncSkipped;
      totals.duplicates += rows.length - seenSourceIds.size;
      totals.cleared += missing.cleared;
    };
    if (syncQuery) {
      // ── QUERY MODE ─────────────────────────────────────────────────────────
      const syncQueryStripped = syncQuery
        .replace(/--[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim()
        .toUpperCase();
      if (!syncQueryStripped.startsWith('SELECT') && !syncQueryStripped.startsWith('WITH')) {
        throw new Error('sync_query must be a SELECT or CTE (WITH ...) statement');
      }

      // Denylist: dangerous patterns that even a SELECT can weaponise
      const FORBIDDEN = [
        /\bDROP\b/i, /\bDELETE\b/i, /\bUPDATE\b/i, /\bINSERT\b/i,
        /\bTRUNCATE\b/i, /\bALTER\b/i, /\bCREATE\b/i, /\bEXEC\b/i,
        /\bEXECUTE\b/i, /\bXP_/i, /\bSP_/i, /\bINTO\s+OUTFILE\b/i,
        /\bLOAD_FILE\b/i, /\bBENCHMARK\b/i, /\bSLEEP\b/i,
        /\bINFORMATION_SCHEMA\b/i, /\bMYSQL\./i,
      ];
      for (const pat of FORBIDDEN) {
        if (pat.test(syncQueryStripped)) {
          throw new Error('sync_query contains a forbidden SQL pattern');
        }
      }

      // Warn if query has no WHERE or LIMIT — may be very expensive
      const hasWhere = /\bWHERE\b/i.test(syncQueryStripped);
      const hasLimit = /\bLIMIT\b/i.test(syncQueryStripped);
      if (!hasWhere && !hasLimit) {
        console.warn(`[sync] Connection ${connectionId}: sync_query has no WHERE or LIMIT clause — this may be slow on large tables`);
      }

      if (!queryIndexField) {
        throw new Error('query_index_field is required for query mode');
      }

      // 60-second timeout on MSSQL queries (set on request object, not chained)
      const result = await withSqlRetry(`sync query for ${connConfig.name}`, () => {
        const req = pool.request();
        req.timeout = 60000;
        return req.query(syncQuery);
      }, { isShuttingDown });
      const rows = result.recordset || [];

      // Use the connection name as the logical source_table so existing records
      // are keyed to this connection rather than a physical table name
      const sourceName = `query::${connConfig.id}`;

      if (connConfig.record_type === 'inventory') {
        runInventoryRows(rows, sourceName, queryFieldMappings);
        // Prune items no longer returned by the query (upsert-then-prune
        // keeps data live). Previously built a `NOT IN (?, ?, ?, …)` with
        // up to 5K placeholders — the SQL string changed every sync (so
        // better-sqlite3's text-cache couldn't reuse it) and the planner
        // can't use the index against an N-element IN list. Stage to a
        // TEMP TABLE inside one transaction: parse-once SQL, index-friendly
        // anti-join, no per-sync placeholder explosion.
        const freshItemNumbers = rows.map(r =>
          String(getMappedOrFallbackValue(r, queryFieldMappings, 'item_number', inventoryMappingConfig.item_number.fallbacks) || '')
        ).filter(Boolean);
        if (freshItemNumbers.length > 0) {
          const pruneViaTempTable = db.transaction((items) => {
            db.exec('CREATE TEMP TABLE IF NOT EXISTS _sync_prune_inventory(item_number TEXT PRIMARY KEY)');
            db.exec('DELETE FROM _sync_prune_inventory');
            const insertTemp = db.prepare('INSERT OR IGNORE INTO _sync_prune_inventory(item_number) VALUES (?)');
            for (const item of items) insertTemp.run(item);
            db.prepare(`
              DELETE FROM inventoryrecord
              WHERE source_table = ?
                AND item_number NOT IN (SELECT item_number FROM _sync_prune_inventory)
            `).run(sourceName);
          });
          pruneViaTempTable(freshItemNumbers);
        }
        totals.itemsFetched += rows.length;
      } else {
        await runWriteRows(rows, sourceName, queryFieldMappings, queryIndexField, Number(connConfig.record_count) || null);
      }
      importedCount = rows.length;
    } else {
      // ── LEGACY TABLE MODE (backward compat) ────────────────────────────────
      const SAFE_IDENTIFIER = /^[a-zA-Z0-9_ ]+$/;

      for (const config of tableConfigs) {
        const { table_name, selected_fields = [], index_field } = config;
        if (!table_name) continue;

        if (!SAFE_IDENTIFIER.test(table_name)) {
          throw new Error(`Invalid table name: ${table_name}`);
        }

        const fieldMappings = isPerTableMappings
          ? (allFieldMappings[table_name] || {})
          : allFieldMappings;

        let fields = '*';
        if (Array.isArray(selected_fields) && selected_fields.length > 0) {
          const mappedSourceFields = Object.values(fieldMappings)
            .map((m) => m?.sourceField)
            .filter(Boolean);
          const uniqueFields = [...new Set([
            ...selected_fields,
            ...(index_field ? [index_field] : []),
            ...mappedSourceFields,
          ])];
          for (const field of uniqueFields) {
            if (!SAFE_IDENTIFIER.test(field)) {
              throw new Error(`Invalid field name: ${field}`);
            }
          }
          fields = uniqueFields.map((field) => `[${field}]`).join(', ');
        }

        const query = `SELECT ${fields} FROM [${table_name}]`;
        const result = await withSqlRetry(`sync query for ${connConfig.name} / ${table_name}`,
          () => pool.request().query(query), { isShuttingDown });
        const rows = result.recordset || [];

        const configRecordType = config.record_type || connConfig.record_type || 'customer';
        if (configRecordType === 'inventory') {
          runInventoryRows(rows, table_name, fieldMappings);
          totals.itemsFetched += rows.length;
        } else {
          await runWriteRows(rows, table_name, fieldMappings, index_field);
        }
        importedCount += rows.length;
      }
    }

    db.prepare(`
      UPDATE databaseconnection
      SET record_count = ?, last_sync = ?, last_error = NULL, updated_date = ?, status = 'active'
      WHERE id = ?
    `).run(totals.customers + totals.itemsFetched || importedCount, new Date().toISOString(), new Date().toISOString(), connectionId);

    const resultMessage = describeSyncResult(totals);
    if (syncRunId) {
      db.prepare(`
        UPDATE syncrun
        SET completed_at = ?, status = 'completed', message = ?
        WHERE id = ?
      `).run(
        new Date().toISOString(),
        resultMessage,
        syncRunId
      );
    }

    // Collections balance-delta hook — runs after every sync round to
    // detect payments and auto-collect zero-balance assignments.
    // Wrapped in try/catch so a Collections-side error never breaks the
    // import flow itself.
    try {
      const { processCollectionBalanceDelta } = await import('./collectionsService.js');
      processCollectionBalanceDelta();
    } catch (err) {
      console.error('[collections-sync] post-sync hook failed:', err.message);
    }

    // The insights feed is derived from the debtor/inventory data this import
    // just mutated. Drop its cache centrally here so every caller (manual
    // import route + interval auto-sync) recomputes against fresh numbers —
    // the nightly job still warms it. Dynamic import + guard so a stale cache
    // never breaks the import. Site-mode only; a no-op in hub mode.
    try {
      const { invalidateInsightsCache } = await import('./insights.js');
      invalidateInsightsCache();
    } catch (err) {
      console.error('[insights] cache invalidation after import failed:', err.message);
    }

    return {
      success: true,
      message: resultMessage,
      imported: importedCount,
      counts: { ...totals, notes: undefined },
      warnings: totals.notes,
    };
  } catch (error) {
    // Pull the connection's identifying fields so the persisted error
    // mentions WHICH SQL Server / DB went wrong. The connection row may
    // have been deleted between the start of import and this catch (rare
    // — happens when an operator removes the connection while a sync is
    // running) so we tolerate a missing row.
    let connRow = null;
    try {
      connRow = db.prepare(`SELECT name, host, database_name FROM databaseconnection WHERE id = ?`).get(connectionId);
    } catch (e) {
      console.error('[sync.import.connrow_lookup] failed', { connectionId }, e.message);
    }
    const friendly = describeSqlError(error, {
      op: connRow ? `sync ${connRow.name}` : 'sync',
      host: connRow?.host,
      database: connRow?.database_name,
    });
    // A BAT-only refusal is reported to the caller but is not a broken connection.
    if (error?.code === 'BAT_ONLY') throw error;
    try { logError('sync.import', error, { connection_id: connectionId, sync_run_id: syncRunId, friendly }); }
    catch (e) { console.error('[sync.import.log_error] failed', { connectionId }, e.message); }
    try {
      db.prepare(`
        UPDATE databaseconnection
        SET status = 'error', last_error = ?, updated_date = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(friendly, connectionId);
    } catch (e) {
      console.error('[sync.import.mark_connection_error] failed', { connectionId }, e.message);
    }

    try {
      if (syncRunId) {
        db.prepare(`
          UPDATE syncrun
          SET completed_at = ?, status = 'failed', message = ?
          WHERE id = ?
        `).run(
          new Date().toISOString(),
          friendly,
          syncRunId
        );
      }
    } catch (e) {
      console.error('[sync.import.mark_syncrun_failed] failed', { connectionId, syncRunId }, e.message);
    }

    throw error;
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch (e) {
        console.error('[sync.import.pool_close] failed', { connectionId }, e.message);
      }
    }

    releaseSyncLock(connectionId);
  }
}

// Exported wrapped in trackOp: a connection import does sustained synchronous
// better-sqlite3 work on the main thread — if the app stalls/freezes during
// one, the freeze forensics (src/lib/mainThreadWatch.js) name the connection
// instead of logging a mystery.
async function runConnectionImportTracked(connectionId, opts) {
  const doneOp = trackOp(`site-sync:connection-${connectionId}`);
  try {
    return await runConnectionImport(connectionId, opts);
  } finally {
    doneOp();
  }
}

export { runConnectionImportTracked as runConnectionImport, acquireSyncLock, releaseSyncLock, activeSyncs };
