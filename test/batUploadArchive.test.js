// Tests for src/services/bat/uploadArchive.js — the helper that
// copies an uploaded BAT supplier spreadsheet into a permanent
// per-recon archive directory.
//
// What's pinned:
//   - Filename sanitisation:
//     - Strips path components (../etc/passwd → passwd)
//     - Replaces filesystem-unsafe chars with underscores
//     - Caps length at 200
//     - Falls back to upload.xlsx for empty/garbage input
//   - archiveSupplierUpload:
//     - Creates uploads/bat-archive/<reconId>/ if missing
//     - Copies bytes verbatim (file content matches source)
//     - Returns the destination path
//     - Rejects bad reconId (NaN, 0, negative, non-int)
//     - Rejects missing srcPath
//     - Idempotent — second copy with same name overwrites
//   - All tests use a tmpdir as the archive root so they don't touch
//     the real uploads/ tree.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  sanitizeArchiveFilename,
  archiveSupplierUpload,
} from '../src/services/bat/uploadArchive.js';

let tmpDir;
let srcDir;
let archiveRoot;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bat-archive-test-'));
  srcDir = path.join(tmpDir, 'src');
  archiveRoot = path.join(tmpDir, 'archive');
  fs.mkdirSync(srcDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSrcFile(name, contents) {
  const p = path.join(srcDir, name);
  fs.writeFileSync(p, contents);
  return p;
}

describe('sanitizeArchiveFilename', () => {
  it('strips path components — directory traversal cannot escape', () => {
    expect(sanitizeArchiveFilename('../etc/passwd')).toBe('passwd');
    expect(sanitizeArchiveFilename('..\\..\\Windows\\System32\\evil.dll'))
      // path.basename on POSIX leaves backslashes alone, but the
      // unsafe-char replacer scrubs them. Either way: no dir traversal
      // survives — the result has no separator characters at all.
      .not.toContain('/');
  });

  it('replaces filesystem-unsafe characters with underscores', () => {
    expect(sanitizeArchiveFilename('Week*22|supplier?.xlsx')).toBe('Week_22_supplier_.xlsx');
    expect(sanitizeArchiveFilename('foo<bar>baz.xlsx')).toBe('foo_bar_baz.xlsx');
  });

  it('preserves alnum, dash, underscore, dot, and space', () => {
    expect(sanitizeArchiveFilename('Week_22 supplier-final.xlsx'))
      .toBe('Week_22 supplier-final.xlsx');
  });

  it('falls back to upload.xlsx for empty/null/undefined input', () => {
    expect(sanitizeArchiveFilename('')).toBe('upload.xlsx');
    expect(sanitizeArchiveFilename(null)).toBe('upload.xlsx');
    expect(sanitizeArchiveFilename(undefined)).toBe('upload.xlsx');
  });

  it('falls back to upload.xlsx when sanitisation strips everything', () => {
    // A name that's pure unsafe characters reduces to '' after the
    // replacer, then the length-trim, then the fallback fires.
    expect(sanitizeArchiveFilename('***')).toBe('___');  // underscores survive
    // Pure whitespace trims to empty → fallback.
    expect(sanitizeArchiveFilename('   ')).toBe('upload.xlsx');
  });

  it('caps length at 200 chars to avoid filesystem limits', () => {
    const long = 'a'.repeat(500) + '.xlsx';
    const result = sanitizeArchiveFilename(long);
    expect(result.length).toBe(200);
  });
});

describe('archiveSupplierUpload', () => {
  it('creates uploads/bat-archive/<reconId>/ when missing', () => {
    const src = writeSrcFile('Week_22_supplier.xlsx', 'fake xlsx bytes');
    const dest = archiveSupplierUpload({
      srcPath: src,
      reconId: 42,
      originalName: 'Week_22_supplier.xlsx',
      archiveRoot,
    });
    expect(fs.existsSync(path.dirname(dest))).toBe(true);
    expect(path.dirname(dest).endsWith(path.join('archive', '42'))).toBe(true);
  });

  it('copies bytes verbatim', () => {
    const payload = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0xAA, 0xBB, 0xCC, 0xDD]); // .xlsx magic prefix + junk
    const src = writeSrcFile('a.xlsx', payload);
    const dest = archiveSupplierUpload({
      srcPath: src,
      reconId: 1,
      originalName: 'a.xlsx',
      archiveRoot,
    });
    const copied = fs.readFileSync(dest);
    expect(copied.equals(payload)).toBe(true);
  });

  it('returns the destination path', () => {
    const src = writeSrcFile('a.xlsx', 'hi');
    const dest = archiveSupplierUpload({
      srcPath: src,
      reconId: 7,
      originalName: 'a.xlsx',
      archiveRoot,
    });
    expect(dest).toBe(path.join(archiveRoot, '7', 'a.xlsx'));
  });

  it('uses the sanitised filename as the destination basename', () => {
    const src = writeSrcFile('temp.xlsx', 'x');
    const dest = archiveSupplierUpload({
      srcPath: src,
      reconId: 3,
      originalName: '../../etc/passwd',
      archiveRoot,
    });
    // Sanitised: dir-stripped to "passwd", no bad chars. Goes into recon 3's dir.
    expect(path.basename(dest)).toBe('passwd');
    expect(dest).toBe(path.join(archiveRoot, '3', 'passwd'));
  });

  it('overwrites on a second copy with the same target name (idempotent)', () => {
    const src1 = writeSrcFile('a.xlsx', 'first');
    archiveSupplierUpload({ srcPath: src1, reconId: 9, originalName: 'a.xlsx', archiveRoot });
    const src2 = writeSrcFile('a-second.xlsx', 'second');
    const dest = archiveSupplierUpload({ srcPath: src2, reconId: 9, originalName: 'a.xlsx', archiveRoot });
    expect(fs.readFileSync(dest, 'utf8')).toBe('second');
  });

  it('throws when reconId is missing or invalid', () => {
    const src = writeSrcFile('a.xlsx', 'x');
    expect(() => archiveSupplierUpload({ srcPath: src, originalName: 'a.xlsx', archiveRoot }))
      .toThrow(/positive integer/);
    expect(() => archiveSupplierUpload({ srcPath: src, reconId: 0, originalName: 'a.xlsx', archiveRoot }))
      .toThrow(/positive integer/);
    expect(() => archiveSupplierUpload({ srcPath: src, reconId: -1, originalName: 'a.xlsx', archiveRoot }))
      .toThrow(/positive integer/);
    expect(() => archiveSupplierUpload({ srcPath: src, reconId: 1.5, originalName: 'a.xlsx', archiveRoot }))
      .toThrow(/positive integer/);
    expect(() => archiveSupplierUpload({ srcPath: src, reconId: 'abc', originalName: 'a.xlsx', archiveRoot }))
      .toThrow(/positive integer/);
  });

  it('throws when srcPath is missing', () => {
    expect(() => archiveSupplierUpload({ reconId: 1, originalName: 'a.xlsx', archiveRoot }))
      .toThrow(/srcPath is required/);
  });

  it('propagates ENOENT when srcPath does not exist', () => {
    expect(() => archiveSupplierUpload({
      srcPath: path.join(srcDir, 'does-not-exist.xlsx'),
      reconId: 1,
      originalName: 'a.xlsx',
      archiveRoot,
    })).toThrow(/ENOENT/);
  });
});
