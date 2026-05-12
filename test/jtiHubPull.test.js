// Unit tests for src/services/hub/jtiHubPull.js. Drives the pull
// service with a stub fetch that returns canned archive lists +
// download bytes. Asserts dedup (already-on-hub archives are not
// re-fetched), failure paths, and per-site results aggregation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  pullMissingArchivesForSite,
  pullMissingArchivesAll,
} from '../src/services/hub/jtiHubPull.js';
import { receiveJtiArchive } from '../src/services/hub/jtiHubReceive.js';

let db;
let tmpRoot;
let originalCwd;

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
  tmpRoot = path.join(os.tmpdir(), `jti-pull-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmpRoot, { recursive: true });
  // receiveJtiArchive uses process.cwd() / database / hub-archives / jti
  // by default — point cwd at tmpRoot so tests don't write to repo.
  originalCwd = process.cwd();
  process.chdir(tmpRoot);
});

afterEach(() => {
  try { process.chdir(originalCwd); } catch {}
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

const site = { id: 'site-erm', url: 'http://site-erm.example/', token: 'tok' };

function makeRemoteArchive({ id, year, month, bytes }) {
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  return {
    id, period_year: year, period_month: month,
    generated_at: '2026-05-01 02:00:00', generated_by: 'system:scheduled',
    source: 'scheduled', filename: `JTI_${year}_${month}.xlsx`,
    byte_size: bytes.length, sha256: sha, row_count: 1,
    town_city: 'X', region: 'Y', country: 'Z', site_label: 'L',
    _bytes: bytes,
  };
}

// Stub fetch that serves /api/reporting/jti/archives + /:id/download
// from a list of remote archives. Captures the URLs hit for assertions.
function stubFetch({ remotes, listFails = false, downloadFailsFor = new Set() }) {
  const calls = [];
  return async (url, opts) => {
    calls.push(url);
    if (url.endsWith('/api/reporting/jti/archives?limit=500')) {
      if (listFails) {
        return { ok: false, status: 500, async text() { return 'list boom'; }, async json() { throw new Error(); } };
      }
      const stripped = remotes.map(({ _bytes, ...rest }) => rest);
      return { ok: true, status: 200, async json() { return { ok: true, archives: stripped }; }, async text() { return ''; } };
    }
    const dlMatch = url.match(/\/api\/reporting\/jti\/archives\/(\d+)\/download$/);
    if (dlMatch) {
      const id = Number(dlMatch[1]);
      if (downloadFailsFor.has(id)) {
        return { ok: false, status: 500, async arrayBuffer() { return new ArrayBuffer(0); }, async text() { return 'dl boom'; } };
      }
      const a = remotes.find(r => r.id === id);
      if (!a) return { ok: false, status: 404, async arrayBuffer() { return new ArrayBuffer(0); } };
      return {
        ok: true, status: 200,
        async arrayBuffer() { return a._bytes.buffer.slice(a._bytes.byteOffset, a._bytes.byteOffset + a._bytes.byteLength); },
      };
    }
    return { ok: false, status: 404 };
  };
}

describe('pullMissingArchivesForSite', () => {
  it('skips when site is missing fields', async () => {
    const r = await pullMissingArchivesForSite({ site: { id: 's' }, db, fetchImpl: () => {} });
    expect(r.status).toBe('skipped');
  });

  it('reports list_network when fetch throws', async () => {
    const r = await pullMissingArchivesForSite({
      site, db,
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('list_network');
  });

  it('reports list_http_NNN when site returns non-2xx for the list', async () => {
    const r = await pullMissingArchivesForSite({
      site, db,
      fetchImpl: stubFetch({ remotes: [], listFails: true }),
    });
    expect(r.status).toBe('failed');
    expect(r.reason).toMatch(/list_http_500/);
  });

  it('returns ok with pulled=0 when nothing is missing', async () => {
    // Pre-seed hub with the same sha256 the remote will report
    const bytes = Buffer.from('already-here');
    const remote = makeRemoteArchive({ id: 1, year: 2026, month: 4, bytes });
    receiveJtiArchive({
      db, archiveRoot: tmpRoot,
      archive: {
        siteId: site.id, buffer: bytes, filename: remote.filename,
        periodYear: remote.period_year, periodMonth: remote.period_month,
        generatedAt: remote.generated_at, source: 'scheduled',
        rowCount: 1, declaredSha256: remote.sha256, declaredByteSize: bytes.length,
        receivedVia: 'push',
      },
    });
    const r = await pullMissingArchivesForSite({
      site, db,
      fetchImpl: stubFetch({ remotes: [remote] }),
    });
    expect(r.status).toBe('ok');
    expect(r.pulled).toBe(0);
    expect(r.missing).toBe(0);
  });

  it('pulls missing archives + records with received_via=pull', async () => {
    const remotes = [
      makeRemoteArchive({ id: 1, year: 2026, month: 4, bytes: Buffer.from('apr-bytes') }),
      makeRemoteArchive({ id: 2, year: 2026, month: 5, bytes: Buffer.from('may-bytes') }),
    ];
    const r = await pullMissingArchivesForSite({
      site, db,
      fetchImpl: stubFetch({ remotes }),
    });
    expect(r.status).toBe('ok');
    expect(r.pulled).toBe(2);
    expect(r.missing).toBe(2);
    const rows = db.prepare(`SELECT received_via, sha256 FROM hub_jti_archive`).all();
    expect(rows).toHaveLength(2);
    expect(rows.every(rw => rw.received_via === 'pull')).toBe(true);
  });

  it('returns partial when some downloads fail', async () => {
    const remotes = [
      makeRemoteArchive({ id: 1, year: 2026, month: 4, bytes: Buffer.from('a') }),
      makeRemoteArchive({ id: 2, year: 2026, month: 5, bytes: Buffer.from('b') }),
    ];
    const r = await pullMissingArchivesForSite({
      site, db,
      fetchImpl: stubFetch({ remotes, downloadFailsFor: new Set([2]) }),
    });
    expect(r.status).toBe('partial');
    expect(r.pulled).toBe(1);
    expect(r.failed).toBe(1);
  });

  it('only pulls the SUBSET that\'s missing — already-present sha256s are skipped', async () => {
    // Pre-seed with month 4. Remote will list both.
    const aprBytes = Buffer.from('apr-bytes');
    const mayBytes = Buffer.from('may-bytes');
    const aprRemote = makeRemoteArchive({ id: 1, year: 2026, month: 4, bytes: aprBytes });
    const mayRemote = makeRemoteArchive({ id: 2, year: 2026, month: 5, bytes: mayBytes });
    receiveJtiArchive({
      db, archiveRoot: tmpRoot,
      archive: {
        siteId: site.id, buffer: aprBytes, filename: aprRemote.filename,
        periodYear: 2026, periodMonth: 4,
        generatedAt: aprRemote.generated_at, source: 'scheduled',
        rowCount: 1, declaredSha256: aprRemote.sha256, declaredByteSize: aprBytes.length,
        receivedVia: 'push',
      },
    });
    const fetched = [];
    const fetchImpl = async (url, opts) => {
      fetched.push(url);
      const inner = stubFetch({ remotes: [aprRemote, mayRemote] });
      return inner(url, opts);
    };
    const r = await pullMissingArchivesForSite({ site, db, fetchImpl });
    expect(r.pulled).toBe(1);
    expect(r.missing).toBe(1);
    // April was not downloaded
    expect(fetched.some(u => u.endsWith('/api/reporting/jti/archives/1/download'))).toBe(false);
    // May was
    expect(fetched.some(u => u.endsWith('/api/reporting/jti/archives/2/download'))).toBe(true);
  });
});

describe('pullMissingArchivesAll', () => {
  it('runs each site and aggregates totals', async () => {
    const remoteA = makeRemoteArchive({ id: 1, year: 2026, month: 4, bytes: Buffer.from('a') });
    const remoteB = makeRemoteArchive({ id: 1, year: 2026, month: 4, bytes: Buffer.from('b') });
    const sites = [
      { id: 'A', url: 'http://a.example', token: 't' },
      { id: 'B', url: 'http://b.example', token: 't' },
    ];
    const fetchImpl = async (url, opts) => {
      const aImpl = stubFetch({ remotes: [remoteA] });
      const bImpl = stubFetch({ remotes: [remoteB] });
      if (url.startsWith('http://a.example')) return aImpl(url, opts);
      return bImpl(url, opts);
    };
    const r = await pullMissingArchivesAll({ sites, db, fetchImpl });
    expect(r.sitesProcessed).toBe(2);
    expect(r.totalPulled).toBe(2);
    expect(r.totalMissing).toBe(2);
  });

  it('handles an empty sites array', async () => {
    const r = await pullMissingArchivesAll({ sites: [], db, fetchImpl: () => {} });
    expect(r).toEqual({ sitesProcessed: 0, totalPulled: 0, totalMissing: 0, results: [] });
  });
});
