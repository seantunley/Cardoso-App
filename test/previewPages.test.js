// Tests for the multi-page preview filename contract (previewPages.js).
//
// This is the single source of truth shared by the OCR worker (writes files),
// the background render queue (writes pages 2..N), and the /preview-pages route
// (lists them). Page 1 stays `<id>.jpg` for back-compat; extra pages are
// `<id>-<n>.jpg`. The risky bit is id-collision (id=1 vs id=12), so that's
// covered explicitly.

import { describe, it, expect } from 'vitest';
import { previewFileName, listPreviewPagesFromFiles } from '../src/services/ocr/previewPages.js';

describe('previewFileName', () => {
  it('page 1 keeps the legacy <id>.jpg name (back-compat)', () => {
    expect(previewFileName(42, 1)).toBe('42.jpg');
  });
  it('pages 2+ use the suffixed <id>-<n>.jpg name', () => {
    expect(previewFileName(42, 2)).toBe('42-2.jpg');
    expect(previewFileName(42, 13)).toBe('42-13.jpg');
  });
});

describe('listPreviewPagesFromFiles', () => {
  it('returns page 1 from the legacy single-page name', () => {
    const pages = listPreviewPagesFromFiles(['42.jpg'], 42);
    expect(pages).toEqual([{ page: 1, filename: '42.jpg' }]);
  });

  it('orders multi-page sets numerically (not lexically)', () => {
    // Lexical sort would put "42-10" before "42-2"; we must sort by number.
    const files = ['42-10.jpg', '42.jpg', '42-2.jpg', '42-3.jpg'];
    const pages = listPreviewPagesFromFiles(files, 42);
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3, 10]);
    expect(pages.map((p) => p.filename)).toEqual(['42.jpg', '42-2.jpg', '42-3.jpg', '42-10.jpg']);
  });

  it('does not confuse id=1 with id=12 (anchored matching)', () => {
    const files = ['1.jpg', '1-2.jpg', '12.jpg', '12-2.jpg', '123.jpg'];
    expect(listPreviewPagesFromFiles(files, 1).map((p) => p.filename)).toEqual(['1.jpg', '1-2.jpg']);
    expect(listPreviewPagesFromFiles(files, 12).map((p) => p.filename)).toEqual(['12.jpg', '12-2.jpg']);
  });

  it('ignores unrelated files and non-jpg', () => {
    const files = ['42.jpg', '42-2.jpg', '99.jpg', '42.pdf', '42-2.jpg.tmp', 'notes.txt'];
    expect(listPreviewPagesFromFiles(files, 42).map((p) => p.filename)).toEqual(['42.jpg', '42-2.jpg']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(listPreviewPagesFromFiles(['99.jpg', '100-2.jpg'], 42)).toEqual([]);
  });

  it('accepts a numeric or string id', () => {
    expect(listPreviewPagesFromFiles(['42.jpg'], '42')).toEqual([{ page: 1, filename: '42.jpg' }]);
  });
});
