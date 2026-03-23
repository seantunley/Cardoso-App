import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';
import mssql from 'npm:mssql@11.0.1';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    const user = await base44.auth.me();
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { host, port, database_name, username, password } = await req.json();

    if (!host || !database_name || !username || !password) {
      return Response.json({ error: 'Missing required connection fields' }, { status: 400 });
    }

    const pool = await mssql.connect({
      server: host,
      port: port || 1433,
      database: database_name,
      user: username,
      password: password,
      options: {
        encrypt: true,
        trustServerCertificate: true,
        connectTimeout: 15000,
      },
    });

    // Get all user tables
    const tablesResult = await pool.request().query(`
      SELECT TABLE_NAME 
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_TYPE = 'BASE TABLE' 
      ORDER BY TABLE_NAME
    `);

    const tables = tablesResult.recordset.map(r => r.TABLE_NAME);

    // Get columns for each table
    const fieldsResult = await pool.request().query(`
      SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME IN (${tables.map(t => `'${t}'`).join(',') || "''"})
      ORDER BY TABLE_NAME, ORDINAL_POSITION
    `);

    const fields = {};
    for (const row of fieldsResult.recordset) {
      if (!fields[row.TABLE_NAME]) fields[row.TABLE_NAME] = [];
      fields[row.TABLE_NAME].push(row.COLUMN_NAME);
    }

    await pool.close();

    return Response.json({ tables, fields });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});