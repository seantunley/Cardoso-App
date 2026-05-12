// Unit tests for src/services/jti/jtiScheduler.js — drives the
// pure functions (previousMonth, generateAndArchivePeriod,
// runScheduledMonthlyJob, runBootCatchUp) directly with stub
// dependencies. No node-cron, no real Sage.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  previousMonth,
  generateAndArchivePeriod,
  runScheduledMonthlyJob,
  runBootCatchUp,
} from '../src/services/jti/jtiScheduler.js';
import { archiveJtiExport } from '../src/services/jti/jtiArchive.js';

let db;
let tmpRoot;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE jti_settings (
      key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now'))
    );
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
  // Pre-seed settings so the scheduler has site_label / address fields
  db.prepare(`INSERT INTO jti_settings (key, value) VALUES ('site_label', 'Ermelo')`).run();
  db.prepare(`INSERT INTO jti_settings (key, value) VALUES ('town_city', 'ERMELO')`).run();
  db.prepare(`INSERT INTO jti_settings (key, value) VALUES ('region', 'MPUMALANGA')`).run();
  db.prepare(`INSERT INTO jti_settings (key, value) VALUES ('country', 'SOUTH AFRICA')`).run();

  tmpRoot = path.join(os.tmpdir(), `jti-scheduler-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});

afterEach(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// Helper Sage pool stub that returns the supplied recordset.
function makeSagePool({ recordset = [], shouldThrow = null } = {}) {
  return async () => {
    if (shouldThrow) throw new Error(shouldThrow);
    return {
      request: () => ({
        input(_n, _v) { return this; },
        async query(_sql) { return { recordset }; },
      }),
    };
  };
}

const sageRow = {
  TRANNUM: 'IN000428009', TRANDATE: 20260401, ITEM: '87',
  DESC: '  CAMEL CLASSIC', CUSTOMER: '10', NAMECUST: 'LIQUOR CITY WHITERIVER', QTYSOLD: 2,
};

// Many of the scheduler functions call archiveJtiExport with no
// archiveRoot override → it writes to uploads/jti-archive. For tests
// we need to sandbox that. Easiest path: monkey-patch process.cwd()
// for the duration of each test? No — too fragile. Instead we let
// the scheduler call through and stub `archiveJtiExport` via vi.mock.
//
// Actually simpler: the scheduler imports archiveJtiExport from
// jtiArchive.js at module scope. We can use vi.mock to swap it.
// But vi.mock is hoisted and module-level, so we use `vi.mock` once
// at the top of the file. The mocked archive writes to tmpRoot.

vi.mock('../src/services/jti/jtiArchive.js', async () => {
  const actual = await vi.importActual('../src/services/jti/jtiArchive.js');
  return {
    ...actual,
    archiveJtiExport: (args) => actual.archiveJtiExport({
      ...args,
      // tmpRoot is closed-over from the test scope — but we need it
      // to be re-evaluated per-test. The wrapper here picks it up
      // freshly each call.
      archiveRoot: globalThis.__JTI_TEST_ROOT__,
    }),
  };
});

beforeEach(() => {
  globalThis.__JTI_TEST_ROOT__ = tmpRoot;
});

describe('previousMonth', () => {
  it('returns Dec of previous year for a Jan date', () => {
    expect(previousMonth(new Date(2026, 0, 1))).toEqual({ year: 2025, month: 12 });
    expect(previousMonth(new Date(2026, 0, 31))).toEqual({ year: 2025, month: 12 });
  });
  it('returns prior month for any other month', () => {
    expect(previousMonth(new Date(2026, 4, 1))).toEqual({ year: 2026, month: 4 });
    expect(previousMonth(new Date(2026, 11, 31))).toEqual({ year: 2026, month: 11 });
  });
});

describe('generateAndArchivePeriod', () => {
  it('archives a period with source=scheduled and generated_by=system:scheduled', async () => {
    const result = await generateAndArchivePeriod({
      db,
      getSagePool: makeSagePool({ recordset: [sageRow] }),
      year: 2026, month: 4,
    });
    expect(result.status).toBe('archived');
    expect(result.rowCount).toBe(1);
    expect(result.archiveId).toBeTypeOf('number');

    const row = db.prepare(`SELECT * FROM jti_archive WHERE id = ?`).get(result.archiveId);
    expect(row.source).toBe('scheduled');
    expect(row.generated_by).toBe('system:scheduled');
    expect(row.period_year).toBe(2026);
    expect(row.period_month).toBe(4);
    expect(row.town_city).toBe('ERMELO');
    expect(row.site_label).toBe('Ermelo');
    expect(fs.existsSync(row.file_path)).toBe(true);
  });

  it('skips with reason "already_archived" when a scheduled row already exists for the period', async () => {
    // Pre-seed a scheduled row for 2026-04
    archiveJtiExport({
      db,
      archiveRoot: tmpRoot,
      archive: {
        buffer: Buffer.from('prev'),
        filename: 'JTI_Cardoso_Sales_Ermelo_20260430.xlsx',
        periodYear: 2026, periodMonth: 4, source: 'scheduled',
        generatedBy: 'system:scheduled', rowCount: 1,
      },
    });
    const result = await generateAndArchivePeriod({
      db, getSagePool: makeSagePool({ recordset: [sageRow] }),
      year: 2026, month: 4,
    });
    expect(result).toEqual({ status: 'skipped', reason: 'already_archived' });
    // No second row was inserted
    expect(db.prepare(`SELECT COUNT(*) AS n FROM jti_archive`).get().n).toBe(1);
  });

  it('skips with reason "pool_unavailable" when getSagePool throws', async () => {
    const result = await generateAndArchivePeriod({
      db,
      getSagePool: makeSagePool({ shouldThrow: 'No connection assigned to JTI export' }),
      year: 2026, month: 4,
    });
    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/pool_unavailable/);
    expect(result.reason).toMatch(/No connection assigned/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM jti_archive`).get().n).toBe(0);
  });

  it('does NOT skip when only a manual row exists for the period — scheduled is still produced', async () => {
    archiveJtiExport({
      db, archiveRoot: tmpRoot,
      archive: {
        buffer: Buffer.from('manual'),
        filename: 'JTI_Cardoso_Sales_Ermelo_20260430.xlsx',
        periodYear: 2026, periodMonth: 4, source: 'manual',
        generatedBy: 'op@example.com', rowCount: 1,
      },
    });
    const result = await generateAndArchivePeriod({
      db, getSagePool: makeSagePool({ recordset: [sageRow] }),
      year: 2026, month: 4,
    });
    expect(result.status).toBe('archived');
    // Now both rows live in the same period
    const rows = db.prepare(`SELECT source FROM jti_archive WHERE period_year = 2026 AND period_month = 4 ORDER BY id`).all();
    expect(rows.map(r => r.source)).toEqual(['manual', 'scheduled']);
  });

  it('uses the right Date range for the period (1st .. last day inclusive)', async () => {
    const capturedInputs = {};
    const captureGetSagePool = async () => ({
      request: () => ({
        input(name, value) { capturedInputs[name] = value; return this; },
        async query() { return { recordset: [] }; },
      }),
    });
    await generateAndArchivePeriod({
      db, getSagePool: captureGetSagePool,
      year: 2026, month: 2, // Feb 2026 is non-leap → 28 days
    });
    expect(capturedInputs.from).toBe(20260201);
    expect(capturedInputs.to).toBe(20260228);
  });

  it('handles leap-year February correctly (29 days)', async () => {
    const capturedInputs = {};
    const captureGetSagePool = async () => ({
      request: () => ({
        input(name, value) { capturedInputs[name] = value; return this; },
        async query() { return { recordset: [] }; },
      }),
    });
    await generateAndArchivePeriod({
      db, getSagePool: captureGetSagePool,
      year: 2024, month: 2, // 2024 is a leap year
    });
    expect(capturedInputs.from).toBe(20240201);
    expect(capturedInputs.to).toBe(20240229);
  });
});

