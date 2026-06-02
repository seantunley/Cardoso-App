// MSSQL pool for the JTI export module.
//
// Resolution: ONLY the connection pinned to the 'jti_export' role in
// connection_role (set via Settings → Connections → Module routing).
// There is intentionally NO fallback to the BAT Sage pool — the BAT
// connection points at the AP module's database, the JTI export
// queries OE Shipment History which can live in a different Sage
// company. Sharing the BAT pool by accident would silently query the
// wrong company; this module fails loudly instead.
//
// Mirrors the pattern in customerSqlPool.js / batReconciliation's
// getSagePool: lazy single-pool, recreated when the underlying
// connection assignment changes or the cached pool dies.

import sql from 'mssql';
import db from '../../db/index.js';
import { decryptPassword } from '../encryption.js';
import { buildSqlServerConfig } from '../mssqlSecurity.js';
import { getRoleConnectionId } from '../connectionRoles.js';
import { logError } from '../../lib/errorLog.js';

let pool = null;
let poolKey = null;

/**
 * Resolve the databaseconnection row to use for JTI. Returns null if
 * the role isn't pinned OR if the pinned connection has been deleted /
 * marked inactive — caller decides how to surface the absence.
 */
function loadJtiSqlConfig() {
  const assignedId = getRoleConnectionId('jti_export');
  if (!assignedId) return null;

  const row = db.prepare(`
    SELECT id, name, host, port, database_name, username, encrypted_password, use_encryption, status
    FROM databaseconnection
    WHERE id = ? AND status = 'active'
  `).get(assignedId);
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
    key: `jti:${row.id}:${row.host}:${row.port || 1433}:${row.database_name}:${row.username}`,
    config,
  };
}

/**
 * Get (or open) the JTI Sage pool. Throws a clear, operator-actionable
 * error when the role isn't configured — DO NOT add a fallback to the
 * BAT pool here. JTI must run against its own deliberately-assigned
 * connection or not at all.
 *
 * @returns {Promise<import('mssql').ConnectionPool>}
 * @throws {Error} when the jti_export role is unset / the assigned
 *                 connection is missing or inactive
 */
export async function getJtiSagePool() {
  const loaded = loadJtiSqlConfig();
  if (!loaded) {
    throw new Error(
      'No connection assigned to JTI export — Settings → Connections → Module routing → assign a connection to "JTI export". This module does not fall back to the BAT Sage pool by design.'
    );
  }

  // Re-open the pool if its config changed under us (operator switched
  // the role assignment) or if the cached pool is no longer connected
  // (idle timeout, network blip).
  if (pool && (poolKey !== loaded.key || pool.connected === false)) {
    try { await pool.close(); } catch {} // eslint-disable-line no-empty -- best-effort close of stale pool; we're discarding it anyway
    pool = null;
  }
  if (pool) return pool;

  console.log(`[jti-sage] Opening JTI pool from ${loaded.source}`);
  try {
    pool = await sql.connect(loaded.config);
  } catch (err) {
    try { logError('jti.sage.pool', err, { source: loaded.source }); } catch {} // eslint-disable-line no-empty -- logError wrapper; we still re-throw the original error
    throw err;
  }
  poolKey = loaded.key;
  return pool;
}

/**
 * Force the cached pool to be re-opened on the next get. Used by:
 *   - tests, to avoid leaking pool state between cases
 *   - the route layer, when the operator changes the role assignment
 *     (so the next export uses the new connection without a server
 *     restart)
 */
export async function resetJtiSagePool() {
  if (pool) { try { await pool.close(); } catch {} } // eslint-disable-line no-empty -- best-effort close during pool reset
  pool = null;
  poolKey = null;
}

/**
 * Inspect whether the JTI pool is currently configured (without
 * actually opening a connection). Used by the GET /api/jti/settings
 * endpoint so the UI can show "JTI is not yet routable" before the
 * operator clicks Generate.
 *
 * @returns {{ configured: boolean, source: string | null }}
 */
export function getJtiPoolStatus() {
  const loaded = loadJtiSqlConfig();
  if (!loaded) return { configured: false, source: null };
  return { configured: true, source: loaded.source };
}
