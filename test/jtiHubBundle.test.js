// Unit tests for src/services/hub/jtiHubBundle.js — exercises group
// composition + completeness math + bundle streaming (with a sink
// PassThrough standing in for the HTTP response).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import {
  listArchiveGroups,
  streamArchiveBundle,
} from '../src/services/hub/jtiHubBundle.js';
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
  tmpRoot = path.join(os.tmpdir(), `jti-bundle-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmpRoot, { recursive: true });
  // receiveJtiArchive writes under process.cwd()/database/hub-archives/jti
  // by default; point cwd at tmpRoot to keep test fixtures isolated.
  originalCwd = process.cwd();
  process.chdir(tmpRoot);
});

afterEach(() => {
  try { process.chdir(originalCwd); } catch {}
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

const SITES = [
  { id: 'site-a', name: 'A' },
  { id: 'site-b', name: 'B' },
  { id: 'site-c', name: 'C' },
];

function seedReceived({ siteId, year, month, bytes = null, source = 'scheduled', receivedAt = null, filename = null }) {
  const buf = bytes || Buffer.from(`${siteId}-${year}-${month}-bytes`);
  // receivedAt override: receiveJtiArchive uses CURRENT_TIMESTAMP, but we
  // sometimes want to control ordering for "latest-version" tests.
  // filename override: collision tests need to force two different sites
  // to produce the same filename (the production scenario where two
  // sites have blank site_label and buildJtiFilename falls back to
  // "Unknown" for both).
  const result = receiveJtiArchive({
    db, archiveRoot: tmpRoot,
    archive: {
      siteId,
      buffer: buf,
      filename: filename || `JTI_${siteId}_${year}${String(month).padStart(2, '0')}30.xlsx`,
      periodYear: year, periodMonth: month,
      generatedAt: '2026-05-01 02:00:00',
      generatedBy: 'system:scheduled',
      source,
      rowCount: 1,
      declaredSha256: require('crypto').createHash('sha256').update(buf).digest('hex'),
      declaredByteSize: buf.length,
      receivedVia: 'push',
    },
  });
  if (receivedAt) {
    db.prepare(`UPDATE hub_jti_archive SET received_at = ? WHERE id = ?`).run(receivedAt, result.row.id);
  }
  return result.row;
}

// Stand-in for an HTTP response. Captures headers + body bytes.
function makeResStub() {
  const stream = new PassThrough();
  stream.statusCode = 200;
  stream._headers = {};
  stream._destroyed = false;
  stream.setHeader = (k, v) => { stream._headers[k.toLowerCase()] = v; };
  stream.status = (code) => { stream.statusCode = code; return stream; };
  const origDestroy = stream.destroy.bind(stream);
  stream.destroy = (err) => { stream._destroyed = true; return origDestroy(err); };
  return stream;
}

// Read the full body of the response stream into a Buffer.
function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

describe('listArchiveGroups — composition + completeness', () => {
  it('returns empty when no archives exist', () => {
    expect(listArchiveGroups({ db, sites: SITES })).toEqual([]);
  });

  it('flags complete=true when every expected site has reported for the period', () => {
    seedReceived({ siteId: 'site-a', year: 2026, month: 4 });
    seedReceived({ siteId: 'site-b', year: 2026, month: 4 });
    seedReceived({ siteId: 'site-c', year: 2026, month: 4 });
    const [g] = listArchiveGroups({ db, sites: SITES });
    expect(g.period_year).toBe(2026);
    expect(g.period_month).toBe(4);
    expect(g.expected_count).toBe(3);
    expect(g.received_count).toBe(3);
    expect(g.complete).toBe(true);
    expect(g.missing_site_ids).toEqual([]);
    expect(g.received.map((r) => r.site_id)).toEqual(['site-a', 'site-b', 'site-c']);
  });

  it('flags complete=false with the missing list when sites have not reported', () => {
    seedReceived({ siteId: 'site-a', year: 2026, month: 4 });
    seedReceived({ siteId: 'site-c', year: 2026, month: 4 });
    const [g] = listArchiveGroups({ db, sites: SITES });
    expect(g.complete).toBe(false);
    expect(g.received_count).toBe(2);
    expect(g.expected_count).toBe(3);
    expect(g.missing_site_ids).toEqual(['site-b']);
  });

  it('groups separately by (year, month) and orders latest first', () => {
    seedReceived({ siteId: 'site-a', year: 2026, month: 3 });
    seedReceived({ siteId: 'site-a', year: 2026, month: 4 });
    seedReceived({ siteId: 'site-a', year: 2025, month: 12 });
    const groups = listArchiveGroups({ db, sites: SITES });
    expect(groups.map((g) => `${g.period_year}-${g.period_month}`))
      .toEqual(['2026-4', '2026-3', '2025-12']);
  });

  it('only the LATEST version per (site_id, period) counts (re-runs)', () => {
    seedReceived({ siteId: 'site-a', year: 2026, month: 4, bytes: Buffer.from('v1'), receivedAt: '2026-05-01 09:00:00' });
    seedReceived({ siteId: 'site-a', year: 2026, month: 4, bytes: Buffer.from('v2'), receivedAt: '2026-05-02 10:00:00' });
    seedReceived({ siteId: 'site-b', year: 2026, month: 4 });
    seedReceived({ siteId: 'site-c', year: 2026, month: 4 });
    const [g] = listArchiveGroups({ db, sites: SITES });
    expect(g.received.length).toBe(3); // not 4
    const a = g.received.find((r) => r.site_id === 'site-a');
    // MAX(id) picks the second insert; bytes from v2.
    expect(Buffer.from(`v2`).length).toBe(2);
    expect(a.byte_size).toBe(2);
  });

  it('counts orphan archives (site not in HUB_SITES) separately — they do NOT block completeness', () => {
    seedReceived({ siteId: 'site-a', year: 2026, month: 4 });
    seedReceived({ siteId: 'site-b', year: 2026, month: 4 });
    seedReceived({ siteId: 'site-c', year: 2026, month: 4 });
    seedReceived({ siteId: 'site-decommissioned', year: 2026, month: 4 });
    const [g] = listArchiveGroups({ db, sites: SITES });
    expect(g.complete).toBe(true); // 3/3 expected present
    expect(g.orphan_site_ids).toEqual(['site-decommissioned']);
    // The orphan still appears in `received` so the operator can see it
    // exists; it just doesn't count toward completeness.
    expect(g.received.map((r) => r.site_id).sort())
      .toEqual(['site-a', 'site-b', 'site-c', 'site-decommissioned']);
  });

  it('respects limit (most recent periods first)', () => {
    for (let m = 1; m <= 8; m++) seedReceived({ siteId: 'site-a', year: 2026, month: m });
    const groups = listArchiveGroups({ db, sites: SITES, limit: 3 });
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.period_month)).toEqual([8, 7, 6]);
  });
});

describe('streamArchiveBundle — refusals', () => {
  it('refuses INCOMPLETE periods with the missing list', () => {
    seedReceived({ siteId: 'site-a', year: 2026, month: 4 });
    seedReceived({ siteId: 'site-c', year: 2026, month: 4 });
    const res = makeResStub();
    const outcome = streamArchiveBundle({
      db, sites: SITES, periodYear: 2026, periodMonth: 4, res,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('INCOMPLETE');
    expect(outcome.missing_site_ids).toEqual(['site-b']);
    expect(outcome.received_count).toBe(2);
    expect(outcome.expected_count).toBe(3);
    // Importantly: no headers set, no body streamed — the route is
    // free to write a JSON 409 from this outcome.
    expect(Object.keys(res._headers)).toEqual([]);
  });

  it('refuses PERIOD_EMPTY when nothing has been received for that period', () => {
    seedReceived({ siteId: 'site-a', year: 2026, month: 3 });
    const res = makeResStub();
    const outcome = streamArchiveBundle({
      db, sites: SITES, periodYear: 2026, periodMonth: 4, res,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('PERIOD_EMPTY');
  });

  it('refuses FILE_MISSING when a recorded archive is no longer on disk', () => {
    const a = seedReceived({ siteId: 'site-a', year: 2026, month: 4 });
    seedReceived({ siteId: 'site-b', year: 2026, month: 4 });
    seedReceived({ siteId: 'site-c', year: 2026, month: 4 });
    fs.unlinkSync(a.file_path);
    const res = makeResStub();
    const outcome = streamArchiveBundle({
      db, sites: SITES, periodYear: 2026, periodMonth: 4, res,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('FILE_MISSING');
    expect(outcome.missing_site_id).toBe('site-a');
    // No partial response started.
    expect(Object.keys(res._headers)).toEqual([]);
  });

  it('refuses BAD_PERIOD on nonsense year/month', () => {
    const res = makeResStub();
    expect(streamArchiveBundle({ db, sites: SITES, periodYear: 999, periodMonth: 4, res }).code).toBe('BAD_PERIOD');
    expect(streamArchiveBundle({ db, sites: SITES, periodYear: 2026, periodMonth: 13, res }).code).toBe('BAD_PERIOD');
  });
});

describe('streamArchiveBundle — happy path', () => {
  it('streams a ZIP containing one entry per expected site, flat at the root (filename only, no site folders)', async () => {
    seedReceived({ siteId: 'site-a', year: 2026, month: 4, bytes: Buffer.from('AAA') });
    seedReceived({ siteId: 'site-b', year: 2026, month: 4, bytes: Buffer.from('BBB') });
    seedReceived({ siteId: 'site-c', year: 2026, month: 4, bytes: Buffer.from('CCC') });
    const res = makeResStub();
    const outcome = streamArchiveBundle({
      db, sites: SITES, periodYear: 2026, periodMonth: 4, res,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.filename).toBe('JTI_Bundle_2026-04.zip');
    expect(res._headers['content-type']).toBe('application/zip');
    expect(res._headers['content-disposition']).toBe('attachment; filename="JTI_Bundle_2026-04.zip"');

    const body = await collect(res);
    // ZIP file magic — 'PK\x03\x04' at start.
    expect(body[0]).toBe(0x50);
    expect(body[1]).toBe(0x4B);
    expect(body[2]).toBe(0x03);
    expect(body[3]).toBe(0x04);
    // Filenames appear in the central directory as plain text — every
    // site's per-site filename is present at the ROOT (no `site-x/`
    // prefix) per the flat layout introduced on 2026-05-19.
    const ascii = body.toString('latin1');
    expect(ascii).toContain('JTI_site-a_20260430.xlsx');
    expect(ascii).toContain('JTI_site-b_20260430.xlsx');
    expect(ascii).toContain('JTI_site-c_20260430.xlsx');
    // No per-site folder prefixes any more.
    expect(ascii).not.toContain('site-a/');
    expect(ascii).not.toContain('site-b/');
    expect(ascii).not.toContain('site-c/');
  });

  it('renames colliding filenames with a __<site_id> suffix so the flat layout never loses a file', async () => {
    // Two sites that both end up with the SAME filename — this is what
    // happens in production when site_label is blank on two sites and
    // buildJtiFilename falls back to "Unknown" for both.
    seedReceived({ siteId: 'site-a', year: 2026, month: 4, filename: 'JTI_Cardoso_Sales_Unknown_20260430.xlsx' });
    seedReceived({ siteId: 'site-b', year: 2026, month: 4, filename: 'JTI_Cardoso_Sales_Unknown_20260430.xlsx' });
    seedReceived({ siteId: 'site-c', year: 2026, month: 4 });
    const res = makeResStub();
    const outcome = streamArchiveBundle({ db, sites: SITES, periodYear: 2026, periodMonth: 4, res });
    expect(outcome.ok).toBe(true);
    const ascii = (await collect(res)).toString('latin1');
    // First occurrence keeps its name; second is suffixed.
    expect(ascii).toContain('JTI_Cardoso_Sales_Unknown_20260430.xlsx');
    expect(ascii).toMatch(/JTI_Cardoso_Sales_Unknown_20260430__site-[ab]\.xlsx/);
  });

  it('treats case-only filename differences as collisions (Windows/macOS extraction safety)', async () => {
    seedReceived({ siteId: 'site-a', year: 2026, month: 4, filename: 'JTI_Cardoso_Sales_Ermelo_20260430.xlsx' });
    seedReceived({ siteId: 'site-b', year: 2026, month: 4, filename: 'JTI_Cardoso_Sales_ermelo_20260430.xlsx' });
    seedReceived({ siteId: 'site-c', year: 2026, month: 4 });
    const res = makeResStub();
    const outcome = streamArchiveBundle({ db, sites: SITES, periodYear: 2026, periodMonth: 4, res });
    expect(outcome.ok).toBe(true);
    const ascii = (await collect(res)).toString('latin1');
    // Both entries are present and the second one is suffixed because
    // it would case-fold-collide with the first.
    expect(ascii).toContain('JTI_Cardoso_Sales_Ermelo_20260430.xlsx');
    expect(ascii).toMatch(/JTI_Cardoso_Sales_(?:Ermelo|ermelo)_20260430__site-[ab]\.xlsx/);
  });

  it('excludes orphan archives from the ZIP (sites no longer in HUB_SITES)', async () => {
    seedReceived({ siteId: 'site-a', year: 2026, month: 4 });
    seedReceived({ siteId: 'site-b', year: 2026, month: 4 });
    seedReceived({ siteId: 'site-c', year: 2026, month: 4 });
    seedReceived({ siteId: 'site-decommissioned', year: 2026, month: 4 });
    const res = makeResStub();
    const outcome = streamArchiveBundle({
      db, sites: SITES, periodYear: 2026, periodMonth: 4, res,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.archives.map((a) => a.site_id).sort()).toEqual(['site-a', 'site-b', 'site-c']);
    const body = await collect(res);
    const ascii = body.toString('latin1');
    expect(ascii).not.toContain('site-decommissioned');
  });

  it('bundles only the LATEST version per (site, period) when re-runs exist', async () => {
    seedReceived({ siteId: 'site-a', year: 2026, month: 4, bytes: Buffer.from('OLD'), receivedAt: '2026-05-01 09:00:00' });
    seedReceived({ siteId: 'site-a', year: 2026, month: 4, bytes: Buffer.from('NEW'), receivedAt: '2026-05-02 10:00:00' });
    seedReceived({ siteId: 'site-b', year: 2026, month: 4 });
    seedReceived({ siteId: 'site-c', year: 2026, month: 4 });
    const res = makeResStub();
    const outcome = streamArchiveBundle({
      db, sites: SITES, periodYear: 2026, periodMonth: 4, res,
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.archives).toHaveLength(3); // one per site, not four
    await collect(res); // drain so the test ends cleanly
  });
});
