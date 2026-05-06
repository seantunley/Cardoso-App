// MSSQL pool for live customer-module queries.
// Resolution order:
//   1. The connection pinned to the 'customer_lookup' role in connection_role
//      (set via Settings → Connections → Module routing).
//   2. Legacy auto-pick: first active databaseconnection that is NOT marked
//      is_bat_only, ordered by id. Kept as fallback so installs that haven't
//      configured routing yet still work.
// The BAT module has its own dedicated pool in batReconciliation.js
// (getSagePool) and must NOT be used here, even though both may technically
// point to the same Sage 300 server.

import sql from 'mssql';
import db from '../db/index.js';
import { decryptPassword } from './encryption.js';
import { buildSqlServerConfig } from './mssqlSecurity.js';
import { getRoleConnectionId } from './connectionRoles.js';
import { logError } from '../lib/errorLog.js';

let pool = null;
let poolKey = null;

function loadCustomerSqlConfig() {
  const selectCols = `
    SELECT id, name, host, port, database_name, username, encrypted_password, use_encryption
    FROM databaseconnection
  `;

  // 1) Explicit role assignment
  let row = null;
  const assignedId = getRoleConnectionId('customer_lookup');
  if (assignedId) {
    row = db.prepare(`${selectCols} WHERE id = ? AND status = 'active'`).get(assignedId);
  }

  // 2) Fallback: first active, non-BAT-only connection (legacy behaviour)
  if (!row) {
    row = db.prepare(`
      ${selectCols}
      WHERE status = 'active'
        AND COALESCE(is_bat_only, 0) = 0
      ORDER BY id
      LIMIT 1
    `).get();
  }

  if (!row) return null;

  const useEncryption = row.use_encryption != null ? Boolean(Number(row.use_encryption)) : null;
  const config = buildSqlServerConfig({
    user: row.username,
    password: decryptPassword(row.encrypted_password),
    server: row.host,
    database: row.database_name,
    port: row.port || 1433,
    useEncryption,
  });

  return {
    source: `databaseconnection#${row.id} (${row.name}) ${row.host}:${row.port || 1433}/${row.database_name}`,
    // Pool key includes everything that would invalidate the connection.
    key: `cust:${row.id}:${row.host}:${row.port || 1433}:${row.database_name}:${row.username}`,
    config,
  };
}

async function getCustomerSqlPool() {
  const loaded = loadCustomerSqlConfig();
  if (!loaded) {
    throw new Error('No active customer SQL connection configured. Mark at least one databaseconnection as active and not BAT-only.');
  }
  // Re-open pool if config changed or the cached one died.
  if (pool && (poolKey !== loaded.key || pool.connected === false)) {
    try { await pool.close(); } catch {}
    pool = null;
  }
  if (pool) return pool;
  console.log(`[customer-sql] Opening pool from ${loaded.source}`);
  try {
    pool = await sql.connect(loaded.config);
  } catch (err) {
    try { logError('customer.sql.pool', err, { source: loaded.source }); } catch {}
    throw err;
  }
  poolKey = loaded.key;
  return pool;
}

// Run a query with one auto-retry if the cached pool turns out to be dead.
export async function runCustomerSqlQuery(sqlText) {
  let p = await getCustomerSqlPool();
  // First 80 chars of the SQL — enough to identify the query in logs
  // without dumping a multi-line SELECT into error_log.context. Helps
  // triage "which query failed" without grep'ing the codebase.
  const sqlPreview = String(sqlText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  try {
    return await p.request().query(sqlText);
  } catch (err) {
    if (/Connection is closed|ECONNRESET|ETIMEDOUT|EPIPE/i.test(err.message || '')) {
      console.log('[customer-sql] Pool dropped, reopening and retrying once');
      try { logError('customer.sql.query', err, { phase: 'pool_dropped_retrying', sql_preview: sqlPreview, role: 'customer_lookup' }, 'info'); } catch {}
      try { await p.close(); } catch {}
      pool = null;
      p = await getCustomerSqlPool();
      return await p.request().query(sqlText);
    }
    try { logError('customer.sql.query', err, { sql_preview: sqlPreview, role: 'customer_lookup', sql_code: err.code }); } catch {}
    throw err;
  }
}

export function resetCustomerSqlPool() {
  if (pool) { try { pool.close(); } catch {} }
  pool = null;
  poolKey = null;
}
