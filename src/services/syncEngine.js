/**
 * Sync engine — extracted from server.js (US-009).
 *
 * Exports runConnectionImport, acquireSyncLock, releaseSyncLock, activeSyncs.
 */

import sql from 'mssql';
import db from '../db/index.js';
import { decryptPassword } from './encryption.js';
import { buildSqlServerConfig } from './mssqlSecurity.js';
import { buildStatements } from '../db/statements.js';
import { getMappedOrFallbackValue, firstDefined, buildFieldPatch, buildDynamicLocalFieldsPatch } from '../fieldRegistry.js';
import { sanitizeForSqlite, parseJsonSafely, stringifyJsonSafely, expandDataRecord } from '../helpers.js';
import { applyAutoFlagRulesToRecord } from './autoFlag.js';

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

async function runConnectionImport(connectionId, { isShuttingDown } = {}) {
  const stmts = buildStatements(db);
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

    pool = await sql.connect(sqlConfig);

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

    const updateExistingRecord = db.prepare(`
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
    `);

    const insertNewRecord = db.prepare(`
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
        note,
        custom_field_1,
        custom_field_2,
        custom_field_3,
        synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

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
      sales_rep:        { fallbacks: ['sales_rep', 'SalesRep', 'Salesman', 'salesperson', 'SalesRepCode', 'SalesRepName', 'sales_representative'] },
    };

    const upsertInventoryRecord = db.prepare(`
      INSERT INTO inventoryrecord (source_table, item_number, item_description, qty_on_hand, last_cost, price_list, price, stocking_uom, commodity, inventory_value, sales_rep, updated_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_table, item_number) DO UPDATE SET
        item_description=excluded.item_description,
        qty_on_hand=excluded.qty_on_hand,
        last_cost=excluded.last_cost,
        price_list=excluded.price_list,
        price=excluded.price,
        stocking_uom=excluded.stocking_uom,
        commodity=excluded.commodity,
        inventory_value=excluded.inventory_value,
        sales_rep=excluded.sales_rep,
        updated_date=excluded.updated_date
    `);

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
            String(getMappedOrFallbackValue(row, mappings, 'sales_rep', inventoryMappingConfig.sales_rep.fallbacks) || ''),
            syncTimestamp
          );
        }
      });
      writeInventory(rows);
    };

    const insertSnapshot = db.prepare(`
      INSERT INTO record_snapshots (connection_id, customer_number, snapshot_data, synced_at)
      VALUES (?, ?, ?, ?)
    `);

    // Shared write-rows helper used by both query mode and legacy table mode
    const runWriteRows = (rows, sourceName, mappings, indexField) => {
      const existingRows = db.prepare(`
        SELECT id, source_id, source_table, customer_number, customer_name,
               age_analysis, age_current, age_7_days, age_14_days, age_21_days,
               note, local_fields, flag_color, flag_reason, flag_created_by, data,
               outstanding_balance, terms, unpaid_invoices, receipts
        FROM datarecord
        WHERE source_table = ?
      `).all(sourceName);

      const existingMap = new Map(
        existingRows.map((r) => [`${r.source_table}::${r.source_id}`, r])
      );

      const syncTimestamp = new Date().toISOString();

      // Load active auto-flag rules once for the entire sync batch
      const activeAutoFlagRules = stmts.activeAutoFlagRules.all();

      const updateRecordFlag = db.prepare(`
        UPDATE datarecord SET flag_color = ?, flag_reason = ?, auto_flagged = ?, flag_source = 'auto' WHERE id = ?
      `);

      const writeRowsTransaction = db.transaction((rowsToWrite) => {
        for (const row of rowsToWrite) {
          const sourceId = String(
            firstDefined(
              getMappedOrFallbackValue(row, mappings, 'customer_number', [indexField, 'id']),
              row[indexField],
              row.id,
              ''
            )
          );

          const existing = existingMap.get(`${sourceName}::${String(sourceId || '')}`);
          const mappedPatch = buildFieldPatch(existing, row, mappings, indexField);
          const dynamicLocalFieldsPatch = buildDynamicLocalFieldsPatch(existing, row, mappings);
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
            updateExistingRecord.run(
              baseRecordData.created_by,
              String(baseRecordData.customer_number ?? existing.customer_number ?? ''),
              String(baseRecordData.customer_name ?? existing.customer_name ?? ''),
              String(baseRecordData.age_analysis ?? existing.age_analysis ?? ''),
              String(baseRecordData.age_current ?? existing.age_current ?? ''),
              String(baseRecordData.age_7_days ?? existing.age_7_days ?? ''),
              String(baseRecordData.age_14_days ?? existing.age_14_days ?? ''),
              String(baseRecordData.age_21_days ?? existing.age_21_days ?? ''),
              String(baseRecordData.outstanding_balance ?? existing.outstanding_balance ?? ''),
              baseRecordData.source_id,
              baseRecordData.source_table,
              baseRecordData.data,
              String(baseRecordData.local_fields ?? stringifyJsonSafely(existingLocalFields)),
              baseRecordData.unpaid_invoices ?? existing.unpaid_invoices ?? '[]',
              baseRecordData.receipts ?? existing.receipts ?? '[]',
              String(baseRecordData.terms ?? existing.terms ?? ''),
              existing.flag_color,
              existing.flag_reason,
              existing.flag_created_by,
              String(baseRecordData.note ?? existing.note ?? ''),
              baseRecordData.custom_field_1 ?? existing.custom_field_1 ?? null,
              baseRecordData.custom_field_2 ?? existing.custom_field_2 ?? null,
              baseRecordData.custom_field_3 ?? existing.custom_field_3 ?? null,
              baseRecordData.synced_at,
              syncTimestamp,
              existing.id
            );
             // Apply auto-flag rules only if the record was NOT manually flagged by a user
             // (manually flagged = has a flag AND auto_flagged is 0 AND flag_created_by is set)
             const manuallyFlagged = existing.flag_color && !existing.auto_flagged && existing.flag_created_by;
             if (activeAutoFlagRules.length > 0 && !manuallyFlagged) {
               const mergedRecord = expandDataRecord({ ...existing, ...baseRecordData });
               const autoFlag = applyAutoFlagRulesToRecord(mergedRecord, activeAutoFlagRules);
               if (autoFlag) {
                 // Flag it (or update the auto-flag if the rule result changed)
                 updateRecordFlag.run(autoFlag.flag_color, autoFlag.flag_reason, 1, existing.id);
               } else if (existing.auto_flagged) {
                 // Rule no longer matches — clear the auto-flag
                 updateRecordFlag.run(null, null, 0, existing.id);
               }
             }
            // Append-only snapshot for audit trail
            try {
              const updatedRecord = db.prepare('SELECT * FROM datarecord WHERE id = ?').get(existing.id);
              if (updatedRecord) {
                insertSnapshot.run(
                  String(connectionId),
                  String(updatedRecord.customer_number || ''),
                  JSON.stringify(updatedRecord),
                  syncTimestamp
                );
              }
            } catch (snapshotErr) {
              console.error('[snapshot] Failed to insert snapshot for record', existing.id, ':', snapshotErr.message);
            }
          } else {
            insertNewRecord.run(
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
              String(baseRecordData.note ?? ''),
              baseRecordData.custom_field_1 ?? null,
              baseRecordData.custom_field_2 ?? null,
              baseRecordData.custom_field_3 ?? null,
              baseRecordData.synced_at
            );
            // Apply auto-flag rules to new records (user hasn't touched them yet)
            const newRecord = db.prepare(`SELECT * FROM datarecord WHERE source_table = ? AND source_id = ?`).get(sourceName, String(sourceId || ''));
            if (activeAutoFlagRules.length > 0 && newRecord) {
              const autoFlag = applyAutoFlagRulesToRecord(expandDataRecord(newRecord), activeAutoFlagRules);
              if (autoFlag) {
                updateRecordFlag.run(autoFlag.flag_color, autoFlag.flag_reason, 1, newRecord.id);
              }
            }
            // Append-only snapshot for audit trail
            try {
              if (newRecord) {
                insertSnapshot.run(
                  String(connectionId),
                  String(newRecord.customer_number || ''),
                  JSON.stringify(newRecord),
                  syncTimestamp
                );
              }
            } catch (snapshotErr) {
              console.error('[snapshot] Failed to insert snapshot for new record:', snapshotErr.message);
            }
          }
        }
      });

      writeRowsTransaction(rows);
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
      if (!queryIndexField) {
        throw new Error('query_index_field is required for query mode');
      }

      const result = await pool.request().query(syncQuery);
      const rows = result.recordset || [];

      // Use the connection name as the logical source_table so existing records
      // are keyed to this connection rather than a physical table name
      const sourceName = `query::${connConfig.id}`;

      if (connConfig.record_type === 'inventory') {
        runInventoryRows(rows, sourceName, queryFieldMappings);
        // Prune items no longer returned by the query (upsert-then-prune keeps data live)
        const freshItemNumbers = rows.map(r =>
          String(getMappedOrFallbackValue(r, queryFieldMappings, 'item_number', inventoryMappingConfig.item_number.fallbacks) || '')
        ).filter(Boolean);
        if (freshItemNumbers.length > 0) {
          const placeholders = freshItemNumbers.map(() => '?').join(',');
          db.prepare(
            `DELETE FROM inventoryrecord WHERE source_table = ? AND item_number NOT IN (${placeholders})`
          ).run(sourceName, ...freshItemNumbers);
        }
      } else {
        runWriteRows(rows, sourceName, queryFieldMappings, queryIndexField);
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
        const result = await pool.request().query(query);
        const rows = result.recordset || [];

        const configRecordType = config.record_type || connConfig.record_type || 'customer';
        if (configRecordType === 'inventory') {
          runInventoryRows(rows, table_name, fieldMappings);
        } else {
          runWriteRows(rows, table_name, fieldMappings, index_field);
        }
        importedCount += rows.length;
      }
    }

    db.prepare(`
      UPDATE databaseconnection
      SET record_count = ?, last_sync = ?, last_error = NULL, updated_date = ?, status = 'active'
      WHERE id = ?
    `).run(importedCount, new Date().toISOString(), new Date().toISOString(), connectionId);

    if (syncRunId) {
      db.prepare(`
        UPDATE syncrun
        SET completed_at = ?, status = 'completed', message = ?
        WHERE id = ?
      `).run(
        new Date().toISOString(),
        `Imported ${importedCount} records`,
        syncRunId
      );
    }

    return {
      success: true,
      message: `Import completed - ${importedCount} records added`,
      imported: importedCount,
    };
  } catch (error) {
    try {
      db.prepare(`
        UPDATE databaseconnection
        SET status = 'error', last_error = ?, updated_date = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(error.message || 'Unknown error', connectionId);
    } catch {}

    try {
      if (syncRunId) {
        db.prepare(`
          UPDATE syncrun
          SET completed_at = ?, status = 'failed', message = ?
          WHERE id = ?
        `).run(
          new Date().toISOString(),
          error.message || 'Import failed',
          syncRunId
        );
      }
    } catch {}

    throw error;
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch {}
    }

    releaseSyncLock(connectionId);
  }
}

export { runConnectionImport, acquireSyncLock, releaseSyncLock, activeSyncs };
