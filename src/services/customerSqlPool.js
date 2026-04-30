// MSSQL pool for live customer-module queries.
// Picks the first active databaseconnection that is NOT marked is_bat_only —
// i.e. the same connection the sync engine uses to import customer data into
// the local datarecord table. The BAT module has its own dedicated pool in
// batReconciliation.js (getSagePool) and must NOT be used here, even though
// they may technically point to the same Sage 300 server.

import sql from 'mssql';
import db from '../db/index.js';
import { decryptPassword } from './encryption.js';
import { buildSqlServerConfig } from './mssqlSecurity.js';

let pool = null;
let poolKey = null;

function loadCustomerSqlConfig() {
  // Pick the first active, non-BAT-only connection. Order by id so behaviour
  // is deterministic when multiple match.
  const row = db.prepare(`
    SELECT id, name, host, port, database_name, username, encrypted_password, use_encryption
    FROM databaseconnection
    WHERE status = 'active'
      AND COALESCE(is_bat_only, 0) = 0
    ORDER BY id
    LIMIT 1
  `).get();

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
  pool = await sql.connect(loaded.config);
  poolKey = loaded.key;
  return pool;
}

// Run a query with one auto-retry if the cached pool turns out to be dead.
export async function runCustomerSqlQuery(sqlText) {
  let p = await getCustomerSqlPool();
  try {
    return await p.request().query(sqlText);
  } catch (err) {
    if (/Connection is closed|ECONNRESET|ETIMEDOUT|EPIPE/i.test(err.message || '')) {
      console.log('[customer-sql] Pool dropped, reopening and retrying once');
      try { await p.close(); } catch {}
      pool = null;
      p = await getCustomerSqlPool();
      return await p.request().query(sqlText);
    }
    throw err;
  }
}

export function resetCustomerSqlPool() {
  if (pool) { try { pool.close(); } catch {} }
  pool = null;
  poolKey = null;
}
