// Contract tests for src/routes/jti.js — drives the handler functions
// directly with mock req/res/db/getSagePool/audit. No HTTP transport,
// no supertest, no live Sage. The handlers were extracted as plain
// functions specifically so they're testable this way.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import XLSX from 'xlsx';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Intercept the audit module BEFORE importing the route. Each test
// already passes its own `audit` spy into the handler, so we never
// exercise the real logAudit here — and audit.js does
// `db.prepare(INSERT INTO auditlog…)` at module load, which fails
// against a fresh CI database that hasn't run migrations yet. Without
// this mock the whole test file fails to load on CI even though no
// test depends on the real audit writer.
vi.mock('../src/lib/audit.js', () => ({
  logAudit: vi.fn(),
  summarizeDiff: vi.fn(() => null),
}));

import {
  handleGetSettings,
  handlePutSettings,
  handleExport,
  handleListArchives,
  handleDownloadArchive,
  pickFirst,
} from '../src/routes/jti.js';
import { archiveJtiExport } from '../src/services/jti/jtiArchive.js';

// Minimal in-memory DB matching migrations v69 (jti_settings) +
// v70 (jti_archive). The archive table is needed because
// handleExport now writes a row when the range is a full calendar
// month — see src/services/jti/jtiArchive.js.
let db;
let tmpArchiveRoot;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE jti_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE jti_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_year INTEGER NOT NULL,
      period_month INTEGER NOT NULL,
      generated_at TEXT NOT NULL DEFAULT (datetime('now')),
      generated_by TEXT,
      source TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      town_city TEXT, region TEXT, country TEXT, site_label TEXT,
      hub_push_status TEXT NOT NULL DEFAULT 'pending',
      hub_push_at TEXT, hub_push_error TEXT,
      hub_push_attempts INTEGER NOT NULL DEFAULT 0
    );
  `);
  // Per-test archive root so disk writes from one test can't leak
  // into another. cleanup not strictly necessary (OS tmp), but kept
  // tidy via afterEach below if needed.
  tmpArchiveRoot = path.join(os.tmpdir(), `jti-archive-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});

// No-op pushToHub injected into handleExport calls. Without this,
// the route's fire-and-forget post-archive push would call the real
// pushArchiveToHub which inspects HUB_URL/REPORTING_TOKEN env vars
// and (without them) marks rows as 'skipped_no_hub' asynchronously
// — racey vs the test's row assertions. Tests that explicitly want
// to inspect push behaviour are in test/jtiHubPush.test.js.
const noopPush = vi.fn(async () => ({ status: 'pushed' }));

// Stub req/res factory. Captures status / json / setHeader / end so
// tests can assert on what the handler did. role defaults to 'admin'
// because most JTI endpoints are admin-permissive; tests that check
// the operator-vs-admin gate pass role: 'operator' explicitly.
function makeReqRes({ body = {}, role = 'admin', query = {}, params = {} } = {}) {
  const req = { body, query, params, currentUser: { id: 1, email: 'op@example.com', role } };
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    raw: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    end(chunk) { this.raw = chunk; return this; },
  };
  return { req, res };
}

// Default pool-status stub for handleGetSettings — assumes JTI is
// configured (so a fresh-install GET doesn't trip the warning path).
const stubPoolConfigured = () => ({ configured: true, source: 'mock://test-connection' });
const stubPoolUnconfigured = () => ({ configured: false, source: null });

// Simple Sage pool stub matching the shape jtiQuery expects (pool →
// request() → input().query()).
function makeSagePool({ recordset = [] } = {}) {
  return {
    request: () => ({
      input(_n, _v) { return this; },
      async query(_sql) { return { recordset }; },
    }),
  };
}

describe('pickFirst', () => {
  it('returns the first non-empty value', () => {
    expect(pickFirst('a', 'b')).toBe('a');
    expect(pickFirst(null, 'b')).toBe('b');
    expect(pickFirst(undefined, '', 'c')).toBe('c');
  });

  it('treats whitespace-only as empty', () => {
    expect(pickFirst('   ', 'b')).toBe('b');
    expect(pickFirst('   ')).toBe('');
  });

  it('returns empty string when all values empty', () => {
    expect(pickFirst()).toBe('');
    expect(pickFirst(null, undefined, '')).toBe('');
  });
});

