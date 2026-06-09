// JTI scheduler — generates a monthly JTI export at 02:00 on the 1st
// of every calendar month, for the PREVIOUS month, and archives it
// via jtiArchive. Also performs a boot-time catch-up that backfills
// up to 12 missed months — covers a site that was offline through
// month-end (power, network, app down) without manual operator action.
//
// Site-only: HUB_MODE installs don't run this. The hub doesn't have
// a Sage pool of its own; it receives archives pushed up from sites.
//
// Idempotency is enforced by hasScheduledArchive — if a row with
// source='scheduled' already exists for (year, month), the catch-up
// run skips that period. Manual exports for the same period stay,
// but the catch-up still produces the canonical 'scheduled' artefact.

import {
  archiveJtiExport,
  hasScheduledArchive,
} from './jtiArchive.js';
import { getJtiSettings } from './jtiSettings.js';
import { resolveSageQuery } from '../sage/queryRegistry.js';
import { queryJtiSales } from './jtiQuery.js';
import { buildJtiWorkbook } from './jtiSpreadsheet.js';
import { buildJtiFilename } from './jtiFilename.js';
import { pushArchiveToHub } from './jtiHubPush.js';
import { logError } from '../../lib/errorLog.js';

/**
 * Compute the (year, month) of the calendar month BEFORE `now`.
 * Used by the cron handler so a 1st-of-month run targets last month
 * regardless of what hour it fires at.
 *
 * @param {Date} [now]
 * @returns {{ year: number, month: number }}
 */
export function previousMonth(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1; // 1..12
  if (m === 1) return { year: y - 1, month: 12 };
  return { year: y, month: m - 1 };
}

