// Hub-side per-month commission bundle. Streams a single ZIP of every
// site's commission PDF for one (period_year, period_month) so the
// operator can grab a whole month with one click — the commission
// equivalent of jtiHubBundle.js.
//
// Difference from the JTI bundle: this is LENIENT on completeness. The
// JTI bundle refuses until every site has reported (one package ships
// externally to JTI). Commission archives are for internal payout, so a
// late site shouldn't block downloading everyone else's — we bundle
// whatever has been received for the period and report the missing set
// in the result for the audit trail. The page still shows the
// completeness pill so the operator knows it's partial.
//
// Per-site selection mirrors HubCommission.jsx's grid cell: prefer the
// 'scheduled' (month-end) archive over a 'manual' re-run, and the latest
// id within the same source.

import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';

// archiver 8 exposes format classes rather than the legacy factory; reach
// the CJS module via createRequire from this ESM file (same as jtiHubBundle).
const requireCjs = createRequire(import.meta.url);
const { ZipArchive } = requireCjs('archiver');

/**
 * Stream the commission bundle for one period as a ZIP. Returns an outcome
 * SYNCHRONOUSLY; on ok=true the response is already streaming (caller only
 * writes the audit row), on ok=false the caller writes its own status/body.
 *
 * @param {{
 *   db: any,
 *   sites: Array<{id:string,name?:string}>,   // the user's allowed/expected sites
 *   periodYear: number,
 *   periodMonth: number,
 *   res: import('http').ServerResponse,
 *   onError?: (err: Error) => void,
 * }} args
 * @returns {{ ok: true, filename: string, archives: Array<{site_id:string, filename:string}>, missing_site_ids: string[] }
 *   | { ok: false, code: string, message: string, missing_site_ids?: string[], received_count?: number, expected_count?: number }}
 */
export function streamCommissionArchiveBundle({ db, sites, periodYear, periodMonth, res, onError }) {
  if (!Number.isInteger(periodYear) || periodYear < 2000 || periodYear > 2100) {
    return { ok: false, code: 'BAD_PERIOD', message: `periodYear ${periodYear} out of range` };
  }
  if (!Number.isInteger(periodMonth) || periodMonth < 1 || periodMonth > 12) {
    return { ok: false, code: 'BAD_PERIOD', message: `periodMonth ${periodMonth} out of range` };
  }

  const expectedIds = new Set((sites || []).map((s) => String(s.id)));
  const expectedCount = expectedIds.size;

  const rows = db.prepare(`
    SELECT id, site_id, filename, source, received_at
    FROM hub_commission_archive
    WHERE period_year = ? AND period_month = ?
  `).all(periodYear, periodMonth);

  // One archive per site: scheduled beats manual; latest id within a source.
  const bySite = new Map();
  for (const r of rows) {
    const sid = String(r.site_id);
    if (!expectedIds.has(sid)) continue; // scope to allowed/expected sites
    const cur = bySite.get(sid);
    if (!cur
      || (r.source === 'scheduled' && cur.source !== 'scheduled')
      || (r.source === cur.source && r.id > cur.id)) {
      bySite.set(sid, r);
    }
  }

  const chosen = Array.from(bySite.values()).sort((a, b) => String(a.site_id).localeCompare(String(b.site_id)));
  const missing_site_ids = Array.from(expectedIds).filter((id) => !bySite.has(id));

  if (chosen.length === 0) {
    return {
      ok: false,
      code: 'PERIOD_EMPTY',
      message: `No commission archives received for ${periodYear}-${String(periodMonth).padStart(2, '0')} yet.`,
      received_count: 0,
      expected_count: expectedCount,
      missing_site_ids,
    };
  }

  // Resolve + verify files on disk BEFORE sending headers, so a stale row
  // still produces a clean 410 instead of a truncated download.
  const enriched = [];
  for (const a of chosen) {
    const row = db.prepare('SELECT file_path FROM hub_commission_archive WHERE id = ?').get(a.id);
    if (!row || !fs.existsSync(row.file_path)) {
      return {
        ok: false,
        code: 'FILE_MISSING',
        message: `hub_commission_archive #${a.id} (site=${a.site_id}, ${a.filename}) is recorded but missing on disk at ${row?.file_path || 'unknown path'}. Bundle aborted.`,
        missing_archive_id: a.id,
        missing_site_id: a.site_id,
      };
    }
    enriched.push({ ...a, file_path: row.file_path });
  }

  const filename = `Commission_Bundle_${periodYear}-${String(periodMonth).padStart(2, '0')}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');

  const zip = new ZipArchive({ zlib: { level: 9 } });
  zip.on('error', (err) => {
    try { if (typeof onError === 'function') onError(err); } catch (e) { console.warn('[commission.bundle.zip_error_cb]', e.message); }
    try { res.destroy(err); } catch (e) { console.warn('[commission.bundle.res_destroy_on_zip_error]', e.message); }
  });
  zip.pipe(res);

  // Flat layout (every PDF at the ZIP root). Site is already in the
  // filename, but guard against collisions case-insensitively (Windows /
  // default macOS extraction treat case-only variants as the same file)
  // by suffixing the colliding entry with the site id.
  const usedNamesLower = new Set();
  for (const entry of enriched) {
    const rawSafe = path.basename(String(entry.filename || `commission-${entry.id}.pdf`))
      .replace(/[^A-Za-z0-9 \-_.]/g, '_').slice(0, 200);
    let safeFile = rawSafe;
    if (usedNamesLower.has(safeFile.toLowerCase())) {
      const siteShort = String(entry.site_id || `id${entry.id}`).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 16);
      const ext = path.extname(rawSafe);
      const base = rawSafe.slice(0, rawSafe.length - ext.length);
      safeFile = `${base}__${siteShort}${ext}`;
      let tiebreak = 2;
      while (usedNamesLower.has(safeFile.toLowerCase())) {
        safeFile = `${base}__${siteShort}__${tiebreak}${ext}`;
        tiebreak += 1;
      }
      console.warn(`[commission-bundle] Filename collision in ${periodYear}-${String(periodMonth).padStart(2, '0')} bundle: "${rawSafe}" already used; renaming site ${entry.site_id}'s copy to "${safeFile}".`);
    }
    usedNamesLower.add(safeFile.toLowerCase());
    zip.file(entry.file_path, { name: safeFile });
  }

  zip.finalize().catch((err) => {
    try { if (typeof onError === 'function') onError(err); } catch (e) { console.warn('[commission.bundle.finalize_error_cb]', e.message); }
    try { res.destroy(err); } catch (e) { console.warn('[commission.bundle.res_destroy_on_finalize_error]', e.message); }
  });

  return {
    ok: true,
    filename,
    archives: enriched.map((e) => ({ site_id: e.site_id, filename: e.filename })),
    missing_site_ids,
  };
}
