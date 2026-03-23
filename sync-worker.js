import cron from 'node-cron';
import Database from 'better-sqlite3';
import sql from 'mssql';
import dotenv from 'dotenv';

dotenv.config();

const dbPath = process.env.DB_PATH || './my-local-app.db';
const db = new Database(dbPath);

console.log(`🔄 Sync worker using SQLite database → ${dbPath}`);

function parseJsonSafely(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

const sanitizeForSqlite = (data) => {
  const sanitized = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    sanitized[key] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  }
  return sanitized;
};

function getMappingForKey(fieldMappings, localKey) {
  const mapping = fieldMappings?.[localKey];
  if (!mapping) return null;

  return {
    sourceField: mapping.sourceField || null,
    mode: mapping.mode || 'sync',
    label: mapping.label || localKey,
    type: mapping.type || 'text',
    isCustom: !!mapping.isCustom,
  };
}

function getRowValue(row, fieldName) {
  if (!fieldName) return undefined;
  return row[fieldName];
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function getMappedOrFallbackValue(row, fieldMappings, localKey, fallbacks = []) {
  const mapping = getMappingForKey(fieldMappings, localKey);
  const mappedValue = getRowValue(row, mapping?.sourceField);

  if (mappedValue !== undefined && mappedValue !== null && mappedValue !== '') {
    return mappedValue;
  }

  for (const key of fallbacks) {
    const fallbackValue = getRowValue(row, key);
    if (fallbackValue !== undefined && fallbackValue !== null && fallbackValue !== '') {
      return fallbackValue;
    }
  }

  return '';
}

function shouldApplyMappedValue(mode, existingValue, incomingValue) {
  if (mode === 'local-only') return false;
  if (incomingValue === undefined || incomingValue === null) return false;

  if (mode === 'sync') return true;

  if (mode === 'sync-if-empty') {
    return existingValue === undefined || existingValue === null || String(existingValue).trim() === '';
  }

  return true;
}

function buildFieldPatch(existingRecord, row, fieldMappings, indexField) {
  const patch = {};

  const mappingConfig = {
    customer_number: {
      fallbacks: ['customer_number', 'CustomerNumber', 'CUSTOMER_NUMBER', indexField, 'id'],
      defaultMode: 'sync',
    },
    customer_name: {
      fallbacks: ['customer_name', 'CustomerName', 'CUSTOMER_NAME', 'name', 'Name'],
      defaultMode: 'sync',
    },
    age_analysis: {
      fallbacks: ['age_analysis', 'AgeAnalysis', 'AGE_ANALYSIS'],
      defaultMode: 'sync',
    },
    note: {
      fallbacks: ['note', 'Note', 'notes', 'Notes'],
      defaultMode: 'local-only',
    },
    custom_field_1: {
      fallbacks: [],
      defaultMode: 'sync-if-empty',
    },
    custom_field_2: {
      fallbacks: [],
      defaultMode: 'sync-if-empty',
    },
    custom_field_3: {
      fallbacks: [],
      defaultMode: 'sync-if-empty',
    },
  };

  for (const [localKey, config] of Object.entries(mappingConfig)) {
    const mapping = getMappingForKey(fieldMappings, localKey);
    const mode = mapping?.mode || config.defaultMode;
    const incomingValue = getMappedOrFallbackValue(row, fieldMappings, localKey, config.fallbacks);
    const existingValue = existingRecord?.[localKey];

    if (shouldApplyMappedValue(mode, existingValue, incomingValue)) {
      patch[localKey] = String(incomingValue ?? '');
    } else if (!existingRecord && incomingValue !== undefined && incomingValue !== null && incomingValue !== '') {
      patch[localKey] = String(incomingValue);
    }
  }

  return patch;
}

let isScheduledSyncRunning = false;

async function runConnectionImport(connectionId) {
  let pool;

  try {
    console.log(`Starting import for connection ${connectionId}`);

    const stmt = db.prepare(`SELECT * FROM databaseconnection WHERE id = ?`);
    const connConfig = stmt.get(connectionId);

    if (!connConfig) {
      throw new Error('Connection not found');
    }

    const sqlConfig = {
      user: connConfig.username,
      password: connConfig.encrypted_password,
      server: connConfig.host,
      database: connConfig.database_name,
      port: parseInt(connConfig.port, 10),
      options: {
        encrypt: false,
        trustServerCertificate: true,
      },
      requestTimeout: 30000,
      connectionTimeout: 15000,
    };

    db.prepare(`UPDATE databaseconnection SET status = 'testing' WHERE id = ?`).run(connectionId);

    pool = await sql.connect(sqlConfig);

    const tableConfigs = parseJsonSafely(connConfig.table_configs, []);
    const fieldMappings = parseJsonSafely(connConfig.field_mappings, {});
    let importedCount = 0;
    let processed = 0;

    for (const config of tableConfigs) {
      const { table_name, selected_fields = [], index_field } = config;
      if (!table_name) continue;

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

        fields = uniqueFields.map((field) => `[${field}]`).join(', ');
      }

      const query = `SELECT ${fields} FROM [${table_name}]`;
      const result = await pool.request().query(query);

      for (const row of result.recordset) {
        const sourceId = String(
          firstDefined(
            getMappedOrFallbackValue(row, fieldMappings, 'customer_number', [index_field, 'id']),
            row[index_field],
            row.id,
            ''
          )
        );

        const existing = db
          .prepare(`SELECT * FROM datarecord WHERE source_id = ? AND source_table = ? LIMIT 1`)
          .get(String(sourceId || ''), table_name);

        const mappedPatch = buildFieldPatch(existing, row, fieldMappings, index_field);
        const dataJson = JSON.stringify(row);

        const invoiceFields = {
          last_unpaid_invoice_1: row.last_unpaid_invoice_1 || row.LastUnpaidInvoice1 || '',
          last_unpaid_invoice_1_amount: row.last_unpaid_invoice_1_amount || row.LastUnpaidInvoice1Amount || '',
          last_unpaid_invoice_2: row.last_unpaid_invoice_2 || row.LastUnpaidInvoice2 || '',
          last_unpaid_invoice_2_amount: row.last_unpaid_invoice_2_amount || row.LastUnpaidInvoice2Amount || '',
          last_unpaid_invoice_3: row.last_unpaid_invoice_3 || row.LastUnpaidInvoice3 || '',
          last_unpaid_invoice_3_amount: row.last_unpaid_invoice_3_amount || row.LastUnpaidInvoice3Amount || '',
        };

        const baseRecordData = sanitizeForSqlite({
          source_id: String(sourceId || ''),
          source_table: table_name,
          data: dataJson,
          synced_at: new Date().toISOString(),
          created_by: 'import',
          ...invoiceFields,
          ...mappedPatch,
        });

        if (existing) {
          const updateData = {
            ...baseRecordData,
            flag_color: existing.flag_color,
            flag_reason: existing.flag_reason,
            flag_created_by: existing.flag_created_by,
            updated_date: new Date().toISOString(),
          };

          const columns = Object.keys(updateData);
          const sets = columns.map((key) => `${key} = ?`).join(', ');

          db.prepare(`UPDATE datarecord SET ${sets} WHERE id = ?`).run(
            ...Object.values(updateData),
            existing.id
          );
        } else {
          const insertData = {
            customer_number: '',
            customer_name: '',
            age_analysis: '',
            note: '',
            custom_field_1: '',
            custom_field_2: '',
            custom_field_3: '',
            ...baseRecordData,
          };

          const columns = Object.keys(insertData);
          const placeholders = columns.map(() => '?').join(',');

          db.prepare(
            `INSERT INTO datarecord (${columns.join(',')}) VALUES (${placeholders})`
          ).run(...Object.values(insertData));
        }

        importedCount++;
        processed++;

        if (processed % 250 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    }

    db.prepare(`
      UPDATE databaseconnection
      SET record_count = ?, last_sync = CURRENT_TIMESTAMP, status = 'active'
      WHERE id = ?
    `).run(importedCount, connectionId);

    console.log(`Import complete for connection ${connectionId}. Total imported: ${importedCount}`);

    return {
      success: true,
      imported: importedCount,
    };
  } catch (error) {
    console.error('Import error:', error);

    try {
      db.prepare(`UPDATE databaseconnection SET status = 'error' WHERE id = ?`).run(connectionId);
    } catch {}

    throw error;
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch {}
    }
  }
}

async function runScheduledSync() {
  if (isScheduledSyncRunning) {
    console.log('⏭ Scheduled sync skipped: previous sync still running');
    return;
  }

  isScheduledSyncRunning = true;
  console.log('⏰ Running scheduled sync for all active connections...');

  try {
    const connections = db
      .prepare(`SELECT id, name FROM databaseconnection WHERE status = 'active'`)
      .all();

    for (const connection of connections) {
      try {
        console.log(`Scheduled sync starting for: ${connection.name} (${connection.id})`);
        await runConnectionImport(connection.id);
        console.log(`Scheduled sync finished for: ${connection.name} (${connection.id})`);
      } catch (error) {
        console.error(`Scheduled sync failed for connection ${connection.id}:`, error.message);
      }
    }

    console.log('✅ Scheduled sync cycle complete');
  } catch (error) {
    console.error('Scheduled sync job failed:', error);
  } finally {
    isScheduledSyncRunning = false;
  }
}

// Every 30 min, weekdays, 06:00 to 16:30
cron.schedule('0,30 6-16 * * 1-5', runScheduledSync);

// 17:00 final weekday run
cron.schedule('0 17 * * 1-5', runScheduledSync);

console.log('🕒 Sync worker started: every 30 min, weekdays, 06:00-17:00');