// Contract tests for src/services/hub/hubHealth.js — the two pure
// roll-up functions that drive the hub dashboard's red/amber/green
// tiles. Previously closure helpers inside createHubRouter (untestable
// — could only be exercised by mocking the whole route handler), now
// extracted so the thresholds can be pinned.
//
// What's pinned:
//   - SQL backup verdict: unavailable / failed / stale / ok rules
//   - Machine health verdict: ok / warning / critical promotion rules
//   - Thresholds: CPU 75/90, RAM 80/90, disk free 20/10
//   - Critical never demotes to warning when later signals say warning
//   - Cardoso service status promotion (Stopped/StartPending → warning)
//   - needs_attention flag tracks status != 'ok'/'unavailable' for SQL
//     and status != 'ok' for machine

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSqlBackupHealth, getMachineHealthSummary } from '../src/services/hub/hubHealth.js';

describe('getSqlBackupHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 2026-05-11T12:00:00Z — well past midnight so "yesterday" calculations
    // are unambiguous regardless of system TZ.
    vi.setSystemTime(new Date('2026-05-11T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns unavailable when sqlBackup is null/undefined', () => {
    expect(getSqlBackupHealth(null))
      .toEqual({ status: 'unavailable', needs_attention: true, last_success_at: null });
    expect(getSqlBackupHealth(undefined))
      .toEqual({ status: 'unavailable', needs_attention: true, last_success_at: null });
  });

  it('returns unavailable when sqlBackup.ok is false', () => {
    expect(getSqlBackupHealth({ ok: false })).toEqual(
      { status: 'unavailable', needs_attention: true, last_success_at: null }
    );
  });

  it('returns unavailable when databases array is missing or empty', () => {
    expect(getSqlBackupHealth({ ok: true })).toEqual(
      { status: 'unavailable', needs_attention: true, last_success_at: null }
    );
    expect(getSqlBackupHealth({ ok: true, databases: [] })).toEqual(
      { status: 'unavailable', needs_attention: true, last_success_at: null }
    );
  });

  it('returns ok when every database backed up successfully within 24h', () => {
    const recent = '2026-05-11T08:00:00Z'; // 4h ago
    const result = getSqlBackupHealth({
      ok: true,
      databases: [
        { isSuccess: true, backupAt: recent },
        { isSuccess: true, backupAt: recent },
      ],
    });
    expect(result.status).toBe('ok');
    expect(result.needs_attention).toBe(false);
    expect(result.last_success_at).toBe(new Date(recent).toISOString());
  });

  it('returns failed when ANY database reports isSuccess=false', () => {
    const recent = '2026-05-11T08:00:00Z';
    const result = getSqlBackupHealth({
      ok: true,
      databases: [
        { isSuccess: true,  backupAt: recent },
        { isSuccess: false, backupAt: recent },
      ],
    });
    expect(result.status).toBe('failed');
    expect(result.needs_attention).toBe(true);
    // last_success_at still tracks the successful one
    expect(result.last_success_at).toBe(new Date(recent).toISOString());
  });

  it('returns stale when freshest successful backup is older than 24h', () => {
    const old = '2026-05-09T08:00:00Z'; // >48h ago
    const result = getSqlBackupHealth({
      ok: true,
      databases: [{ isSuccess: true, backupAt: old }],
    });
    expect(result.status).toBe('stale');
    expect(result.needs_attention).toBe(true);
    expect(result.last_success_at).toBe(new Date(old).toISOString());
  });

  it('returns stale when no databases have a backupAt timestamp at all', () => {
    const result = getSqlBackupHealth({
      ok: true,
      databases: [{ isSuccess: true }],
    });
    expect(result.status).toBe('stale');
    expect(result.last_success_at).toBeNull();
  });

  it('failed beats stale when both apply', () => {
    const old = '2026-05-09T08:00:00Z';
    const result = getSqlBackupHealth({
      ok: true,
      databases: [
        { isSuccess: false, backupAt: old },
        { isSuccess: true,  backupAt: old },
      ],
    });
    expect(result.status).toBe('failed');
  });

  it('uses the LATEST successful backup time across databases', () => {
    const older  = '2026-05-10T08:00:00Z';
    const newer  = '2026-05-11T08:00:00Z';
    const result = getSqlBackupHealth({
      ok: true,
      databases: [
        { isSuccess: true, backupAt: older },
        { isSuccess: true, backupAt: newer },
      ],
    });
    expect(result.last_success_at).toBe(new Date(newer).toISOString());
  });
});

