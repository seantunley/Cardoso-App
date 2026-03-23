import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';
import mssql from 'npm:mssql@11.0.1';

function getString(value: unknown): string {
  return String(value ?? '');
}

function escapeSqlIdentifier(name: string): string {
  return `[${String(name).replace(/]/g, ']]')}]`;
}

function uniqueNonEmpty(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((v): v is string => !!v && String(v).trim() !== ''))];
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function buildSelectedFields(selectedFields: string[], indexField: string): string {
  const fields = uniqueNonEmpty([indexField, ...selectedFields]);
  if (fields.length === 0) {
    throw new Error('No fields configured for sync');
  }
  return fields.map(escapeSqlIdentifier).join(', ');
}

function buildRecordData(row: Record<string, unknown>, tableName: string, indexField: string) {
  const sourceId = getString(row[indexField] || '');

  const payload = {
    customer_number: getString(
      row['customer_number'] ||
      row['CustomerNumber'] ||
      row['CUSTOMER_NUMBER'] ||
      row[indexField] ||
      ''
    ),
    customer_name: getString(
      row['customer_name'] ||
      row['CustomerName'] ||
      row['CUSTOMER_NAME'] ||
      row['name'] ||
      row['Name'] ||
      ''
    ),
    age_analysis: getString(
      row['age_analysis'] ||
      row['AgeAnalysis'] ||
      row['AGE_ANALYSIS'] ||
      ''
    ),
    source_id: sourceId,
    source_table: tableName,
    data: row,
    last_unpaid_invoice_1: getString(
      row['last_unpaid_invoice_1'] || row['LastUnpaidInvoice1'] || ''
    ),
    last_unpaid_invoice_1_amount: getString(
      row['last_unpaid_invoice_1_amount'] || row['LastUnpaidInvoice1Amount'] || ''
    ),
    last_unpaid_invoice_2: getString(
      row['last_unpaid_invoice_2'] || row['LastUnpaidInvoice2'] || ''
    ),
    last_unpaid_invoice_2_amount: getString(
      row['last_unpaid_invoice_2_amount'] || row['LastUnpaidInvoice2Amount'] || ''
    ),
    last_unpaid_invoice_3: getString(
      row['last_unpaid_invoice_3'] || row['LastUnpaidInvoice3'] || ''
    ),
    last_unpaid_invoice_3_amount: getString(
      row['last_unpaid_invoice_3_amount'] || row['LastUnpaidInvoice3Amount'] || ''
    ),
    synced_at: new Date().toISOString(),
  };

  return { sourceId, payload };
}

function hasMeaningfulChanges(existingRecord: any, nextPayload: any): boolean {
  return (
    getString(existingRecord.customer_number) !== getString(nextPayload.customer_number) ||
    getString(existingRecord.customer_name) !== getString(nextPayload.customer_name) ||
    getString(existingRecord.age_analysis) !== getString(nextPayload.age_analysis) ||
    getString(existingRecord.last_unpaid_invoice_1) !== getString(nextPayload.last_unpaid_invoice_1) ||
    getString(existingRecord.last_unpaid_invoice_1_amount) !== getString(nextPayload.last_unpaid_invoice_1_amount) ||
    getString(existingRecord.last_unpaid_invoice_2) !== getString(nextPayload.last_unpaid_invoice_2) ||
    getString(existingRecord.last_unpaid_invoice_2_amount) !== getString(nextPayload.last_unpaid_invoice_2_amount) ||
    getString(existingRecord.last_unpaid_invoice_3) !== getString(nextPayload.last_unpaid_invoice_3) ||
    getString(existingRecord.last_unpaid_invoice_3_amount) !== getString(nextPayload.last_unpaid_invoice_3_amount) ||
    stableJson(existingRecord.data) !== stableJson(nextPayload.data)
  );
}

