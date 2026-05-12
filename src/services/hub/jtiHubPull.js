// Hub-side JTI archive pull-fallback. The site pushes new archives
// to the hub immediately after generation (Phase 2 — see
// src/services/jti/jtiHubPush.js + src/routes/hub.js receive route),
// but a site can't push if it was offline / behind a NAT timeout /
// behind a hub that was down. This pull tick is the safety net:
// once a day, the hub asks every site for its archive list and
// fetches anything it doesn't already have.
//
// Dedup by sha256 — receiveJtiArchive's UNIQUE INDEX (site_id, sha256)
// makes a pull-fallback that races a successful push idempotent
// (the second arrival is a deduped 200, no double-write).

import { knownSha256ForSite, receiveJtiArchive } from './jtiHubReceive.js';
import { logError } from '../../lib/errorLog.js';

/**
 * Pull missing archives from a single site. Steps:
 *   1. GET <site.url>/api/jti/archive  → remote archive list
 *   2. Subtract sha256s the hub already has for this site
 *   3. For each missing archive, GET its bytes via
 *      /api/jti/archive/:id/download and stuff into receiveJtiArchive
 *      with received_via='pull'
 *
 * The site's /api/jti/archive endpoint is gated by can_access_jti +
 * requireAuth — but we're a server-to-server call, not a logged-in
 * user. So this endpoint won't reach us authentically right now.
 *
 * To make pull-fallback work, the site exposes a parallel
 * /api/reporting/jti/archives + /:id/download pair gated by
 * x-reporting-token (the same auth model the hub uses for backup
 * pulls today). The hub-side pull always uses those reporting routes,
 * not the user-facing /api/jti/* ones.
 *
 * @param {{ site: { id: string, url: string, token: string }, db: any, fetchImpl?: any }} args
 */
export async function pullMissingArchivesForSite({ site, db, fetchImpl = globalThis.fetch }) {
  if (!site?.id || !site?.url || !site?.token) {
    return { siteId: site?.id, status: 'skipped', reason: 'site_missing_fields' };
  }
  const baseUrl = String(site.url).replace(/\/+$/, '');
  const known = knownSha256ForSite({ db, siteId: site.id });

  let listed;
  try {
    const r = await fetchImpl(`${baseUrl}/api/reporting/jti/archives?limit=500`, {
      headers: { 'x-reporting-token': site.token },
    });
    if (!r.ok) {
      const body = await safeText(r);
      return {
        siteId: site.id,
        status: 'failed',
        reason: `list_http_${r.status}`,
        error: truncate(body, 300),
      };
    }
    listed = await r.json();
  } catch (err) {
    return { siteId: site.id, status: 'failed', reason: 'list_network', error: err.message };
  }

  const archives = Array.isArray(listed?.archives) ? listed.archives : [];
  const missing = archives.filter(a => a.sha256 && !known.has(a.sha256));
  if (missing.length === 0) {
    return { siteId: site.id, status: 'ok', listed: archives.length, missing: 0, pulled: 0 };
  }

  let pulled = 0;
  let failed = 0;
  for (const a of missing) {
    try {
      const dl = await fetchImpl(`${baseUrl}/api/reporting/jti/archives/${a.id}/download`, {
        headers: { 'x-reporting-token': site.token },
      });
      if (!dl.ok) {
        failed++;
        console.warn(`[jti-pull] site=${site.id} archive #${a.id} download HTTP ${dl.status}`);
        continue;
      }
      const buf = Buffer.from(await dl.arrayBuffer());
      receiveJtiArchive({
        db,
        archive: {
          siteId: site.id,
          siteArchiveId: a.id,
          buffer: buf,
          filename: a.filename,
          periodYear: a.period_year,
          periodMonth: a.period_month,
          generatedAt: a.generated_at,
          generatedBy: a.generated_by,
          source: a.source,
          rowCount: a.row_count,
          declaredSha256: a.sha256,
          declaredByteSize: a.byte_size,
          townCity: a.town_city,
          region: a.region,
          country: a.country,
          siteLabel: a.site_label,
          receivedVia: 'pull',
        },
      });
      pulled++;
    } catch (err) {
      failed++;
      console.error(`[jti-pull] site=${site.id} archive #${a.id} pull failed: ${err.message}`);
      try { logError('hub.jti_pull', err, { siteId: site.id, archiveId: a.id }); } catch {}
    }
  }
  return { siteId: site.id, status: failed > 0 ? 'partial' : 'ok', listed: archives.length, missing: missing.length, pulled, failed };
}

/**
 * Run the pull fallback against every site in the supplied list.
 * Returns per-site results so the cron lifecycle wrapper can land a
 * useful summary in job_runs.context.
 */
export async function pullMissingArchivesAll({ sites, db, fetchImpl }) {
  const results = [];
  for (const site of sites || []) {
    const r = await pullMissingArchivesForSite({ site, db, fetchImpl });
    results.push(r);
  }
  return {
    sitesProcessed: results.length,
    totalPulled: results.reduce((s, r) => s + (r.pulled || 0), 0),
    totalMissing: results.reduce((s, r) => s + (r.missing || 0), 0),
    results,
  };
}

async function safeText(r) {
  try { return await r.text(); } catch { return ''; }
}
function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}
