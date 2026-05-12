// JTI archive — versioned monthly storage for JTI exports.
//
// One row per generated export, per period (year, month). Multiple
// rows per period are intentional — manual operator re-runs after
// fixing data shouldn't overwrite the prior canonical version. UI
// shows the latest version per period; full history is queryable.
//
// File layout on disk:
//   uploads/jti-archive/<YYYY>-<MM>/<id>-<filename>
//   e.g.  uploads/jti-archive/2026-04/47-JTI_Cardoso_Sales_Ermelo_20260430.xlsx
//
// All file operations are synchronous (better-sqlite3 is sync, and
// the archive write happens inside a single insert+write critical
// section). Disk size per file is small (~200 KB) so the cost is fine.
//
// This service is pure storage — it does NOT generate the .xlsx
// itself. Callers (the scheduled job, the manual export route) build
// the workbook via jtiSpreadsheet.buildJtiWorkbook and hand the
// resulting Buffer to archiveJtiExport().

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const ARCHIVE_ROOT = path.join(process.cwd(), 'uploads', 'jti-archive');

/**
 * @typedef {Object} JtiArchiveInput
 * @property {Buffer} buffer            the .xlsx file bytes
 * @property {string} filename          download filename (e.g. JTI_Cardoso_Sales_Ermelo_20260430.xlsx)
 * @property {number} periodYear        e.g. 2026
 * @property {number} periodMonth       1..12
 * @property {'scheduled' | 'manual'} source
 * @property {string} [generatedBy]     user email for manual; defaults to 'system:scheduled' for scheduled
 * @property {number} rowCount          number of data rows in the .xlsx (excludes header)
 * @property {string} [townCity]
 * @property {string} [region]
 * @property {string} [country]
 * @property {string} [siteLabel]
 *
 * @typedef {Object} JtiArchiveRow
 * @property {number} id
 * @property {number} period_year
 * @property {number} period_month
 * @property {string} generated_at
 * @property {string} generated_by
 * @property {string} source
 * @property {string} filename
 * @property {string} file_path
 * @property {number} byte_size
 * @property {string} sha256
 * @property {number} row_count
 * @property {string|null} town_city
 * @property {string|null} region
 * @property {string|null} country
 * @property {string|null} site_label
 * @property {string} hub_push_status
 * @property {string|null} hub_push_at
 * @property {string|null} hub_push_error
 * @property {number} hub_push_attempts
 */

/**
 * Persist an .xlsx buffer + metadata as a JTI archive row.
 *
 * Two-step write: insert the row first to get the auto-increment id,
 * then write the file at the path that includes the id, then UPDATE
 * the row's file_path. Wrapped in a transaction so a partial failure
 * (DB write succeeds but disk write fails, or vice versa) leaves no
 * orphan row pointing at a missing file.
 *
 * @param {{ db: import('better-sqlite3').Database, archive: JtiArchiveInput, archiveRoot?: string }} args
 * @returns {JtiArchiveRow}
 */
export function archiveJtiExport({ db, archive, archiveRoot = ARCHIVE_ROOT }) {
  if (!db) throw new TypeError('archiveJtiExport: db is required');
  if (!archive) throw new TypeError('archiveJtiExport: archive is required');
  if (!Buffer.isBuffer(archive.buffer)) {
    throw new TypeError('archiveJtiExport: archive.buffer must be a Buffer');
  }
  if (!archive.filename) throw new TypeError('archiveJtiExport: archive.filename is required');
  if (!Number.isInteger(archive.periodYear) || archive.periodYear < 2000 || archive.periodYear > 2100) {
    throw new RangeError(`archiveJtiExport: periodYear ${archive.periodYear} out of range`);
  }
  if (!Number.isInteger(archive.periodMonth) || archive.periodMonth < 1 || archive.periodMonth > 12) {
    throw new RangeError(`archiveJtiExport: periodMonth ${archive.periodMonth} must be 1..12`);
  }
  if (archive.source !== 'scheduled' && archive.source !== 'manual') {
    throw new TypeError(`archiveJtiExport: source must be 'scheduled' or 'manual', got ${archive.source}`);
  }
  if (!Number.isInteger(archive.rowCount) || archive.rowCount < 0) {
    throw new RangeError('archiveJtiExport: rowCount must be a non-negative integer');
  }

  const sha256 = crypto.createHash('sha256').update(archive.buffer).digest('hex');
  const generatedBy = archive.generatedBy
    || (archive.source === 'scheduled' ? 'system:scheduled' : 'unknown');

  // Period directory: uploads/jti-archive/2026-04/
  const periodDir = path.join(archiveRoot, `${archive.periodYear}-${String(archive.periodMonth).padStart(2, '0')}`);
  fs.mkdirSync(periodDir, { recursive: true });

  // Sanitise the filename to avoid any path-traversal nasties — we
  // use it verbatim from the operator-side filename builder, but
  // belt-and-braces.
  const safeName = path.basename(String(archive.filename))
    .replace(/[^A-Za-z0-9 \-_.]/g, '_')
    .slice(0, 200) || 'jti-export.xlsx';

  // Two-step write inside a transaction. The transaction wraps just
  // the DB writes; the file write happens between them. If the file
  // write throws, the transaction rolls back (no orphan row). If the
  // file write succeeds but the UPDATE fails (extremely unlikely),
  // we delete the just-written file in the catch.
  const insert = db.prepare(`
    INSERT INTO jti_archive (
      period_year, period_month, generated_at, generated_by, source,
      filename, file_path, byte_size, sha256, row_count,
      town_city, region, country, site_label,
      hub_push_status
    ) VALUES (
      ?, ?, datetime('now'), ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      'pending'
    )
  `);
  const updatePath = db.prepare(`UPDATE jti_archive SET file_path = ? WHERE id = ?`);
  const select = db.prepare(`SELECT * FROM jti_archive WHERE id = ?`);

  let writtenFilePath = null;
  try {
    const tx = db.transaction(() => {
      const info = insert.run(
        archive.periodYear, archive.periodMonth, generatedBy, archive.source,
        safeName, '__pending__', archive.buffer.byteLength, sha256, archive.rowCount,
        archive.townCity ?? null, archive.region ?? null,
        archive.country ?? null, archive.siteLabel ?? null,
      );
      const id = Number(info.lastInsertRowid);
      const finalPath = path.join(periodDir, `${id}-${safeName}`);
      // Disk write is BEFORE the path UPDATE so a write failure rolls
      // back the row via the transaction. If the write succeeds and
      // the UPDATE then fails, the catch below cleans up.
      fs.writeFileSync(finalPath, archive.buffer);
      writtenFilePath = finalPath;
      updatePath.run(finalPath, id);
      return id;
    });
    const id = tx();
    return select.get(id);
  } catch (err) {
    if (writtenFilePath) {
      try { fs.unlinkSync(writtenFilePath); } catch {}
    }
    throw err;
  }
}

