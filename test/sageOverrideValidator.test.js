// SEC-1 — the Sage SQL-override guardrail must keep an operator override
// read-only and single-statement even if the connecting Sage login is
// over-privileged. (The primary control is a least-privilege READ-ONLY Sage
// login; this validator is defense in depth.)

import { describe, it, expect, vi } from 'vitest';

// queryRegistry imports db at module load; readOnlyOverrideViolation itself is pure.
vi.mock('../src/db/index.js', () => ({ default: { prepare: vi.fn() } }));

import { readOnlyOverrideViolation } from '../src/services/sage/queryRegistry.js';
import { DEFAULT_JTI_SQL } from '../src/services/jti/jtiQuery.js';

describe('readOnlyOverrideViolation — SEC-1 bypass vectors are blocked', () => {
  const blocked = {
    'SELECT … INTO (table creation)': 'SELECT IDCUST, AMTDUEHC INTO evil FROM AROBL WHERE DATEINVC >= @from',
    'OPENROWSET (out-of-band read)': "SELECT * FROM OPENROWSET('SQLNCLI','Server=x;','SELECT 1') t WHERE x = @from",
    'OPENQUERY (linked server)': "SELECT * FROM OPENQUERY(srv,'SELECT 1') t WHERE x = @from",
    'BULK (file read)': "SELECT * FROM OPENROWSET(BULK 'c:\\x.dat', SINGLE_CLOB) z WHERE x = @from",
    'WAITFOR via a 2nd statement (time-based DoS)': "SELECT 1 FROM AROBL WHERE x = @from; WAITFOR DELAY '0:0:5'",
    'xp_cmdshell via a 2nd statement': "SELECT 1 FROM AROBL WHERE x = @from; EXEC xp_cmdshell 'dir'",
    'sp_ proc reference': 'SELECT 1 FROM AROBL WHERE sp_who2 = @from',
    'second ;-separated statement': 'SELECT 1 FROM AROBL WHERE x = @from; SELECT 2 FROM ARTBL',
    'not read-only (EXEC)': 'EXEC something @from',
    'leading ; then a write': '; DELETE FROM AROBL WHERE x = @from',
    // The -- lives inside a string literal, so it is NOT a comment to SQL Server;
    // a literal-unaware stripper would eat the real ;DROP and pass this.
    'literal-hidden second statement': "SELECT @from, '--'; DROP TABLE x",
    'literal-hidden block-comment write': "SELECT '/*' AS x, @from; DELETE FROM AROBL",
  };
  for (const [name, sql] of Object.entries(blocked)) {
    it(`blocks: ${name}`, () => {
      expect(readOnlyOverrideViolation(sql)).toBeTruthy();
    });
  }
});

describe('readOnlyOverrideViolation — legitimate queries pass', () => {
  const allowed = [
    'SELECT IDCUST, AMTDUEHC FROM AROBL WHERE DATEINVC >= @from',
    ';WITH cte AS (SELECT 1 AS a) SELECT a FROM cte',      // leading ; CTE
    'SELECT 1 FROM x;',                                     // trailing ; ok
    '-- header comment\nSELECT 1 FROM x',                  // leading line comment
    '/* block */ SELECT 1 FROM x',                         // leading block comment
    // A banned keyword INSIDE a comment is inert SQL and must NOT false-positive.
    'SELECT 1 /* DELETE FROM x */ FROM AROBL WHERE y = @from',
    // A "second statement" that is commented out is a single statement.
    'SELECT 1 FROM AROBL WHERE y = @from --; DROP TABLE x',
    // A ';' or '--' INSIDE a string literal is data — must not false-positive as
    // a second statement / comment now that the scrub is literal-aware.
    "SELECT 'a;b' AS marker FROM AROBL WHERE x = @from",
    "SELECT '-- not a comment' AS note FROM AROBL WHERE x = @from",
  ];
  for (const sql of allowed) {
    it(`allows: ${JSON.stringify(sql.slice(0, 30))}`, () => {
      expect(readOnlyOverrideViolation(sql)).toBeNull();
    });
  }

  it('empty / null is acceptable (clear-to-default)', () => {
    expect(readOnlyOverrideViolation('')).toBeNull();
    expect(readOnlyOverrideViolation(null)).toBeNull();
  });

  it('the JTI default query stays valid under the hardened rules', () => {
    expect(readOnlyOverrideViolation(DEFAULT_JTI_SQL)).toBeNull();
  });
});
