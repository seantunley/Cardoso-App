// Tests for src/hub/siteBackupDir.js — unique, readable hub backup folder
// names; the resolver every read/write path shares; and the one-time migration
// of legacy token-named folders.

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  siteBackupDirName,
  resolveSiteBackupDir,
  reconcileHubBackupDirs,
} from '../src/hub/siteBackupDir.js';

describe('siteBackupDirName', () => {
  it('is <name>-<id> when a name is present', () => {
    expect(siteBackupDirName({ id: 'a1b2c3', name: 'Ermelo' })).toBe('Ermelo-a1b2c3');
  });

  it('replaces spaces and unsafe chars in the name (id kept as suffix)', () => {
    expect(siteBackupDirName({ id: 'x', name: 'Cardoso Ermelo' })).toBe('Cardoso_Ermelo-x');
    expect(siteBackupDirName({ id: 'x', name: 'JHB / Depot #2' })).toBe('JHB_Depot_2-x');
  });

  it('falls back to slug, then bare id', () => {
    expect(siteBackupDirName({ id: 'tok123', slug: 'ermelo-north' })).toBe('ermelo-north-tok123');
    expect(siteBackupDirName({ id: 'tok123' })).toBe('tok123');
  });

  it('uses the bare id when the name sanitises to empty', () => {
    expect(siteBackupDirName({ id: 'tok123', name: '///' })).toBe('tok123');
  });

  it('caps the name prefix but always keeps the unique id suffix', () => {
    const dir = siteBackupDirName({ id: 'tok123', name: 'A'.repeat(200) });
    expect(dir).toBe(`${'A'.repeat(48)}-tok123`);
  });

  // The bug this guards: a name-only folder is not unique.
  it('gives colliding sanitised names DIFFERENT folders (uniqueness)', () => {
    const a = siteBackupDirName({ id: 'id1', name: 'A/B' });   // -> A_B-id1
    const b = siteBackupDirName({ id: 'id2', name: 'A_B' });   // -> A_B-id2
    expect(a).not.toBe(b);
    expect(a).toBe('A_B-id1');
    expect(b).toBe('A_B-id2');
  });
});

describe('resolveSiteBackupDir', () => {
  let baseDir;
  beforeEach(() => { baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardoso-resolve-')); });

  it('returns the readable folder when it exists', () => {
    const site = { id: 'tok', name: 'Ermelo' };
    fs.mkdirSync(path.join(baseDir, 'Ermelo-tok'));
    expect(resolveSiteBackupDir(baseDir, site)).toBe(path.join(baseDir, 'Ermelo-tok'));
  });

  it('falls back to the legacy id folder pre-migration', () => {
    const site = { id: 'tok', name: 'Ermelo' };
    fs.mkdirSync(path.join(baseDir, 'tok'));
    expect(resolveSiteBackupDir(baseDir, site)).toBe(path.join(baseDir, 'tok'));
  });

  it('defaults to the readable folder when neither exists (new pull target)', () => {
    const site = { id: 'tok', name: 'Ermelo' };
    expect(resolveSiteBackupDir(baseDir, site)).toBe(path.join(baseDir, 'Ermelo-tok'));
  });
});

describe('reconcileHubBackupDirs', () => {
  let baseDir;
  beforeEach(() => { baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardoso-hubdirs-')); });

  function seedDir(name, files = []) {
    const d = path.join(baseDir, name);
    fs.mkdirSync(d, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(d, f), 'x');
    return d;
  }

  it('renames a legacy id folder to the readable <name>-<id> folder', () => {
    seedDir('tok-abc', ['cardoso-tok-abc-2026-06-29.db']);
    const r = reconcileHubBackupDirs(baseDir, [{ id: 'tok-abc', name: 'Ermelo' }]);
    expect(r.renamed).toBe(1);
    expect(fs.existsSync(path.join(baseDir, 'Ermelo-tok-abc', 'cardoso-tok-abc-2026-06-29.db'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'tok-abc'))).toBe(false);
  });

  it('merges into an existing readable folder without clobbering', () => {
    seedDir('tok-abc', ['old.db']);
    seedDir('Ermelo-tok-abc', ['existing.db']);
    const r = reconcileHubBackupDirs(baseDir, [{ id: 'tok-abc', name: 'Ermelo' }]);
    expect(r.merged).toBe(1);
    expect(fs.existsSync(path.join(baseDir, 'Ermelo-tok-abc', 'old.db'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'Ermelo-tok-abc', 'existing.db'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'tok-abc'))).toBe(false);
  });

  it('is a no-op when the legacy id folder does not exist', () => {
    const r = reconcileHubBackupDirs(baseDir, [{ id: 'tok-abc', name: 'Ermelo' }]);
    expect(r).toEqual({ renamed: 0, merged: 0 });
  });

  it('is a no-op when there is no name (folder already equals the id)', () => {
    seedDir('tok-abc', ['a.db']);
    const r = reconcileHubBackupDirs(baseDir, [{ id: 'tok-abc' }]);
    expect(r).toEqual({ renamed: 0, merged: 0 });
    expect(fs.existsSync(path.join(baseDir, 'tok-abc', 'a.db'))).toBe(true);
  });

  it('does not clobber a file that already exists in the target', () => {
    seedDir('tok-abc', ['dup.db']);
    seedDir('Ermelo-tok-abc', ['dup.db']);
    fs.writeFileSync(path.join(baseDir, 'Ermelo-tok-abc', 'dup.db'), 'keep-me');
    reconcileHubBackupDirs(baseDir, [{ id: 'tok-abc', name: 'Ermelo' }]);
    expect(fs.readFileSync(path.join(baseDir, 'Ermelo-tok-abc', 'dup.db'), 'utf8')).toBe('keep-me');
  });

  // The site-rename orphaning bug: a display-name change moves the canonical
  // folder; reconcile must migrate the old <oldName>-<id> folder by id suffix.
  it('migrates an old <oldName>-<id> folder after a site rename', () => {
    seedDir('Ermelo-tok-abc', ['snap.db']);
    const r = reconcileHubBackupDirs(baseDir, [{ id: 'tok-abc', name: 'Johannesburg' }]);
    expect(r.renamed).toBe(1);
    expect(fs.existsSync(path.join(baseDir, 'Johannesburg-tok-abc', 'snap.db'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'Ermelo-tok-abc'))).toBe(false);
  });

  it('does not let one site claim another site whose canonical it suffix-matches', () => {
    // siteA id 'x', siteB id 'a-x'. siteB's canonical 'Foo-a-x' ends with '-x',
    // but the reserved guard must keep it for siteB, not let siteA grab it.
    seedDir('Foo-a-x', ['b.db']);
    const sites = [{ id: 'x', name: 'Aaa' }, { id: 'a-x', name: 'Foo' }];
    reconcileHubBackupDirs(baseDir, sites, { allSites: sites });
    // 'Foo-a-x' is siteB's canonical → untouched; siteA created nothing.
    expect(fs.existsSync(path.join(baseDir, 'Foo-a-x', 'b.db'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, 'Aaa-x'))).toBe(false);
  });
});

describe('resolveSiteBackupDir — rename window', () => {
  let baseDir;
  beforeEach(() => { baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardoso-resolve2-')); });

  it('finds the old <oldName>-<id> folder before reconcile runs', () => {
    fs.mkdirSync(path.join(baseDir, 'Ermelo-tok'));
    // Site was renamed to Johannesburg; canonical folder not created yet.
    const dir = resolveSiteBackupDir(baseDir, { id: 'tok', name: 'Johannesburg' });
    expect(dir).toBe(path.join(baseDir, 'Ermelo-tok'));
  });
});
