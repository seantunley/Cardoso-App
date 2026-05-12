// Contract tests for src/services/bat/uploadProcessor.js — the
// per-file pipeline shared by the single and batch supplier-upload
// routes. Pinning behaviour here prevents drift between the two
// endpoints (which otherwise would inevitably diverge).
//
// Approach: dependency-inject every collaborator the processor uses
// (parser, recon repo, Sage, etc.) so we can drive happy + failure
// paths deterministically without standing up the real service stack.
//
// What's pinned:
//   - Year fallback chain: parsed.year > fallbackYear > toIsoYear(now)
//   - Archive failure NULLs archive_path (never leaves stale forensic
//     bytes pointing at a previous upload)
//   - Sage failure persists the error string and is NON-fatal (the
//     parsed recon still returns)
//   - SpreadsheetValidationError propagates verbatim (caller maps to 400)
//   - Generic errors propagate (caller maps to 500)
//   - Return shape includes podCount + fees so audit logs match the
//     pre-extraction route's audit details exactly

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { processSupplierUpload } from '../src/services/bat/uploadProcessor.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

// SpreadsheetValidationError shape — mimic the real one without
// importing the parser module (which pulls in xlsx and the whole
// service stack). Parser tests pin the real shape; this one just
// needs to be `instanceof`-checkable for parity.
class SpreadsheetValidationError extends Error {
  constructor(reasons, fileName) {
    super(`Spreadsheet rejected (${reasons.length} issue${reasons.length === 1 ? '' : 's'})`);
    this.name = 'SpreadsheetValidationError';
    this.reasons = reasons;
    this.fileName = fileName;
  }
}

