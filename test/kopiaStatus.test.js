// Tests for src/services/hub/kopiaStatus.js — the pure verdict logic over the
// JSON kopia emits (no binary / repo needed).

import { describe, it, expect } from 'vitest';
import {
  summarizeKopiaSnapshots,
  mergeWithKnownSites,
  getKopiaStaleHours,
} from '../src/services/hub/kopiaStatus.js';

const HOUR = 3_600_000;
const iso = (ageHours, now) => new Date(now - ageHours * HOUR).toISOString();

function snap(host, ageHours, now, bytes = 1000) {
  return {
    source: { host, userName: 'cardoso', path: 'C:\\Cardoso Customer App' },
    startTime: iso(ageHours + 0.1, now),
    endTime: iso(ageHours, now),
    stats: { totalSize: bytes },
  };
}

describe('summarizeKopiaSnapshots', () => {
  it('groups by site host and takes the newest snapshot per site', () => {
    const now = Date.now();
    const rows = summarizeKopiaSnapshots(
      [snap('Ermelo', 40, now), snap('Ermelo', 2, now, 2048), snap('JHB', 5, now)],
      { now, staleHours: 26 },
    );
    const ermelo = rows.find((r) => r.site === 'Ermelo');
    expect(ermelo.count).toBe(2);
    expect(ermelo.age_hours).toBeLessThan(3);
    expect(ermelo.total_bytes).toBe(2048);
    expect(ermelo.status).toBe('ok');
  });

  it('marks a site critical/stale when its newest snapshot is older than the threshold', () => {
    const now = Date.now();
    const rows = summarizeKopiaSnapshots([snap('Ermelo', 40, now)], { now, staleHours: 26 });
    expect(rows[0].status).toBe('critical');
    expect(rows[0].reason).toBe('stale');
  });

  it('handles an empty list', () => {
    expect(summarizeKopiaSnapshots([], { now: Date.now() })).toEqual([]);
    expect(summarizeKopiaSnapshots(null)).toEqual([]);
  });

  it('flags snapshots with no usable timestamp', () => {
    const rows = summarizeKopiaSnapshots([{ source: { host: 'X' } }], { now: Date.now() });
    expect(rows[0].status).toBe('critical');
    expect(rows[0].reason).toBe('no_valid_timestamp');
  });
});

describe('mergeWithKnownSites', () => {
  it('marks a known site that has NEVER snapshotted as critical/never', () => {
    const now = Date.now();
    const summary = summarizeKopiaSnapshots([snap('Ermelo', 2, now)], { now, staleHours: 26 });
    const merged = mergeWithKnownSites(
      [{ id: 'tok1', name: 'Ermelo' }, { id: 'tok2', name: 'Newcastle' }],
      summary,
    );
    const ncl = merged.find((r) => r.site_name === 'Newcastle');
    expect(ncl.status).toBe('critical');
    expect(ncl.reason).toBe('never');
    expect(ncl.count).toBe(0);
    const erm = merged.find((r) => r.site_name === 'Ermelo');
    expect(erm.status).toBe('ok');
    expect(erm.site_id).toBe('tok1');
  });

  it('surfaces repo snapshots for an unknown host rather than hiding them', () => {
    const now = Date.now();
    const summary = summarizeKopiaSnapshots([snap('Mystery', 2, now)], { now, staleHours: 26 });
    const merged = mergeWithKnownSites([{ id: 'tok1', name: 'Ermelo' }], summary);
    expect(merged.find((r) => r.site === 'Mystery')).toBeDefined();
    expect(merged.find((r) => r.site_name === 'Ermelo').reason).toBe('never');
  });
});

describe('getKopiaStaleHours', () => {
  it('defaults to 26 and respects a valid override', () => {
    const prev = process.env.KOPIA_SITE_STALE_HOURS;
    try {
      delete process.env.KOPIA_SITE_STALE_HOURS;
      expect(getKopiaStaleHours()).toBe(26);
      process.env.KOPIA_SITE_STALE_HOURS = '48';
      expect(getKopiaStaleHours()).toBe(48);
      process.env.KOPIA_SITE_STALE_HOURS = 'garbage';
      expect(getKopiaStaleHours()).toBe(26);
    } finally {
      if (prev === undefined) delete process.env.KOPIA_SITE_STALE_HOURS;
      else process.env.KOPIA_SITE_STALE_HOURS = prev;
    }
  });
});
