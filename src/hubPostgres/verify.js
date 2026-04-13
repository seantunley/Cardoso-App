import pg from 'pg';
import { assertHubPostgresConfig, getHubPostgresConfig } from './config.js';
import { runHubPostgresMigrations } from './migrate.js';

const { Client } = pg;

async function verifyHubPostgresSchema(options = {}) {
  const config = {
    ...getHubPostgresConfig(),
    ...options,
  };
  assertHubPostgresConfig(config);

  await runHubPostgresMigrations(config);

  const client = new Client({ connectionString: config.connectionString });
  await client.connect();
  try {
    const tableRows = await client.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1
       ORDER BY table_name`,
      [config.schema]
    );

    const indexRows = await client.query(
      `SELECT tablename, indexname
       FROM pg_indexes
       WHERE schemaname = $1
       ORDER BY tablename, indexname`,
      [config.schema]
    );

    const requiredTables = ['customer_balances', 'customers', 'flag_events', 'schema_migrations', 'sites', 'sync_runs'];
    const existingTables = new Set(tableRows.rows.map((row) => row.table_name));
    const missingTables = requiredTables.filter((name) => !existingTables.has(name));

    return {
      schema: config.schema,
      tables: tableRows.rows.map((row) => row.table_name),
      indexes: indexRows.rows,
      missingTables,
      ok: missingTables.length === 0,
    };
  } finally {
    await client.end();
  }
}

export { verifyHubPostgresSchema };
