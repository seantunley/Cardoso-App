// Commission archive — same pattern as jtiArchive (v70/v71): per-month
// PDF + JSON snapshot persisted on disk and referenced by a row in
// commission_archive. Two-step write (insert row → write file → update
// path) inside a transaction so partial failures don't leave orphans.
//
// File layout:
//   uploads/commission-archive/<YYYY>-<MM>/<id>-<filename>
//
// One canonical 'scheduled' row per period (uniqueness enforced at DB
// level by migration v83). Operator-initiated 'manual' rows can coexist
// for ad-hoc re-runs.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const ARCHIVE_ROOT = path.join(process.cwd(), 'uploads', 'commission-archive');

/**
 * @typedef {Object} CommissionArchiveInput
 * @property {Buffer} buffer         PDF bytes
 * @property {string} filename       download filename
 * @property {number} periodYear     e.g. 2026
 * @property {number} periodMonth    1..12
 * @property {string} periodFrom     YYYY-MM-DD
 * @property {string} periodTo       YYYY-MM-DD
 * @property {'scheduled' | 'manual'} source
 * @property {string} [generatedBy]
 * @property {object} reportJson     the full report payload
 * @property {string} [siteLabel]
 */

export function archiveCommissionReport({ db, archive, archiveRoot = ARCHIVE_ROOT }) {
  if (!db) throw new TypeError('archiveCommissionReport: db is required');
  if (!archive) throw new TypeError('archiveCommissionReport: archive is required');
  if (!Buffer.isBuffer(archive.buffer)) throw new TypeError('archive.buffer must be a Buffer');
  if (!archive.filename) throw new TypeError('archive.filename is required');
  if (!Number.isInteger(archive.periodYear)) throw new RangeError('periodYear must be an integer');
  if (!Number.isInteger(archive.periodMonth) || archive.periodMonth < 1 || archive.periodMonth > 12) {
    throw new RangeError(`periodMonth ${archive.periodMonth} must be 1..12`);
  }
  if (archive.source !== 'scheduled' && archive.source !== 'manual') {
    throw new TypeError(`source must be 'scheduled' or 'manual'`);
  }
  if (!archive.reportJson) throw new TypeError('reportJson is required');

  const sha256 = crypto.createHash('sha256').update(archive.buffer).digest('hex');
  const generatedBy = archive.generatedBy
    || (archive.source === 'scheduled' ? 'system:scheduled' : 'unknown');
  const periodDir = path.join(archiveRoot, `${archive.periodYear}-${String(archive.periodMonth).padStart(2, '0')}`);
  fs.mkdirSync(periodDir, { recursive: true });
  const safeName = path.basename(String(archive.filename))
    .replace(/[^A-Za-z0-9 \-_.]/g, '_')
    .slice(0, 200) || 'commission.pdf';

  const insert = db.prepare(`
    INSERT INTO commission_archive (
      period_year, period_month, period_from, period_to,
      generated_at, generated_by, source,
      filename, file_path, byte_size, sha256,
      report_json, site_label, hub_push_status
    ) VALUES (
      ?, ?, ?, ?,
      datetime('now'), ?, ?,
      ?, ?, ?, ?,
      ?, ?, 'pending'
    )
  `);
  const updatePath = db.prepare(`UPDATE commission_archive SET file_path = ? WHERE id = ?`);
  const select = db.prepare(`SELECT * FROM commission_archive WHERE id = ?`);

  let writtenFilePath = null;
  try {
    const tx = db.transaction(() => {
      const info = insert.run(
        archive.periodYear, archive.periodMonth, archive.periodFrom, archive.periodTo,
        generatedBy, archive.source,
        safeName, '__pending__', archive.buffer.byteLength, sha256,
        JSON.stringify(archive.reportJson),
        archive.siteLabel ?? null,
      );
      const id = Number(info.lastInsertRowid);
      const finalPath = path.join(periodDir, `${id}-${safeName}`);
      fs.writeFileSync(finalPath, archive.buffer);
      writtenFilePath = finalPath;
      updatePath.run(finalPath, id);
      return id;
    });
    const id = tx();
    return select.get(id);
  } catch (err) {
    if (writtenFilePath) {
      try { fs.unlinkSync(writtenFilePath); }
      catch (e) { console.warn('[commission.archive.cleanup_unlink]', { writtenFilePath }, e.message); }
    }
    throw err;
  }
}

export function listCommissionArchives({ db, limit = 60 }) {
  if (!db) throw new TypeError('listCommissionArchives: db is required');
  return db.prepare(`
    SELECT * FROM commission_archive
    ORDER BY period_year DESC, period_month DESC, generated_at DESC
    LIMIT ?
  `).all(limit);
}

export function getCommissionArchive({ db, id }) {
  if (!db) throw new TypeError('getCommissionArchive: db is required');
  if (!Number.isInteger(Number(id))) throw new TypeError('id must be numeric');
  return db.prepare(`SELECT * FROM commission_archive WHERE id = ?`).get(Number(id));
}

export function hasScheduledArchive({ db, periodYear, periodMonth }) {
  if (!db) throw new TypeError('hasScheduledArchive: db is required');
  return Boolean(db.prepare(`
    SELECT 1 FROM commission_archive
    WHERE period_year = ? AND period_month = ? AND source = 'scheduled'
    LIMIT 1
  `).get(periodYear, periodMonth));
}

/**
 * Compute the commission period covered by a "run on the 24th" job.
 *   Cycle: 24th of previous month → 23rd of current month.
 *   So running on (say) 2026-05-24 covers 2026-04-24 → 2026-05-23
 *   and is labelled period_year=2026, period_month=5 (May).
 *
 * @param {Date} [now]
 * @returns {{ year: number, month: number, fromDate: string, toDate: string }}
 *   ISO YYYY-MM-DD for from/to.
 */
export function commissionPeriodForRun(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1; // 1..12
  const prevMonth = m === 1 ? 12 : m - 1;
  const prevYear  = m === 1 ? y - 1 : y;
  const pad = (n) => String(n).padStart(2, '0');
  return {
    year: y,
    month: m,
    fromDate: `${prevYear}-${pad(prevMonth)}-24`,
    toDate: `${y}-${pad(m)}-23`,
  };
}
