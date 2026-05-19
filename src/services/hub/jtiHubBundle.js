// Hub-side per-month bundle service. Groups hub_jti_archive rows by
// (period_year, period_month) and renders a completeness summary
// (received_count vs expected_count from HUB_SITES). When every
// configured site has reported, streams a single ZIP containing all
// of them.
//
// Why this exists: the existing flat list on HubJti.jsx is fine for
// "did the latest one arrive", but the operator's actual question is
// "do I have a complete monthly set yet, so I can ship it to JTI as
// one package?" Bundling is just a presentation choice — the source
// of truth is hub_jti_archive — but bundling the download means an
// operator can grab a complete month with one click.
//
// Latest-version semantics: for each (site_id, period_year, period_month)
// we take the MOST RECENT archive (highest received_at). Sites can
// re-run an archive (different bytes → new sha256 → new row); the
// bundle should ship the latest version.

import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';

// archiver 8 dropped the legacy `archiver('zip', opts)` factory in
// favour of explicit format classes. The runtime exports an object
// with { Archiver, ZipArchive, TarArchive, JsonArchive } — instantiate
// ZipArchive directly. createRequire is the cleanest way to reach the
// CJS module from this ESM file without ESM-default-interop surprises.
const requireCjs = createRequire(import.meta.url);
const { ZipArchive } = requireCjs('archiver');

/**
 * Group hub_jti_archive rows by (year, month) with completeness vs HUB_SITES.
 *
 * @param {{ db: import('better-sqlite3').Database, sites: Array<{id:string,name?:string}>, limit?: number }} args
 * @returns {Array<{
 *   period_year: number,
 *   period_month: number,
 *   expected_count: number,
 *   received_count: number,
 *   complete: boolean,
 *   missing_site_ids: string[],
 *   received: Array<{
 *     id: number, site_id: string, filename: string, byte_size: number,
 *     sha256: string, source: 'scheduled'|'manual', received_at: string,
 *     received_via: 'push'|'pull', row_count: number,
 *   }>,
 * }>}
 */
export function listArchiveGroups({ db, sites, limit = 60 }) {
  const expectedSiteIds = (sites || [])
    .map((s) => (s && s.id ? String(s.id) : null))
    .filter(Boolean);
  const expectedSet = new Set(expectedSiteIds);
  const expectedCount = expectedSiteIds.length;

  // Latest archive per (site_id, period). MAX(id) is safe — id is
  // monotonic; we INSERT then UPDATE the file_path inside one
  // transaction, so a higher id is always a later receipt.
  const latestRows = db.prepare(`
    SELECT period_year, period_month, site_id, MAX(id) AS latest_id
    FROM hub_jti_archive
    GROUP BY period_year, period_month, site_id
  `).all();

  // Group: period → { received: [archive rows], missing: [site_ids] }
  // Iterate latestRows once, fetch the full row per latest_id.
  const fetchOne = db.prepare(`SELECT * FROM hub_jti_archive WHERE id = ?`);
  const groupsByKey = new Map();
  for (const r of latestRows) {
    const key = `${r.period_year}-${String(r.period_month).padStart(2, '0')}`;
    if (!groupsByKey.has(key)) {
      groupsByKey.set(key, {
        period_year: r.period_year,
        period_month: r.period_month,
        received_by_site: new Map(),
      });
    }
    const full = fetchOne.get(r.latest_id);
    if (full) groupsByKey.get(key).received_by_site.set(r.site_id, full);
  }

  // Convert each group into the response shape, computing missing sites.
  // Sort periods by latest-first so the UI's typical render order
  // (most recent month at the top) matches the data order.
  const groups = Array.from(groupsByKey.values())
    .map((g) => {
      const received = Array.from(g.received_by_site.values())
        .map((row) => ({
          id: row.id,
          site_id: row.site_id,
          filename: row.filename,
          byte_size: row.byte_size,
          sha256: row.sha256,
          source: row.source,
          received_at: row.received_at,
          received_via: row.received_via,
          row_count: row.row_count,
        }))
        // Stable per-site order so the UI table reads consistently
        // across renders even when received_at order changes.
        .sort((a, b) => a.site_id.localeCompare(b.site_id));

      const received_site_ids = new Set(received.map((r) => r.site_id));
      const missing_site_ids = expectedSiteIds.filter((id) => !received_site_ids.has(id));
      // Orphan archives — sites that aren't in HUB_SITES anymore. We
      // still show them individually (their rows are in `received`),
      // but they don't count toward completeness; a removed site
      // shouldn't keep prior months "complete by historical accident".
      const orphan_site_ids = Array.from(received_site_ids).filter((id) => !expectedSet.has(id));

      const expected_received_count = received.filter((r) => expectedSet.has(r.site_id)).length;
      return {
        period_year: g.period_year,
        period_month: g.period_month,
        expected_count: expectedCount,
        received_count: expected_received_count,
        complete: expectedCount > 0 && expected_received_count === expectedCount,
        missing_site_ids,
        orphan_site_ids,
        received,
      };
    })
    .sort((a, b) => {
      if (a.period_year !== b.period_year) return b.period_year - a.period_year;
      return b.period_month - a.period_month;
    })
    .slice(0, limit);

  return groups;
}

