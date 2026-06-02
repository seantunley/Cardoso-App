// Hub-side JTI archive intake — receives uploads pushed by sites
// (POST /api/hub/receive-jti-archive) and pull-fallback fetches
// (src/services/hub/jtiHubPull.js). Single point of truth for the
// validation + storage rules so push and pull can't drift.
//
// File layout on hub disk:
//   database/hub-archives/jti/<site_id>/<YYYY>-<MM>/<id>-<filename>
//
// Dedup: enforced by UNIQUE INDEX (site_id, sha256) on hub_jti_archive.
// A re-push of bytes the hub already has is a 200 with the existing
// row's id — NOT a 409 — so the site can confidently mark its row
// 'pushed' even if the network duplicated the request.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const HUB_ARCHIVE_ROOT = path.join(process.cwd(), 'database', 'hub-archives', 'jti');

/**
 * @typedef {Object} JtiHubReceiveInput
 * @property {string}  siteId
 * @property {number} [siteArchiveId]
 * @property {Buffer}  buffer
 * @property {string}  filename
 * @property {number}  periodYear
 * @property {number}  periodMonth
 * @property {string}  generatedAt          ISO-ish (server stamps as TEXT)
 * @property {string} [generatedBy]
 * @property {'scheduled' | 'manual'} source
 * @property {number}  rowCount
 * @property {string}  declaredSha256       sender's sha256 (we recompute and verify)
 * @property {number} [declaredByteSize]    optional belt-and-braces check
 * @property {string} [townCity]
 * @property {string} [region]
 * @property {string} [country]
 * @property {string} [siteLabel]
 * @property {'push' | 'pull'} receivedVia
 */

/**
 * Validate, dedup, and persist a JTI archive arriving on the hub.
 * Returns { ok:true, ...row } on insert, { ok:true, deduped:true, ...row }
 * on dedup hit. Throws on validation failure (caller maps to 400).
 *
 * @param {{ db: import('better-sqlite3').Database, archive: JtiHubReceiveInput, archiveRoot?: string }} args
 */
