// Tests for the consolidated env validator (src/config/env.js).
// The whole point of consolidation is "one boot pass surfaces every
// problem at once" — these tests pin that behaviour.

import { describe, it, expect } from 'vitest';
import { parseEnv } from '../src/config/env.js';

// Minimum env that should always parse clean. Each test extends this
// with the field under test.
const baseEnv = {
  NODE_ENV: 'development',
  SESSION_SECRET: 'a'.repeat(32),
};

describe('parseEnv — happy paths', () => {
  it('accepts a minimal valid env', () => {
    const { ok, config, issues } = parseEnv(baseEnv);
    expect(ok).toBe(true);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(config).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3001,
      HUB_MODE: false,
      OCR_CONCURRENCY: 2,
      BACKUP_KEEP_COUNT: 30,
    });
  });

  it('coerces boolean-ish strings to real booleans', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      const { config } = parseEnv({ ...baseEnv, HUB_MODE: v });
      expect(config.HUB_MODE).toBe(true);
    }
    for (const v of ['0', 'false', 'no', 'off', '']) {
      const { config } = parseEnv({ ...baseEnv, HUB_MODE: v });
      expect(config.HUB_MODE).toBe(false);
    }
  });

  it('coerces optional ints with defaults', () => {
    const { config } = parseEnv({ ...baseEnv, OCR_CONCURRENCY: '4' });
    expect(config.OCR_CONCURRENCY).toBe(4);
    expect(parseEnv({ ...baseEnv, OCR_CONCURRENCY: '' }).config.OCR_CONCURRENCY).toBe(2);
    expect(parseEnv({ ...baseEnv }).config.OCR_CONCURRENCY).toBe(2);
  });

  it('passes through unrelated env vars without rejecting', () => {
    const { ok, config } = parseEnv({ ...baseEnv, RANDOM_OS_VAR: 'whatever' });
    expect(ok).toBe(true);
    expect(config.RANDOM_OS_VAR).toBe('whatever');
  });
});

describe('parseEnv — hard errors', () => {
  it('rejects a SESSION_SECRET shorter than 32 chars', () => {
    const { ok, issues } = parseEnv({ ...baseEnv, SESSION_SECRET: 'too-short' });
    expect(ok).toBe(false);
    const errs = issues.filter((i) => i.severity === 'error');
    expect(errs.some((e) => e.path === 'SESSION_SECRET')).toBe(true);
  });

  it('treats installer placeholder as missing (so auto-heal can fire)', () => {
    const { ok, issues } = parseEnv({
      ...baseEnv,
      SESSION_SECRET: 'CHANGE_ME_RUN_SETUP',
    });
    // Without auto-heal, the placeholder should fail — the integration
    // contract is autoHealSessionSecretIfNeeded() runs BEFORE parseEnv.
    expect(ok).toBe(false);
    expect(issues.some((i) => i.path === 'SESSION_SECRET')).toBe(true);
  });

  it('rejects a malformed ENCRYPTION_KEY (not 64 hex chars)', () => {
    const { ok, issues } = parseEnv({
      ...baseEnv,
      ENCRYPTION_KEY: 'not-hex-at-all',
    });
    expect(ok).toBe(false);
    expect(issues.some((i) => i.path === 'ENCRYPTION_KEY')).toBe(true);
  });

  it('accepts a valid 64-char hex ENCRYPTION_KEY', () => {
    const { ok } = parseEnv({
      ...baseEnv,
      ENCRYPTION_KEY: 'a'.repeat(64),
    });
    expect(ok).toBe(true);
  });

  it('rejects HUB_POSTGRES_ENABLED + HUB_MODE without HUB_POSTGRES_URL', () => {
    const { ok, issues } = parseEnv({
      ...baseEnv,
      HUB_MODE: 'true',
      HUB_POSTGRES_ENABLED: 'true',
      // HUB_POSTGRES_URL omitted
    });
    expect(ok).toBe(false);
    expect(issues.some((i) => i.path === 'HUB_POSTGRES_URL')).toBe(true);
  });

  it('reports MULTIPLE errors in one pass (the whole point of consolidation)', () => {
    const { ok, issues } = parseEnv({
      NODE_ENV: 'production',
      SESSION_SECRET: 'too-short',
      ENCRYPTION_KEY: 'bad-hex',
      HUB_MODE: 'true',
      HUB_POSTGRES_ENABLED: 'true',
    });
    expect(ok).toBe(false);
    const errs = issues.filter((i) => i.severity === 'error');
    expect(errs.length).toBeGreaterThanOrEqual(3);
    const paths = errs.map((e) => e.path);
    expect(paths).toContain('SESSION_SECRET');
    expect(paths).toContain('ENCRYPTION_KEY');
    expect(paths).toContain('HUB_POSTGRES_URL');
  });
});

describe('parseEnv — soft warnings (don\'t block boot)', () => {
  it('warns when HUB_TOKEN_SECRET is set but too short', () => {
    const { ok, issues } = parseEnv({
      ...baseEnv,
      HUB_TOKEN_SECRET: 'short',
    });
    expect(ok).toBe(true);
    const warns = issues.filter((i) => i.severity === 'warning');
    expect(warns.some((w) => w.path === 'HUB_TOKEN_SECRET')).toBe(true);
  });

  it('warns when HUB_POSTGRES_ENABLED is set without HUB_MODE', () => {
    const { ok, issues } = parseEnv({
      ...baseEnv,
      HUB_POSTGRES_ENABLED: 'true',
      HUB_MODE: 'false',
    });
    expect(ok).toBe(true);
    expect(issues.some((i) => i.severity === 'warning' && i.path === 'HUB_POSTGRES_ENABLED')).toBe(true);
  });
});