describe('handleGetSettings', () => {
  it('returns empty defaults + the default SQL + pool status for a fresh install', async () => {
    const { req, res } = makeReqRes();
    handleGetSettings({ db, getPoolStatus: stubPoolConfigured, req, res });
    expect(res.body.ok).toBe(true);
    expect(res.body.settings).toEqual({
      townCity: '', region: '', country: '', siteLabel: '', queryOverride: '',
    });
    // effective === default when no override is stored
    expect(res.body.effectiveSql).toBe(res.body.defaultSql);
    expect(res.body.effectiveSql).toMatch(/FROM OESHDT/);
    expect(res.body.poolStatus).toEqual({ configured: true, source: 'mock://test-connection' });
  });

  it('returns the stored defaults + override when present', async () => {
    db.prepare(`INSERT INTO jti_settings (key, value) VALUES ('town_city', 'ERMELO')`).run();
    db.prepare(`INSERT INTO jti_settings (key, value) VALUES ('site_label', 'Ermelo')`).run();
    db.prepare(`INSERT INTO jti_settings (key, value) VALUES ('query_override', 'SELECT 1 AS TRANNUM, 2 AS TRANDATE, 3 AS ITEM, 4 AS [DESC], 5 AS CUSTOMER, 6 AS NAMECUST, 7 AS QTYSOLD WHERE @from <= @to AND @vendor = @vendor')`).run();
    const { req, res } = makeReqRes();
    handleGetSettings({ db, getPoolStatus: stubPoolConfigured, req, res });
    expect(res.body.settings.townCity).toBe('ERMELO');
    expect(res.body.settings.siteLabel).toBe('Ermelo');
    // effectiveSql now reflects the override, not the default
    expect(res.body.effectiveSql).toMatch(/SELECT 1 AS TRANNUM/);
    expect(res.body.effectiveSql).not.toBe(res.body.defaultSql);
  });

  it('surfaces poolStatus.configured=false when JTI has no role assigned', async () => {
    const { req, res } = makeReqRes();
    handleGetSettings({ db, getPoolStatus: stubPoolUnconfigured, req, res });
    expect(res.body.poolStatus).toEqual({ configured: false, source: null });
  });
});

