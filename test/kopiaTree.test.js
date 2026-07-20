// Tests for src/services/hub/kopiaTree.js — the pure parse/verdict logic over
// `kopia ls -l` text and Ola Hallengren .bak paths (no binary / repo needed).

import { describe, it, expect } from 'vitest';
import {
  parseKopiaLsLong,
  parseSqlBackupEntry,
  summarizeSqlOffsite,
} from '../src/services/hub/kopiaTree.js';

const HOUR = 3_600_000;

describe('parseKopiaLsLong', () => {
  it('parses files and directories from -l output', () => {
    const out = [
      '-rw-r--r--         1234 2024-06-15 14:30:00 SAST database/cardoso.db',
      'drwxr-xr-x            0 2024-06-15 14:30:00 SAST database/backups/',
    ].join('\n');
    const rows = parseKopiaLsLong(out);
    expect(rows).toHaveLength(2);
    const file = rows.find((r) => !r.isDir);
    expect(file.name).toBe('database/cardoso.db');
    expect(file.size).toBe(1234);
    // mtime is the local wall-clock time interpreted from the listing.
    expect(new Date(file.mtime).getHours()).toBe(14);
    const dir = rows.find((r) => r.isDir);
    expect(dir.name).toBe('database/backups'); // trailing slash stripped
    expect(dir.size).toBeNull();
  });

  it('keeps names that contain spaces', () => {
    const rows = parseKopiaLsLong('-rw-r--r--  10 2024-06-15 14:30:00 UTC My Documents/a file.bak');
    expect(rows[0].name).toBe('My Documents/a file.bak');
  });

  it('strips a leading object-id column when kopia emits one', () => {
    const rows = parseKopiaLsLong('drwxr-xr-x  0 2024-06-15 14:30:00 SAST k2f3a9c2b1e0d4f6a8b1c3d5e7f9a0b12 database');
    expect(rows[0].name).toBe('database');
    expect(rows[0].isDir).toBe(true);
    expect(rows[0].objectID).toBe('k2f3a9c2b1e0d4f6a8b1c3d5e7f9a0b12');
  });

  it('does not eat a lone hex-named file as an object id', () => {
    const rows = parseKopiaLsLong('-rw-r--r--  10 2024-06-15 14:30:00 UTC a1b2c3d4e5f6a1b2c3d4.bak');
    expect(rows[0].name).toBe('a1b2c3d4e5f6a1b2c3d4.bak');
    expect(rows[0].objectID).toBeNull();
  });

  it('detects a directory by mode even without a trailing slash', () => {
    const rows = parseKopiaLsLong('drwxr-xr-x 0 2024-06-15 14:30:00 UTC subdir');
    expect(rows[0].isDir).toBe(true);
  });

  it('skips unparseable lines instead of crashing', () => {
    const rows = parseKopiaLsLong('total 5\ngarbage line\n-rw-r--r-- 1 2024-06-15 14:30:00 UTC ok.bak');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('ok.bak');
  });

  it('returns [] for empty/nullish input', () => {
    expect(parseKopiaLsLong('')).toEqual([]);
    expect(parseKopiaLsLong(null)).toEqual([]);
  });
});

describe('parseSqlBackupEntry', () => {
  it('reads database + type from the Ola path and time from the filename', () => {
    const e = parseSqlBackupEntry({ name: 'SRV01$SQL2019/CARDAT/FULL/SRV01$SQL2019_CARDAT_FULL_20260702_013000.bak' });
    expect(e.database).toBe('CARDAT');
    expect(e.type).toBe('FULL');
    // Filename stamp is interpreted as local wall-clock time.
    const at = new Date(e.at);
    expect([at.getFullYear(), at.getMonth() + 1, at.getDate(), at.getHours(), at.getMinutes()])
      .toEqual([2026, 7, 2, 1, 30]);
  });

  it('handles a split-file numeric suffix', () => {
    const e = parseSqlBackupEntry({ name: 'S$I/PPDdata/DIFF/S$I_PPDdata_DIFF_20260702_013000_1.bak' });
    expect(e.database).toBe('PPDdata');
    expect(e.type).toBe('DIFF');
  });

  it('falls back to the filename when the path is flat', () => {
    const e = parseSqlBackupEntry({ name: 'SRV_CARSYS_FULL_20260702_013000.bak' });
    expect(e.type).toBe('FULL');
    expect(e.database).toBe('CARSYS');
  });

  it('returns null for non-.bak entries', () => {
    expect(parseSqlBackupEntry({ name: 'CARDAT/FULL/notes.txt' })).toBeNull();
  });
});

describe('summarizeSqlOffsite', () => {
  const now = Date.now();
  // Build an Ola filename whose embedded stamp is LOCAL time (as the parser
  // interprets it), so the round-tripped instant matches `now - ageHours`.
  const file = (db, type, ageHours) => {
    const d = new Date(now - ageHours * HOUR);
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    return { isDir: false, name: `S$I/${db}/${type}/S$I_${db}_${type}_${stamp}.bak` };
  };
  const ageH = (iso) => (now - new Date(iso).getTime()) / HOUR;

  it('reports never when there are no backups', () => {
    const v = summarizeSqlOffsite([], { now });
    expect(v.status).toBe('never');
    expect(v.databases).toEqual([]);
  });

  it('rolls up per database with full + diff and an ok verdict when fresh', () => {
    const v = summarizeSqlOffsite([
      file('CARDAT', 'FULL', 30), file('CARDAT', 'DIFF', 2),
      file('CARSYS', 'FULL', 30), file('CARSYS', 'DIFF', 2),
    ], { now, staleHours: 26 });
    expect(v.status).toBe('ok');
    expect(v.file_count).toBe(4);
    const cardat = v.databases.find((d) => d.name === 'CARDAT');
    expect(ageH(cardat.full_at)).toBeCloseTo(30, 0);
    expect(ageH(cardat.diff_at)).toBeCloseTo(2, 0);
    expect(cardat.status).toBe('ok'); // newest (diff) is fresh
  });

  it('is stale when the newest backup exceeds the threshold', () => {
    const v = summarizeSqlOffsite([file('CARDAT', 'FULL', 50)], { now, staleHours: 26 });
    expect(v.status).toBe('stale');
    expect(v.databases[0].status).toBe('stale');
  });

  it('takes the newest of duplicate backups for a database', () => {
    const v = summarizeSqlOffsite([
      file('CARDAT', 'DIFF', 40), file('CARDAT', 'DIFF', 3),
    ], { now, staleHours: 26 });
    expect(v.status).toBe('ok'); // newest diff (3h) wins
    expect(ageH(v.databases[0].diff_at)).toBeCloseTo(3, 0);
  });
});