async function runInBatches<T>(
  items: T[],
  batchSize: number,
  handler: (item: T) => Promise<unknown>
) {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(handler));
  }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    let isScheduled = false;
    try {
      const user = await base44.auth.me();
      if (user?.role !== 'admin') {
        return Response.json({ error: 'Admin access required' }, { status: 403 });
      }
    } catch {
      isScheduled = true;
    }

    const client = isScheduled ? base44.asServiceRole : base44;

    const connections = await client.entities.DatabaseConnection.list();
    const activeConnections = connections.filter((c: any) => c.status === 'active');

    if (activeConnections.length === 0) {
      return Response.json({
        message: 'No active connections to sync',
        totalSynced: 0,
        results: [],
      });
    }

    let totalSynced = 0;
    const results: any[] = [];

    for (const conn of activeConnections) {
      let pool: mssql.ConnectionPool | null = null;

      try {
        const connectionStart = Date.now();

        pool = await mssql.connect({
          server: conn.host,
          port: conn.port || 1433,
          database: conn.database_name,
          user: conn.username,
          password: conn.encrypted_password,
          options: {
            encrypt: true,
            trustServerCertificate: true,
          },
          requestTimeout: 30000,
          connectionTimeout: 15000,
        });

        const tableConfigs = Array.isArray(conn.table_configs) ? conn.table_configs : [];
        let connectionSynced = 0;
        let createdCount = 0;
        let updatedCount = 0;
        let skippedCount = 0;

        for (const tableConfig of tableConfigs) {
          const tableName = tableConfig?.table_name;
          const selectedFields = Array.isArray(tableConfig?.selected_fields) ? tableConfig.selected_fields : [];
          const indexField = tableConfig?.index_field || 'id';

          if (!tableName) continue;

          const fieldsSql = buildSelectedFields(selectedFields, indexField);
          const query = `SELECT ${fieldsSql} FROM ${escapeSqlIdentifier(tableName)}`;

          const fetchStart = Date.now();
          const sqlResult = await pool.request().query(query);
          const rows = Array.isArray(sqlResult.recordset) ? sqlResult.recordset : [];
          const fetchMs = Date.now() - fetchStart;

          const existingFetchStart = Date.now();
          const existingRecords = await client.entities.DataRecord.filter({
            source_table: tableName,
          });
          const existingFetchMs = Date.now() - existingFetchStart;

          const existingMap = new Map<string, any>(
            existingRecords.map((record: any) => [
              `${record.source_table}::${record.source_id}`,
              record,
            ])
          );

          const toCreate: any[] = [];
          const toUpdate: Array<{ id: string; payload: any }> = [];

          for (const row of rows) {
            const { sourceId, payload } = buildRecordData(row, tableName, indexField);
            const existingRecord = existingMap.get(`${tableName}::${sourceId}`);

            if (existingRecord) {
              if (!hasMeaningfulChanges(existingRecord, payload)) {
                skippedCount++;
                continue;
              }

              toUpdate.push({
                id: existingRecord.id,
                payload: {
                  ...payload,
                  flag_color: existingRecord.flag_color,
                  flag_reason: existingRecord.flag_reason,
                  flag_created_by: existingRecord.flag_created_by,
                  note: existingRecord.note,
                  custom_field_1: existingRecord.custom_field_1,
                  custom_field_2: existingRecord.custom_field_2,
                  custom_field_3: existingRecord.custom_field_3,
                },
              });
            } else {
              toCreate.push(payload);
            }
          }

          const writeStart = Date.now();

          await runInBatches(toCreate, 10, async (payload) => {
            await client.entities.DataRecord.create(payload);
          });

          await runInBatches(toUpdate, 10, async ({ id, payload }) => {
            await client.entities.DataRecord.update(id, payload);
          });

          const writeMs = Date.now() - writeStart;

          createdCount += toCreate.length;
          updatedCount += toUpdate.length;
          connectionSynced += toCreate.length + toUpdate.length;

          results.push({
            connection: conn.name,
            table: tableName,
            fetched: rows.length,
            created: toCreate.length,
            updated: toUpdate.length,
            skipped: skippedCount,
            fetchMs,
            existingFetchMs,
            writeMs,
            status: 'success',
          });
        }

        totalSynced += connectionSynced;

        await client.entities.DatabaseConnection.update(conn.id, {
          last_sync: new Date().toISOString(),
          record_count: connectionSynced,
          status: 'active',
        });

        results.push({
          connection: conn.name,
          synced: connectionSynced,
          created: createdCount,
          updated: updatedCount,
          skipped: skippedCount,
          totalMs: Date.now() - connectionStart,
          status: 'success',
        });
      } catch (connError: any) {
        try {
          await client.entities.DatabaseConnection.update(conn.id, {
            status: 'error',
          });
        } catch {}

        results.push({
          connection: conn.name,
          error: connError?.message || 'Unknown sync error',
          status: 'error',
        });
      } finally {
        if (pool) {
          try {
            await pool.close();
          } catch {}
        }
      }
    }

    return Response.json({
      message: `Sync complete. ${totalSynced} records synced.`,
      totalSynced,
      results,
    });
  } catch (error: any) {
    return Response.json(
      { error: error?.message || 'Unexpected sync error' },
      { status: 500 }
    );
  }
});