describe('handlePutSettings', () => {
  it('persists address-field updates + audits with before/after', async () => {
    const audit = vi.fn();
    const { req, res } = makeReqRes({
      body: { townCity: 'ERMELO', region: 'MPUMALANGA' },
    });
    handlePutSettings({ db, audit, req, res });
    expect(res.body.ok).toBe(true);
    expect(res.body.settings.townCity).toBe('ERMELO');
    expect(res.body.settings.region).toBe('MPUMALANGA');
    expect(audit).toHaveBeenCalledTimes(1);
    const auditArg = audit.mock.calls[0][0];
    expect(auditArg.action).toBe('jti_settings_update');
    expect(auditArg.changes.before).toEqual({ townCity: '', region: '', country: '', siteLabel: '', queryOverride: '' });
    expect(auditArg.changes.after.townCity).toBe('ERMELO');
  });

  it('respects partial updates (other fields untouched)', async () => {
    db.prepare(`INSERT INTO jti_settings (key, value) VALUES ('country', 'SOUTH AFRICA')`).run();
    const { req, res } = makeReqRes({ body: { townCity: 'ERMELO' } });
    handlePutSettings({ db, audit: vi.fn(), req, res });
    expect(res.body.settings).toEqual({
      townCity: 'ERMELO', region: '', country: 'SOUTH AFRICA', siteLabel: '', queryOverride: '',
    });
  });

  it('REJECTS queryOverride from non-admin users (403)', async () => {
    const { req, res } = makeReqRes({
      body: { queryOverride: 'SELECT 1 AS TRANNUM ...' },
      role: 'operator',
    });
    handlePutSettings({ db, audit: vi.fn(), req, res });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/admin/i);
  });

  it('REJECTS invalid override SQL with structured issues array', async () => {
    const { req, res } = makeReqRes({
      body: { queryOverride: 'SELECT * FROM OESHDT' },  // missing every required column AND param
    });
    handlePutSettings({ db, audit: vi.fn(), req, res });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/issues/);
    expect(res.body.issues.length).toBeGreaterThan(0);
    // Persisted nothing
    const stored = db.prepare(`SELECT value FROM jti_settings WHERE key = 'query_override'`).get();
    expect(stored).toBeUndefined();
  });

  it('REJECTS mutating SQL keywords', async () => {
    const { req, res } = makeReqRes({
      body: { queryOverride: 'SELECT @from, @to, @vendor, TRANNUM, TRANDATE, ITEM, [DESC], CUSTOMER, NAMECUST, QTYSOLD; DROP TABLE OESHDT' },
    });
    handlePutSettings({ db, audit: vi.fn(), req, res });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body.issues)).toMatch(/mutating keyword/i);
  });

  it('ACCEPTS a well-formed override and audits with the SQL-update action', async () => {
    const audit = vi.fn();
    const goodSql = `
      SELECT TRANNUM, TRANDATE, ITEM, [DESC], CUSTOMER, NAMECUST, QTYSOLD
      FROM OESHDT
      WHERE TRANDATE BETWEEN @from AND @to
        AND ITEM IN (SELECT ITEMNO FROM ICITMV WHERE VENDNUM LIKE @vendor)
    `;
    const { req, res } = makeReqRes({ body: { queryOverride: goodSql } });
    handlePutSettings({ db, audit, req, res });
    expect(res.statusCode).toBe(200);
    expect(res.body.settings.queryOverride.trim()).toBe(goodSql.trim());
    expect(audit.mock.calls[0][0].action).toBe('jti_settings_query_update');
  });

  it('audits as "reset to default" when override is cleared with empty string', async () => {
    db.prepare(`INSERT INTO jti_settings (key, value) VALUES ('query_override', 'SELECT 1')`).run();
    const audit = vi.fn();
    const { req, res } = makeReqRes({ body: { queryOverride: '' } });
    handlePutSettings({ db, audit, req, res });
    expect(res.statusCode).toBe(200);
    expect(res.body.settings.queryOverride).toBe('');
    expect(audit.mock.calls[0][0].details).toMatch(/reset to default/);
  });

  it('warns (not errors) when override omits @vendor', async () => {
    const noVendor = `
      SELECT TRANNUM, TRANDATE, ITEM, [DESC], CUSTOMER, NAMECUST, QTYSOLD
      FROM OESHDT WHERE TRANDATE BETWEEN @from AND @to
    `;
    const { req, res } = makeReqRes({ body: { queryOverride: noVendor } });
    handlePutSettings({ db, audit: vi.fn(), req, res });
    expect(res.statusCode).toBe(200);
    expect(res.body.warnings.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body.warnings)).toMatch(/@vendor/);
  });
});

describe('handleExport — input validation', () => {
  it('returns 400 when from is missing', async () => {
    const { req, res } = makeReqRes({ body: { to: '20260430' } });
    await handleExport({ db, getSagePool: () => makeSagePool(), audit: vi.fn(), req, res });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Date range required/);
  });

  it('returns 400 when to is missing', async () => {
    const { req, res } = makeReqRes({ body: { from: '20260401' } });
    await handleExport({ db, getSagePool: () => makeSagePool(), audit: vi.fn(), req, res });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when fromDate > toDate (delegated from buildJtiSql)', async () => {
    const { req, res } = makeReqRes({ body: { from: '20260430', to: '20260401' } });
    await handleExport({ db, getSagePool: async () => makeSagePool(), audit: vi.fn(), req, res });
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/must not be after/);
  });

  it('returns 400 when dates are unparseable', async () => {
    const { req, res } = makeReqRes({ body: { from: 'garbage', to: '20260430' } });
    await handleExport({ db, getSagePool: async () => makeSagePool(), audit: vi.fn(), req, res });
    expect(res.statusCode).toBe(400);
  });
});

describe('handleExport — JTI pool unavailable', () => {
  it('returns 503 with a clear message when the pool throws', async () => {
    const { req, res } = makeReqRes({ body: { from: '20260401', to: '20260430' } });
    const failingPool = async () => { throw new Error('Sage server timeout'); };
    await handleExport({ db, getSagePool: failingPool, audit: vi.fn(), req, res });
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/Sage server timeout/);
  });

  it('surfaces the "configure module routing" message verbatim when no role is assigned', async () => {
    // This is the message getJtiSagePool throws when jti_export role
    // is unset. The handler must NOT mask it — operator needs the
    // exact "Settings → Connections → Module routing" hint to act.
    const { req, res } = makeReqRes({ body: { from: '20260401', to: '20260430' } });
    const unconfigured = async () => {
      throw new Error('No connection assigned to JTI export — Settings → Connections → Module routing → assign a connection to "JTI export". This module does not fall back to the BAT Sage pool by design.');
    };
    await handleExport({ db, getSagePool: unconfigured, audit: vi.fn(), req, res });
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/Module routing/);
    expect(res.body.error).toMatch(/JTI export/);
  });
});

