// Unit tests for src/services/jti/jtiHubPush.js — drive the push
// functions with a stub fetch that captures (or fails) the request.
// No real network. The stub also lets us assert the multipart body
// shape (boundaries, field names, header).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  pushArchiveToHub,
  pushPendingArchives,
} from '../src/services/jti/jtiHubPush.js';
import { archiveJtiExport } from '../src/services/jti/jtiArchive.js';

let db;
let tmpRoot;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE jti_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_year INTEGER NOT NULL, period_month INTEGER NOT NULL,
      generated_at TEXT NOT NULL DEFAULT (datetime('now')),
      generated_by TEXT, source TEXT NOT NULL,
      filename TEXT NOT NULL, file_path TEXT NOT NULL,
      byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, row_count INTEGER NOT NULL,
      town_city TEXT, region TEXT, country TEXT, site_label TEXT,
      hub_push_status TEXT NOT NULL DEFAULT 'pending',
      hub_push_at TEXT, hub_push_error TEXT,
      hub_push_attempts INTEGER NOT NULL DEFAULT 0
    );
  `);
  tmpRoot = path.join(os.tmpdir(), `jti-push-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});

afterEach(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

function seedArchive({ source = 'manual', year = 2026, month = 4 } = {}) {
  return archiveJtiExport({
    db, archiveRoot: tmpRoot,
    archive: {
      buffer: Buffer.from('fake-xlsx-content-for-push-test'),
      filename: `JTI_Cardoso_Sales_Test_${year}${String(month).padStart(2, '0')}30.xlsx`,
      periodYear: year, periodMonth: month, source,
      generatedBy: source === 'scheduled' ? 'system:scheduled' : 'op@example.com',
      rowCount: 1,
      townCity: 'TEST', region: 'R', country: 'C', siteLabel: 'TestSite',
    },
  });
}

// Stub fetch factories
function fetchOk({ hubArchiveId = 99 } = {}) {
  return vi.fn(async (_url, _opts) => ({
    ok: true,
    status: 200,
    async json() { return { ok: true, hubArchiveId }; },
    async text() { return JSON.stringify({ ok: true, hubArchiveId }); },
  }));
}
function fetchFail({ status = 500, body = 'boom' } = {}) {
  return vi.fn(async (_url, _opts) => ({
    ok: false,
    status,
    async json() { throw new Error('not json'); },
    async text() { return body; },
  }));
}
function fetchNetworkError(message = 'ECONNREFUSED') {
  return vi.fn(async () => { throw new Error(message); });
}
function fetchCapture() {
  const calls = [];
  const fn = vi.fn(async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true, status: 200,
      async json() { return { ok: true, hubArchiveId: 1 }; },
      async text() { return ''; },
    };
  });
  return { fn, calls };
}

