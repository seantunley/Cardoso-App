// JTI hub push — site-side. Sends a freshly-archived .xlsx (and its
// metadata) to the hub via POST /api/reporting/jti/archive, then
// updates jti_archive.hub_push_* columns to reflect the outcome.
//
// State machine (mirrored in migration v70):
//   pending        → never attempted (fresh row from archiveJtiExport)
//   pushed         → hub acknowledged receipt
//   failed         → push attempted, hub returned error or unreachable;
//                    hub_push_attempts incremented; retry job picks
//                    it up next tick
//   skipped_no_hub → site isn't configured for hub mode (no
//                    HUB_URL/REPORTING_TOKEN); won't be retried by
//                    pushPendingArchives
//
// The hub-side mirror (hub_jti_archive) dedups on (site_id, sha256),
// so a push retry that reaches the hub after a successful prior push
// won't double-insert — the second receive returns 200 with the
// existing hub id, and the site simply records a redundant 'pushed'.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logError } from '../../lib/errorLog.js';
import { getHubSyncBaseUrl } from '../creditLogic.js';

// Re-tries are scheduled by jtiScheduler's pushRetry tick. Cap on
// attempts before we stop logging loudly — a row that's failed 20
// times in a row is almost certainly a config issue (bad token,
// hub down for days), not a transient network blip.
const VERBOSE_LOG_ATTEMPT_CAP = 5;

/**
 * @typedef {Object} JtiHubPushResult
 * @property {number} archiveId
 * @property {'pushed' | 'failed' | 'skipped_no_hub'} status
 * @property {number} [httpStatus]
 * @property {string} [error]
 * @property {number} [hubArchiveId]
 */

/**
 * Push a single archive row to the hub. Updates the row's hub_push_*
 * columns based on outcome. Resolves with a structured result; never
 * throws (even on network error) — the caller's lifecycle wrapper
 * uses the result.status field to decide what to log.
 *
 * @param {object} args
 * @param {import('better-sqlite3').Database} args.db
 * @param {{id:number,filename:string,file_path:string,sha256:string,
 *          period_year:number,period_month:number,source:string,
 *          generated_at:string,generated_by:string|null,row_count:number,
 *          town_city:string|null,region:string|null,country:string|null,
 *          site_label:string|null,byte_size:number}} args.archive
 * @param {string} [args.hubUrl]              defaults to getHubSyncBaseUrl()
 * @param {string} [args.reportingToken=process.env.REPORTING_TOKEN]
 * @param {string} [args.siteId=process.env.SITE_ID]
 * @param {(...args: any[]) => Promise<Response>} [args.fetchImpl]
 * @returns {Promise<JtiHubPushResult>}
 */
