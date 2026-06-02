// Commission hub push — site → hub. Identical state machine to
// jtiHubPush (v70 design), distinct target URL + multipart fields.

import fs from 'fs';
import crypto from 'crypto';
import { logError } from '../../lib/errorLog.js';
import { getHubSyncBaseUrl } from '../creditLogic.js';

const VERBOSE_LOG_ATTEMPT_CAP = 5;

export async function pushCommissionArchiveToHub({
  db, archive,
  hubUrl,
  reportingToken = process.env.REPORTING_TOKEN,
  siteId = process.env.SITE_ID,
  fetchImpl = globalThis.fetch,
}) {
  if (hubUrl === undefined) {
    try { hubUrl = getHubSyncBaseUrl(); } catch { hubUrl = ''; }
  }
  if (!archive?.id) throw new TypeError('pushCommissionArchiveToHub: archive (with id) is required');

  if (!hubUrl || !reportingToken) {
    db.prepare(`
      UPDATE commission_archive
      SET hub_push_status = 'skipped_no_hub',
          hub_push_at = datetime('now'),
          hub_push_error = ?
      WHERE id = ?
    `).run(
      !hubUrl
        ? 'HUB_URL not configured on this site — commission archives won\'t be pushed.'
        : 'REPORTING_TOKEN not configured on this site — commission archives won\'t be pushed.',
      archive.id,
    );
    return { archiveId: archive.id, status: 'skipped_no_hub' };
  }

  if (!fs.existsSync(archive.file_path)) {
    const msg = `Archive PDF missing on disk: ${archive.file_path}`;
    recordFailure(db, archive, msg);
    return { archiveId: archive.id, status: 'failed', error: msg };
  }

  const targetUrl = hubUrl.replace(/\/+$/, '') + '/api/hub/receive-commission-archive';

  let response;
  try {
    const boundary = '----commission-archive-' + crypto.randomBytes(16).toString('hex');
    const fileBytes = fs.readFileSync(archive.file_path);
    const body = buildMultipartBody({
      boundary,
      fields: {
        site_id:         siteId || '',
        site_archive_id: String(archive.id),
        period_year:     String(archive.period_year),
        period_month:    String(archive.period_month),
        period_from:     archive.period_from,
        period_to:       archive.period_to,
        generated_at:    archive.generated_at,
        generated_by:    archive.generated_by || '',
        source:          archive.source,
        sha256:          archive.sha256,
        byte_size:       String(archive.byte_size),
        site_label:      archive.site_label || '',
        report_json:     archive.report_json,
      },
      file: {
        field: 'file',
        filename: archive.filename,
        contentType: 'application/pdf',
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
    const msg = `Network error reaching hub at ${targetUrl}: ${err.message}`;
    recordFailure(db, archive, msg);
    if (archive.hub_push_attempts < VERBOSE_LOG_ATTEMPT_CAP) {
      console.error(`[commission-push] archive #${archive.id} → hub: ${msg}`);
      try { logError('commission.hub_push', err, { archiveId: archive.id, url: targetUrl }); }
      catch (e) { console.error('[commission.hub_push.log]', { archiveId: archive.id }, e.message); }
    }
    return { archiveId: archive.id, status: 'failed', error: msg };
  }

  if (!response.ok) {
    let body = '';
    try { body = await response.text(); }
    catch (e) { console.warn('[commission.hub_push.body_read]', e.message); }
    const msg = `Hub returned HTTP ${response.status}${body ? `: ${truncate(body, 300)}` : ''}`;
    recordFailure(db, archive, msg);
    if (archive.hub_push_attempts < VERBOSE_LOG_ATTEMPT_CAP) {
      console.error(`[commission-push] archive #${archive.id} → hub ${response.status}: ${truncate(body, 200)}`);
    }
    return { archiveId: archive.id, status: 'failed', httpStatus: response.status, error: msg };
  }

  let parsed = null;
  try { parsed = await response.json(); }
  catch (e) { console.warn('[commission.hub_push.parse_response]', e.message); }

  db.prepare(`
    UPDATE commission_archive
    SET hub_push_status = 'pushed',
        hub_push_at = datetime('now'),
        hub_push_error = NULL,
        hub_push_attempts = hub_push_attempts + 1
    WHERE id = ?
  `).run(archive.id);

  console.log(`[commission-push] archive #${archive.id} (${archive.filename}) → hub OK${parsed?.hubArchiveId ? ` (hub id ${parsed.hubArchiveId})` : ''}`);
  return { archiveId: archive.id, status: 'pushed', hubArchiveId: parsed?.hubArchiveId, httpStatus: response.status };
}

function recordFailure(db, archive, message) {
  db.prepare(`
    UPDATE commission_archive
    SET hub_push_status = 'failed',
        hub_push_at = datetime('now'),
        hub_push_error = ?,
        hub_push_attempts = hub_push_attempts + 1
    WHERE id = ?
  `).run(truncate(message, 1000), archive.id);
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export async function pushPendingCommissionArchives({
  db, maxAttempts = 50, batchSize = 10,
  hubUrl, reportingToken, siteId, fetchImpl,
}) {
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
    SELECT * FROM commission_archive
    WHERE hub_push_status IN (${placeholders})
      AND hub_push_attempts < ?
    ORDER BY
      CASE hub_push_status
        WHEN 'pending'        THEN 0
        WHEN 'failed'         THEN 1
        WHEN 'skipped_no_hub' THEN 2
        ELSE 99
      END,
      period_year ASC, period_month ASC, id ASC
    LIMIT ?
  `).all(...statusList, maxAttempts, batchSize);

  let pushed = 0, failed = 0, skipped = 0;
  for (const archive of rows) {
    const result = await pushCommissionArchiveToHub({
      db, archive, hubUrl: effectiveHubUrl, reportingToken: effectiveToken, siteId, fetchImpl,
    });
    if (result.status === 'pushed') pushed++;
    else if (result.status === 'failed') failed++;
    else skipped++;
  }
  return { pushed, failed, skipped, considered: rows.length };
}

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