describe('pushArchiveToHub — skipped_no_hub', () => {
  it('marks status=skipped_no_hub when HUB_URL is unset', async () => {
    const archive = seedArchive();
    const res = await pushArchiveToHub({
      db, archive,
      hubUrl: '', reportingToken: 'tok', siteId: 's1',
      fetchImpl: fetchOk(),
    });
    expect(res.status).toBe('skipped_no_hub');
    const row = db.prepare(`SELECT * FROM jti_archive WHERE id = ?`).get(archive.id);
    expect(row.hub_push_status).toBe('skipped_no_hub');
    expect(row.hub_push_error).toMatch(/HUB_URL/);
    expect(row.hub_push_attempts).toBe(0);
  });

  it('marks status=skipped_no_hub when REPORTING_TOKEN is unset', async () => {
    const archive = seedArchive();
    const res = await pushArchiveToHub({
      db, archive,
      hubUrl: 'http://hub.example', reportingToken: '', siteId: 's1',
      fetchImpl: fetchOk(),
    });
    expect(res.status).toBe('skipped_no_hub');
    const row = db.prepare(`SELECT * FROM jti_archive WHERE id = ?`).get(archive.id);
    expect(row.hub_push_error).toMatch(/REPORTING_TOKEN/);
  });

  it('does not call fetch when no hub configured', async () => {
    const archive = seedArchive();
    const f = fetchOk();
    await pushArchiveToHub({
      db, archive,
      hubUrl: '', reportingToken: '', siteId: 's1',
      fetchImpl: f,
    });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('pushArchiveToHub — happy path', () => {
  it('POSTs to <hubUrl>/api/hub/receive-jti-archive with x-reporting-token', async () => {
    const archive = seedArchive();
    const { fn, calls } = fetchCapture();
    await pushArchiveToHub({
      db, archive,
      hubUrl: 'http://hub.example/', reportingToken: 'sekret', siteId: 'site-erm',
      fetchImpl: fn,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://hub.example/api/hub/receive-jti-archive');
    expect(calls[0].opts.headers['x-reporting-token']).toBe('sekret');
    expect(calls[0].opts.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(calls[0].opts.method).toBe('POST');
  });

  it('multipart body contains all metadata fields + the file', async () => {
    const archive = seedArchive({ year: 2026, month: 4 });
    const { fn, calls } = fetchCapture();
    await pushArchiveToHub({
      db, archive,
      hubUrl: 'http://hub.example', reportingToken: 't', siteId: 'site-erm',
      fetchImpl: fn,
    });
    const body = calls[0].opts.body.toString('latin1');
    // Field names should appear as form-data parts
    for (const f of ['site_id', 'site_archive_id', 'period_year', 'period_month',
                     'generated_at', 'source', 'row_count', 'sha256', 'byte_size',
                     'town_city', 'region', 'country', 'site_label']) {
      expect(body).toContain(`name="${f}"`);
    }
    expect(body).toContain(`name="file"; filename="${archive.filename}"`);
    expect(body).toContain('site-erm');
    expect(body).toContain('2026');
    expect(body).toContain(archive.sha256);
    // The actual file bytes are in the body too
    expect(body).toContain('fake-xlsx-content-for-push-test');
  });

  it('marks status=pushed and increments attempts on success', async () => {
    const archive = seedArchive();
    const res = await pushArchiveToHub({
      db, archive,
      hubUrl: 'http://hub.example', reportingToken: 't', siteId: 's1',
      fetchImpl: fetchOk({ hubArchiveId: 42 }),
    });
    expect(res.status).toBe('pushed');
    expect(res.hubArchiveId).toBe(42);
    const row = db.prepare(`SELECT * FROM jti_archive WHERE id = ?`).get(archive.id);
    expect(row.hub_push_status).toBe('pushed');
    expect(row.hub_push_attempts).toBe(1);
    expect(row.hub_push_error).toBeNull();
    expect(row.hub_push_at).toBeTruthy();
  });

  it('clears prior hub_push_error on a re-push that succeeds', async () => {
    const archive = seedArchive();
    // Simulate a prior failure.
    db.prepare(`UPDATE jti_archive SET hub_push_status='failed', hub_push_error='old', hub_push_attempts=2 WHERE id=?`).run(archive.id);
    // Re-fetch the row so it reflects the failed state.
    const stale = db.prepare(`SELECT * FROM jti_archive WHERE id=?`).get(archive.id);
    await pushArchiveToHub({
      db, archive: stale,
      hubUrl: 'http://hub.example', reportingToken: 't', siteId: 's1',
      fetchImpl: fetchOk(),
    });
    const row = db.prepare(`SELECT * FROM jti_archive WHERE id=?`).get(archive.id);
    expect(row.hub_push_status).toBe('pushed');
    expect(row.hub_push_error).toBeNull();
    expect(row.hub_push_attempts).toBe(3); // 2 previous + 1 this time
  });
});

describe('pushArchiveToHub — failure handling', () => {
  it('marks status=failed and records the body on HTTP 500', async () => {
    const archive = seedArchive();
    const res = await pushArchiveToHub({
      db, archive,
      hubUrl: 'http://hub.example', reportingToken: 't', siteId: 's1',
      fetchImpl: fetchFail({ status: 500, body: 'internal explosion' }),
    });
    expect(res.status).toBe('failed');
    expect(res.httpStatus).toBe(500);
    const row = db.prepare(`SELECT * FROM jti_archive WHERE id = ?`).get(archive.id);
    expect(row.hub_push_status).toBe('failed');
    expect(row.hub_push_error).toMatch(/HTTP 500/);
    expect(row.hub_push_error).toMatch(/internal explosion/);
    expect(row.hub_push_attempts).toBe(1);
  });

  it('marks status=failed on network error (ECONNREFUSED)', async () => {
    const archive = seedArchive();
    const res = await pushArchiveToHub({
      db, archive,
      hubUrl: 'http://hub.example', reportingToken: 't', siteId: 's1',
      fetchImpl: fetchNetworkError('ECONNREFUSED'),
    });
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/Network error/);
    expect(res.error).toMatch(/ECONNREFUSED/);
  });

  it('marks status=failed when the file is missing on disk', async () => {
    const archive = seedArchive();
    fs.unlinkSync(archive.file_path);
    const res = await pushArchiveToHub({
      db, archive,
      hubUrl: 'http://hub.example', reportingToken: 't', siteId: 's1',
      fetchImpl: fetchOk(),
    });
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/missing on disk/);
  });

  it('does NOT throw on network error (caller relies on result.status)', async () => {
    const archive = seedArchive();
    await expect(pushArchiveToHub({
      db, archive,
      hubUrl: 'http://hub.example', reportingToken: 't', siteId: 's1',
      fetchImpl: fetchNetworkError(),
    })).resolves.toBeTruthy();
  });
});

describe('pushPendingArchives', () => {
  it('returns counts of pushed/failed/skipped/considered', async () => {
    seedArchive({ year: 2026, month: 4 });
    seedArchive({ year: 2026, month: 3 });
    seedArchive({ year: 2026, month: 2 });
    const res = await pushPendingArchives({
      db,
      hubUrl: 'http://hub.example', reportingToken: 't', siteId: 's1',
      fetchImpl: fetchOk(),
    });
    expect(res.considered).toBe(3);
    expect(res.pushed).toBe(3);
    expect(res.failed).toBe(0);
  });

  it('skips already-pushed rows (only scans pending/failed)', async () => {
    const a = seedArchive({ year: 2026, month: 4 });
    db.prepare(`UPDATE jti_archive SET hub_push_status='pushed' WHERE id=?`).run(a.id);
    const b = seedArchive({ year: 2026, month: 5 });
    const res = await pushPendingArchives({
      db,
      hubUrl: 'http://hub.example', reportingToken: 't', siteId: 's1',
      fetchImpl: fetchOk(),
    });
    expect(res.considered).toBe(1); // only b was eligible
    const aRow = db.prepare(`SELECT * FROM jti_archive WHERE id=?`).get(a.id);
    expect(aRow.hub_push_attempts).toBe(0); // a was not retried
    const bRow = db.prepare(`SELECT * FROM jti_archive WHERE id=?`).get(b.id);
    expect(bRow.hub_push_status).toBe('pushed');
  });

  it('respects maxAttempts cap — rows past the cap are not retried', async () => {
    const a = seedArchive({ year: 2026, month: 4 });
    db.prepare(`UPDATE jti_archive SET hub_push_status='failed', hub_push_attempts=50 WHERE id=?`).run(a.id);
    const res = await pushPendingArchives({
      db, maxAttempts: 50,
      hubUrl: 'http://hub.example', reportingToken: 't', siteId: 's1',
      fetchImpl: fetchOk(),
    });
    expect(res.considered).toBe(0);
  });

  it('returns immediately with zero counts when no archives exist', async () => {
    const res = await pushPendingArchives({
      db,
      hubUrl: 'http://hub.example', reportingToken: 't', siteId: 's1',
      fetchImpl: fetchOk(),
    });
    expect(res).toEqual({ pushed: 0, failed: 0, skipped: 0, considered: 0 });
  });

  it('honours batchSize (does not push more than batchSize per call)', async () => {
    for (let m = 1; m <= 6; m++) seedArchive({ year: 2026, month: m });
    const f = fetchOk();
    await pushPendingArchives({
      db, batchSize: 2,
      hubUrl: 'http://hub.example', reportingToken: 't', siteId: 's1',
      fetchImpl: f,
    });
    expect(f).toHaveBeenCalledTimes(2);
  });
});
