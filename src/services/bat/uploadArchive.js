// Archive uploaded BAT supplier spreadsheets to disk so a later
// dispute can be replayed against the original file.
//
// The upload route parses .xlsx → DB rows then unlinks the multer
// temp file. Without this archive, once the operator is looking at
// the recon there's no way back to the source bytes — and supplier
// disputes are exactly the situation where you want the source bytes.
//
// Layout: uploads/bat-archive/<reconId>/<safeName>.xlsx
// One dir per recon (matches the per-recon resourceId already used
// by the audit log entries; easy to find a recon's source file from
// its DB id alone).
//
// This module is filesystem-only — no DB access. The route caller is
// responsible for persisting the returned path into
// bat_reconciliations.archive_path.

import fs from 'fs';
import path from 'path';

const ARCHIVE_ROOT = path.join(process.cwd(), 'uploads', 'bat-archive');

/**
 * Sanitise a user-supplied filename to a single path-safe basename.
 * - Strips any directory components (path.basename) so an upload
 *   named "../etc/passwd" can't escape the archive root.
 * - Replaces filesystem-unsafe characters with underscores.
 * - Caps total length at 200 chars so weird supplier filenames don't
 *   bust filesystem limits.
 *
 * @param {string} originalName
 * @returns {string}
 */
export function sanitizeArchiveFilename(originalName) {
  const base = path.basename(String(originalName || 'upload.xlsx'));
  // Replace anything that isn't alnum, dash, underscore, dot, or space.
  const cleaned = base.replace(/[^A-Za-z0-9 \-_.]/g, '_').trim();
  const safe = cleaned || 'upload.xlsx';
  return safe.length > 200 ? safe.slice(0, 200) : safe;
}

/**
 * Copy an uploaded supplier spreadsheet from its multer temp path
 * into the per-recon archive directory. Returns the archive path so
 * the caller can persist it to bat_reconciliations.archive_path.
 *
 * Failures are NOT swallowed — the route's try/catch decides what to
 * do (today: log + continue without an archive, since losing the
 * original bytes is regrettable but doesn't invalidate the parsed
 * data). That decision lives in the route, not here.
 *
 * @param {{ srcPath: string, reconId: number, originalName: string, archiveRoot?: string }} args
 * @returns {string} absolute path to the archived file
 */
export function archiveSupplierUpload({ srcPath, reconId, originalName, archiveRoot = ARCHIVE_ROOT }) {
  if (!srcPath) throw new Error('archiveSupplierUpload: srcPath is required');
  if (!Number.isInteger(reconId) || reconId <= 0) {
    throw new Error(`archiveSupplierUpload: reconId must be a positive integer, got ${reconId}`);
  }
  const dir = path.join(archiveRoot, String(reconId));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, sanitizeArchiveFilename(originalName));
  fs.copyFileSync(srcPath, dest);
  return dest;
}
