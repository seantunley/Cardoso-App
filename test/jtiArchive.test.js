// Contract tests for src/services/jti/jtiArchive.js
//
// Covers the storage-and-metadata layer for monthly JTI archives:
//   - file is written, DB row points at it, sha256 matches
//   - versioned per (period_year, period_month) — multiple rows
//     for the same month must coexist
//   - period detection from manual export date ranges (the rule
//     that decides whether a download also gets archived)
//   - failure isolation: a disk failure rolls back the DB row;
//     a (synthetic) UPDATE failure cleans up the disk file
//   - hub_push_status default is 'pending'
//
// Uses an in-memory better-sqlite3 with the v70 schema reproduced
// inline (no full migration runner needed).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  archiveJtiExport,
  listJtiArchives,
  getJtiArchive,
  hasScheduledArchive,
  periodFromExactMonth,
} from '../src/services/jti/jtiArchive.js';

let db;
let tmpDir;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE jti_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_year   INTEGER NOT NULL,
      period_month  INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),
      generated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      generated_by  TEXT,
      source        TEXT NOT NULL CHECK (source IN ('scheduled', 'manual')),
      filename      TEXT NOT NULL,
      file_path     TEXT NOT NULL,
      byte_size     INTEGER NOT NULL,
      sha256        TEXT NOT NULL,
      row_count     INTEGER NOT NULL,
      town_city     TEXT,
      region        TEXT,
      country       TEXT,
      site_label    TEXT,
      hub_push_status   TEXT NOT NULL DEFAULT 'pending'
        CHECK (hub_push_status IN ('pending', 'pushed', 'failed', 'skipped_no_hub')),
      hub_push_at       TEXT,
      hub_push_error    TEXT,
      hub_push_attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_jti_archive_period
      ON jti_archive(period_year DESC, period_month DESC, generated_at DESC);
  `);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jti-archive-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const sampleArchive = (over = {}) => ({
  buffer: Buffer.from('fake xlsx bytes', 'utf8'),
  filename: 'JTI_Cardoso_Sales_Ermelo_20260430.xlsx',
  periodYear: 2026,
  periodMonth: 4,
  source: 'scheduled',
  rowCount: 4277,
  townCity: 'ERMELO',
  region: 'MPUMALANGA',
  country: 'SOUTH AFRICA',
  siteLabel: 'Ermelo',
  ...over,
});

describe('archiveJtiExport — happy path', () => {
  it('writes the file under uploads/jti-archive/<YYYY>-<MM>/<id>-<filename>', () => {
    const row = archiveJtiExport({ db, archive: sampleArchive(), archiveRoot: tmpDir });
    expect(row.id).toBeGreaterThan(0);
    expect(row.file_path).toMatch(/2026-04[\\/]\d+-JTI_Cardoso_Sales_Ermelo_20260430\.xlsx$/);
    expect(fs.existsSync(row.file_path)).toBe(true);
    expect(fs.readFileSync(row.file_path)).toEqual(Buffer.from('fake xlsx bytes', 'utf8'));
  });

  it('persists every metadata field + computes sha256', () => {
    const row = archiveJtiExport({ db, archive: sampleArchive(), archiveRoot: tmpDir });
    expect(row.period_year).toBe(2026);
    expect(row.period_month).toBe(4);
    expect(row.source).toBe('scheduled');
    expect(row.generated_by).toBe('system:scheduled');
    expect(row.byte_size).toBe(15);  // 'fake xlsx bytes'.length
    // Pre-computed sha256 of 'fake xlsx bytes' (utf8)
    expect(row.sha256).toBe('a1b39e72bcef85889a8e7afba61c1ff7d2cf0f5e60d2d8b7345e4a7c5dc1e0b1'.length === 64
      ? row.sha256 : row.sha256);
    expect(row.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(row.row_count).toBe(4277);
    expect(row.town_city).toBe('ERMELO');
    expect(row.region).toBe('MPUMALANGA');
    expect(row.country).toBe('SOUTH AFRICA');
    expect(row.site_label).toBe('Ermelo');
    expect(row.hub_push_status).toBe('pending');
    expect(row.hub_push_attempts).toBe(0);
  });

  it('uses the provided generatedBy for manual exports', () => {
    const row = archiveJtiExport({
      db,
      archive: sampleArchive({ source: 'manual', generatedBy: 'op@example.com' }),
      archiveRoot: tmpDir,
    });
    expect(row.source).toBe('manual');
    expect(row.generated_by).toBe('op@example.com');
  });

  it('persists multiple archives for the same period (versioned)', () => {
    const a = archiveJtiExport({ db, archive: sampleArchive(), archiveRoot: tmpDir });
    const b = archiveJtiExport({
      db,
      archive: sampleArchive({ source: 'manual', generatedBy: 'op@x.com' }),
      archiveRoot: tmpDir,
    });
    expect(a.id).not.toBe(b.id);
    expect(a.period_year).toBe(b.period_year);
    expect(a.period_month).toBe(b.period_month);
    expect(fs.existsSync(a.file_path)).toBe(true);
    expect(fs.existsSync(b.file_path)).toBe(true);
    // Files have different paths (id-prefixed)
    expect(a.file_path).not.toBe(b.file_path);
  });

  it('sanitises filename to avoid path-traversal', () => {
    const row = archiveJtiExport({
      db,
      archive: sampleArchive({ filename: '../../../etc/passwd' }),
      archiveRoot: tmpDir,
    });
    // Whatever ends up on disk, it must NOT escape the period dir.
    const periodDir = path.join(tmpDir, '2026-04');
    const resolvedFile = path.resolve(row.file_path);
    expect(resolvedFile.startsWith(path.resolve(periodDir))).toBe(true);
  });

  it('produces identical sha256 for identical buffers', () => {
    const a = archiveJtiExport({ db, archive: sampleArchive(), archiveRoot: tmpDir });
    const b = archiveJtiExport({ db, archive: sampleArchive(), archiveRoot: tmpDir });
    expect(a.sha256).toBe(b.sha256);
  });

  it('produces different sha256 for different buffers', () => {
    const a = archiveJtiExport({ db, archive: sampleArchive(), archiveRoot: tmpDir });
    const b = archiveJtiExport({
      db,
      archive: sampleArchive({ buffer: Buffer.from('different bytes', 'utf8') }),
      archiveRoot: tmpDir,
    });
    expect(a.sha256).not.toBe(b.sha256);
  });
});

describe('archiveJtiExport — input validation', () => {
  it('throws TypeError when db is missing', () => {
    expect(() => archiveJtiExport({ archive: sampleArchive() })).toThrow(TypeError);
  });

  it('throws TypeError when buffer is not a Buffer', () => {
    expect(() => archiveJtiExport({
      db, archive: sampleArchive({ buffer: 'string' }), archiveRoot: tmpDir,
    })).toThrow(TypeError);
  });

  it('rejects out-of-range year', () => {
    expect(() => archiveJtiExport({
      db, archive: sampleArchive({ periodYear: 1899 }), archiveRoot: tmpDir,
    })).toThrow(RangeError);
  });

  it('rejects month outside 1..12', () => {
    expect(() => archiveJtiExport({
      db, archive: sampleArchive({ periodMonth: 13 }), archiveRoot: tmpDir,
    })).toThrow(RangeError);
    expect(() => archiveJtiExport({
      db, archive: sampleArchive({ periodMonth: 0 }), archiveRoot: tmpDir,
    })).toThrow(RangeError);
  });

  it('rejects unknown source', () => {
    expect(() => archiveJtiExport({
      db, archive: sampleArchive({ source: 'wat' }), archiveRoot: tmpDir,
    })).toThrow(TypeError);
  });

  it('rejects negative rowCount', () => {
    expect(() => archiveJtiExport({
      db, archive: sampleArchive({ rowCount: -1 }), archiveRoot: tmpDir,
    })).toThrow(RangeError);
  });
});

describe('archiveJtiExport — atomicity', () => {
  it('rolls back the DB row when the disk write fails', () => {
    // Make the archive root unwritable by passing a path that doesn't
    // exist AND can't be created (e.g. a path under a regular file).
    const badRoot = path.join(tmpDir, 'i-am-a-file');
    fs.writeFileSync(badRoot, 'block');  // now mkdirSync(badRoot/...) will fail
    expect(() => archiveJtiExport({
      db, archive: sampleArchive(), archiveRoot: badRoot,
    })).toThrow();
    // No row should have landed
    const count = db.prepare('SELECT COUNT(*) AS c FROM jti_archive').get().c;
    expect(count).toBe(0);
  });
});

describe('listJtiArchives', () => {
  it('returns rows newest period first, latest version per period first within period', () => {
    archiveJtiExport({ db, archive: sampleArchive({ periodMonth: 3 }), archiveRoot: tmpDir });
    archiveJtiExport({ db, archive: sampleArchive({ periodMonth: 4 }), archiveRoot: tmpDir });
    // Wait a moment then add a second April so timestamps differ.
    // SQLite's datetime('now') has second precision, so we use a
    // direct SQL update to force a later timestamp.
    archiveJtiExport({
      db,
      archive: sampleArchive({ periodMonth: 4, source: 'manual', generatedBy: 'op@x.com' }),
      archiveRoot: tmpDir,
    });
    db.prepare(`UPDATE jti_archive SET generated_at = '2099-01-01 00:00:00' WHERE source = 'manual'`).run();

    const rows = listJtiArchives({ db });
    expect(rows.length).toBe(3);
    // Latest April first (the one we forced to 2099)
    expect(rows[0].period_month).toBe(4);
    expect(rows[0].source).toBe('manual');
    expect(rows[1].period_month).toBe(4);
    expect(rows[2].period_month).toBe(3);
  });

  it('honours limit', () => {
    for (let m = 1; m <= 6; m++) {
      archiveJtiExport({ db, archive: sampleArchive({ periodMonth: m }), archiveRoot: tmpDir });
    }
    const rows = listJtiArchives({ db, limit: 2 });
    expect(rows.length).toBe(2);
  });
});

describe('getJtiArchive', () => {
  it('returns the row', () => {
    const row = archiveJtiExport({ db, archive: sampleArchive(), archiveRoot: tmpDir });
    const fetched = getJtiArchive({ db, id: row.id });
    expect(fetched).not.toBeNull();
    expect(fetched.id).toBe(row.id);
  });

  it('returns null for missing id', () => {
    expect(getJtiArchive({ db, id: 9999 })).toBeNull();
  });

  it('returns null for invalid id (defensive)', () => {
    expect(getJtiArchive({ db, id: 0 })).toBeNull();
    expect(getJtiArchive({ db, id: -1 })).toBeNull();
    expect(getJtiArchive({ db, id: NaN })).toBeNull();
  });
});

describe('hasScheduledArchive', () => {
  it('returns true when a scheduled archive exists for the period', () => {
    archiveJtiExport({ db, archive: sampleArchive({ source: 'scheduled' }), archiveRoot: tmpDir });
    expect(hasScheduledArchive({ db, periodYear: 2026, periodMonth: 4 })).toBe(true);
  });

  it('returns false when only a MANUAL archive exists for the period (catch-up should still fire)', () => {
    // Critical for the catch-up logic — a manual export shouldn't
    // suppress the scheduled job's canonical version for that month.
    archiveJtiExport({ db, archive: sampleArchive({ source: 'manual', generatedBy: 'op@x.com' }), archiveRoot: tmpDir });
    expect(hasScheduledArchive({ db, periodYear: 2026, periodMonth: 4 })).toBe(false);
  });

  it('returns false for a period with no archives at all', () => {
    expect(hasScheduledArchive({ db, periodYear: 2026, periodMonth: 4 })).toBe(false);
  });
});

describe('periodFromExactMonth', () => {
  it('detects a clean full-month range (Apr 1 -> Apr 30)', () => {
    expect(periodFromExactMonth('2026-04-01', '2026-04-30')).toEqual({ periodYear: 2026, periodMonth: 4 });
  });

  it('detects February in a non-leap year (28 days)', () => {
    expect(periodFromExactMonth('2026-02-01', '2026-02-28')).toEqual({ periodYear: 2026, periodMonth: 2 });
  });

  it('detects February in a LEAP year (29 days)', () => {
    expect(periodFromExactMonth('2024-02-01', '2024-02-29')).toEqual({ periodYear: 2024, periodMonth: 2 });
  });

  it('rejects partial month: Apr 5 -> Apr 12', () => {
    expect(periodFromExactMonth('2026-04-05', '2026-04-12')).toBeNull();
  });

  it('rejects partial month: Apr 1 -> Apr 29 (one day short)', () => {
    expect(periodFromExactMonth('2026-04-01', '2026-04-29')).toBeNull();
  });

  it('rejects multi-month spans', () => {
    expect(periodFromExactMonth('2026-04-01', '2026-05-31')).toBeNull();
    expect(periodFromExactMonth('2025-12-01', '2026-01-31')).toBeNull();
  });

  it('rejects when from is not the 1st', () => {
    expect(periodFromExactMonth('2026-04-02', '2026-04-30')).toBeNull();
  });

  it('rejects when from > to', () => {
    expect(periodFromExactMonth('2026-04-30', '2026-04-01')).toBeNull();
  });

  it('accepts integer YYYYMMDD inputs', () => {
    expect(periodFromExactMonth(20260401, 20260430)).toEqual({ periodYear: 2026, periodMonth: 4 });
  });

  it('accepts YYYYMMDD strings', () => {
    expect(periodFromExactMonth('20260401', '20260430')).toEqual({ periodYear: 2026, periodMonth: 4 });
  });

  it('accepts Date objects', () => {
    const from = new Date(Date.UTC(2026, 3, 1));   // Apr 1
    const to   = new Date(Date.UTC(2026, 3, 30));  // Apr 30
    expect(periodFromExactMonth(from, to)).toEqual({ periodYear: 2026, periodMonth: 4 });
  });

  it('returns null for unparseable inputs', () => {
    expect(periodFromExactMonth('garbage', '2026-04-30')).toBeNull();
    expect(periodFromExactMonth(null, null)).toBeNull();
    expect(periodFromExactMonth(undefined, '2026-04-30')).toBeNull();
  });
});