function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function ymd(year, month, day) {
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

/**
 * Generate + archive ONE month, if not already archived as 'scheduled'.
 * Returns a result describing what happened — `skipped: 'already_archived'`
 * when a prior scheduled run covered the period, `skipped: 'no_pool'` when
 * JTI isn't routable, etc. Errors are surfaced (not swallowed) so the
 * caller can record them in job_runs / error_log.
 *
 * @param {object} args
 * @param {import('better-sqlite3').Database} args.db
 * @param {() => Promise<any>} args.getSagePool
 * @param {number} args.year
 * @param {number} args.month
 * @param {(args: any) => Promise<any>} [args.pushToHub]  injectable for tests
 * @returns {Promise<{ status: 'archived'|'skipped', reason?: string, archiveId?: number, rowCount?: number }>}
 */
export async function generateAndArchivePeriod({ db, getSagePool, year, month, pushToHub = pushArchiveToHub }) {
  if (hasScheduledArchive({ db, periodYear: year, periodMonth: month })) {
    return { status: 'skipped', reason: 'already_archived' };
  }

  const settings = getJtiSettings({ db });
  // Resolve the export SQL through the central Sage query registry (unified
  // override store, key 'jti.export'). Returns the operator override when set,
  // else DEFAULT_JTI_SQL — same result as the old settings.queryOverride path,
  // but edits made in Settings → Sage Queries now take effect here.
  const sqlOverride = resolveSageQuery('jti.export');

  let pool;
  try {
    pool = await getSagePool();
  } catch (err) {
    return { status: 'skipped', reason: `pool_unavailable: ${err.message}` };
  }

  const lastDay = lastDayOfMonth(year, month);
  const fromDate = ymd(year, month, 1);
  const toDate = ymd(year, month, lastDay);

  const rows = await queryJtiSales({ pool, fromDate, toDate, sqlOverride });
  const buffer = await buildJtiWorkbook({
    rows,
    manual: { townCity: settings.townCity, region: settings.region, country: settings.country },
  });
  const filename = buildJtiFilename({ site: settings.siteLabel, endDate: toDate });

  const archiveRow = archiveJtiExport({
    db,
    archive: {
      buffer,
      filename,
      periodYear: year,
      periodMonth: month,
      source: 'scheduled',
      generatedBy: 'system:scheduled',
      rowCount: rows.length,
      townCity: settings.townCity,
      region: settings.region,
      country: settings.country,
      siteLabel: settings.siteLabel,
    },
  });

  // Immediately try to push to the hub. Don't block on it (or
  // fail the whole archive if it doesn't go through) — the periodic
  // retry tick will pick it up if this attempt fails. Awaited here
  // (not fire-and-forget) so the lifecycle wrapper records the
  // push outcome in job_runs.context, but wrapped in try/catch
  // because pushArchiveToHub returning a 'failed' status is normal.
  let pushResult = null;
  try {
    pushResult = await pushToHub({ db, archive: archiveRow });
  } catch (err) {
    console.error(`[jti-scheduler] post-archive push threw for #${archiveRow.id}: ${err.message}`);
  }

  return {
    status: 'archived',
    archiveId: archiveRow.id,
    rowCount: rows.length,
    filename,
    push: pushResult ? { status: pushResult.status, error: pushResult.error } : null,
  };
}

/**
 * Run the 1st-of-month scheduled archive for the most-recent
 * complete month. Wrapped by the cron registration in startJtiScheduler.
 *
 * @param {object} args
 * @param {import('better-sqlite3').Database} args.db
 * @param {() => Promise<any>} args.getSagePool
 * @param {Date} [args.now]
 */
export async function runScheduledMonthlyJob({ db, getSagePool, now = new Date() }) {
  const { year, month } = previousMonth(now);
  console.log(`[jti-scheduler] monthly run firing for ${year}-${String(month).padStart(2, '0')}`);
  const result = await generateAndArchivePeriod({ db, getSagePool, year, month });
  if (result.status === 'archived') {
    console.log(`[jti-scheduler] archived ${year}-${String(month).padStart(2, '0')} as #${result.archiveId} (${result.rowCount} rows, ${result.filename})`);
  } else {
    console.log(`[jti-scheduler] skipped ${year}-${String(month).padStart(2, '0')}: ${result.reason}`);
  }
  return { period: { year, month }, ...result };
}

/**
 * Boot-time catch-up: walk back up to `monthsBack` months from `now`,
 * starting with the previous month, and archive any that haven't yet
 * been covered by a 'scheduled' row.
 *
 * Picks the missed months in chronological order so the oldest one
 * runs first — if the JTI pool is wedged or the SQL is broken, the
 * operator sees the failure on the OLDEST missing month rather than
 * having last-month succeed and only the deeper backfill fail.
 *
 * Stops on the first hard error (thrown by queryJtiSales etc.) and
 * returns the partial result. The intent is "get the recent ones
 * landed reliably first" rather than "best-effort across all 12 even
 * if half fail confusingly".
 *
 * @param {object} args
 * @param {import('better-sqlite3').Database} args.db
 * @param {() => Promise<any>} args.getSagePool
 * @param {Date} [args.now]
 * @param {number} [args.monthsBack=12]
 */
export async function runBootCatchUp({ db, getSagePool, now = new Date(), monthsBack = 12 }) {
  // Build a list of (year, month) from previous-month back monthsBack
  // total entries, oldest-first.
  const periods = [];
  let cursor = previousMonth(now);
  for (let i = 0; i < monthsBack; i++) {
    periods.push(cursor);
    cursor = previousMonth(new Date(cursor.year, cursor.month - 1, 1));
  }
  periods.reverse();

  // Pre-classify every period in the window so the result accounts
  // for ALL of them, not just the ones we attempted to archive.
  // already-archived periods land in `skipped` with reason
  // 'already_archived' so a caller can show "12/12 covered" cleanly.
  const archived = [];
  const skipped = [];
  const needed = [];
  for (const p of periods) {
    if (hasScheduledArchive({ db, periodYear: p.year, periodMonth: p.month })) {
      skipped.push({ ...p, reason: 'already_archived' });
    } else {
      needed.push(p);
    }
  }
  if (needed.length === 0) {
    console.log('[jti-scheduler] boot catch-up: nothing to backfill');
    return { archived, skipped, failed: null };
  }

  console.log(`[jti-scheduler] boot catch-up: ${needed.length} missed month(s) to backfill (${needed.map(p => `${p.year}-${String(p.month).padStart(2, '0')}`).join(', ')})`);
  for (const { year, month } of needed) {
    try {
      const result = await generateAndArchivePeriod({ db, getSagePool, year, month });
      if (result.status === 'archived') {
        console.log(`[jti-scheduler] catch-up archived ${year}-${String(month).padStart(2, '0')} as #${result.archiveId} (${result.rowCount} rows)`);
        archived.push({ year, month, archiveId: result.archiveId, rowCount: result.rowCount });
      } else {
        console.log(`[jti-scheduler] catch-up skipped ${year}-${String(month).padStart(2, '0')}: ${result.reason}`);
        skipped.push({ year, month, reason: result.reason });
        // pool unavailable is the one "skip" worth bailing on — every
        // subsequent period would skip for the same reason and we'd
        // spam System Log.
        if (typeof result.reason === 'string' && result.reason.startsWith('pool_unavailable')) {
          return { archived, skipped, failed: { year, month, error: result.reason } };
        }
      }
    } catch (err) {
      console.error(`[jti-scheduler] catch-up FAILED on ${year}-${String(month).padStart(2, '0')}: ${err.message}`);
      try { logError('jti.scheduler.catchup', err, { year, month }); } catch {} // eslint-disable-line no-empty -- logError wrapper; catch-up failure already logged to console above
      return { archived, skipped, failed: { year, month, error: err.message } };
    }
  }
  return { archived, skipped, failed: null };
}
