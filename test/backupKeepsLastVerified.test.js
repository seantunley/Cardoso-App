// The newest backup that passed verification must survive any run of bad
// backups, even after job_runs has forgotten the verification (it's pruned at
// 30 days). Drives the real runLocalBackup + verifyLatestBackup over 40
// simulated days in which every new backup is corrupt and fails verification.

import { it, expect, vi, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-keep-'));
const dbFile = path.join(dir, 'cardoso.db');
const backupDir = path.join(dir, 'backups');
const fileDb = new Database(dbFile);
fileDb.function('now_local', () => new Date().toISOString());
vi.mock('../src/db/index.js', () => ({ default: fileDb, dbPath: dbFile }));

let runLocalBackup, verifyLatestBackup;
beforeAll(async () => {
  delete process.env.HUB_MODE;
  delete process.env.BACKUP_KEEP_DAYS;
  (await import('../src/db/batSchema.js')).initBatSchema(fileDb);
  (await import('../src/db/schema.js')).initSchema(fileDb);
  (await import('../src/db/migrations.js')).runMigrations(fileDb);
  ({ runLocalBackup, verifyLatestBackup } = await import('../src/scheduler.js'));
  vi.useFakeTimers({ toFake: ['Date'] }); // real timers: the verify worker must still run
});
afterAll(() => { vi.useRealTimers(); fileDb.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const DAY = 86_400_000;
const START = Date.parse('2026-09-01T02:00:00+02:00');
const newestBackup = () => fs.readdirSync(backupDir).filter((f) => f.endsWith('.db'))
  .map((f) => ({ f, m: fs.statSync(path.join(backupDir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0].f;
// The backup's mtime is real wall-clock time; set it to the simulated day.
const ageTo = (f, ms) => fs.utimesSync(path.join(backupDir, f), ms / 1000, ms / 1000);

it('keeps the last good backup through 40 days of failed verification', async () => {
  vi.setSystemTime(START);
  await runLocalBackup();
  const good = newestBackup();
  ageTo(good, START);
  expect((await verifyLatestBackup()).ok).toBe(true);

  fileDb.exec("DELETE FROM job_runs"); // the verification has dropped out of job_runs history

  for (let d = 1; d <= 40; d++) {
    const now = START + d * DAY;
    vi.setSystemTime(now);
    await runLocalBackup();
    const bad = newestBackup();
    fs.writeFileSync(path.join(backupDir, bad), 'not a database'); // corrupt, like a damaged disk
    ageTo(bad, now);
    expect((await verifyLatestBackup()).ok).toBe(false);
  }

  const left = fs.readdirSync(backupDir).filter((f) => f.endsWith('.db'));
  expect(left).toContain(good);
  // Pruning still works around it: the good one plus the last 3 days (+ today's), not 41 files.
  expect(left.length).toBeLessThanOrEqual(5);
  const kept = new Database(path.join(backupDir, good), { readonly: true });
  expect(kept.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
  kept.close();
}, 120_000);
