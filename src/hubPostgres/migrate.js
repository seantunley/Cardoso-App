import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import { assertHubPostgresConfig, getHubPostgresConfig } from './config.js';

const { Client } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.join(__dirname, 'migrations');

function getMigrationFiles() {
  return fs.readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function renderSql(template, schema) {
  return template.replaceAll('__SCHEMA__', schema);
}

function buildChecksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

async function ensureMigrationTable(client, schema) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function runHubPostgresMigrations(options = {}) {
  const config = {
    ...getHubPostgresConfig(),
    ...options,
  };

  const files = getMigrationFiles();
  if (options.dryRun) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(config.schema)) {
      throw new Error(`Invalid HUB_POSTGRES_SCHEMA: ${config.schema}`);
    }
    return {
      dryRun: true,
      schema: config.schema,
      files,
    };
  }

  assertHubPostgresConfig(config);

  const client = new Client({ connectionString: config.connectionString });
  await client.connect();

  try {
    const lockKey = `hub-postgres-migrate:${config.schema}`;
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    await ensureMigrationTable(client, config.schema);

    const applied = await client.query(`SELECT version, checksum FROM ${config.schema}.schema_migrations`);
    const appliedMap = new Map(applied.rows.map((row) => [row.version, row.checksum]));
    const completed = [];

    for (const file of files) {
      const version = file.split('_')[0];
      const rawSql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      const sql = renderSql(rawSql, config.schema);
      const checksum = buildChecksum(sql);
      const existingChecksum = appliedMap.get(version);

      if (existingChecksum) {
        if (existingChecksum !== checksum) {
          throw new Error(`Migration checksum mismatch for ${file}`);
        }
        completed.push({ version, file, status: 'already_applied' });
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO ${config.schema}.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
          [version, file, checksum]
        );
        await client.query('COMMIT');
        completed.push({ version, file, status: 'applied' });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    return {
      dryRun: false,
      schema: config.schema,
      completed,
    };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`hub-postgres-migrate:${config.schema}`]);
    } catch {}
    await client.end();
  }
}

export { getMigrationFiles, renderSql, runHubPostgresMigrations };