export async function pushArchiveToHub({
  db,
  archive,
  // Resolve via the same helper the rest of the system uses
  // (bat_settings.hub_sync_url with env-var fallbacks). Reading
  // process.env.HUB_URL directly is a footgun — sites set the hub URL
  // through Settings → TLS, not .env, so a direct env read returns
  // empty on every real production install and the push silently
  // marks every archive 'skipped_no_hub'.
  //
  // Caller-provided `hubUrl` still wins (used by tests) — the default
  // only fires when undefined is passed.
  hubUrl,
  reportingToken = process.env.REPORTING_TOKEN,
  siteId = process.env.SITE_ID,
  fetchImpl = globalThis.fetch,
}) {
  if (hubUrl === undefined) {
    try { hubUrl = getHubSyncBaseUrl(); } catch { hubUrl = ''; }
  }
  if (!archive || !archive.id) {
    throw new TypeError('pushArchiveToHub: archive (with id) is required');
  }

  // No hub configured — mark and return without retrying.
  if (!hubUrl || !reportingToken) {
    db.prepare(`
      UPDATE jti_archive
      SET hub_push_status = 'skipped_no_hub',
          hub_push_at     = datetime('now'),
          hub_push_error  = ?
      WHERE id = ?
    `).run(
      !hubUrl
        ? 'HUB_URL env not configured on this site — JTI archives won\'t be pushed to a central hub.'
        : 'REPORTING_TOKEN env not configured on this site — JTI archives won\'t be pushed (hub would reject anyway).',
      archive.id,
    );
    return { archiveId: archive.id, status: 'skipped_no_hub' };
  }

  if (!fs.existsSync(archive.file_path)) {
    const msg = `Archive file missing on disk: ${archive.file_path}`;
    recordFailure(db, archive, msg);
    return { archiveId: archive.id, status: 'failed', error: msg };
  }

  // Hub URL: trim trailing slash, append /api/hub/receive-jti-archive.
  // Mirrors the existing site→hub pattern (notify-backup-ready,
  // receive-users, receive-rules) — auth via x-reporting-token,
  // body is multipart for the .xlsx + metadata fields.
  const targetUrl = hubUrl.replace(/\/+$/, '') + '/api/hub/receive-jti-archive';

  let response;
  try {
    // Manual multipart so we don't pull in form-data / undici quirks.
    // The hub side uses multer.single('file'); we mirror its expected
    // field name + add the metadata fields as form parts.
    const boundary = '----jti-archive-' + crypto.randomBytes(16).toString('hex');
    const fileBytes = fs.readFileSync(archive.file_path);
    const body = buildMultipartBody({
      boundary,
      fields: {
        site_id:        siteId || '',
        site_archive_id: String(archive.id),
        period_year:    String(archive.period_year),
        period_month:   String(archive.period_month),
        generated_at:   archive.generated_at,
        generated_by:   archive.generated_by || '',
        source:         archive.source,
        row_count:      String(archive.row_count),
        sha256:         archive.sha256,
        byte_size:      String(archive.byte_size),
        town_city:      archive.town_city || '',
        region:         archive.region || '',
        country:        archive.country || '',
        site_label:     archive.site_label || '',
      },
      file: {
        field: 'file',
        filename: archive.filename,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes: fileBytes,
      },
    });
    response = await fetchImpl(targetUrl, {
      method: 'POST',
      headers: {
        'x-reporting-token': reportingToken,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
      body,
    });
  } catch (err) {
    // Network-level error (DNS, ECONNREFUSED, TLS, etc.) — record
    // as failed; retry job will pick this up.
    const msg = `Network error reaching hub at ${targetUrl}: ${err.message}`;
    recordFailure(db, archive, msg);
    if (archive.hub_push_attempts < VERBOSE_LOG_ATTEMPT_CAP) {
      console.error(`[jti-push] archive #${archive.id} → hub: ${msg}`);
      try { logError('jti.hub_push', err, { archiveId: archive.id, url: targetUrl }); } catch {}
    }
    return { archiveId: archive.id, status: 'failed', error: msg };
  }

  if (!response.ok) {
    let body = '';
    try { body = await response.text(); } catch {}
    const msg = `Hub returned HTTP ${response.status}${body ? `: ${truncate(body, 300)}` : ''}`;
    recordFailure(db, archive, msg);
    if (archive.hub_push_attempts < VERBOSE_LOG_ATTEMPT_CAP) {
      console.error(`[jti-push] archive #${archive.id} → hub ${response.status}: ${truncate(body, 200)}`);
    }
    return { archiveId: archive.id, status: 'failed', httpStatus: response.status, error: msg };
  }

  let parsed = null;
  try { parsed = await response.json(); } catch { /* hub returned non-JSON 200 — still ok */ }

  db.prepare(`
    UPDATE jti_archive
    SET hub_push_status   = 'pushed',
        hub_push_at       = datetime('now'),
        hub_push_error    = NULL,
        hub_push_attempts = hub_push_attempts + 1
    WHERE id = ?
  `).run(archive.id);

  console.log(`[jti-push] archive #${archive.id} (${archive.filename}) → hub OK${parsed?.hubArchiveId ? ` (hub id ${parsed.hubArchiveId})` : ''}`);
  return {
    archiveId: archive.id,
    status: 'pushed',
    hubArchiveId: parsed?.hubArchiveId,
    httpStatus: response.status,
  };
}

function recordFailure(db, archive, message) {
  db.prepare(`
    UPDATE jti_archive
    SET hub_push_status   = 'failed',
        hub_push_at       = datetime('now'),
        hub_push_error    = ?,
        hub_push_attempts = hub_push_attempts + 1
    WHERE id = ?
  `).run(truncate(message, 1000), archive.id);
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Scan for archive rows in the pending/failed states and push each
 * one. Used by the periodic retry tick AND by the post-archive
 * "push immediately" trigger after a successful generate.
 *
 * The scan is bounded by a max attempt cap — a row that's failed 50
 * times is almost certainly a permanent issue (bad sha256 the hub
 * keeps rejecting, etc.); leaving it in the queue would mean it
 * gets retried forever and dominates the log. After the cap we leave
 * it in 'failed' but stop attempting; the operator sees it stuck in
 * the UI and can investigate.
 *
 * @param {object} args
 * @param {import('better-sqlite3').Database} args.db
 * @param {number} [args.maxAttempts=50]
 * @param {number} [args.batchSize=10]   how many to push per tick
 * @param {string} [args.hubUrl]
 * @param {string} [args.reportingToken]
 * @param {string} [args.siteId]
 * @param {(...args: any[]) => Promise<Response>} [args.fetchImpl]
 * @returns {Promise<{ pushed: number, failed: number, skipped: number, considered: number }>}
 */
export async function pushPendingArchives({
  db,
  maxAttempts = 50,
  batchSize = 10,
  hubUrl,
  reportingToken,
  siteId,
  fetchImpl,
}) {
  // Resolve hub URL here too — if no hub is configured we should skip
  // the whole scan rather than walking rows just to re-mark each one
  // 'skipped_no_hub'. That also tells us whether to include rows
  // currently marked 'skipped_no_hub' in this tick: when the operator
  // FIRST configures the hub URL (Settings → TLS), previously-archived
  // rows are sitting at 'skipped_no_hub' and would otherwise stay that
  // way forever (the old scan only included pending/failed). Re-
  // including them when a hub URL is now resolvable means the catch-up
  // happens automatically on the next 15-min retry tick.
  let effectiveHubUrl = hubUrl;
  if (effectiveHubUrl === undefined) {
    try { effectiveHubUrl = getHubSyncBaseUrl(); } catch { effectiveHubUrl = ''; }
  }
  const effectiveToken = reportingToken !== undefined ? reportingToken : process.env.REPORTING_TOKEN;
  const hubReachable = !!(effectiveHubUrl && effectiveToken);

  const statusList = hubReachable
    ? ['pending', 'failed', 'skipped_no_hub']
    : ['pending', 'failed'];
  const placeholders = statusList.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT * FROM jti_archive
    WHERE hub_push_status IN (${placeholders})
      AND hub_push_attempts < ?
    ORDER BY hub_push_status DESC, period_year ASC, period_month ASC, id ASC
    LIMIT ?
  `).all(...statusList, maxAttempts, batchSize);

  let pushed = 0, failed = 0, skipped = 0;
  for (const archive of rows) {
    const result = await pushArchiveToHub({
      db, archive,
      hubUrl: effectiveHubUrl,
      reportingToken: effectiveToken,
      siteId,
      fetchImpl,
    });
    if (result.status === 'pushed') pushed++;
    else if (result.status === 'failed') failed++;
    else skipped++;
  }
  return { pushed, failed, skipped, considered: rows.length };
}

/**
 * Construct a multipart/form-data body as a single Buffer. Used
 * instead of FormData so that:
 *   (1) we control exact bytes (Content-Length is reliable);
 *   (2) tests can run with a stub fetch that just inspects the body
 *       directly without needing FormData parsing infrastructure;
 *   (3) no third-party form-data dep needed.
 */
function buildMultipartBody({ boundary, fields, file }) {
  const CRLF = '\r\n';
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}` +
      `${value}${CRLF}`
    ));
  }
  parts.push(Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"${CRLF}` +
    `Content-Type: ${file.contentType}${CRLF}${CRLF}`
  ));
  parts.push(file.bytes);
  parts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`));
  return Buffer.concat(parts);
}