export function receiveJtiArchive({ db, archive, archiveRoot = HUB_ARCHIVE_ROOT }) {
  if (!archive) throw new TypeError('receiveJtiArchive: archive is required');
  if (!archive.siteId) throw new TypeError('receiveJtiArchive: siteId is required');
  if (!Buffer.isBuffer(archive.buffer)) {
    throw new TypeError('receiveJtiArchive: buffer must be a Buffer');
  }
  if (!archive.filename) throw new TypeError('receiveJtiArchive: filename is required');
  if (!Number.isInteger(archive.periodYear) || archive.periodYear < 2000 || archive.periodYear > 2100) {
    throw new RangeError(`receiveJtiArchive: periodYear ${archive.periodYear} out of range`);
  }
  if (!Number.isInteger(archive.periodMonth) || archive.periodMonth < 1 || archive.periodMonth > 12) {
    throw new RangeError(`receiveJtiArchive: periodMonth must be 1..12`);
  }
  if (archive.source !== 'scheduled' && archive.source !== 'manual') {
    throw new TypeError(`receiveJtiArchive: source must be 'scheduled' or 'manual'`);
  }
  if (archive.receivedVia !== 'push' && archive.receivedVia !== 'pull') {
    throw new TypeError(`receiveJtiArchive: receivedVia must be 'push' or 'pull'`);
  }
  if (!Number.isInteger(archive.rowCount) || archive.rowCount < 0) {
    throw new RangeError('receiveJtiArchive: rowCount must be a non-negative integer');
  }

  // Recompute sha256 ourselves and reject mismatches — sender lying
  // about their hash means we'd happily accept tampered bytes.
  const computedSha = crypto.createHash('sha256').update(archive.buffer).digest('hex');
  if (archive.declaredSha256 && archive.declaredSha256 !== computedSha) {
    throw new RangeError(
      `receiveJtiArchive: sha256 mismatch — sender said ${archive.declaredSha256.slice(0, 12)}…, computed ${computedSha.slice(0, 12)}…`
    );
  }
  if (archive.declaredByteSize != null && Number(archive.declaredByteSize) !== archive.buffer.byteLength) {
    throw new RangeError(
      `receiveJtiArchive: byte_size mismatch — sender said ${archive.declaredByteSize}, got ${archive.buffer.byteLength}`
    );
  }

  // Dedup: same site + same bytes → return the existing row, no
  // disk write, no insert.
  const existing = db.prepare(`
    SELECT * FROM hub_jti_archive WHERE site_id = ? AND sha256 = ?
  `).get(archive.siteId, computedSha);
  if (existing) {
    return { ok: true, deduped: true, row: existing };
  }

  const safeName = path.basename(String(archive.filename))
    .replace(/[^A-Za-z0-9 \-_.]/g, '_')
    .slice(0, 200) || 'jti-export.xlsx';
  const safeSiteId = String(archive.siteId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  const periodDir = path.join(
    archiveRoot,
    safeSiteId,
    `${archive.periodYear}-${String(archive.periodMonth).padStart(2, '0')}`,
  );
  fs.mkdirSync(periodDir, { recursive: true });

  const insert = db.prepare(`
    INSERT INTO hub_jti_archive (
      site_id, site_archive_id,
      period_year, period_month,
      generated_at, generated_by, source,
      filename, file_path, byte_size, sha256, row_count,
      town_city, region, country, site_label,
      received_at, received_via
    ) VALUES (
      ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      datetime('now'), ?
    )
  `);
  const updatePath = db.prepare(`UPDATE hub_jti_archive SET file_path = ? WHERE id = ?`);
  const select = db.prepare(`SELECT * FROM hub_jti_archive WHERE id = ?`);

  let writtenFilePath = null;
  try {
    const tx = db.transaction(() => {
      const info = insert.run(
        archive.siteId,
        Number.isInteger(archive.siteArchiveId) ? archive.siteArchiveId : null,
        archive.periodYear, archive.periodMonth,
        archive.generatedAt || new Date().toISOString().replace('T', ' ').slice(0, 19),
        archive.generatedBy || null,
        archive.source,
        safeName, '__pending__',
        archive.buffer.byteLength, computedSha, archive.rowCount,
        archive.townCity || null, archive.region || null,
        archive.country || null, archive.siteLabel || null,
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
      try { fs.unlinkSync(writtenFilePath); } catch (e) { console.warn('[hub.jti.receive.cleanup_unlink]', { writtenFilePath }, e.message); }
    }
    throw err;
  }
}

/**
 * List hub_jti_archive rows. Defaults to latest-period-first across
 * all sites; pass `siteId` to filter to one site.
 *
 * LEFT JOINs hub_sites so the row carries site_name + site_slug
 * alongside the archive's own site_id. The hub UI uses site_name
 * for the operator-facing labels (filter chips, table cells, empty-
 * state messages); a UUID-shaped site_id is meaningless to read.
 * Falls back to site_id on the client if the join misses (orphan
 * archive whose hub_sites row was removed).
 */
export function listHubJtiArchives({ db, siteId = null, limit = 60 }) {
  const baseSelect = `
    SELECT a.*,
           s.name AS site_name,
           s.slug AS site_slug
      FROM hub_jti_archive a
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

export function getHubJtiArchive({ db, id }) {
  if (!Number.isInteger(id) || id <= 0) return null;
  return db.prepare(`SELECT * FROM hub_jti_archive WHERE id = ?`).get(id) || null;
}

/**
 * Sha256 set the hub already holds for a site — used by the pull-
 * fallback to skip re-fetching bytes already on disk.
 */
export function knownSha256ForSite({ db, siteId }) {
  const rows = db.prepare(`SELECT sha256 FROM hub_jti_archive WHERE site_id = ?`).all(siteId);
  return new Set(rows.map(r => r.sha256));
}
