// Tests for src/lib/backupHealth.js — the request-time, artifact-based backup
// health verdict. Uses a real temp directory for the backup FILES (the whole
// point of the helper is that it trusts the disk, not the job ledger) plus an
// in-memory SQLite for the backup-verify job_runs rows.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cardoso-bh-'));
const dbFile = path.join(tmpRoot, 'cardoso.db');
const backupDir = path.join(tmpRoot, 'backups');

// A small real file standing in for the live DB, so db_bytes resolves.
fs.writeFileSync(dbFile, Buffer.alloc(1024, 7));

const memDb = new Database(':memory:');
memDb.exec(`
  CREATE TABLE job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_ms INTEGER,
    error_message TEXT,
    context TEXT
  );
`);

vi.mock('../src/db/index.js', () => ({ default: memDb, dbPath: dbFile }));

const { computeBackupHealth } = await import('../src/lib/backupHealth.js');

const HOUR = 3_600_000;

function writeBackup(name, bytes, ageHours) {
  fs.mkdirSync(backupDir, { recursive: true });
  const full = path.join(backupDir, name);
  fs.writeFileSync(full, Buffer.alloc(bytes, 1));
  const t = new Date(Date.now() - ageHours * HOUR);
  fs.utimesSync(full, t, t);
}

function seedVerify(status, ageHours, error = null) {
  const iso = new Date(Date.now() - ageHours * HOUR).toISOString();
  memDb.prepare(`
    INSERT INTO job_runs (name, status, started_at, ended_at, error_message)
    VALUES ('backup-verify', ?, ?, ?, ?)
  `).run(status, iso, iso, error);
}

beforeEach(() => {
  fs.rmSync(backupDir, { recursive: true, force: true });
  memDb.prepare('DELETE FROM job_runs').run();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('computeBackupHealth — primary (artifact) signals', () => {
  it('critical / no_backups when the backups dir is missing', () => {
    const h = computeBackupHealth();
    expect(h.status).toBe('critical');
    expect(h.reason).toBe('no_backups');
    expect(h.total_backups).toBe(0);
  });

  it('critical / no_backups when the dir exists but is empty', () => {
    fs.mkdirSync(backupDir, { recursive: true });
    const h = computeBackupHealth();
    expect(h.status).toBe('critical');
    expect(h.reason).toBe('no_backups');
  });

  it('critical / latest_empty when the newest backup is 0 bytes', () => {
    writeBackup('cardoso-site-2026-06-29.db', 0, 1);
    const h = computeBackupHealth();
    expect(h.status).toBe('critical');
    expect(h.reason).toBe('latest_empty');
  });

  it('critical / stale when the newest backup is older than 26h', () => {
    writeBackup('cardoso-site-old.db', 4096, 30);
    seedVerify('succeeded', 30); // even a recent-ish verify cannot save a stale file
    const h = computeBackupHealth();
    expect(h.status).toBe('critical');
    expect(h.reason).toBe('stale');
    expect(h.age_hours).toBeGreaterThan(26);
  });

  it('critical / stale_critical for a multi-day-old backup', () => {
    writeBackup('cardoso-site-ancient.db', 4096, 60);
    const h = computeBackupHealth();
    expect(h.status).toBe('critical');
    expect(h.reason).toBe('stale_critical');
    expect(h.message).toMatch(/day/);
  });

  it('picks the NEWEST file as latest, ignoring older ones', () => {
    writeBackup('cardoso-site-older.db', 4096, 40);
    writeBackup('cardoso-site-newer.db', 8192, 2);
    seedVerify('succeeded', 2);
    const h = computeBackupHealth();
    expect(h.file).toBe('cardoso-site-newer.db');
    expect(h.total_backups).toBe(2);
    expect(h.status).toBe('ok');
  });
});

describe('computeBackupHealth — secondary (verification) signals', () => {
  it('ok when a fresh backup was verified successfully and recently', () => {
    writeBackup('cardoso-site-fresh.db', 4096, 2);
    seedVerify('succeeded', 1);
    const h = computeBackupHealth();
    expect(h.status).toBe('ok');
    expect(h.reason).toBe('ok');
    expect(h.verify.status).toBe('succeeded');
  });

  it('warn / unverified when a fresh backup has no verification row', () => {
    writeBackup('cardoso-site-fresh.db', 4096, 2);
    const h = computeBackupHealth();
    expect(h.status).toBe('warn');
    expect(h.reason).toBe('unverified');
  });

  it('warn / unverified when the last successful verify is stale (>50h)', () => {
    writeBackup('cardoso-site-fresh.db', 4096, 2);
    seedVerify('succeeded', 60);
    const h = computeBackupHealth();
    expect(h.status).toBe('warn');
    expect(h.reason).toBe('unverified');
  });

  it('critical / verify_failed when a fresh backup failed integrity check', () => {
    writeBackup('cardoso-site-fresh.db', 4096, 2);
    seedVerify('failed', 1, 'integrity_check_failed');
    const h = computeBackupHealth();
    expect(h.status).toBe('critical');
    expect(h.reason).toBe('verify_failed');
    expect(h.message).toMatch(/integrity_check_failed/);
  });
});
