// Tests for src/hub/siteBackupDir.js — readable hub backup folder names and
// the one-time migration of legacy token-named folders.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { siteBackupDirName, reconcileHubBackupDirs } from '../src/hub/siteBackupDir.js';

describe('siteBackupDirName', () => {
  it('uses the site name when present', () => {
    expect(siteBackupDirName({ id: 'a1b2c3', name: 'Ermelo' })).toBe('Ermelo');
  });

  it('replaces spaces and unsafe chars with underscores', () => {
    expect(siteBackupDirName({ id: 'x', name: 'Cardoso Ermelo' })).toBe('Cardoso_Ermelo');
    expect(siteBackupDirName({ id: 'x', name: 'JHB / Depot #2' })).toBe('JHB_Depot_2');
  });

  it('falls back to slug, then id', () => {
    expect(siteBackupDirName({ id: 'tok123', slug: 'ermelo-north' })).toBe('ermelo-north');
    expect(siteBackupDirName({ id: 'tok123' })).toBe('tok123');
  });

  it('falls back to id when the name sanitises to empty', () => {
    expect(siteBackupDirName({ id: 'tok123', name: '///' })).toBe('tok123');
  });

  it('caps length at 64 chars', () => {
    const long = 'A'.repeat(200);
    expect(siteBackupDirName({ id: 'x', name: long }).length).toBe(64);
  });
});

describe('reconcileHubBackupDirs', () => {
  let baseDir;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardoso-hubdirs-'));
  });

  afterAll(() => {
    // best-effort cleanup of any leftover temp roots
  });

  function seedDir(name, files = []) {
    const d = path.join(baseDir, name);
    fs.mkdirSync(d, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(d, f), 'x');
    return d;
  }

  it('renames a legacy id folder to the readable name folder', () => {
    seedDir('tok-abc', ['cardoso-tok-abc-2026-06-29.db']);
    const r = reconcileHubBackupDirs(baseDir, [{ id: 'tok-abc', name: 'Ermelo' }]);
    expect(r.renamed).toBe(1);
    expect(fs.existsSync(path.join(baseDir, 'Ermelo', 'cardoso-tok-abc-2026-06-29.db'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'tok-abc'))).toBe(false);
  });

  it('merges into an existing name folder without clobbering', () => {
    seedDir('tok-abc', ['old.db']);
    seedDir('Ermelo', ['existing.db']);
    const r = reconcileHubBackupDirs(baseDir, [{ id: 'tok-abc', name: 'Ermelo' }]);
    expect(r.merged).toBe(1);
    expect(fs.existsSync(path.join(baseDir, 'Ermelo', 'old.db'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'Ermelo', 'existing.db'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'tok-abc'))).toBe(false);
  });

  it('is a no-op when the id folder does not exist', () => {
    const r = reconcileHubBackupDirs(baseDir, [{ id: 'tok-abc', name: 'Ermelo' }]);
    expect(r).toEqual({ renamed: 0, merged: 0 });
  });

  it('is a no-op when name resolves to the id (nothing to rename)', () => {
    seedDir('tok-abc', ['a.db']);
    const r = reconcileHubBackupDirs(baseDir, [{ id: 'tok-abc' }]); // no name/slug → dirName === id
    expect(r).toEqual({ renamed: 0, merged: 0 });
    expect(fs.existsSync(path.join(baseDir, 'tok-abc', 'a.db'))).toBe(true);
  });

  it('does not clobber a file that already exists in the target', () => {
    seedDir('tok-abc', ['dup.db']);
    seedDir('Ermelo', ['dup.db']);
    fs.writeFileSync(path.join(baseDir, 'Ermelo', 'dup.db'), 'keep-me');
    reconcileHubBackupDirs(baseDir, [{ id: 'tok-abc', name: 'Ermelo' }]);
    // Target file preserved; legacy dir kept (still holds the un-moved dup).
    expect(fs.readFileSync(path.join(baseDir, 'Ermelo', 'dup.db'), 'utf8')).toBe('keep-me');
  });
});
