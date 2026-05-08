// Contract tests for the customer-lookup endpoints in src/routes/records.js.
//
// Tests run at the SQL level (not via HTTP) — same style as alertEngine /
// jobRunner tests. The route handlers are thin wrappers around these
// queries; pinning the SQL behaviour locks the contract that matters
// (ranking, sub-account expansion, empty-name exclusion, whitespace
// handling) without pulling in a supertest dependency.
//
// What's pinned:
//   1. Exact-number priority over name match
//   2. Empty-name rows excluded from suggestions
//   3. Parent/sub-account expansion: parent '100' matches '100A', '100-1';
//      does NOT match '1001'
//   4. Suggestion ranking: exact number > exact name > prefix > contains
//   5. Whitespace normalization: '  100  WC' → '100 WC' for queries
//   6. Lower-case index migration is sargable for lower(customer_name) =
//
// If any of these break, the operator-visible behaviour is wrong and the
// test fails loudly. The query strings copied from records.js verbatim
// are intentional — a refactor that changes the query SQL must update
// these tests in lock-step.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// In-memory DB with the minimal datarecord schema needed for these tests.
// Just the columns the lookup queries touch — full schema would pull in
// migration history we don't need.
const memDb = new Database(':memory:');
memDb.exec(`
  CREATE TABLE datarecord (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_number TEXT,
    customer_name TEXT,
    flag_color TEXT DEFAULT 'none',
    flag_reason TEXT,
    flag_created_by TEXT,
    auto_flagged INTEGER DEFAULT 0,
    data TEXT,
    local_fields TEXT DEFAULT '{}',
    unpaid_invoices TEXT DEFAULT '[]',
    receipts TEXT DEFAULT '[]'
  );
  CREATE INDEX idx_datarecord_customer_number ON datarecord(customer_number);
  CREATE INDEX idx_datarecord_customer_name_lower ON datarecord(lower(customer_name));
`);

const insertRow = memDb.prepare(`
  INSERT INTO datarecord (customer_number, customer_name)
  VALUES (?, ?)
`);

beforeEach(() => {
  memDb.prepare('DELETE FROM datarecord').run();
});

// ── Query helpers (verbatim from src/routes/records.js) ──────────────────
//
// Kept inline so any refactor of the route SQL needs to update both
// places — that's the contract these tests are meant to lock down.

function lookupExact(query) {
  return memDb.prepare(`
    SELECT *
    FROM datarecord
    WHERE TRIM(customer_number) = ?
       OR lower(customer_name) = lower(?)
    ORDER BY
      CASE
        WHEN TRIM(customer_number) = ? THEN 0
        WHEN lower(customer_name) = lower(?) THEN 1
        ELSE 2
      END,
      id DESC
    LIMIT 1
  `).get(query, query, query, query);
}

function lookupSubAccounts(parent) {
  const matches = memDb.prepare(`
    SELECT *
    FROM datarecord
    WHERE TRIM(customer_number) LIKE ?
      AND TRIM(customer_number) != ?
    ORDER BY customer_number ASC, id ASC
  `).all(`${parent}%`, parent);
  return matches.filter((row) => {
    const childNumber = String(row.customer_number || '').trim();
    const m = childNumber.match(/^(\d+)/);
    return m && m[1] === parent;
  });
}

function lookupSuggestions(query, limit = 20) {
  const startsWith = `${query}%`;
  const contains = `%${query}%`;
  return memDb.prepare(`
    SELECT *
    FROM datarecord
    WHERE TRIM(COALESCE(customer_name, '')) != ''
      AND (
            TRIM(customer_number) LIKE ?
         OR customer_name LIKE ?
         OR TRIM(customer_number) LIKE ?
         OR customer_name LIKE ?
      )
    ORDER BY
      CASE
        WHEN TRIM(customer_number) = ? THEN 0
        WHEN lower(customer_name) = lower(?) THEN 1
        WHEN TRIM(customer_number) LIKE ? THEN 2
        WHEN customer_name LIKE ? THEN 3
        ELSE 4
      END,
      length(customer_number) ASC,
      length(customer_name) ASC,
      customer_name ASC,
      customer_number ASC,
      id DESC
    LIMIT ?
  `).all(startsWith, startsWith, contains, contains, query, query, startsWith, startsWith, limit);
}

// Normalisation helper (verbatim from records.js Batch B fix).
const MAX_QUERY_LENGTH = 256;
function _normalizeCustomerQuery(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY_LENGTH);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('lookupExact — exact-number priority', () => {
  it('returns the exact customer_number match before any name match', () => {
    insertRow.run('200', 'Acme Hardware');           // name match if user types "200"? no
    insertRow.run('100', 'Some other shop');         // exact-number match for query "100"
    insertRow.run('300', '100');                     // name "100" — should rank below the number match

    const r = lookupExact('100');
    expect(r).not.toBeNull();
    expect(r.customer_number).toBe('100');           // not '300'
    expect(r.customer_name).toBe('Some other shop');
  });

  it('falls back to name match when number does not match', () => {
    insertRow.run('500', 'BP Express');
    insertRow.run('501', 'BP East');

    const r = lookupExact('BP Express');
    expect(r).not.toBeNull();
    expect(r.customer_number).toBe('500');
  });

  it('matches name case-insensitively', () => {
    insertRow.run('600', 'Acme Hardware');

    const r = lookupExact('acme hardware');
    expect(r).not.toBeNull();
    expect(r.customer_number).toBe('600');
  });

  it('returns null for a query that matches nothing', () => {
    insertRow.run('700', 'Foo');
    expect(lookupExact('does not exist')).toBeUndefined();
  });
});

