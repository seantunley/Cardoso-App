// A local backup only gets its real name once it's complete, and the verify
// worker fails a backup that's missing a critical table
// (src/lib/backupWrite.js, src/lib/backupVerifyWorker.js).

import { it, expect, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Worker } from 'worker_threads';
import { writeBackupFile, removeStalePartials } from '../src/lib/backupWrite.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-write-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const makeDb = (file, tables) => {
  const db = new Database(file);
  for (const t of tables) db.exec(`CREATE TABLE "${t}" (id INTEGER PRIMARY KEY); INSERT INTO "${t}" DEFAULT VALUES;`);
  return db;
};

it('a finished backup gets the real name and leaves no .partial', async () => {
  const db = makeDb(path.join(dir, 'live.db'), ['datarecord']);
  const dest = path.join(dir, 'cardoso-site-2026-11-09T02-00-00.db');
  const size = await writeBackupFile(db, dest);
  db.close();
  expect(size).toBeGreaterThan(0);
  expect(fs.existsSync(dest)).toBe(true);
  expect(fs.existsSync(`${dest}.partial`)).toBe(false);
});

it('a backup cut off part-way never appears under the real name', async () => {
  const dest = path.join(dir, 'cardoso-site-2026-11-10T02-00-00.db');
  const cutOff = { backup: async (to) => { fs.writeFileSync(to, 'half a database'); throw new Error('service stopping'); } };
  await expect(writeBackupFile(cutOff, dest)).rejects.toThrow('service stopping');
  expect(fs.existsSync(dest)).toBe(false);
  expect(fs.existsSync(`${dest}.partial`)).toBe(false);
});

it('removes old leftover .partial files but not one being written now', () => {
  const old = path.join(dir, 'old.db.partial');
  const fresh = path.join(dir, 'fresh.db.partial');
  fs.writeFileSync(old, 'x');
  fs.writeFileSync(fresh, 'x');
  const sevenHoursAgo = (Date.now() - 7 * 3_600_000) / 1000;
  fs.utimesSync(old, sevenHoursAgo, sevenHoursAgo);
  expect(removeStalePartials(dir)).toBe(1);
  expect(fs.existsSync(old)).toBe(false);
  expect(fs.existsSync(fresh)).toBe(true);
});

const verify = (filePath) => new Promise((resolve, reject) => {
  const w = new Worker(new URL('../src/lib/backupVerifyWorker.js', import.meta.url), { workerData: { filePath, criticalTables: ['datarecord', 'user'] } });
  w.once('message', resolve);
  w.once('error', reject);
});

it('verify fails a backup that is missing a critical table, passes a complete one', async () => {
  const good = path.join(dir, 'good.db');
  const bad = path.join(dir, 'bad.db');
  makeDb(good, ['datarecord', 'user']).close();
  makeDb(bad, ['datarecord']).close();
  expect(await verify(good)).toMatchObject({ ok: true, counts: { datarecord: 1, user: 1 } });
  const res = await verify(bad);
  expect(res).toMatchObject({ ok: false, reason: 'critical_table_missing' });
  expect(res.error).toMatch(/user/);
});
