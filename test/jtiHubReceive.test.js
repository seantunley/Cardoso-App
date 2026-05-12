// Unit tests for src/services/hub/jtiHubReceive.js — drives the
// pure functions with an in-memory DB matching the v71 schema.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  receiveJtiArchive,
  listHubJtiArchives,
  getHubJtiArchive,
  knownSha256ForSite,
} from '../src/services/hub/jtiHubReceive.js';

let db;
let tmpRoot;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE hub_jti_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id TEXT NOT NULL, site_archive_id INTEGER,
      period_year INTEGER NOT NULL, period_month INTEGER NOT NULL,
      generated_at TEXT NOT NULL, generated_by TEXT,
      source TEXT NOT NULL,
      filename TEXT NOT NULL, file_path TEXT NOT NULL,
      byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, row_count INTEGER NOT NULL,
      town_city TEXT, region TEXT, country TEXT, site_label TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      received_via TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_hub_jti_archive_dedup ON hub_jti_archive(site_id, sha256);
  `);
  tmpRoot = path.join(os.tmpdir(), `jti-hub-receive-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});

afterEach(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

function buildInput(overrides = {}) {
  const buffer = overrides.buffer || Buffer.from('hub-receive-test-bytes');
  return {
    siteId: 'site-erm',
    siteArchiveId: 47,
    buffer,
    filename: 'JTI_Cardoso_Sales_Ermelo_20260430.xlsx',
    periodYear: 2026, periodMonth: 4,
    generatedAt: '2026-05-01 02:00:01',
    generatedBy: 'system:scheduled',
    source: 'scheduled',
    rowCount: 1,
    declaredSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    declaredByteSize: buffer.length,
    townCity: 'ERMELO', region: 'MPUMALANGA', country: 'SOUTH AFRICA',
    siteLabel: 'Ermelo',
    receivedVia: 'push',
    ...overrides,
  };
}

describe('receiveJtiArchive — happy path', () => {
  it('inserts a row + writes the file at <root>/<site>/<period>/<id>-<filename>', () => {
    const r = receiveJtiArchive({ db, archive: buildInput(), archiveRoot: tmpRoot });
    expect(r.ok).toBe(true);
    expect(r.deduped).toBe(false);
    expect(r.row.site_id).toBe('site-erm');
    expect(r.row.period_year).toBe(2026);
    expect(r.row.period_month).toBe(4);
    expect(r.row.received_via).toBe('push');
    expect(r.row.site_archive_id).toBe(47);

    const expectedPath = path.join(tmpRoot, 'site-erm', '2026-04', `${r.row.id}-JTI_Cardoso_Sales_Ermelo_20260430.xlsx`);
    expect(r.row.file_path).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(fs.statSync(expectedPath).size).toBe(r.row.byte_size);
  });

  it('computes sha256 server-side and stores it', () => {
    const buf = Buffer.from('one-true-byte-stream');
    const r = receiveJtiArchive({
      db, archiveRoot: tmpRoot,
      archive: buildInput({ buffer: buf, declaredSha256: crypto.createHash('sha256').update(buf).digest('hex') }),
    });
    expect(r.row.sha256).toBe(crypto.createHash('sha256').update(buf).digest('hex'));
  });
});

describe('receiveJtiArchive — dedup', () => {
  it('returns deduped:true on a second call with the same (site, bytes)', () => {
    const inputA = buildInput();
    const r1 = receiveJtiArchive({ db, archive: inputA, archiveRoot: tmpRoot });
    expect(r1.deduped).toBe(false);

    const r2 = receiveJtiArchive({ db, archive: { ...inputA }, archiveRoot: tmpRoot });
    expect(r2.deduped).toBe(true);
    expect(r2.row.id).toBe(r1.row.id);
    // No second file written
    expect(db.prepare(`SELECT COUNT(*) AS n FROM hub_jti_archive`).get().n).toBe(1);
  });

  it('does NOT dedup across sites — same bytes from two sites = two rows', () => {
    const inputA = buildInput({ siteId: 'site-A' });
    const inputB = buildInput({ siteId: 'site-B' });
    const r1 = receiveJtiArchive({ db, archive: inputA, archiveRoot: tmpRoot });
    const r2 = receiveJtiArchive({ db, archive: inputB, archiveRoot: tmpRoot });
    expect(r1.row.id).not.toBe(r2.row.id);
    expect(r2.deduped).toBe(false);
  });

  it('does NOT dedup when bytes change — re-archived month from same site = new row', () => {
    const r1 = receiveJtiArchive({ db, archive: buildInput({ buffer: Buffer.from('v1') }), archiveRoot: tmpRoot });
    const r2 = receiveJtiArchive({ db, archive: buildInput({ buffer: Buffer.from('v2') }), archiveRoot: tmpRoot });
    expect(r1.row.id).not.toBe(r2.row.id);
    expect(r2.deduped).toBe(false);
  });
});

describe('receiveJtiArchive — validation', () => {
  it('throws on sha256 mismatch (lying sender)', () => {
    expect(() => receiveJtiArchive({
      db, archiveRoot: tmpRoot,
      archive: buildInput({ declaredSha256: 'a'.repeat(64) }),
    })).toThrow(/sha256 mismatch/);
  });

  it('throws on byte_size mismatch', () => {
    expect(() => receiveJtiArchive({
      db, archiveRoot: tmpRoot,
      archive: buildInput({ declaredByteSize: 999999 }),
    })).toThrow(/byte_size mismatch/);
  });

  it('throws on missing siteId', () => {
    expect(() => receiveJtiArchive({
      db, archiveRoot: tmpRoot, archive: buildInput({ siteId: '' }),
    })).toThrow(/siteId is required/);
  });

  it('throws on bogus periodMonth', () => {
    expect(() => receiveJtiArchive({
      db, archiveRoot: tmpRoot, archive: buildInput({ periodMonth: 13 }),
    })).toThrow(/periodMonth/);
  });

  it('throws on bad source value', () => {
    expect(() => receiveJtiArchive({
      db, archiveRoot: tmpRoot, archive: buildInput({ source: 'bogus' }),
    })).toThrow(/source must be/);
  });

  it('throws on bad receivedVia value', () => {
    expect(() => receiveJtiArchive({
      db, archiveRoot: tmpRoot, archive: buildInput({ receivedVia: 'sneakernet' }),
    })).toThrow(/receivedVia must be/);
  });

  it('sanitises a path-traversal filename', () => {
    const r = receiveJtiArchive({
      db, archiveRoot: tmpRoot,
      archive: buildInput({ filename: '../../../etc/passwd' }),
    });
    // basename + char filter strips the traversal
    expect(r.row.filename).not.toContain('..');
    expect(r.row.filename).not.toContain('/');
    expect(path.dirname(r.row.file_path)).toBe(path.join(tmpRoot, 'site-erm', '2026-04'));
  });

  it('sanitises a path-traversal siteId', () => {
    const r = receiveJtiArchive({
      db, archiveRoot: tmpRoot,
      archive: buildInput({ siteId: '../sneaky' }),
    });
    expect(r.row.file_path).not.toContain('..');
    expect(r.row.file_path).toContain('_sneaky');
  });
});

describe('listHubJtiArchives + getHubJtiArchive + knownSha256ForSite', () => {
  it('listHubJtiArchives returns all sites unfiltered', () => {
    receiveJtiArchive({ db, archiveRoot: tmpRoot, archive: buildInput({ siteId: 'A', buffer: Buffer.from('a') }) });
    receiveJtiArchive({ db, archiveRoot: tmpRoot, archive: buildInput({ siteId: 'B', buffer: Buffer.from('b') }) });
    const all = listHubJtiArchives({ db });
    expect(all).toHaveLength(2);
  });

  it('listHubJtiArchives filters to one site when siteId given', () => {
    receiveJtiArchive({ db, archiveRoot: tmpRoot, archive: buildInput({ siteId: 'A', buffer: Buffer.from('a') }) });
    receiveJtiArchive({ db, archiveRoot: tmpRoot, archive: buildInput({ siteId: 'B', buffer: Buffer.from('b') }) });
    const onlyA = listHubJtiArchives({ db, siteId: 'A' });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0].site_id).toBe('A');
  });

  it('getHubJtiArchive returns row by id, null on miss', () => {
    const r = receiveJtiArchive({ db, archiveRoot: tmpRoot, archive: buildInput() });
    expect(getHubJtiArchive({ db, id: r.row.id }).id).toBe(r.row.id);
    expect(getHubJtiArchive({ db, id: 9999 })).toBeNull();
    expect(getHubJtiArchive({ db, id: -1 })).toBeNull();
  });

  it('knownSha256ForSite returns a Set of sha256 for the site', () => {
    const r1 = receiveJtiArchive({ db, archiveRoot: tmpRoot, archive: buildInput({ buffer: Buffer.from('a1') }) });
    const r2 = receiveJtiArchive({ db, archiveRoot: tmpRoot, archive: buildInput({ buffer: Buffer.from('a2') }) });
    receiveJtiArchive({ db, archiveRoot: tmpRoot, archive: buildInput({ siteId: 'other-site', buffer: Buffer.from('other') }) });
    const set = knownSha256ForSite({ db, siteId: 'site-erm' });
    expect(set.size).toBe(2);
    expect(set.has(r1.row.sha256)).toBe(true);
    expect(set.has(r2.row.sha256)).toBe(true);
  });
});