describe('runScheduledMonthlyJob', () => {
  it('targets the previous calendar month', async () => {
    const now = new Date(2026, 4, 1, 2, 0, 0); // 1st May 2026, 02:00
    const result = await runScheduledMonthlyJob({
      db, getSagePool: makeSagePool({ recordset: [sageRow] }), now,
    });
    expect(result.period).toEqual({ year: 2026, month: 4 });
    expect(result.status).toBe('archived');
  });

  it('handles a January 1st run (targets December of previous year)', async () => {
    const now = new Date(2027, 0, 1, 2, 0, 0);
    const result = await runScheduledMonthlyJob({
      db, getSagePool: makeSagePool({ recordset: [sageRow] }), now,
    });
    expect(result.period).toEqual({ year: 2026, month: 12 });
    expect(result.status).toBe('archived');
  });
});

describe('runBootCatchUp', () => {
  it('returns no-op when every period in the window is already archived', async () => {
    const now = new Date(2026, 4, 1);
    // Pre-seed all 12 months back from prev-month (2026-04 .. 2025-05)
    for (let i = 0; i < 12; i++) {
      const d = new Date(2026, 3 - i, 1);
      archiveJtiExport({
        db, archiveRoot: tmpRoot,
        archive: {
          buffer: Buffer.from(`m${i}`),
          filename: `JTI_${d.getFullYear()}_${d.getMonth() + 1}.xlsx`,
          periodYear: d.getFullYear(), periodMonth: d.getMonth() + 1,
          source: 'scheduled', generatedBy: 'system:scheduled', rowCount: 1,
        },
      });
    }
    const result = await runBootCatchUp({
      db, getSagePool: makeSagePool({ recordset: [sageRow] }), now, monthsBack: 12,
    });
    expect(result.archived).toEqual([]);
    expect(result.skipped).toHaveLength(12);
    expect(result.failed).toBeNull();
  });

  it('archives all 12 missing months in chronological order (oldest first)', async () => {
    const now = new Date(2026, 4, 1);
    const result = await runBootCatchUp({
      db, getSagePool: makeSagePool({ recordset: [sageRow] }), now, monthsBack: 12,
    });
    expect(result.archived).toHaveLength(12);
    // Oldest first: 2025-05, 2025-06, ..., 2026-04
    expect(result.archived[0]).toMatchObject({ year: 2025, month: 5 });
    expect(result.archived[11]).toMatchObject({ year: 2026, month: 4 });
  });

  it('archives only the missing months when some exist', async () => {
    const now = new Date(2026, 4, 1);
    // Pre-seed 2026-02 only
    archiveJtiExport({
      db, archiveRoot: tmpRoot,
      archive: {
        buffer: Buffer.from('feb'),
        filename: 'feb.xlsx',
        periodYear: 2026, periodMonth: 2,
        source: 'scheduled', generatedBy: 'system:scheduled', rowCount: 1,
      },
    });
    const result = await runBootCatchUp({
      db, getSagePool: makeSagePool({ recordset: [sageRow] }), now, monthsBack: 6,
    });
    // Periods walked: 2025-11, 2025-12, 2026-01, 2026-02 (skip), 2026-03, 2026-04
    expect(result.archived.map(a => `${a.year}-${a.month}`)).toEqual([
      '2025-11', '2025-12', '2026-1', '2026-3', '2026-4',
    ]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ year: 2026, month: 2, reason: 'already_archived' });
  });

  it('bails out when the Sage pool is unavailable rather than spamming the log', async () => {
    const now = new Date(2026, 4, 1);
    const result = await runBootCatchUp({
      db,
      getSagePool: makeSagePool({ shouldThrow: 'No connection assigned to JTI export' }),
      now,
      monthsBack: 6,
    });
    expect(result.archived).toEqual([]);
    // Failed on the first (oldest) period
    expect(result.failed).toMatchObject({ year: 2025, month: 11 });
    expect(result.failed.error).toMatch(/pool_unavailable/);
  });

  it('bails out (returns partial) on the first hard query error', async () => {
    const now = new Date(2026, 4, 1);
    let callCount = 0;
    const flakeyPool = async () => {
      callCount++;
      if (callCount === 3) {
        // Third call (third period) throws
        return {
          request: () => ({
            input() { return this; },
            async query() { throw new Error('Sage timed out'); },
          }),
        };
      }
      return {
        request: () => ({
          input() { return this; },
          async query() { return { recordset: [sageRow] }; },
        }),
      };
    };
    const result = await runBootCatchUp({
      db, getSagePool: flakeyPool, now, monthsBack: 6,
    });
    // First two archived ok, third failed
    expect(result.archived).toHaveLength(2);
    expect(result.failed).toBeTruthy();
    expect(result.failed.error).toMatch(/Sage timed out/);
  });
});
