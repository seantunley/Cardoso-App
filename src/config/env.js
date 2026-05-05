// Boot-time environment validation under a single zod schema.
//
// Replaces a handful of ad-hoc validators that were scattered across
// startup.js + config/hubPostgres.js (validateSessionSecret,
// validateHubTokenSecret, validateEncryptionKey, validateHubPostgresConfig).
// Each used to bail at the first failure with its own error format; this
// schema parses everything once and reports every problem in one boot
// message, so an operator fixing a misconfigured site sees the full list
// instead of fix-restart-fix-restart.
//
// Auto-heal of SESSION_SECRET stays in startup.js (it's an *action*, not a
// validator — runs in production when the secret is missing/placeholder).
// Pass-through env vars (DB_PATH, PORT, etc.) are not validated here —
// they're either defaulted at use-site or self-validating (Database
// constructor will throw if DB_PATH is bad).

import { z } from 'zod';

// Known placeholder values written by the installer — treated as "not set"
// so auto-heal can fire instead of rejecting them as a length violation.
const SESSION_SECRET_PLACEHOLDERS = new Set([
  'CHANGE_ME_RUN_SETUP',
  'change-me-to-a-long-random-string',
]);

// Coerce common boolean-ish env strings ('true', '1', 'yes', 'on') to
// real booleans. Anything else → false.
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const boolish = z.preprocess(
  (v) => (v == null || v === '' ? false : TRUE_VALUES.has(String(v).trim().toLowerCase())),
  z.boolean(),
);

// Optional integer with default. Empty/missing → fallback.
const optionalInt = (fallback) =>
  z.preprocess(
    (v) => {
      if (v == null || v === '') return fallback;
      const n = Number.parseInt(String(v), 10);
      return Number.isFinite(n) ? n : v; // pass non-numbers through so zod throws a useful error
    },
    z.number().int(),
  );