/**
 * List archive rows, latest version per (year, month) first.
 *
 * @param {{ db: import('better-sqlite3').Database, limit?: number }} args
 * @returns {JtiArchiveRow[]}
 */
export function listJtiArchives({ db, limit = 60 }) {
  if (!db) throw new TypeError('listJtiArchives: db is required');
  return db.prepare(`
    SELECT * FROM jti_archive
    ORDER BY period_year DESC, period_month DESC, generated_at DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Look up a single archive row by id.
 *
 * @param {{ db: import('better-sqlite3').Database, id: number }} args
 * @returns {JtiArchiveRow | null}
 */
export function getJtiArchive({ db, id }) {
  if (!db) throw new TypeError('getJtiArchive: db is required');
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = db.prepare(`SELECT * FROM jti_archive WHERE id = ?`).get(id);
  return row || null;
}

/**
 * Check whether a 'scheduled' archive already exists for a given
 * period — used by the scheduler's catch-up logic to avoid double-
 * generating a month that's already covered.
 *
 * @param {{ db: import('better-sqlite3').Database, periodYear: number, periodMonth: number }} args
 * @returns {boolean}
 */
export function hasScheduledArchive({ db, periodYear, periodMonth }) {
  if (!db) throw new TypeError('hasScheduledArchive: db is required');
  const row = db.prepare(`
    SELECT 1 FROM jti_archive
    WHERE period_year = ? AND period_month = ? AND source = 'scheduled'
    LIMIT 1
  `).get(periodYear, periodMonth);
  return Boolean(row);
}

/**
 * Determine whether a (fromDate, toDate) pair represents an exact
 * full calendar month. Drives the manual-export → archive policy:
 * exports covering a clean month get archived (source='manual');
 * partial-month exports stay download-only.
 *
 * Inputs accepted as Date / 'YYYY-MM-DD' / 'YYYYMMDD' / Date string.
 * Returns null when the range isn't a full single month, or
 * { periodYear, periodMonth } when it is.
 *
 * @param {Date | number | string} fromDate
 * @param {Date | number | string} toDate
 * @returns {{ periodYear: number, periodMonth: number } | null}
 */
export function periodFromExactMonth(fromDate, toDate) {
  const from = parseToYmd(fromDate);
  const to = parseToYmd(toDate);
  if (!from || !to) return null;
  // Same year + month?
  if (from.y !== to.y || from.m !== to.m) return null;
  // From is the 1st of the month?
  if (from.d !== 1) return null;
  // To is the last day of that month?
  const lastDay = daysInMonth(from.y, from.m);
  if (to.d !== lastDay) return null;
  return { periodYear: from.y, periodMonth: from.m };
}

function parseToYmd(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return { y: value.getUTCFullYear(), m: value.getUTCMonth() + 1, d: value.getUTCDate() };
  }
  if (typeof value === 'number' && Number.isInteger(value)) {
    // YYYYMMDD integer
    if (value < 19000101 || value > 21001231) return null;
    return { y: Math.floor(value / 10000), m: Math.floor((value % 10000) / 100), d: value % 100 };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // YYYYMMDD
    if (/^\d{8}$/.test(trimmed)) {
      return parseToYmd(Number(trimmed));
    }
    // YYYY-MM-DD
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
    if (m) {
      return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
    }
    // Fall through to Date parse
    const d = new Date(trimmed);
    if (!Number.isNaN(d.getTime())) {
      return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
    }
  }
  return null;
}

function daysInMonth(year, month) {
  // Day 0 of the next month = last day of this month, in UTC.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
