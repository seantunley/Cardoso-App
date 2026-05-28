// Hub-side Commission archive intake — receives PDF uploads pushed by
// sites (POST /api/hub/receive-commission-archive). Mirrors the JTI hub
// receive shape (src/services/hub/jtiHubReceive.js); kept as a separate
// file so the storage layout + dedup logic for the two report types stay
// independently tweakable without one rule accidentally leaking into the
// other.
//
// File layout on hub disk:
//   uploads/hub-commission-archive/<YYYY>-<MM>/<id>-<filename>
//
// Dedup: enforced by UNIQUE INDEX (site_id, sha256) on
// hub_commission_archive. A re-push of the same bytes for the same
// site returns 200 with the existing row's id (idempotent push retry),
// NOT a 409.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const HUB_ARCHIVE_ROOT = path.join(process.cwd(), 'uploads', 'hub-commission-archive');

/**
 * @typedef {Object} CommissionHubReceiveInput
 * @property {string}  siteId
 * @property {number} [siteArchiveId]
 * @property {Buffer}  buffer
 * @property {string}  filename
 * @property {number}  periodYear
 * @property {number}  periodMonth
 * @property {string}  periodFrom            YYYY-MM-DD
 * @property {string}  periodTo              YYYY-MM-DD
 * @property {string}  generatedAt           ISO-ish (server stamps as TEXT)
 * @property {string} [generatedBy]
 * @property {'scheduled' | 'manual'} source
 * @property {string}  declaredSha256        sender's sha256 (we recompute and verify)
 * @property {number} [declaredByteSize]     optional belt-and-braces check
 * @property {string}  reportJson            JSON snapshot of the rendered report payload
 * @property {string} [siteLabel]
 * @property {'push' | 'pull'} receivedVia
 */

/**
 * Validate, dedup, and persist a Commission archive arriving on the hub.
 * Returns { ok:true, deduped:false, row } on insert,
 * { ok:true, deduped:true, row } on dedup hit. Throws on validation
 * failure (caller maps to 400).
 *
 * @param {{ db: import('better-sqlite3').Database, archive: CommissionHubReceiveInput, archiveRoot?: string }} args
 */