describe('handleExport — happy path', () => {
  const sageRows = [
    { TRANNUM: 'IN000428009', TRANDATE: 20260401, ITEM: '87',
      DESC: '  CAMEL CLASSIC', CUSTOMER: '10', NAMECUST: 'LIQUOR CITY WHITERIVER', QTYSOLD: 2 },
    { TRANNUM: 'IN000428010', TRANDATE: 20260415, ITEM: '65',
      DESC: '  CAMEL DOUBLE', CUSTOMER: '11', NAMECUST: 'CALTEX SHOP', QTYSOLD: 5 },
  ];

  it('returns 200 with .xlsx Content-Type and the right Content-Disposition filename', async () => {
    db.prepare(`INSERT INTO jti_settings (key, value) VALUES ('site_label', 'Ermelo')`).run();
    const { req, res } = makeReqRes({ body: { from: '20260401', to: '20260430' } });
    await handleExport({
      db,
      getSagePool: async () => makeSagePool({ recordset: sageRows }),
      audit: vi.fn(),
      archiveRoot: tmpArchiveRoot,
      pushToHub: noopPush,
      req, res,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toBe('attachment; filename="JTI_Cardoso_Sales_Ermelo_20260430.xlsx"');
    expect(res.headers['content-length']).toBe(String(res.raw.length));
  });

  it('returns a structurally-correct .xlsx (re-parseable, has 2 data rows + headers)', async () => {
    const { req, res } = makeReqRes({
      body: {
        from: '20260401', to: '20260430',
        townCity: 'ERMELO', region: 'MPUMALANGA', country: 'SOUTH AFRICA',
      },
    });
    await handleExport({
      db,
      getSagePool: async () => makeSagePool({ recordset: sageRows }),
      audit: vi.fn(),
      archiveRoot: tmpArchiveRoot,
      pushToHub: noopPush,
      req, res,
    });
    const wb = XLSX.read(res.raw, { cellNF: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    expect(wb.SheetNames).toEqual(['Sheet1']);
    expect(ws['A1'].v).toBe('DocumentType');
    expect(ws['A2'].v).toBe('Invoice');     // derived from IN000428009
    expect(ws['B2'].v).toBe('IN000428009');
    expect(ws['H2'].v).toBe('ERMELO');       // override applied
    expect(ws['A3'].v).toBe('Invoice');     // second row
    expect(ws['G3'].v).toBe('CALTEX SHOP');
  });

  it('falls back to saved defaults when the request omits the manual fields', async () => {
    db.prepare(`INSERT INTO jti_settings (key, value) VALUES ('town_city', 'SAVED_TOWN')`).run();
    db.prepare(`INSERT INTO jti_settings (key, value) VALUES ('region', 'SAVED_REGION')`).run();
    db.prepare(`INSERT INTO jti_settings (key, value) VALUES ('country', 'SAVED_COUNTRY')`).run();
    const { req, res } = makeReqRes({ body: { from: '20260401', to: '20260430' } });
    await handleExport({
      db,
      getSagePool: async () => makeSagePool({ recordset: sageRows.slice(0, 1) }),
      audit: vi.fn(),
      archiveRoot: tmpArchiveRoot,
      pushToHub: noopPush,
      req, res,
    });
    const wb = XLSX.read(res.raw);
    const ws = wb.Sheets['Sheet1'];
    expect(ws['H2'].v).toBe('SAVED_TOWN');
    expect(ws['I2'].v).toBe('SAVED_REGION');
    expect(ws['J2'].v).toBe('SAVED_COUNTRY');
  });

  it('per-export overrides win over saved defaults', async () => {
    db.prepare(`INSERT INTO jti_settings (key, value) VALUES ('town_city', 'SAVED_TOWN')`).run();
    const { req, res } = makeReqRes({
      body: { from: '20260401', to: '20260430', townCity: 'OVERRIDE_TOWN' },
    });
    await handleExport({
      db,
      getSagePool: async () => makeSagePool({ recordset: sageRows.slice(0, 1) }),
      audit: vi.fn(),
      archiveRoot: tmpArchiveRoot,
      pushToHub: noopPush,
      req, res,
    });
    const wb = XLSX.read(res.raw);
    const ws = wb.Sheets['Sheet1'];
    expect(ws['H2'].v).toBe('OVERRIDE_TOWN');
  });

  it('audits the export with row count + range + manual fields', async () => {
    const audit = vi.fn();
    const { req, res } = makeReqRes({
      body: { from: '20260401', to: '20260430', townCity: 'X', region: 'Y', country: 'Z' },
    });
    await handleExport({
      db,
      getSagePool: async () => makeSagePool({ recordset: sageRows }),
      audit,
      archiveRoot: tmpArchiveRoot,
      pushToHub: noopPush,
      req, res,
    });
    // The success-path audit is called once at the end; the failure-path
    // audits we don't expect to fire here.
    expect(audit).toHaveBeenCalledTimes(1);
    const arg = audit.mock.calls[0][0];
    expect(arg.action).toBe('jti_export');
    expect(arg.details).toMatch(/2 row\(s\)/);
    expect(arg.changes.from).toBe('20260401');
    expect(arg.changes.to).toBe('20260430');
    expect(arg.changes.rowCount).toBe(2);
    expect(arg.changes.manual).toEqual({ townCity: 'X', region: 'Y', country: 'Z' });
  });

  it('returns a header-only .xlsx (200, not 404) when Sage returns no rows', async () => {
    const { req, res } = makeReqRes({ body: { from: '20260401', to: '20260430' } });
    await handleExport({
      db,
      getSagePool: async () => makeSagePool({ recordset: [] }),
      audit: vi.fn(),
      archiveRoot: tmpArchiveRoot,
      pushToHub: noopPush,
      req, res,
    });
    expect(res.statusCode).toBe(200);
    const wb = XLSX.read(res.raw);
    const ws = wb.Sheets['Sheet1'];
    const range = XLSX.utils.decode_range(ws['!ref']);
    // Header row only: 1 row, 14 cols
    expect(range.e.r).toBe(0);
    expect(range.e.c).toBe(13);
  });
});

describe('handleExport — Unknown site fallback', () => {
  it('uses "Unknown" in the filename when no site label is set anywhere', async () => {
    const { req, res } = makeReqRes({ body: { from: '20260401', to: '20260430' } });
    await handleExport({
      db,
      getSagePool: async () => makeSagePool({ recordset: [] }),
      audit: vi.fn(),
      archiveRoot: tmpArchiveRoot,
      pushToHub: noopPush,
      req, res,
    });
    expect(res.headers['content-disposition']).toBe('attachment; filename="JTI_Cardoso_Sales_Unknown_20260430.xlsx"');
  });
});

describe('handleExport — auto-archive on full-month range', () => {
  const sageRows = [
    { TRANNUM: 'IN000428009', TRANDATE: 20260401, ITEM: '87',
      DESC: '  CAMEL CLASSIC', CUSTOMER: '10', NAMECUST: 'LIQUOR CITY WHITERIVER', QTYSOLD: 2 },
  ];

  afterEach(() => {
    if (tmpArchiveRoot && fs.existsSync(tmpArchiveRoot)) {
      fs.rmSync(tmpArchiveRoot, { recursive: true, force: true });
    }
  });

  it('writes an archive row + sets X-JTI-Archive-Id when the range is a full calendar month', async () => {
    db.prepare(`INSERT INTO jti_settings (key, value) VALUES ('site_label', 'Ermelo')`).run();
    const { req, res } = makeReqRes({
      body: { from: '20260401', to: '20260430', townCity: 'ERMELO', region: 'MPUMALANGA', country: 'SOUTH AFRICA' },
    });
    await handleExport({
      db,
      getSagePool: async () => makeSagePool({ recordset: sageRows }),
      audit: vi.fn(),
      archiveRoot: tmpArchiveRoot,
      pushToHub: noopPush,
      req, res,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-jti-archive-id']).toBeDefined();

    const archived = db.prepare(`SELECT * FROM jti_archive`).all();
    expect(archived).toHaveLength(1);
    const row = archived[0];
    expect(row.period_year).toBe(2026);
    expect(row.period_month).toBe(4);
    expect(row.source).toBe('manual');
    expect(row.generated_by).toBe('op@example.com');
    expect(row.row_count).toBe(1);
    expect(row.town_city).toBe('ERMELO');
    expect(row.region).toBe('MPUMALANGA');
    expect(row.country).toBe('SOUTH AFRICA');
    expect(row.site_label).toBe('Ermelo');
    expect(row.byte_size).toBe(res.raw.length);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(row.file_path)).toBe(true);
    expect(fs.statSync(row.file_path).size).toBe(res.raw.length);
  });

  it('does NOT archive when the range is a partial month', async () => {
    const { req, res } = makeReqRes({
      body: { from: '20260405', to: '20260412' },
    });
    await handleExport({
      db,
      getSagePool: async () => makeSagePool({ recordset: sageRows }),
      audit: vi.fn(),
      archiveRoot: tmpArchiveRoot,
      pushToHub: noopPush,
      req, res,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-jti-archive-id']).toBeUndefined();
    const archived = db.prepare(`SELECT COUNT(*) AS n FROM jti_archive`).get();
    expect(archived.n).toBe(0);
  });

  it('does NOT archive when the range crosses two calendar months', async () => {
    const { req, res } = makeReqRes({
      body: { from: '20260315', to: '20260415' },
    });
    await handleExport({
      db,
      getSagePool: async () => makeSagePool({ recordset: sageRows }),
      audit: vi.fn(),
      archiveRoot: tmpArchiveRoot,
      pushToHub: noopPush,
      req, res,
    });
    expect(res.statusCode).toBe(200);
    const archived = db.prepare(`SELECT COUNT(*) AS n FROM jti_archive`).get();
    expect(archived.n).toBe(0);
  });

  it('still returns 200 + the .xlsx download when the archive write fails', async () => {
    // Force archive write to fail by passing an unwritable archive
    // root (a path under a non-existent file rather than directory).
    const blocked = path.join(tmpArchiveRoot, 'not-a-dir', 'cant-create-here');
    // Pre-create a FILE at the parent so mkdirSync recursive throws
    // (you can't create a directory under a file).
    fs.mkdirSync(tmpArchiveRoot, { recursive: true });
    fs.writeFileSync(path.join(tmpArchiveRoot, 'not-a-dir'), 'blocker');

    const audit = vi.fn();
    const { req, res } = makeReqRes({
      body: { from: '20260401', to: '20260430' },
    });
    await handleExport({
      db,
      getSagePool: async () => makeSagePool({ recordset: sageRows }),
      audit,
      archiveRoot: blocked,
      req, res,
    });
    // The download still succeeds — operator gets their file.
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-jti-archive-id']).toBeUndefined();
    // Audit captures the archive failure and marks status='partial'.
    const arg = audit.mock.calls[0][0];
    expect(arg.status).toBe('partial');
    expect(arg.details).toMatch(/ARCHIVE FAILED/);
    expect(arg.changes.archiveError).toBeTruthy();
    expect(arg.changes.archivedId).toBeNull();
    // No row was persisted (transaction rolled back).
    const archived = db.prepare(`SELECT COUNT(*) AS n FROM jti_archive`).get();
    expect(archived.n).toBe(0);
  });

  it('records the audit details suffix "archived as #N" on success', async () => {
    const audit = vi.fn();
    const { req, res } = makeReqRes({
      body: { from: '20260401', to: '20260430' },
    });
    await handleExport({
      db,
      getSagePool: async () => makeSagePool({ recordset: sageRows }),
      audit,
      archiveRoot: tmpArchiveRoot,
      pushToHub: noopPush,
      req, res,
    });
    const arg = audit.mock.calls[0][0];
    expect(arg.details).toMatch(/full month 2026-04/);
    expect(arg.details).toMatch(/archived as #\d+/);
    expect(arg.changes.archivedId).toBeTypeOf('number');
  });
});

describe('handleListArchives', () => {
  afterEach(() => {
    if (tmpArchiveRoot && fs.existsSync(tmpArchiveRoot)) {
      fs.rmSync(tmpArchiveRoot, { recursive: true, force: true });
    }
  });

  it('returns an empty list on a fresh install', async () => {
    const { req, res } = makeReqRes();
    handleListArchives({ db, req, res });
    expect(res.body.ok).toBe(true);
    expect(res.body.archives).toEqual([]);
    expect(res.body.limit).toBe(60);
  });

  it('returns archives ordered latest-period first', async () => {
    archiveJtiExport({ db, archiveRoot: tmpArchiveRoot, archive: makeArchiveInput({ year: 2026, month: 2 }) });
    archiveJtiExport({ db, archiveRoot: tmpArchiveRoot, archive: makeArchiveInput({ year: 2026, month: 4 }) });
    archiveJtiExport({ db, archiveRoot: tmpArchiveRoot, archive: makeArchiveInput({ year: 2026, month: 3 }) });
    const { req, res } = makeReqRes();
    handleListArchives({ db, req, res });
    expect(res.body.archives.map(a => a.period_month)).toEqual([4, 3, 2]);
  });

  it('honours the `limit` query param within bounds', async () => {
    for (let m = 1; m <= 6; m++) {
      archiveJtiExport({ db, archiveRoot: tmpArchiveRoot, archive: makeArchiveInput({ year: 2026, month: m }) });
    }
    const { req, res } = makeReqRes({ query: { limit: '2' } });
    handleListArchives({ db, req, res });
    expect(res.body.archives).toHaveLength(2);
    expect(res.body.limit).toBe(2);
  });

  it('falls back to default limit on garbage input', async () => {
    const { req, res } = makeReqRes({ query: { limit: 'abc' } });
    handleListArchives({ db, req, res });
    expect(res.body.limit).toBe(60);
  });
});

describe('handleDownloadArchive', () => {
  afterEach(() => {
    if (tmpArchiveRoot && fs.existsSync(tmpArchiveRoot)) {
      fs.rmSync(tmpArchiveRoot, { recursive: true, force: true });
    }
  });

  it('returns 400 on a non-numeric id', async () => {
    const { req, res } = makeReqRes({ params: { id: 'abc' } });
    handleDownloadArchive({ db, audit: vi.fn(), req, res });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when the id does not exist', async () => {
    const { req, res } = makeReqRes({ params: { id: '999' } });
    handleDownloadArchive({ db, audit: vi.fn(), req, res });
    expect(res.statusCode).toBe(404);
  });

  it('returns 410 when the row exists but the file is missing on disk', async () => {
    const row = archiveJtiExport({ db, archiveRoot: tmpArchiveRoot, archive: makeArchiveInput({ year: 2026, month: 4 }) });
    fs.unlinkSync(row.file_path);
    const audit = vi.fn();
    const { req, res } = makeReqRes({ params: { id: String(row.id) } });
    handleDownloadArchive({ db, audit, req, res });
    expect(res.statusCode).toBe(410);
    expect(audit.mock.calls[0][0].status).toBe('failure');
  });

  it('returns the .xlsx bytes + headers on a valid id', async () => {
    const row = archiveJtiExport({ db, archiveRoot: tmpArchiveRoot, archive: makeArchiveInput({ year: 2026, month: 4 }) });
    const audit = vi.fn();
    const { req, res } = makeReqRes({ params: { id: String(row.id) } });
    handleDownloadArchive({ db, audit, req, res });
    expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename=/);
    expect(res.headers['x-jti-archive-id']).toBe(String(row.id));
    expect(res.headers['x-jti-archive-sha256']).toBe(row.sha256);
    expect(Buffer.isBuffer(res.raw)).toBe(true);
    expect(res.raw.length).toBe(row.byte_size);
    expect(audit.mock.calls[0][0].action).toBe('jti_archive_download');
  });
});

// Helper for the archive-route tests: build a valid archive input
// with a tiny in-memory buffer (we don't care about .xlsx validity,
// only that bytes flow through end-to-end).
function makeArchiveInput({ year, month, source = 'manual' }) {
  return {
    buffer: Buffer.from(`fake-xlsx-bytes-for-${year}-${month}`),
    filename: `JTI_Cardoso_Sales_Test_${year}${String(month).padStart(2, '0')}30.xlsx`,
    periodYear: year,
    periodMonth: month,
    source,
    rowCount: 1,
    townCity: 'TEST',
    region: 'TEST',
    country: 'TEST',
    siteLabel: 'TEST',
  };
}