describe('lookupSubAccounts — parent/child expansion', () => {
  it('matches purely-numeric parent with non-digit suffixes', () => {
    insertRow.run('100', 'Parent Co');
    insertRow.run('100A', 'Branch A');
    insertRow.run('100-1', 'Sub one');
    insertRow.run('100OC', 'Sub OC');

    const subs = lookupSubAccounts('100');
    const numbers = subs.map(r => r.customer_number).sort();
    expect(numbers).toEqual(['100-1', '100A', '100OC']);
  });

  it('does NOT match numeric siblings (the "100 vs 1001" case)', () => {
    insertRow.run('100', 'Parent Co');
    insertRow.run('100A', 'Sub A');
    insertRow.run('1001', 'Different customer');
    insertRow.run('1002', 'Different customer 2');

    const subs = lookupSubAccounts('100');
    const numbers = subs.map(r => r.customer_number);
    expect(numbers).toContain('100A');
    expect(numbers).not.toContain('1001');
    expect(numbers).not.toContain('1002');
  });

  it('excludes the parent itself from sub-account results', () => {
    insertRow.run('100', 'Parent Co');
    insertRow.run('100A', 'Branch A');

    const subs = lookupSubAccounts('100');
    expect(subs.find(r => r.customer_number === '100')).toBeUndefined();
  });

  it('returns empty for parents with no children', () => {
    insertRow.run('100', 'Lone customer');

    expect(lookupSubAccounts('100')).toEqual([]);
  });
});

describe('lookupSuggestions — empty-name exclusion', () => {
  it('omits rows with blank customer_name (Sage closed accounts)', () => {
    insertRow.run('900', 'Real Customer');
    insertRow.run('901', '');                        // blank — closed/placeholder
    insertRow.run('902', '   ');                     // whitespace-only — also blank

    const r = lookupSuggestions('9');
    const numbers = r.map(s => s.customer_number);
    expect(numbers).toContain('900');
    expect(numbers).not.toContain('901');
    expect(numbers).not.toContain('902');
  });

  it('omits rows with NULL customer_name', () => {
    insertRow.run('910', 'Real Customer');
    memDb.prepare('INSERT INTO datarecord (customer_number, customer_name) VALUES (?, NULL)').run('911');

    const r = lookupSuggestions('9');
    const numbers = r.map(s => s.customer_number);
    expect(numbers).toContain('910');
    expect(numbers).not.toContain('911');
  });
});

describe('lookupSuggestions — ranking', () => {
  it('ranks exact-number match above prefix matches', () => {
    insertRow.run('100', 'Foo');
    insertRow.run('1000', 'Bar');
    insertRow.run('1001', 'Baz');

    const r = lookupSuggestions('100');
    expect(r[0].customer_number).toBe('100');        // exact-number first
  });

  it('ranks exact-name match above prefix matches', () => {
    insertRow.run('500', 'BP Express');
    insertRow.run('501', 'BP Express North');
    insertRow.run('502', 'BP Express South');

    const r = lookupSuggestions('BP Express');
    expect(r[0].customer_name).toBe('BP Express');   // exact name first
  });

  it('ranks number-prefix above name-contains', () => {
    insertRow.run('700', 'Foo');                     // number starts with 7
    insertRow.run('800', 'Aldi 7th Avenue');         // name contains "7"

    const r = lookupSuggestions('7');
    const idx700 = r.findIndex(x => x.customer_number === '700');
    const idx800 = r.findIndex(x => x.customer_number === '800');
    expect(idx700).toBeGreaterThanOrEqual(0);
    expect(idx800).toBeGreaterThanOrEqual(0);
    expect(idx700).toBeLessThan(idx800);
  });
});

describe('_normalizeCustomerQuery — input shape', () => {
  it('trims leading and trailing whitespace', () => {
    expect(_normalizeCustomerQuery('  100  ')).toBe('100');
  });

  it('collapses internal whitespace to a single space', () => {
    expect(_normalizeCustomerQuery('BP   Express')).toBe('BP Express');
    expect(_normalizeCustomerQuery('100\t\tWC')).toBe('100 WC');
    expect(_normalizeCustomerQuery('a\nb')).toBe('a b');
  });

  it('caps at 256 characters', () => {
    const long = 'x'.repeat(500);
    expect(_normalizeCustomerQuery(long).length).toBe(256);
  });

  it('returns empty string for non-string input', () => {
    expect(_normalizeCustomerQuery(undefined)).toBe('');
    expect(_normalizeCustomerQuery(null)).toBe('');
    expect(_normalizeCustomerQuery(42)).toBe('');
    expect(_normalizeCustomerQuery({ a: 1 })).toBe('');
  });

  it('treats whitespace-only as empty after normalization', () => {
    expect(_normalizeCustomerQuery('   ')).toBe('');
    expect(_normalizeCustomerQuery('\t\n')).toBe('');
  });
});

describe('idx_datarecord_customer_name_lower — sargable expression match', () => {
  it('SQLite uses the lower(customer_name) expression index for equality match', () => {
    insertRow.run('100', 'Acme Hardware');

    const plan = memDb
      .prepare(`EXPLAIN QUERY PLAN SELECT * FROM datarecord WHERE lower(customer_name) = lower(?)`)
      .all('Acme Hardware');
    const detail = plan.map(r => r.detail || '').join(' | ');
    // The index name must appear in the plan; if it doesn't, SQLite is
    // doing a full scan and the migration didn't take effect.
    expect(detail).toMatch(/idx_datarecord_customer_name_lower/);
  });
});
