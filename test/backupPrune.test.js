// Unit tests for the local-backup prune selection. It deletes files, so its
// logic is pinned here — especially the "never prune to zero" floor and the
// filename match that the old inline regex got wrong.

import { describe, it, expect } from 'vitest';
import { selectPrunableBackups, BACKUP_FILE_RE } from '../src/lib/backupPrune.js';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;
const at = (daysAgo) => NOW - daysAgo * DAY;

describe('BACKUP_FILE_RE', () => {
  it('matches every timestamp format the writer has produced', () => {
    expect(BACKUP_FILE_RE.test('cardoso-site-2026-07-03_020002.db')).toBe(true);   // underscore + HHMMSS
    expect(BACKUP_FILE_RE.test('cardoso-site-2026-07-03T02-00-02.db')).toBe(true); // ISO 'T'
    expect(BACKUP_FILE_RE.test('cardoso-site-2026-07-03-02-00-02.db')).toBe(true); // fully dashed
    expect(BACKUP_FILE_RE.test('cardoso-a3f9-2026-01-01T00-00-00.db')).toBe(true); // uuid-ish id
  });

  it('never matches the live DB or a forensic copy (they start "cardoso." not "cardoso-")', () => {
    expect(BACKUP_FILE_RE.test('cardoso.db')).toBe(false);
    expect(BACKUP_FILE_RE.test('cardoso.db.corrupt.db')).toBe(false);
    expect(BACKUP_FILE_RE.test('cardoso.db-wal')).toBe(false);
    expect(BACKUP_FILE_RE.test('something-else.db')).toBe(false);
    expect(BACKUP_FILE_RE.test('cardoso-site-notadate.db')).toBe(false);
    // a forensic copy of a real backup — must NOT match (extra suffix after .db)
    expect(BACKUP_FILE_RE.test('cardoso-site-2026-07-03T02-00-02.db.corrupt.db')).toBe(false);
    expect(BACKUP_FILE_RE.test('cardoso-site-2026-07-03_020002.db.bak')).toBe(false);
  });
});

describe('selectPrunableBackups', () => {
  const mk = (daysAgo, i = 0) => ({ name: `cardoso-site-2026-07-${String(daysAgo).padStart(2, '0')}T00-00-0${i}.db`, mtime: at(daysAgo) });

  it('keeps everything within keepDays', () => {
    const entries = [mk(0), mk(1), mk(2)]; // all ≤ 3 days
    expect(selectPrunableBackups(entries, { now: NOW, keepDays: 3, minKeep: 3 })).toEqual([]);
  });

  it('deletes backups older than keepDays once past the newest minKeep', () => {
    const entries = [mk(0), mk(1), mk(2), mk(4), mk(6)]; // two are > 3 days old
    const del = selectPrunableBackups(entries, { now: NOW, keepDays: 3, minKeep: 3 });
    expect(del).toContain('cardoso-site-2026-07-04T00-00-00.db');
    expect(del).toContain('cardoso-site-2026-07-06T00-00-00.db');
    expect(del).toHaveLength(2);
  });

  it('NEVER prunes below the newest minKeep, even if every backup is old (stalled job)', () => {
    // Job stopped 10 days ago; 5 backups, all older than keepDays.
    const entries = [mk(10), mk(11), mk(12), mk(13), mk(14)];
    const del = selectPrunableBackups(entries, { now: NOW, keepDays: 3, minKeep: 3 });
    expect(del).toHaveLength(2); // keeps the newest 3, drops the 2 oldest
    expect(del).toContain('cardoso-site-2026-07-13T00-00-00.db');
    expect(del).toContain('cardoso-site-2026-07-14T00-00-00.db');
  });

  it('ignores non-backup .db files entirely (never selects them, never counts them toward the floor)', () => {
    const entries = [
      { name: 'cardoso.db', mtime: at(0) },
      { name: 'cardoso.db.corrupt.db', mtime: at(30) },
      mk(5), mk(6), mk(7), mk(8),
    ];
    const del = selectPrunableBackups(entries, { now: NOW, keepDays: 3, minKeep: 3 });
    expect(del).not.toContain('cardoso.db');
    expect(del).not.toContain('cardoso.db.corrupt.db');
    // 4 real backups, all old → keep newest 3, delete 1
    expect(del).toHaveLength(1);
    expect(del).toContain('cardoso-site-2026-07-08T00-00-00.db');
  });

  it('handles empty / junk input safely', () => {
    expect(selectPrunableBackups([], { now: NOW })).toEqual([]);
    expect(selectPrunableBackups(null, { now: NOW })).toEqual([]);
    expect(selectPrunableBackups([{ name: null }, {}], { now: NOW })).toEqual([]);
  });
});
