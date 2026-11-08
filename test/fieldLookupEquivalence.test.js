// getFirstNonEmptyObjectValue (src/helpers.js) was made fast with caches; it
// must return exactly what the original implementation did.

import { it, expect } from 'vitest';
import { getFirstNonEmptyObjectValue, SALES_REP_ALIASES, ACCOUNT_TYPE_ALIASES } from '../src/helpers.js';

// ── Original implementation, verbatim (reference) ──
const norm = (input) => String(input || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const likelyRep = (k) => { const n = norm(k); return !!n && (n.includes('salesrep') || n.includes('salerep') || n.includes('salesperson') || n.includes('salesman') || n.includes('slsrep') || n.includes('slsman') || (n.includes('rep') && n.includes('sales'))); };
const likelyType = (k) => { const n = norm(k); return !!n && (n.includes('accounttype') || n.includes('customertype') || n.includes('customerclass') || n.includes('accountclass') || n.includes('accttype') || n.includes('acctype') || (n.includes('type') && (n.includes('account') || n.includes('customer') || n.includes('acct'))) || (n.includes('class') && (n.includes('account') || n.includes('customer')))); };
function reference(source, aliases = []) {
  if (!source || typeof source !== 'object') return '';
  for (const key of aliases) { const v = source[key]; if (v !== undefined && v !== null && String(v).trim() !== '') return v; }
  const entries = Object.entries(source);
  const m = new Map(entries.map(([k, v]) => [norm(k), v]));
  for (const key of aliases) { const v = m.get(norm(key)); if (v !== undefined && v !== null && String(v).trim() !== '') return v; }
  const aliasSet = new Set(aliases.map(norm));
  if (SALES_REP_ALIASES.some((k) => aliasSet.has(norm(k)))) for (const [k, v] of entries) if (likelyRep(k) && v !== undefined && v !== null && String(v).trim() !== '') return v;
  if (ACCOUNT_TYPE_ALIASES.some((k) => aliasSet.has(norm(k)))) for (const [k, v] of entries) if (likelyType(k) && v !== undefined && v !== null && String(v).trim() !== '') return v;
  return '';
}

const rows = [
  { IDCUST: 'C1', NAMECUST: 'Acme', CODESLSP1: 'R7', outstanding_balance: '10' },
  { 'Customer Number': 'C2', 'Sales Rep': ' ', SalesPerson_Code: 'R9', 'Account Type': 'National' },
  { customer_number: 'C3', CUSTOMER_NUMBER: 'C3b', salesrep: null, SLSMAN: 'R1', CustClass: 'X' },
  { custno: 'C4', 'sales rep name': '', REP_CODE: 'R2', 'Acct Type': '', CUSTOMER_TYPE: 'Retail' },
  { a: 1, b: '', c: 0, d: '   ', 'Sales-Rep': 'R3', 'Account.Class': 'Gold' },
  {},
];
const aliasSets = [
  ['customer_number', 'IDCUST', 'Customer Number', 'custno'],
  SALES_REP_ALIASES, ACCOUNT_TYPE_ALIASES,
  ['outstanding_balance', 'Balance'], ['nope'], [],
  ['c', 'C', ' c '],
];

it('matches the original implementation on every row × alias set', () => {
  for (let pass = 0; pass < 2; pass++) { // 2nd pass hits the caches
    for (const row of rows) for (const aliases of aliasSets) {
      expect(getFirstNonEmptyObjectValue(row, aliases)).toEqual(reference(row, aliases));
    }
  }
});

it('reads values live: a row changed between lookups returns the new value', () => {
  const row = { SalesRepCode: 'OLD', X: 1 };
  expect(getFirstNonEmptyObjectValue(row, ['sales_rep_code'])).toBe('OLD');
  row.SalesRepCode = 'NEW';
  expect(getFirstNonEmptyObjectValue(row, ['sales_rep_code'])).toBe('NEW');
});
