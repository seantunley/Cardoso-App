// Commission scheduler — fires on the 24th of each month, generating
// the commission report for the period (prev24 → cur23) and archiving
// the PDF. Site-only: HUB_MODE installs receive archives via push.
//
// Idempotency: at most one 'scheduled' row per (year, month), enforced
// by the unique partial index in migration v83. A boot-time catch-up
// (mirrors jtiScheduler.runBootCatchUp) backfills missed months when
// the site was offline at month-end.

import { buildCommissionReport } from '../commission.js';
import { buildCommissionPdf } from './commissionPdf.js';
import { archiveCommissionReport, hasScheduledArchive, commissionPeriodForRun } from './commissionArchive.js';
import { pushCommissionArchiveToHub } from './commissionHubPush.js';
import { logError } from '../../lib/errorLog.js';

function readDepotProfile(db) {
  try {
    const row = db.prepare(`SELECT name, city FROM depot_profile WHERE id = 1`).get();
    return { name: (row?.name || '').trim(), city: (row?.city || '').trim() };
  } catch (e) {
    console.warn('[commission.scheduler.depot_profile]', e.message);
    return { name: '', city: '' };
  }
}

/**
 * Generate + archive ONE period. Returns a structured result without
 * throwing on hub-push failure (matches jtiScheduler behaviour).
 *
 * @param {object} args
 * @param {import('better-sqlite3').Database} args.db
 * @param {number} args.year     period_year — the calendar year of the END date
 * @param {number} args.month    1..12 — the calendar month of the END date
 * @param {(args: any) => Promise<any>} [args.pushToHub]
 */
export async function generateAndArchiveCommissionPeriod({
  db, year, month, pushToHub = pushCommissionArchiveToHub,
}) {
  if (hasScheduledArchive({ db, periodYear: year, periodMonth: month })) {
    return { status: 'skipped', reason: 'already_archived' };
  }

  // Compute from/to using the (year, month) directly rather than "now",
  // so catch-up runs target the right month even if today is the 25th.
  const pad = (n) => String(n).padStart(2, '0');
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear  = month === 1 ? year - 1 : year;
  const fromDate = `${prevYear}-${pad(prevMonth)}-24`;
  const toDate   = `${year}-${pad(month)}-23`;

  let report;
  try {
    report = await buildCommissionReport({ from: fromDate, to: toDate });
  } catch (err) {
    return { status: 'skipped', reason: `report_query_failed: ${err.message}` };
  }

  const { name: depotName, city: depotCity } = readDepotProfile(db);
  let pdfBuffer;
  try {
    pdfBuffer = buildCommissionPdf({ depotName, report });
  } catch (err) {
    return { status: 'skipped', reason: `pdf_build_failed: ${err.message}` };
  }

  // Filename uses the city alone (e.g. "Johannesburg") — full depot
  // name with "Cardoso Cigarettes" prefix is too long for a filename
  // and is already in the PDF heading.
  const filenamePrefix = depotCity ? `${depotCity} Commission` : 'Commission';
  const filename = `${filenamePrefix} ${fromDate} to ${toDate}.pdf`;

  const archiveRow = archiveCommissionReport({
    db,
    archive: {
      buffer: pdfBuffer,
      filename,
      periodYear: year,
      periodMonth: month,
      periodFrom: fromDate,
      periodTo: toDate,
      source: 'scheduled',
      generatedBy: 'system:scheduled',
      reportJson: report,
      siteLabel: depotName,
    },
  });

  let pushResult = null;
  try {
    pushResult = await pushToHub({ db, archive: archiveRow });
  } catch (err) {
    console.error(`[commission-scheduler] push for #${archiveRow.id} threw: ${err.message}`);
  }

  return {
    status: 'archived',
    archiveId: archiveRow.id,
    filename,
    period: { from: fromDate, to: toDate },
    push: pushResult ? { status: pushResult.status, error: pushResult.error } : null,
  };
}

/**
 * The 24th-of-each-month cron handler. Fires for the CURRENT calendar
 * month — i.e. running on 2026-05-24 produces the May commission
 * archive covering Apr 24 → May 23.
 */
export async function runScheduledMonthlyCommissionJob({ db, now = new Date() }) {
  const period = commissionPeriodForRun(now);
  console.log(`[commission-scheduler] monthly run firing for ${period.year}-${String(period.month).padStart(2, '0')} (${period.fromDate} → ${period.toDate})`);
  const result = await generateAndArchiveCommissionPeriod({
    db, year: period.year, month: period.month,
  });
  if (result.status === 'archived') {
    console.log(`[commission-scheduler] archived ${period.year}-${String(period.month).padStart(2, '0')} as #${result.archiveId}`);
  } else {
    console.log(`[commission-scheduler] skipped ${period.year}-${String(period.month).padStart(2, '0')}: ${result.reason}`);
  }
  return { period, ...result };
}

/**
 * Catch-up: walk back `monthsBack` months and archive any whose
 * 'scheduled' row is missing. Same shape as jtiScheduler.runBootCatchUp.
 */
export async function runCommissionBootCatchUp({ db, now = new Date(), monthsBack = 12 }) {
  const periods = [];
  let cursor = commissionPeriodForRun(now);
  // The first iteration shouldn't include the CURRENT month if today is
  // earlier than the 24th — that period isn't complete yet.
  for (let i = 0; i < monthsBack; i++) {
    periods.push({ year: cursor.year, month: cursor.month });
    const prevMonth = cursor.month === 1 ? 12 : cursor.month - 1;
    const prevYear  = cursor.month === 1 ? cursor.year - 1 : cursor.year;
    cursor = { year: prevYear, month: prevMonth };
  }
  // Don't include a period whose end-date (cur.23rd) is in the future.
  const today = now.toISOString().slice(0, 10);
  const eligible = periods.filter(p => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${p.year}-${pad(p.month)}-23` <= today;
  });
  eligible.reverse(); // oldest first

  const archived = [];
  const skipped = [];
  for (const { year, month } of eligible) {
    if (hasScheduledArchive({ db, periodYear: year, periodMonth: month })) {
      skipped.push({ year, month, reason: 'already_archived' });
      continue;
    }
    try {
      const r = await generateAndArchiveCommissionPeriod({ db, year, month });
      if (r.status === 'archived') archived.push({ year, month, archiveId: r.archiveId });
      else skipped.push({ year, month, reason: r.reason });
    } catch (err) {
      console.error(`[commission-scheduler.catchup] ${year}-${String(month).padStart(2, '0')} failed: ${err.message}`);
      try { logError('commission.scheduler.catchup', err, { year, month }); }
      catch (e) { console.error('[commission.scheduler.catchup.log]', e.message); }
      return { archived, skipped, failed: { year, month, error: err.message } };
    }
  }
  return { archived, skipped, failed: null };
}
