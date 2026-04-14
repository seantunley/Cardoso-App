// Default schema must match src/config/hubPostgres.js (both default to 'public')
const DEFAULT_SCHEMA = 'public';

function boolFromEnv(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function getHubPostgresConfig(env = process.env) {
  return {
    enabled: boolFromEnv(env.HUB_POSTGRES_ENABLED, false),
    connectionString: env.HUB_POSTGRES_URL || env.DATABASE_URL || '',
    schema: env.HUB_POSTGRES_SCHEMA || DEFAULT_SCHEMA,
  };
}

function assertHubPostgresConfig(config) {
  if (!config.connectionString) {
    throw new Error('HUB_POSTGRES_URL (or DATABASE_URL) is required for Hub Postgres tasks');
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(config.schema)) {
    throw new Error(`Invalid HUB_POSTGRES_SCHEMA: ${config.schema}`);
  }
}

export { DEFAULT_SCHEMA, boolFromEnv, getHubPostgresConfig, assertHubPostgresConfig };