export function receiveCommissionArchive({ db, archive, archiveRoot = HUB_ARCHIVE_ROOT }) {
  if (!archive) throw new TypeError('receiveCommissionArchive: archive is required');
  if (!archive.siteId) throw new TypeError('receiveCommissionArchive: siteId is required');
  if (!Buffer.isBuffer(archive.buffer)) {
    throw new TypeError('receiveCommissionArchive: buffer must be a Buffer');
  }
  if (!archive.filename) throw new TypeError('receiveCommissionArchive: filename is required');
  if (!Number.isInteger(archive.periodYear) || archive.periodYear < 2000 || archive.periodYear > 2100) {
    throw new RangeError(`receiveCommissionArchive: periodYear ${archive.periodYear} out of range`);
  }
  if (!Number.isInteger(archive.periodMonth) || archive.periodMonth < 1 || archive.periodMonth > 12) {
    throw new RangeError(`receiveCommissionArchive: periodMonth must be 1..12`);
  }
  if (!archive.periodFrom || !/^\d{4}-\d{2}-\d{2}$/.test(archive.periodFrom)) {
    throw new RangeError('receiveCommissionArchive: periodFrom must be YYYY-MM-DD');
  }
  if (!archive.periodTo || !/^\d{4}-\d{2}-\d{2}$/.test(archive.periodTo)) {
    throw new RangeError('receiveCommissionArchive: periodTo must be YYYY-MM-DD');
  }
  if (archive.source !== 'scheduled' && archive.source !== 'manual') {
    throw new TypeError(`receiveCommissionArchive: source must be 'scheduled' or 'manual'`);
  }
  if (archive.receivedVia !== 'push' && archive.receivedVia !== 'pull') {
    throw new TypeError(`receiveCommissionArchive: receivedVia must be 'push' or 'pull'`);
  }
  if (!archive.reportJson || typeof archive.reportJson !== 'string') {
    throw new TypeError('receiveCommissionArchive: reportJson must be a JSON string');
  }
  // Sanity-check that report_json is parseable — a corrupt blob would
  // poison the hub UI's "view archive" panel later.
  try { JSON.parse(archive.reportJson); }
  catch (e) { throw new RangeError(`receiveCommissionArchive: reportJson is not valid JSON (${e.message})`); }

  // Recompute sha256 ourselves and reject mismatches — sender lying
  // about their hash means we'd happily accept tampered bytes.
  const computedSha = crypto.createHash('sha256').update(archive.buffer).digest('hex');
  if (archive.declaredSha256 && archive.declaredSha256 !== computedSha) {
    throw new RangeError(
      `receiveCommissionArchive: sha256 mismatch — sender said ${archive.declaredSha256.slice(0, 12)}…, computed ${computedSha.slice(0, 12)}…`
    );
  }
  if (archive.declaredByteSize != null && Number(archive.declaredByteSize) !== archive.buffer.byteLength) {
    throw new RangeError(
      `receiveCommissionArchive: byte_size mismatch — sender said ${archive.declaredByteSize}, got ${archive.buffer.byteLength}`
    );
  }

  // Dedup: same site + same bytes → return the existing row.
  const existing = db.prepare(`
    SELECT * FROM hub_commission_archive WHERE site_id = ? AND sha256 = ?
  `).get(archive.siteId, computedSha);
  if (existing) {
    return { ok: true, deduped: true, row: existing };
  }

  const safeName = path.basename(String(archive.filename))
    .replace(/[^A-Za-z0-9 \-_.]/g, '_')
    .slice(0, 200) || 'commission.pdf';
  const safeSiteId = String(archive.siteId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  const periodDir = path.join(
    archiveRoot,
    safeSiteId,
    `${archive.periodYear}-${String(archive.periodMonth).padStart(2, '0')}`,
  );
  fs.mkdirSync(periodDir, { recursive: true });

  const insert = db.prepare(`
    INSERT INTO hub_commission_archive (
      site_id, site_archive_id,
      period_year, period_month, period_from, period_to,
      generated_at, generated_by, source,
      filename, file_path, byte_size, sha256,
      report_json, site_label,
      received_at, received_via
    ) VALUES (
      ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?,
      datetime('now'), ?
    )
  `);
  const updatePath = db.prepare(`UPDATE hub_commission_archive SET file_path = ? WHERE id = ?`);
  const select = db.prepare(`SELECT * FROM hub_commission_archive WHERE id = ?`);

  let writtenFilePath = null;
  try {
    const tx = db.transaction(() => {
      const info = insert.run(
        archive.siteId,
        Number.isInteger(archive.siteArchiveId) ? archive.siteArchiveId : null,
        archive.periodYear, archive.periodMonth,
        archive.periodFrom, archive.periodTo,
        archive.generatedAt || new Date().toISOString().replace('T', ' ').slice(0, 19),
        archive.generatedBy || null,
        archive.source,
        safeName, '__pending__',
        archive.buffer.byteLength, computedSha,
        archive.reportJson,
        archive.siteLabel || null,
        archive.receivedVia,
      );
      const id = Number(info.lastInsertRowid);
      const finalPath = path.join(periodDir, `${id}-${safeName}`);
      fs.writeFileSync(finalPath, archive.buffer);
      writtenFilePath = finalPath;
      updatePath.run(finalPath, id);
      return id;
    });
    const id = tx();
    return { ok: true, deduped: false, row: select.get(id) };
  } catch (err) {
    if (writtenFilePath) {
      try { fs.unlinkSync(writtenFilePath); }
      catch (e) { console.warn('[hub.commission.receive.cleanup_unlink]', { writtenFilePath }, e.message); }
    }
    throw err;
  }
}

/**
 * List hub_commission_archive rows. Defaults to latest-period-first across
 * all sites; pass `siteId` to filter to one site. LEFT JOINs hub_sites
 * so the row carries site_name + site_slug alongside the archive's
 * own site_id (same UX rationale as listHubJtiArchives).
 */
export function listHubCommissionArchives({ db, siteId = null, limit = 60 }) {
  const baseSelect = `
    SELECT a.*,
           s.name AS site_name,
           s.slug AS site_slug
      FROM hub_commission_archive a
      LEFT JOIN hub_sites s ON s.id = a.site_id
  `;
  if (siteId) {
    return db.prepare(`
      ${baseSelect}
      WHERE a.site_id = ?
      ORDER BY a.period_year DESC, a.period_month DESC, a.received_at DESC
      LIMIT ?
    `).all(siteId, limit);
  }
  return db.prepare(`
    ${baseSelect}
    ORDER BY a.period_year DESC, a.period_month DESC, a.received_at DESC
    LIMIT ?
  `).all(limit);
}

export function getHubCommissionArchive({ db, id }) {
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.prepare(`SELECT * FROM hub_commission_archive WHERE id = ?`).get(id) || null;
}
