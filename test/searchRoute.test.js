// Contract tests for src/routes/search.js — the entity quick-search behind
// the command palette. Drives searchEntities (core) and handleEntitySearch
// (permission gating / query hygiene) directly with an in-memory DB and mock
// req/res, per the routes/jti.js contract-test pattern.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { searchEntities, handleEntitySearch } from '../src/routes/search.js';

let db;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE datarecord (
      id INTEGER PRIMARY KEY, customer_number TEXT, customer_name TEXT, outstanding_balance TEXT
    );
    CREATE TABLE creditor (
      id INTEGER PRIMARY KEY, vendor_code TEXT, vendor_name TEXT, is_active INTEGER DEFAULT 1
    );
    CREATE TABLE hub_records (
      site_id INTEGER, record_id INTEGER, customer_number TEXT, customer_name TEXT
    );
    CREATE TABLE hub_creditor (
      id INTEGER PRIMARY KEY, site_id INTEGER, vendor_code TEXT, vendor_name TEXT, is_active INTEGER DEFAULT 1
    );
  `);
  const c = db.prepare('INSERT INTO datarecord (customer_number, customer_name, outstanding_balance) VALUES (?, ?, ?)');
  c.run('LIQ001', 'LIQUOR CITY WHITERIVER', 'R 12,345.00');
  c.run('LIQ002', 'LIQUOR CITY NELSPRUIT', 'R 99.00');
  c.run('SPA001', 'SPAR MALELANE', 'R 5.00');
  c.run('ZZZ100', 'TOTAL GARAGE (LIQUID FUELS)', 'R 1.00'); // contains-match for "liq"
  const v = db.prepare('INSERT INTO creditor (vendor_code, vendor_name, is_active) VALUES (?, ?, ?)');
  v.run('BAT01', 'BRITISH AMERICAN TOBACCO', 1);
  v.run('JTI01', 'JTI SOUTH AFRICA', 1);
  v.run('OLD01', 'RETIRED VENDOR', 0);
  const h = db.prepare('INSERT INTO hub_records (site_id, record_id, customer_number, customer_name) VALUES (?, ?, ?, ?)');
  h.run(1, 11, 'LIQ001', 'LIQUOR CITY WHITERIVER');
  h.run(2, 22, 'LIQ001', 'LIQUOR CITY WHITERIVER'); // same customer, second site
  h.run(2, 23, 'LIQ009', 'LIQUOR LEGENDS');
});

afterEach(() => {
  db.close();
  delete process.env.HUB_MODE;
});

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

describe('searchEntities (core)', () => {
  it('ranks prefix matches above contains matches', () => {
    const { customers } = searchEntities(db, { q: 'liq', wantCustomers: true, wantVendors: false, hub: false });
    const names = customers.map((r) => r.customer_name);
    expect(names[0]).toMatch(/^LIQUOR/);
    expect(names).toContain('TOTAL GARAGE (LIQUID FUELS)'); // contains-match included, ranked later
    expect(names.indexOf('TOTAL GARAGE (LIQUID FUELS)')).toBeGreaterThan(names.indexOf('LIQUOR CITY NELSPRUIT'));
  });

  it('matches on customer number too', () => {
    const { customers } = searchEntities(db, { q: 'SPA001', wantCustomers: true, wantVendors: false, hub: false });
    expect(customers).toHaveLength(1);
    expect(customers[0].customer_name).toBe('SPAR MALELANE');
  });

  it('excludes inactive vendors', () => {
    const { vendors } = searchEntities(db, { q: 'vendor', wantCustomers: false, wantVendors: true, hub: false });
    expect(vendors).toHaveLength(0); // RETIRED VENDOR is is_active=0
  });

  it('escapes LIKE metacharacters — a literal % cannot match everything', () => {
    const { customers } = searchEntities(db, { q: '%%', wantCustomers: true, wantVendors: false, hub: false });
    expect(customers).toHaveLength(0);
  });

  it('hub mode collapses a customer across sites with a site count', () => {
    const { customers } = searchEntities(db, { q: 'liquor', wantCustomers: true, wantVendors: false, hub: true });
    const white = customers.find((c) => c.customer_number === 'LIQ001');
    expect(white).toBeDefined();
    expect(white.sites).toBe(2);
    expect(customers.filter((c) => c.customer_number === 'LIQ001')).toHaveLength(1);
  });
});

describe('handleEntitySearch (gating + hygiene)', () => {
  const admin = { role: 'admin' };
  const customerOnly = { role: 'user', can_access_customer_search: 1 };
  const nothing = { role: 'user' };

  it('admin gets both groups', () => {
    const res = mockRes();
    handleEntitySearch({ db })({ query: { q: 'liq' }, currentUser: admin }, res);
    expect(res.body.customers.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.vendors)).toBe(true);
  });

  it('customer-only user gets NO vendors even when the query matches one', () => {
    const res = mockRes();
    handleEntitySearch({ db })({ query: { q: 'tobacco' }, currentUser: customerOnly }, res);
    expect(res.body.vendors).toHaveLength(0);
    expect(res.body.customers).toHaveLength(0); // no customer named tobacco
  });

  it('user with no entity permissions gets the empty shape, not an error', () => {
    const res = mockRes();
    handleEntitySearch({ db })({ query: { q: 'liquor' }, currentUser: nothing }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ q: 'liquor', customers: [], vendors: [] });
  });

  it('short and missing queries return the empty shape', () => {
    for (const q of ['a', '', undefined]) {
      const res = mockRes();
      handleEntitySearch({ db })({ query: { q }, currentUser: admin }, res);
      expect(res.statusCode).toBe(200);
      expect(res.body.customers).toEqual([]);
    }
  });

  it('over-long queries are truncated, not rejected', () => {
    const res = mockRes();
    handleEntitySearch({ db })({ query: { q: 'LIQUOR CITY ' + 'x'.repeat(200) }, currentUser: admin }, res);
    expect(res.statusCode).toBe(200); // no throw; truncation means a valid (if unmatched) search
  });
});
