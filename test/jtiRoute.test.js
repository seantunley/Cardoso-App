// Contract tests for src/routes/jti.js — drives the handler functions
// directly with mock req/res/db/getSagePool/audit. No HTTP transport,
// no supertest, no live Sage. The handlers were extracted as plain
// functions specifically so they're testable this way.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import XLSX from 'xlsx';
import {
  handleGetSettings,
  handlePutSettings,
  handleExport,
  pickFirst,
} from '../src/routes/jti.js';

// Minimal in-memory DB matching migration v69's jti_settings shape.
let db;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE jti_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
});

// Stub req/res factory. Captures status / json / setHeader / end so
// tests can assert on what the handler did.
function makeReqRes({ body = {} } = {}) {
  const req = { body, currentUser: { id: 1, email: 'op@example.com' } };
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
  it('returns empty defaults for a fresh install', async () => {
    const { req, res } = makeReqRes();
    handleGetSettings({ db, req, res });
    expect(res.body).toEqual({
      ok: true,
      settings: { townCity: '', region: '', country: '', siteLabel: '' },
    });
  });

  it('returns the stored defaults', async () => {
    db.prepare(`INSERT INTO jti_settings (key, value) VALUES ('town_city', 'ERMELO')`).run();
    db.prepare(`INSERT INTO jti_settings (key, value) VALUES ('site_label', 'Ermelo')`).run();
    const { req, res } = makeReqRes();
    handleGetSettings({ db, req, res });
    expect(res.body.settings.townCity).toBe('ERMELO');
    expect(res.body.settings.siteLabel).toBe('Ermelo');
  });
});

describe('handlePutSettings', () => {
  it('persists the update + audits with before/after', async () => {
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
    expect(auditArg.changes.before).toEqual({ townCity: '', region: '', country: '', siteLabel: '' });
    expect(auditArg.changes.after.townCity).toBe('ERMELO');
  });

  it('respects partial updates (other fields untouched)', async () => {
    db.prepare(`INSERT INTO jti_settings (key, value) VALUES ('country', 'SOUTH AFRICA')`).run();
    const { req, res } = makeReqRes({ body: { townCity: 'ERMELO' } });
    handlePutSettings({ db, audit: vi.fn(), req, res });
    expect(res.body.settings).toEqual({
      townCity: 'ERMELO', region: '', country: 'SOUTH AFRICA', siteLabel: '',
    });
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

describe('handleExport — Sage pool unavailable', () => {
  it('returns 503 with a clear message when the pool throws', async () => {
    const { req, res } = makeReqRes({ body: { from: '20260401', to: '20260430' } });
    const failingPool = async () => { throw new Error('Sage server timeout'); };
    await handleExport({ db, getSagePool: failingPool, audit: vi.fn(), req, res });
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toMatch(/Sage 300 unavailable.*timeout/);
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
      req, res,
    });
    expect(res.headers['content-disposition']).toBe('attachment; filename="JTI_Cardoso_Sales_Unknown_20260430.xlsx"');
  });
});
