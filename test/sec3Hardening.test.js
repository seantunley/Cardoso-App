import { describe, it, expect, afterEach } from 'vitest';
import { safeTokenEqual } from '../src/lib/safeEqual.js';
import { getBackupConfigExportMode } from '../src/routes/backup.js';

describe('safeTokenEqual (SEC-3 — constant-time token compare)', () => {
  it('true for identical tokens', () => {
    expect(safeTokenEqual('s3cr3t-token-abc', 's3cr3t-token-abc')).toBe(true);
  });
  it('false for different tokens of the same length', () => {
    expect(safeTokenEqual('s3cr3t-token-abc', 's3cr3t-token-abd')).toBe(false);
  });
  it('false for different lengths (no throw from timingSafeEqual)', () => {
    expect(safeTokenEqual('short', 'a-much-longer-token')).toBe(false);
  });
  it('false for empty/missing provided token', () => {
    expect(safeTokenEqual(undefined, 'expected')).toBe(false);
    expect(safeTokenEqual('', 'expected')).toBe(false);
  });
  it('false when both empty (so a blank header never matches a blank secret)', () => {
    expect(safeTokenEqual('', '')).toBe(false);
  });
});

describe('getBackupConfigExportMode (SEC-3 — safe default)', () => {
  const ORIG_MODE = process.env.BACKUP_CONFIG_EXPORT_MODE;
  const ORIG_NODE_ENV = process.env.NODE_ENV;
  afterEach(() => {
    if (ORIG_MODE === undefined) delete process.env.BACKUP_CONFIG_EXPORT_MODE;
    else process.env.BACKUP_CONFIG_EXPORT_MODE = ORIG_MODE;
    if (ORIG_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIG_NODE_ENV;
  });

  it('defaults to redacted when no override and not production', () => {
    delete process.env.BACKUP_CONFIG_EXPORT_MODE;
    process.env.NODE_ENV = 'development';
    expect(getBackupConfigExportMode()).toBe('redacted');
  });
  it('defaults to redacted even when NODE_ENV is unset (the footgun)', () => {
    delete process.env.BACKUP_CONFIG_EXPORT_MODE;
    delete process.env.NODE_ENV;
    expect(getBackupConfigExportMode()).toBe('redacted');
  });
  it('honors an explicit full opt-in', () => {
    process.env.BACKUP_CONFIG_EXPORT_MODE = 'full';
    expect(getBackupConfigExportMode()).toBe('full');
  });
  it('honors an explicit disabled', () => {
    process.env.BACKUP_CONFIG_EXPORT_MODE = 'disabled';
    expect(getBackupConfigExportMode()).toBe('disabled');
  });
});