describe('getMachineHealthSummary', () => {
  it('returns unavailable when machineHealth is null/undefined', () => {
    expect(getMachineHealthSummary(null)).toEqual({
      status: 'unavailable',
      needs_attention: true,
      reasons: ['Machine health unavailable'],
    });
  });

  it('returns unavailable with the snapshot message when ok is false', () => {
    const result = getMachineHealthSummary({ ok: false, message: 'Probe timed out' });
    expect(result.status).toBe('unavailable');
    expect(result.reasons).toEqual(['Probe timed out']);
  });

  it('returns ok with empty reasons when all metrics are healthy', () => {
    const result = getMachineHealthSummary({
      ok: true,
      cpu: { usage_percent: 30 },
      memory: { used_percent: 50 },
      disks: [{ drive: 'C:', free_percent: 60 }],
    });
    expect(result).toEqual({ status: 'ok', needs_attention: false, reasons: [] });
  });

  it('CPU promotes to warning at 75% and critical at 90%', () => {
    expect(getMachineHealthSummary({ ok: true, cpu: { usage_percent: 74.9 } }).status).toBe('ok');
    expect(getMachineHealthSummary({ ok: true, cpu: { usage_percent: 75 } }).status).toBe('warning');
    expect(getMachineHealthSummary({ ok: true, cpu: { usage_percent: 89.9 } }).status).toBe('warning');
    expect(getMachineHealthSummary({ ok: true, cpu: { usage_percent: 90 } }).status).toBe('critical');
  });

  it('RAM promotes to warning at 80% and critical at 90%', () => {
    expect(getMachineHealthSummary({ ok: true, memory: { used_percent: 79.9 } }).status).toBe('ok');
    expect(getMachineHealthSummary({ ok: true, memory: { used_percent: 80 } }).status).toBe('warning');
    expect(getMachineHealthSummary({ ok: true, memory: { used_percent: 89.9 } }).status).toBe('warning');
    expect(getMachineHealthSummary({ ok: true, memory: { used_percent: 90 } }).status).toBe('critical');
  });

  it('disk free promotes to warning at <=20% and critical at <=10%', () => {
    const make = (free) => ({ ok: true, disks: [{ drive: 'C:', free_percent: free }] });
    expect(getMachineHealthSummary(make(21)).status).toBe('ok');
    expect(getMachineHealthSummary(make(20)).status).toBe('warning');
    expect(getMachineHealthSummary(make(10.1)).status).toBe('warning');
    expect(getMachineHealthSummary(make(10)).status).toBe('critical');
    expect(getMachineHealthSummary(make(0)).status).toBe('critical');
  });

  it('critical never demotes to warning even if later signals only warn', () => {
    // Disk critical first, then RAM warning — final should still be critical.
    const result = getMachineHealthSummary({
      ok: true,
      cpu: { usage_percent: 30 },
      memory: { used_percent: 80 },                  // → warning
      disks: [{ drive: 'C:', free_percent: 5 }],     // → critical
    });
    expect(result.status).toBe('critical');
    // All reasons still collected, in evaluation order (cpu, ram, disk).
    expect(result.reasons.length).toBe(2);
  });

  it('Cardoso service in non-Running state promotes to warning', () => {
    const result = getMachineHealthSummary({
      ok: true,
      cardoso_service: { present: true, status: 'Stopped' },
    });
    expect(result.status).toBe('warning');
    expect(result.reasons).toEqual(['Cardoso service stopped']);
  });

  it('Cardoso service Running or missing does not promote', () => {
    expect(getMachineHealthSummary({
      ok: true,
      cardoso_service: { present: true, status: 'Running' },
    }).status).toBe('ok');
    expect(getMachineHealthSummary({
      ok: true,
      cardoso_service: { present: false, status: 'Stopped' },
    }).status).toBe('ok');
  });

  it('skips disk entries whose free_percent is non-numeric (NaN/undefined)', () => {
    // Quirk worth noting: Number(null) === 0, so a disk reporting
    // free_percent: null would be treated as 0% free → critical.
    // This isn't ideal (null means "no data", not "no space"), but
    // pinning current behaviour — fixing it is a separate PR.
    const result = getMachineHealthSummary({
      ok: true,
      disks: [
        { drive: 'C:', free_percent: 60 },
        { drive: 'D:', free_percent: undefined },
        { drive: 'E:', free_percent: 'not a number' },
      ],
    });
    expect(result.status).toBe('ok');
    expect(result.reasons).toEqual([]);
  });

  it('reasons include human-readable values rounded to 1 decimal', () => {
    const result = getMachineHealthSummary({
      ok: true,
      cpu: { usage_percent: 92.456 },
      memory: { used_percent: 81.2 },
      disks: [{ drive: 'C:', free_percent: 8.3 }],
    });
    expect(result.status).toBe('critical');
    expect(result.reasons).toContain('CPU 92.5%');
    expect(result.reasons).toContain('RAM 81.2% used');
    expect(result.reasons).toContain('C: low space (8.3% free)');
  });

  it('falls back to "disk" label when drive name is missing', () => {
    const result = getMachineHealthSummary({
      ok: true,
      disks: [{ free_percent: 5 }],
    });
    expect(result.reasons[0]).toMatch(/^disk low space/);
  });
});
