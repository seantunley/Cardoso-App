/**
 * Connection and sync routes — extracted from server.js (US-008).
 *
 * Factory pattern: createConnectionsRouter(deps) returns an Express router.
 */

import { Router } from 'express';
import sql from 'mssql';
import { decryptPassword } from '../services/encryption.js';
import { buildSqlServerConfig } from '../services/mssqlSecurity.js';
import { runConnectionImport } from '../services/syncEngine.js';

export function createConnectionsRouter({ db, requireAuth, requirePermission, isShuttingDown }) {
  const router = Router();

  // ==================== TEST SQL SERVER CONNECTION ====================
  router.post(
    '/api/test-connection',
    requireAuth,
    requirePermission('can_access_connections'),
    async (req, res) => {
      const { host, port = 1433, database_name, username, connectionId } = req.body;
      let { password, use_encryption } = req.body;
      let pool;

      // If no password supplied but a connectionId is, decrypt the stored one
      if (!password && connectionId) {
        const stored = db.prepare('SELECT encrypted_password, use_encryption FROM databaseconnection WHERE id = ?').get(connectionId);
        if (stored?.encrypted_password) {
          try { password = decryptPassword(stored.encrypted_password); } catch {}
        }
        // Use saved encryption preference if not overridden in the test request
        if (use_encryption == null && stored != null) {
          use_encryption = stored.use_encryption;
        }
      }

      if (!host || !database_name || !username || !password) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      try {
        const useEncryptionBool = use_encryption != null ? Boolean(Number(use_encryption)) : null;
        const config = buildSqlServerConfig({
          user: username,
          password,
          server: host,
          database: database_name,
          port,
          useEncryption: useEncryptionBool,
        });

        pool = await sql.connect(config);

        const tablesResult = await pool.request().query(`
          SELECT TABLE_NAME
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_TYPE = 'BASE TABLE'
          ORDER BY TABLE_NAME
        `);

        const tables = tablesResult.recordset.map((r) => r.TABLE_NAME);

        const fields = {};
        for (const table of tables) {
          const columnsResult = await pool.request()
            .input('tableName', sql.VarChar(128), table)
            .query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @tableName ORDER BY ORDINAL_POSITION`);
          fields[table] = columnsResult.recordset.map((r) => r.COLUMN_NAME);
        }

        res.json({
          success: true,
          tables,
          fields,
        });
      } catch (error) {
        console.error('Test connection error:', error);
        res.status(500).json({
          error: error.message || 'Failed to connect to SQL Server',
        });
      } finally {
        if (pool) {
          try {
            await pool.close();
          } catch {}
        }
      }
    }
  );

  // ==================== TEST QUERY ====================
  router.post(
    '/api/test-query',
    requireAuth,
    requirePermission('can_access_connections'),
    async (req, res) => {
          const { host, port = 1433, database_name, username, query, connectionId } = req.body;
      let { password, use_encryption } = req.body;
      let pool;

      // If no password supplied but a connectionId is, decrypt the stored one
      if (!password && connectionId) {
        const stored = db.prepare('SELECT encrypted_password, use_encryption FROM databaseconnection WHERE id = ?').get(connectionId);
        if (stored?.encrypted_password) {
          try { password = decryptPassword(stored.encrypted_password); } catch {}
        }
        if (use_encryption == null && stored != null) use_encryption = stored.use_encryption;
      }

      if (!host || !database_name || !username || !password) {
        return res.status(400).json({ error: 'Missing connection credentials' });
      }
      if (!query || !query.trim()) {
        return res.status(400).json({ error: 'No query provided' });
      }

      // Basic safety: only allow SELECT/CTE/comment-prefixed queries
      // Strip leading comments (-- lines and /* */ blocks) before checking
      const strippedForCheck = query
        .replace(/--[^\n]*/g, '')        // remove -- comments
        .replace(/\/\*[\s\S]*?\*\//g, '') // remove /* */ blocks
        .trim()
        .toUpperCase();
      if (!strippedForCheck.startsWith('SELECT') && !strippedForCheck.startsWith('WITH')) {
        return res.status(400).json({ error: 'Only SELECT or CTE (WITH ...) queries are allowed' });
      }

      try {
        const useEncBool = use_encryption != null ? Boolean(Number(use_encryption)) : null;
        pool = await sql.connect(buildSqlServerConfig({
          user: username,
          password,
          server: host,
          database: database_name,
          port,
          useEncryption: useEncBool,
        }));

        // Run the full query and slice — avoids any SQL modification that breaks
        // CTEs, comments, HAVING, ORDER BY, UNION, etc.
        const result = await pool.request().query(query);
        const allRows = result.recordset || [];
        const rows = allRows.slice(0, 5);
        const columns = rows.length > 0
          ? Object.keys(rows[0])
          : (result.recordset?.columns ? Object.keys(result.recordset.columns) : []);
        const columnsMeta = columns;

        res.json({
          success: true,
          columns: columnsMeta.length > 0 ? columnsMeta : columns,
          preview: rows,
        });
      } catch (error) {
        console.error('Test query error:', error);
        res.status(500).json({ error: error.message || 'Query failed' });
      } finally {
        if (pool) { try { await pool.close(); } catch {} }
      }
    }
  );

  // ==================== IMPORT FROM SQL SERVER ====================
  router.post(
    '/api/import/:connectionId',
    requireAuth,
    requirePermission('can_access_connections'),
    async (req, res) => {
      if (isShuttingDown()) {
        return res.status(503).json({ error: 'Server is shutting down' });
      }

      try {
        const result = await runConnectionImport(req.params.connectionId, { isShuttingDown });
        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message || 'Import failed' });
      }
    }
  );

  return router;
}