// Hex string of exact byte length. ENCRYPTION_KEY must be 64 hex chars
// (32 bytes for AES-256). Optional — only required when there are
// stored DB passwords AND we're in production (that check stays in
// startup.js because it requires a DB query).
const hexBytes = (bytes) =>
  z
    .string()
    .regex(new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`), `must be exactly ${bytes * 2} hex characters (${bytes} bytes)`)
    .optional();

// Build the schema. Most fields are optional with sensible defaults so
// dev installs can omit them; production just needs SESSION_SECRET set.
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: optionalInt(3001).pipe(z.number().int().min(1).max(65535)),

    // Session secret. REQUIRED — express-session crashes at first request
    // with "secret option required" if this is missing, turning a config
    // bug into a runtime auth failure. In production, autoHealSession-
    // SecretIfNeeded() runs BEFORE this validator and will generate one
    // for the installer-placeholder case, so production boots clean even
    // if the operator hasn't set it. In development, an unset/short
    // secret hard-fails here so the developer notices misconfiguration.
    //
    // Placeholder values get coerced to '' so they fail the .min(32)
    // check (otherwise an installer placeholder would slip through).
    SESSION_SECRET: z.preprocess(
      (v) => (typeof v === 'string' && SESSION_SECRET_PLACEHOLDERS.has(v) ? '' : v),
      z.string({
        required_error: 'SESSION_SECRET is required (set a 32+ char value in .env)',
        invalid_type_error: 'SESSION_SECRET must be a string of at least 32 chars',
      }).min(32, 'SESSION_SECRET must be at least 32 characters long'),
    ),

    // Hub silent-login JWT secret. Optional; warning only if too short
    // (handled outside zod since it's a soft warning, not a hard fail).
    HUB_TOKEN_SECRET: z.string().min(1).optional(),

    // AES-256-GCM key for encrypting DB connection passwords at rest.
    // Optional in dev; the migration path warns if missing in prod with
    // stored passwords (that check stays in startup.js).
    ENCRYPTION_KEY: hexBytes(32),

    // Mode flags
    HUB_MODE: boolish.default(false),
    HTTPS: boolish.default(false),
    TLS_FRONTING: boolish.default(false),

    // Hub Postgres scaffold (enabled = HUB_MODE && HUB_POSTGRES_ENABLED &&
    // HUB_POSTGRES_URL set). Validation chain expressed as refinements
    // below the object schema.
    HUB_POSTGRES_ENABLED: boolish.default(false),
    HUB_POSTGRES_URL: z.string().optional(),
    HUB_POSTGRES_SCHEMA: z.string().default('public'),
    HUB_POSTGRES_SSL: boolish.default(false),
    HUB_POSTGRES_APPLICATION_NAME: z.string().default('cardoso-hub'),
    HUB_POSTGRES_POOL_MIN: optionalInt(0).pipe(z.number().int().min(0)),
    HUB_POSTGRES_POOL_MAX: optionalInt(10).pipe(z.number().int().min(1)),

    // OCR worker pool
    OCR_CONCURRENCY: optionalInt(2).pipe(z.number().int().min(1).max(16)),

    // Backup retention
    BACKUP_KEEP_COUNT: optionalInt(30).pipe(z.number().int().min(1)),

    // SQLite mmap size (set to 0 to disable). 256MB default applied at
    // db/index.js, not here, since the ENV var may be intentionally unset.
    SQLITE_MMAP_BYTES: optionalInt(0).pipe(z.number().int().min(0)).optional(),
  })
  .passthrough() // allow arbitrary other env vars (PATH, etc.)
  .superRefine((v, ctx) => {
    // Hub Postgres: if requested without URL, that's a hard error.
    if (v.HUB_POSTGRES_ENABLED && v.HUB_MODE && !v.HUB_POSTGRES_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['HUB_POSTGRES_URL'],
        message: 'HUB_POSTGRES_URL is required when HUB_POSTGRES_ENABLED=true and HUB_MODE=true',
      });
    }
  });

/**
 * Parse and validate process.env. Returns { ok, config, issues }.
 * - ok: true if no hard errors (warnings still allowed via the warnings array).
 * - config: the parsed/coerced env object (only present when ok=true).
 * - issues: array of { path, message, severity } for all failures (errors and warnings).
 *
 * Caller decides how to react. server.js currently bails with process.exit(1)
 * on any error and console.warn's warnings.
 */
export function parseEnv(env = process.env) {
  const result = envSchema.safeParse(env);
  const issues = [];

  if (!result.success) {
    for (const issue of result.error.issues) {
      issues.push({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
        severity: 'error',
      });
    }
  }

  // Soft warnings (don't block boot, just flag). Use the parsed config
  // for boolean-typed checks — raw env strings ('true'/'false') are both
  // truthy so `!env.HUB_MODE` would always be false against a string.
  if (env.HUB_TOKEN_SECRET && env.HUB_TOKEN_SECRET.length < 32) {
    issues.push({
      path: 'HUB_TOKEN_SECRET',
      message: 'HUB_TOKEN_SECRET is shorter than 32 chars — hub_redirect silent login disabled',
      severity: 'warning',
    });
  }
  if (result.success && result.data.HUB_POSTGRES_ENABLED && !result.data.HUB_MODE) {
    issues.push({
      path: 'HUB_POSTGRES_ENABLED',
      message: 'HUB_POSTGRES_ENABLED is set but HUB_MODE is not true — Postgres scaffold will stay disabled',
      severity: 'warning',
    });
  }

  const errors = issues.filter((i) => i.severity === 'error');
  return {
    ok: errors.length === 0,
    config: result.success ? result.data : null,
    issues,
  };
}

/**
 * Convenience for boot: parse, log every issue, and exit on any error.
 * Returns the parsed config on success.
 */
export function validateEnvOrExit(env = process.env) {
  const { ok, config, issues } = parseEnv(env);

  for (const issue of issues) {
    if (issue.severity === 'error') {
      console.error(`[env] ❌ ${issue.path}: ${issue.message}`);
    } else {
      console.warn(`[env] ⚠️  ${issue.path}: ${issue.message}`);
    }
  }

  if (!ok) {
    console.error(`[env] ${issues.filter((i) => i.severity === 'error').length} configuration error(s) — refusing to start.`);
    process.exit(1);
  }

  return config;
}