/**
 * Stream the bundle for one period as a ZIP. Refuses with structured
 * info when the period isn't complete (so the route can return 409 +
 * a human-readable reason).
 *
 * The caller is responsible for the audit row. We never throw on
 * archiver errors — those are forwarded into the response stream
 * (where the operator's browser shows a truncated download), and the
 * `error` event hook calls the supplied `onError` once for the audit
 * trail.
 *
 * @param {{
 *   db: any,
 *   sites: Array<{id:string,name?:string}>,
 *   periodYear: number,
 *   periodMonth: number,
 *   res: import('http').ServerResponse,
 *   onError?: (err: Error) => void,
 * }} args
 * @returns {{ ok: true, filename: string, archives: Array<{site_id:string, filename:string}> } | { ok: false, code: string, message: string, missing_site_ids?: string[], expected_count?: number, received_count?: number }}
 *
 * Returns an outcome SYNCHRONOUSLY. Side-effects (response headers +
 * stream finalize) only happen on the ok=true branch; the caller
 * writes its own status/body on the ok=false branch.
 */
export function streamArchiveBundle({ db, sites, periodYear, periodMonth, res, onError }) {
  if (!Number.isInteger(periodYear) || periodYear < 2000 || periodYear > 2100) {
    return { ok: false, code: 'BAD_PERIOD', message: `periodYear ${periodYear} out of range` };
  }
  if (!Number.isInteger(periodMonth) || periodMonth < 1 || periodMonth > 12) {
    return { ok: false, code: 'BAD_PERIOD', message: `periodMonth ${periodMonth} out of range` };
  }

  // Re-use the grouping logic so the completeness check matches the
  // listing endpoint EXACTLY. If we computed it differently here the
  // UI could show "complete" but the download would 409.
  const groups = listArchiveGroups({ db, sites, limit: 10_000 });
  const group = groups.find((g) => g.period_year === periodYear && g.period_month === periodMonth);

  if (!group) {
    return {
      ok: false,
      code: 'PERIOD_EMPTY',
      message: `No archives received for ${periodYear}-${String(periodMonth).padStart(2, '0')} yet.`,
      received_count: 0,
      expected_count: sites?.length ?? 0,
      missing_site_ids: (sites || []).map((s) => s.id),
    };
  }
  if (!group.complete) {
    return {
      ok: false,
      code: 'INCOMPLETE',
      message: `Bundle not ready — ${group.received_count}/${group.expected_count} sites have reported. Missing: ${group.missing_site_ids.join(', ') || '(none configured)'}`,
      received_count: group.received_count,
      expected_count: group.expected_count,
      missing_site_ids: group.missing_site_ids,
    };
  }

  // Filter to the EXPECTED sites only — orphan archives (received from
  // a site no longer in HUB_SITES) don't go into the bundle, so the
  // operator hands over a clean per-site set that matches the current
  // configuration. They're still individually downloadable via the
  // per-row download endpoint.
  const expectedIds = new Set((sites || []).map((s) => s.id));
  const bundleEntries = group.received.filter((a) => expectedIds.has(a.site_id));

  // Surface missing-on-disk BEFORE we send headers, so a stale row can
  // still produce a clean 410. Once we've called res.setHeader+pipe,
  // any error during stream lands as a truncated browser download —
  // which is what `error` event below handles for run-time failures.
  const enrichedEntries = [];
  for (const a of bundleEntries) {
    const row = db.prepare(`SELECT file_path FROM hub_jti_archive WHERE id = ?`).get(a.id);
    if (!row || !fs.existsSync(row.file_path)) {
      return {
        ok: false,
        code: 'FILE_MISSING',
        message: `hub_jti_archive #${a.id} (site=${a.site_id}, ${a.filename}) is recorded but missing on disk at ${row?.file_path || 'unknown path'}. Bundle aborted.`,
        missing_archive_id: a.id,
        missing_site_id: a.site_id,
      };
    }
    enrichedEntries.push({ ...a, file_path: row.file_path });
  }

  const filename = `JTI_Bundle_${periodYear}-${String(periodMonth).padStart(2, '0')}.zip`;

  // Headers FIRST — once we pipe the archiver, the response is live.
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');

  const zip = new ZipArchive({ zlib: { level: 9 } });
  zip.on('error', (err) => {
    try { if (typeof onError === 'function') onError(err); } catch {}
    // res is already a streaming response; the only thing we can do
    // here is destroy the underlying socket so the client sees the
    // download as failed instead of receiving a half-truncated ZIP
    // that decompresses to corrupt files.
    try { res.destroy(err); } catch {}
  });
  zip.pipe(res);

  // Layout inside the ZIP: flat — every spreadsheet at the root, no
  // site folders. Operator-requested 2026-05-19: the per-site UUID
  // folders the previous layout produced made the unzipped bundle
  // awkward to hand to JTI (operator had to drag-extract each file).
  // Filenames already embed the site (e.g.
  // JTI_Cardoso_Sales_Ermelo_YYYYMMDD.xlsx) so collisions are rare.
  //
  // Defensive collision guard: when a site has no site_label set,
  // buildJtiFilename falls back to "Unknown" (jtiFilename.js:32+37),
  // so two unlabeled sites can produce identical filenames. The
  // previous <site_id>/ prefix was the only guard against that;
  // dropping it would let one site's file silently overwrite the
  // other on extraction. If a collision IS detected, suffix the
  // colliding entry with __<site_id_short> before the extension so
  // both files land in the bundle. Only kicks in on actual
  // collision — the happy path stays flat and clean.
  // Collision detection uses a case-insensitive key (lowercased) so
  // case-only variants ("Ermelo" vs "ermelo") still trigger the
  // rename branch. Windows and default macOS extraction treat such
  // names as the same file in the same directory — without a
  // normalised check the ZIP would carry two entries but extraction
  // would overwrite or prompt, dropping one site's spreadsheet. The
  // entry we actually write keeps its original case.
  const usedNamesLower = new Set();
  for (const entry of enrichedEntries) {
    const rawSafe = path.basename(String(entry.filename || `archive-${entry.id}.xlsx`))
      .replace(/[^A-Za-z0-9 \-_.]/g, '_').slice(0, 200);
    let safeFile = rawSafe;
    if (usedNamesLower.has(safeFile.toLowerCase())) {
      const siteShort = String(entry.site_id || `id${entry.id}`)
        .replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 16);
      const ext = path.extname(rawSafe);
      const base = rawSafe.slice(0, rawSafe.length - ext.length);
      safeFile = `${base}__${siteShort}${ext}`;
      // If even the suffixed name somehow collides (e.g. two sites
      // share the same id prefix after sanitisation), fall through
      // to a numeric tiebreaker so we never lose a file.
      let tiebreak = 2;
      while (usedNamesLower.has(safeFile.toLowerCase())) {
        safeFile = `${base}__${siteShort}__${tiebreak}${ext}`;
        tiebreak += 1;
      }
      console.warn(`[jti-bundle] Filename collision (case-insensitive) in ${periodYear}-${String(periodMonth).padStart(2, '0')} bundle: "${rawSafe}" already used; renaming site ${entry.site_id}'s copy to "${safeFile}". Set a unique site_label on this site to avoid the rename.`);
    }
    usedNamesLower.add(safeFile.toLowerCase());
    zip.file(entry.file_path, { name: safeFile });
  }

  zip.finalize().catch((err) => {
    try { if (typeof onError === 'function') onError(err); } catch {}
    try { res.destroy(err); } catch {}
  });

  return {
    ok: true,
    filename,
    archives: enrichedEntries.map((e) => ({ site_id: e.site_id, filename: e.filename })),
  };
}