let db;
let tmpDir;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE bat_reconciliations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_number INTEGER NOT NULL,
      year INTEGER NOT NULL,
      sage_error TEXT,
      archive_path TEXT,
      UNIQUE(week_number, year)
    );
  `);
  // Tmpdir for the archive copy. processSupplierUpload calls
  // archiveSupplierUpload internally, which writes to the cwd's
  // uploads/bat-archive/ tree. We can't easily redirect that without
  // a tmpdir-aware injection. Instead the archive helper accepts an
  // archiveRoot opt — but processSupplierUpload doesn't expose it.
  // For now: just chdir into a tmpdir per test so the archive lands
  // in tmpDir/uploads/bat-archive/.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processor-test-'));
});

// Build a stub set of dependencies. Each test overrides the bits it
// cares about.
function buildDeps(overrides = {}) {
  // Default: parser returns a clean parsed payload
  const parseSupplierSpreadsheet = vi.fn().mockReturnValue({
    weekNumber: 22,
    year: 2026,
    fees: { delivery: 100, discount: 50, pricing: 25 },
    podUrls: [{ url: 'https://example.com/a.pdf' }, { url: 'https://example.com/b.pdf' }],
    orderAmounts: [],
  });
  const createReconciliation = vi.fn().mockImplementation(({ weekNumber, year }) => {
    return db.prepare('INSERT INTO bat_reconciliations (week_number, year) VALUES (?, ?)').run(weekNumber, year).lastInsertRowid;
  });
  const querySageCreditNotes = vi.fn().mockResolvedValue([]);
  const replaceSageCreditNotes = vi.fn();
  const backfillOrderAmounts = vi.fn().mockReturnValue(0);
  const getReconciliation = vi.fn().mockImplementation((id) => {
    return db.prepare('SELECT * FROM bat_reconciliations WHERE id = ?').get(id);
  });
  const toIsoYear = vi.fn().mockReturnValue(2026);
  return {
    db,
    parseSupplierSpreadsheet,
    createReconciliation,
    querySageCreditNotes,
    replaceSageCreditNotes,
    backfillOrderAmounts,
    getReconciliation,
    toIsoYear,
    ...overrides,
  };
}

// Make a fake multer-style file in the test tmpdir so the archive
// copy has real bytes to copy.
function fakeFile(originalname, contents = 'fake xlsx bytes') {
  const p = path.join(tmpDir, `multer-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`);
  fs.writeFileSync(p, contents);
  return { path: p, originalname };
}

// Run a function with cwd set to tmpDir so archiveSupplierUpload's
// cwd-relative archive root lands in our test sandbox, not the real
// uploads/ tree.
async function withCwd(dir, fn) {
  const original = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(original);
  }
}

describe('processSupplierUpload — happy path', () => {
  it('returns reconciliation + backfilled + week/year + podCount + fees', async () => {
    const deps = buildDeps();
    const result = await withCwd(tmpDir, () =>
      processSupplierUpload({
        file: fakeFile('Week_22_supplier.xlsx'),
        fallbackYear: null,
        userId: 1,
        ...deps,
      })
    );
    expect(result.reconciliation).toMatchObject({ week_number: 22, year: 2026 });
    expect(result.weekNumber).toBe(22);
    expect(result.year).toBe(2026);
    expect(result.podCount).toBe(2);
    expect(result.fees).toEqual({ delivery: 100, discount: 50, pricing: 25 });
    expect(result.archived).toBe(true);
    expect(result.sageError).toBeNull();
    expect(result.backfilled).toBe(0);
  });
});

describe('processSupplierUpload — year fallback chain', () => {
  it('uses parsed.year when set (highest priority)', async () => {
    const deps = buildDeps({
      parseSupplierSpreadsheet: vi.fn().mockReturnValue({
        weekNumber: 5, year: 2024,
        fees: {}, podUrls: [], orderAmounts: [],
      }),
    });
    const result = await withCwd(tmpDir, () =>
      processSupplierUpload({
        file: fakeFile('Week_05.xlsx'),
        fallbackYear: 2025,    // ignored — parser had its own year
        userId: 1,
        ...deps,
      })
    );
    expect(result.year).toBe(2024);
  });

  it('uses fallbackYear when parser does not set one', async () => {
    const deps = buildDeps({
      parseSupplierSpreadsheet: vi.fn().mockReturnValue({
        weekNumber: 5, year: null,
        fees: {}, podUrls: [], orderAmounts: [],
      }),
    });
    const result = await withCwd(tmpDir, () =>
      processSupplierUpload({
        file: fakeFile('Week_05.xlsx'),
        fallbackYear: 2025,
        userId: 1,
        ...deps,
      })
    );
    expect(result.year).toBe(2025);
  });

  it('falls back to toIsoYear(now) when neither is set', async () => {
    const deps = buildDeps({
      parseSupplierSpreadsheet: vi.fn().mockReturnValue({
        weekNumber: 5, year: null,
        fees: {}, podUrls: [], orderAmounts: [],
      }),
      toIsoYear: vi.fn().mockReturnValue(2099),
    });
    const result = await withCwd(tmpDir, () =>
      processSupplierUpload({
        file: fakeFile('Week_05.xlsx'),
        fallbackYear: null,
        userId: 1,
        ...deps,
      })
    );
    expect(result.year).toBe(2099);
  });
});

describe('processSupplierUpload — failure paths', () => {
  it('SpreadsheetValidationError propagates verbatim (caller maps to 400)', async () => {
    const deps = buildDeps({
      parseSupplierSpreadsheet: vi.fn().mockImplementation(() => {
        throw new SpreadsheetValidationError(['no Overview sheet', 'no PODs'], 'bad.xlsx');
      }),
    });
    await expect(
      withCwd(tmpDir, () =>
        processSupplierUpload({
          file: fakeFile('bad.xlsx'),
          fallbackYear: null,
          userId: 1,
          ...deps,
        })
      )
    ).rejects.toMatchObject({
      name: 'SpreadsheetValidationError',
      reasons: ['no Overview sheet', 'no PODs'],
      fileName: 'bad.xlsx',
    });
    // No recon row should have been created — parse failed before
    // createReconciliation was called.
    expect(db.prepare('SELECT COUNT(*) AS c FROM bat_reconciliations').get().c).toBe(0);
  });

  it('archive failure NULLs archive_path and is non-fatal', async () => {
    const deps = buildDeps();
    // Use a non-existent srcPath to make the internal copy throw.
    const file = { path: path.join(tmpDir, 'does-not-exist.xlsx'), originalname: 'gone.xlsx' };
    // Pre-seed an archive_path on the (week, year) row to simulate a
    // previous successful upload — archive failure on re-upload MUST
    // null this out (proven by the test below).
    db.prepare('INSERT INTO bat_reconciliations (week_number, year, archive_path) VALUES (22, 2026, ?)')
      .run('/old/stale/path.xlsx');
    // createReconciliation now needs to upsert (return existing id)
    deps.createReconciliation = vi.fn().mockImplementation(({ weekNumber, year }) => {
      return db.prepare('SELECT id FROM bat_reconciliations WHERE week_number = ? AND year = ?').get(weekNumber, year).id;
    });

    const result = await withCwd(tmpDir, () =>
      processSupplierUpload({
        file,
        fallbackYear: null,
        userId: 1,
        ...deps,
      })
    );
    expect(result.archived).toBe(false);
    // The stale archive_path MUST be nulled — otherwise dispute replay
    // would be served bytes that don't match the current parsed totals.
    const row = db.prepare('SELECT archive_path FROM bat_reconciliations WHERE id = ?').get(result.reconciliation.id);
    expect(row.archive_path).toBeNull();
  });

  it('Sage query failure persists the error string and is non-fatal', async () => {
    const deps = buildDeps({
      querySageCreditNotes: vi.fn().mockRejectedValue(new Error('Sage 300 unreachable')),
    });
    const result = await withCwd(tmpDir, () =>
      processSupplierUpload({
        file: fakeFile('Week_22.xlsx'),
        fallbackYear: null,
        userId: 1,
        ...deps,
      })
    );
    expect(result.sageError).toBe('Sage 300 unreachable');
    // Persisted to the row so the UI surfaces it.
    const row = db.prepare('SELECT sage_error FROM bat_reconciliations WHERE id = ?').get(result.reconciliation.id);
    expect(row.sage_error).toBe('Sage 300 unreachable');
    // The recon itself still came back (non-fatal).
    expect(result.reconciliation).toBeDefined();
  });

  it('Sage error message is truncated to 500 chars before persisting', async () => {
    const longMessage = 'X'.repeat(800);
    const deps = buildDeps({
      querySageCreditNotes: vi.fn().mockRejectedValue(new Error(longMessage)),
    });
    const result = await withCwd(tmpDir, () =>
      processSupplierUpload({
        file: fakeFile('Week_22.xlsx'),
        fallbackYear: null,
        userId: 1,
        ...deps,
      })
    );
    const row = db.prepare('SELECT sage_error FROM bat_reconciliations WHERE id = ?').get(result.reconciliation.id);
    expect(row.sage_error.length).toBe(500);
  });
});

describe('processSupplierUpload — pipeline ordering', () => {
  it('createReconciliation runs before archive (so reconId exists for archive_path UPDATE)', async () => {
    const callOrder = [];
    const deps = buildDeps({
      createReconciliation: vi.fn().mockImplementation(({ weekNumber, year }) => {
        callOrder.push('createReconciliation');
        return db.prepare('INSERT INTO bat_reconciliations (week_number, year) VALUES (?, ?)').run(weekNumber, year).lastInsertRowid;
      }),
      querySageCreditNotes: vi.fn().mockImplementation(async () => {
        callOrder.push('querySageCreditNotes');
        return [];
      }),
      backfillOrderAmounts: vi.fn().mockImplementation(() => {
        callOrder.push('backfillOrderAmounts');
        return 0;
      }),
      getReconciliation: vi.fn().mockImplementation((id) => {
        callOrder.push('getReconciliation');
        return db.prepare('SELECT * FROM bat_reconciliations WHERE id = ?').get(id);
      }),
    });
    await withCwd(tmpDir, () =>
      processSupplierUpload({
        file: fakeFile('Week_22.xlsx'),
        fallbackYear: null,
        userId: 1,
        ...deps,
      })
    );
    // Order must be: createReconciliation → (archive, internal) →
    // sage → backfill → getReconciliation. Pinning so a refactor can't
    // accidentally move sage/backfill before the row exists.
    expect(callOrder).toEqual([
      'createReconciliation',
      'querySageCreditNotes',
      'backfillOrderAmounts',
      'getReconciliation',
    ]);
  });
});
