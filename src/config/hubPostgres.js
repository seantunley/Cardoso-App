const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function readFlag(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return TRUE_VALUES.has(String(value).trim().toLowerCase());
}

function readInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getHubPostgresConfig(env = process.env) {
  const hubMode = String(env.HUB_MODE || '').trim().toLowerCase() === 'true';
  const requested = readFlag(env.HUB_POSTGRES_ENABLED, false);
  const connectionString = String(env.HUB_POSTGRES_URL || '').trim();
  const schema = String(env.HUB_POSTGRES_SCHEMA || 'public').trim() || 'public';
  const ssl = readFlag(env.HUB_POSTGRES_SSL, false);
  const applicationName = String(env.HUB_POSTGRES_APPLICATION_NAME || 'cardoso-hub').trim() || 'cardoso-hub';
  const poolMin = readInt(env.HUB_POSTGRES_POOL_MIN, 0);
  const poolMax = readInt(env.HUB_POSTGRES_POOL_MAX, 10);
  const enabled = hubMode && requested;

  let reason = 'disabled';
  if (requested && !hubMode) reason = 'hub_mode_disabled';
  else if (enabled) reason = 'enabled';

  const missing = [];
  if (enabled && !connectionString) missing.push('HUB_POSTGRES_URL');

  return {
    requested,
    enabled,
    hubMode,
    reason,
    connectionString,
    schema,
    ssl,
    applicationName,
    poolMin,
    poolMax,
    validation: {
      ok: missing.length === 0,
      missing,
    },
  };
}

// validateHubPostgresConfig was removed in v2026.4.21 — its validation is now
// part of the consolidated zod schema in src/config/env.js (single boot pass,
// aggregated error reporting). getHubPostgresConfig stays because hub
// storage init still needs the richer { enabled, reason, ... } object.
