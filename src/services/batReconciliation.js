import sql from 'mssql';
import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import db from '../db/index.js';
import { decryptPassword } from './encryption.js';
import { getRoleConnectionId } from './connectionRoles.js';
import { logError } from '../lib/errorLog.js';
import { isoYear, currentIsoWeek } from '../lib/isoWeek.js';
import { matchCardosoToSupplier as matchCardosoToSupplierService } from './bat/matching.js';
import { buildGlobalDuplicateIndex as buildGlobalDuplicateIndexService } from './bat/duplicates.js';
import { findInvoiceNumber, HARDCODED_POISON_INVOICES } from './bat/findInvoiceNumber.js';

// Back-compat shim — see src/services/bat/matching.js. Existing callers
// pass a positional reconId; the new module takes `{ db, reconId }` so
// it can be unit-tested with an in-memory DB. New code should import
// directly from `./bat/matching.js` and pass `db` explicitly.
export function matchCardosoToSupplier(reconId = null) {
  return matchCardosoToSupplierService({ db, reconId });
}

// Status emitter for the SSE-based extraction-status stream. Worker emits
// 'update:<reconId>' after every invoice processed; subscribers (route
// handlers) translate that into Server-Sent Events to push to the browser.
export const extractionEvents = new EventEmitter();
extractionEvents.setMaxListeners(50); // multiple browser tabs can subscribe

// Throttle emits to at most one per THROTTLE_MS per recon. Without this,
// each OCR row produces 5–10 progress messages and each emit triggers
// every connected SSE listener to run getExtractionProgress() (2 sync
// SQLite SELECTs) and write JSON to its response. With multiple tabs /
// zombie listeners this saturated the main thread enough to stall
// unrelated requests (JPEG previews, etc.) until they hit Chrome's
// 6-per-origin connection limit and the operator had to close+reopen
// the tab to recover. Trailing-edge fire so the final "done" event
// always lands even if it arrives mid-throttle window.
const EMIT_THROTTLE_MS = 250;
const _emitState = new Map(); // reconId -> { lastFiredAt, pending }
function emitExtractionUpdate(reconId) {
  if (!reconId) return;
  const now = Date.now();
  const state = _emitState.get(reconId) || { lastFiredAt: 0, pending: null };
  const sinceLast = now - state.lastFiredAt;
  if (sinceLast >= EMIT_THROTTLE_MS) {
    state.lastFiredAt = now;
    _emitState.set(reconId, state);
    try { extractionEvents.emit(`update:${reconId}`); } catch {}
    return;
  }
  if (state.pending) return; // a trailing emit is already scheduled
  state.pending = setTimeout(() => {
    state.pending = null;
    state.lastFiredAt = Date.now();
    try { extractionEvents.emit(`update:${reconId}`); } catch {}
  }, EMIT_THROTTLE_MS - sinceLast);
  if (typeof state.pending.unref === 'function') state.pending.unref();
  _emitState.set(reconId, state);
}

// ── MSSQL Connection ─────────────────────────────────────────────────────────

let pool = null;
let poolConfigKey = null; // tracks which config the current pool was opened with

// Picks the Sage MSSQL config in this order:
//   1. The connection pinned to role 'bat_sage' in connection_role
//      (set via Settings → Connections → Module routing).
//   2. The databaseconnection row whose id matches bat_settings.sage_connection_id
//      (legacy — pre-dates the connection_role table).
//   3. The first active databaseconnection whose name matches /sage/i
//   4. SAGE_* environment variables (legacy)
function loadSageConfig() {
  // 1) Module-routing assignment, then 2) legacy bat_settings setting
  const pickedId = (() => {
    const fromRole = getRoleConnectionId('bat_sage');
    if (fromRole) return fromRole;
    try {
      const row = db.prepare(`SELECT value FROM bat_settings WHERE key = 'sage_connection_id'`).get();
      return row?.value ? parseInt(row.value, 10) : null;
    } catch { return null; }
  })();

  let row = null;
  if (pickedId) {
    row = db.prepare(`SELECT id, name, host, port, database_name, username, encrypted_password FROM databaseconnection WHERE id = ?`).get(pickedId);
  }

  // 2) Auto-pick by name
  if (!row) {
    row = db.prepare(`SELECT id, name, host, port, database_name, username, encrypted_password FROM databaseconnection WHERE status = 'active' AND LOWER(name) LIKE '%sage%' ORDER BY id LIMIT 1`).get();
  }

  if (row) {
    return {
      source: `databaseconnection#${row.id} (${row.name}) ${row.host}:${row.port || 1433}/${row.database_name}`,
      // Key includes host/port/db so a host change on the same row id reopens the pool
      key: `db:${row.id}:${row.host}:${row.port || 1433}:${row.database_name}:${row.username}`,
      config: {
        user: row.username,
        password: decryptPassword(row.encrypted_password),
        server: row.host,
        database: row.database_name,
        port: row.port || 1433,
        options: {
          encrypt: false,
          trustServerCertificate: true,
          enableArithAbort: true,
        },
        requestTimeout: 60000,
        connectionTimeout: 15000,
      },
    };
  }

  // 3) Env-var fallback
  if (process.env.SAGE_HOST) {
    return {
      source: 'env:SAGE_*',
      key: 'env',
      config: {
        user: process.env.SAGE_USER,
        password: process.env.SAGE_PASSWORD,
        server: process.env.SAGE_HOST,
        database: process.env.SAGE_DATABASE,
        port: parseInt(process.env.SAGE_PORT || '1433', 10),
        options: {
          encrypt: process.env.SAGE_ENCRYPT === 'true',
          trustServerCertificate: process.env.SAGE_TRUST_CERT !== 'false',
          enableArithAbort: true,
        },
        requestTimeout: 60000,
        connectionTimeout: 15000,
      },
    };
  }

  return null;
}

async function getSagePool() {
  const loaded = loadSageConfig();
  if (!loaded) {
    throw new Error('No Sage connection configured — add a databaseconnection with "sage" in its name, set bat_settings.sage_connection_id, or set SAGE_* env vars');
  }

  // Re-open pool if the config source changed under us, or if the cached pool
  // is no longer connected (idle timeout, network blip via Tailscale, etc.)
  if (pool && (poolConfigKey !== loaded.key || pool.connected === false || pool.connecting === false && !pool.connected)) {
    try { await pool.close(); } catch {}
    pool = null;
  }

  if (pool) return pool;
  console.log(`[bat-sage] Opening Sage pool from ${loaded.source}`);
  try {
    pool = await sql.connect(loaded.config);
  } catch (err) {
    // A Sage pool failure stalls every BAT operation that needs Sage data
    // (week-status, credit notes, dashboards). Surface it in System Log so
    // a remote operator doesn't have to ssh in to diagnose.
    try { logError('bat.sage.pool', err, { source: loaded.source }); } catch {}
    throw err;
  }
  poolConfigKey = loaded.key;
  return pool;
}

// Run a Sage query with one auto-retry if the cached pool turns out to be dead.
async function runSageQuery(sqlText) {
  let p = await getSagePool();
  try {
    return await p.request().query(sqlText);
  } catch (err) {
    if (/Connection is closed|ECONNRESET|ETIMEDOUT|EPIPE/i.test(err.message || '')) {
      console.log('[bat-sage] Pool dropped, reopening and retrying once');
      try { logError('bat.sage.query', err, { phase: 'pool_dropped_retrying' }, 'info'); } catch {}
      try { await p.close(); } catch {}
      pool = null;
      p = await getSagePool();
      return await p.request().query(sqlText);
    }
    try { logError('bat.sage.query', err); } catch {}
    throw err;
  }
}

export async function resetSagePool() {
  if (pool) {
    try { await pool.close(); } catch {}
  }
  pool = null;
  poolConfigKey = null;
}

// ── Sage health check ────────────────────────────────────────────────────────
//
// Sage is the highest-likelihood silent-degrade integration in this app:
// when the MSSQL box is unreachable, every BAT operation that needs Sage
// data quietly returns empty results. The user only finds out later when
// reconciliations look wrong. This probe runs every minute, tracks how
// long Sage has been unreachable, and surfaces the state to the admin UI
// via /api/bat/sage-health so a banner can warn before someone starts
// debugging a "missing credit notes" report that's actually just a dead
// Sage pool.
//
// The state is process-local (resets on restart). That's fine — once the
// service comes back, the next probe rebuilds the picture within 60s.

const _sageHealthState = {
  ok: null,                  // null = never probed; true/false = last result
  lastOkAt: null,            // ms timestamp of last successful probe
  lastFailAt: null,          // ms timestamp of last failed probe
  lastError: null,           // string of last error message
  consecutiveFailures: 0,    // resets to 0 on success
  lastProbeAt: null,         // when did probe last run
};

export async function probeSageHealth() {
  _sageHealthState.lastProbeAt = Date.now();
  try {
    const p = await getSagePool();
    // Cheapest possible round-trip — hits the SQL Server but reads nothing.
    await p.request().query('SELECT 1 AS ok');
    _sageHealthState.ok = true;
    _sageHealthState.lastOkAt = Date.now();
    _sageHealthState.consecutiveFailures = 0;
    _sageHealthState.lastError = null;
    return _sageHealthState;
  } catch (err) {
    _sageHealthState.ok = false;
    _sageHealthState.lastFailAt = Date.now();
    _sageHealthState.consecutiveFailures += 1;
    _sageHealthState.lastError = err?.message || String(err);
    // Don't logError on every probe failure — that floods the System Log
    // when Sage is offline. Log only the FIRST failure of a streak.
    if (_sageHealthState.consecutiveFailures === 1) {
      try { logError('bat.sage.health_probe', err, { phase: 'first_failure' }, 'warn'); } catch {}
    }
    return _sageHealthState;
  }
}

export function getSageHealth() {
  // Derive a human-friendly summary on read. The probe loop owns the raw
  // numbers; consumers just read this snapshot.
  const s = _sageHealthState;
  const downForMs = s.ok === false && s.lastFailAt ? Date.now() - s.lastFailAt : 0;
  const downForMinutes = Math.floor(downForMs / 60_000);
  return {
    ok: s.ok,
    lastProbeAt: s.lastProbeAt,
    lastOkAt: s.lastOkAt,
    lastFailAt: s.lastFailAt,
    lastError: s.lastError,
    consecutiveFailures: s.consecutiveFailures,
    downForMinutes,
    // attention=true when Sage has been failing for >5 minutes. UI uses
    // this single flag to decide whether to show the warning banner.
    attention: s.ok === false && s.consecutiveFailures >= 5,
  };
}

// ── Spreadsheet Parsing ──────────────────────────────────────────────────────
//
// Parser logic now lives in src/services/bat/parser.js (carved out as
// part of the BAT module split — see PR #279 + this PR). The
// re-exports below preserve the existing import surface so any caller
// that hasn't been updated keeps working; new code should import
// directly from `./bat/parser.js`.
export { SpreadsheetValidationError, parseSupplierSpreadsheet, parseCardosoSpreadsheet } from './bat/parser.js';

// ── Sage 300 Queries ─────────────────────────────────────────────────────────

export async function querySageCreditNotes(weekNumber, year) {
  // Validate week before opening a Sage pool. The query interpolates
  // targetWeek as a SQL literal, so a NaN would produce a syntax error
  // ("desc_week = NaN"). The previous LIKE-based filter degraded to
  // "match nothing" on bad input — preserve that softer failure mode
  // for callers that hand us malformed legacy data (no recon page
  // currently does, but the public route /api/bat/sage-credit-notes
  // and any future ad-hoc caller might).
  const targetWeek = parseInt(weekNumber, 10);
  if (!Number.isFinite(targetWeek) || targetWeek < 1 || targetWeek > 53) {
    return [];
  }
  const targetYear = parseInt(year, 10);

  const sagePool = await getSagePool();
  // APIBC join is LEFT so credit-note lines whose batch header has been
  // purged / archived still appear (they were dropped silently before,
  // making per-week totals diverge from the cached week totals).
  //
  // Week match parses the digits after "WEEK " as an INT and compares
  // numerically. The previous version filtered with a literal
  // `LIKE '%WEEK ${wk}%'` (zero-padded), which silently dropped every
  // line whose description used the unpadded form ("WEEK 1" vs "WEEK 01")
  // — Sage operators format these by hand so both forms appear in the
  // wild on the same site. The cache feeder (querySageWeekTotals) has
  // always parsed-and-compared, so this brings the two paths in sync.
  //
  // Year attribution mirrors querySageWeekTotals: derive the year from
  // h.DATEINVC adjusted by the ISO-week heuristic (a desc_week far
  // ahead of the doc's actual ISO week means the line crossed a year
  // boundary and belongs to the previous calendar year). The previous
  // BETWEEN window on h.DATEINVC was a coarser approximation of the
  // same idea — unifying on the heuristic eliminates a class of
  // edge-case disagreement between the credit-note details panel and
  // the comparison Sage column.
  const yearClause = Number.isFinite(targetYear) && targetYear > 0
    ? `AND attributed_year = ${targetYear}`
    : '';

  const result = await sagePool.request().query(`
    ;WITH src AS (
      SELECT
        h.CNTBTCH,
        bc.BTCHDESC,
        bc.BTCHSTTS,
        h.IDVEND,
        h.IDINVC,
        h.DATEINVC,
        CAST(CAST(h.DATEINVC AS VARCHAR(8)) AS DATE) AS doc_date,
        d.TEXTDESC,
        d.AMTDISTHC,
        CAST(LTRIM(RTRIM(SUBSTRING(d.TEXTDESC, PATINDEX('%WEEK [0-9]%', d.TEXTDESC) + 5, 2))) AS INT) AS desc_week
      FROM APIBH h
      INNER JOIN APIBD d ON d.CNTBTCH = h.CNTBTCH AND d.CNTITEM = h.CNTITEM
      LEFT JOIN APIBC bc ON bc.CNTBTCH = h.CNTBTCH
      WHERE LTRIM(RTRIM(h.IDVEND)) LIKE '%BAT%'
        AND d.TEXTDESC LIKE '%WEEK [0-9]%'
    ),
    attributed AS (
      SELECT *,
        CASE
          -- desc_week far AHEAD of ISO_WEEK(doc_date) → previous year.
          -- See querySageWeekTotals for the full reasoning. Same shape
          -- here so totals (querySageWeekTotals) and per-line details
          -- (this query) agree on which year a line belongs to.
          --
          -- Initial fix to the W10/2027 phantom tightened both branches
          -- symmetrically (required doc_date AND desc_week to both be
          -- near the year boundary). That regressed the legitimate
          -- cross-year-lag case: a W52 credit note posted in February
          -- (W6) was no longer attributed to the previous year, so
          -- prior-year cache totals were silently understated. Restored
          -- this branch to the pre-fix threshold; only the year+1 branch
          -- below stays tightened.
          WHEN desc_week > DATEPART(ISO_WEEK, doc_date) + 4
            THEN YEAR(doc_date) - 1
          -- desc_week far BEHIND ISO_WEEK(doc_date) → next year.
          -- ONLY at the end of the year. See querySageWeekTotals for
          -- why the symmetric "behind" gate is too eager and how it
          -- created the phantom W10/2027 row mid-year.
          WHEN DATEPART(ISO_WEEK, doc_date) >= 49 AND desc_week <= 4
            THEN YEAR(doc_date) + 1
          ELSE YEAR(doc_date)
        END AS attributed_year
      FROM src
    )
    SELECT
      CNTBTCH AS batch_number,
      LTRIM(RTRIM(COALESCE(BTCHDESC, ''))) AS batch_description,
      CASE BTCHSTTS
        WHEN 1 THEN 'Open'
        WHEN 3 THEN 'Posted'
        WHEN 4 THEN 'Deleted'
        WHEN 7 THEN 'Posted'
        WHEN NULL THEN 'Archived'
        ELSE 'Unknown (' + CAST(BTCHSTTS AS VARCHAR) + ')'
      END AS batch_status,
      LTRIM(RTRIM(IDVEND)) AS vendor_number,
      LTRIM(RTRIM(IDINVC)) AS document_number,
      DATEINVC AS document_date,
      LTRIM(RTRIM(TEXTDESC)) AS line_description,
      desc_week AS week_number,
      CASE
        WHEN LTRIM(RTRIM(TEXTDESC)) LIKE 'DELIVERY%' THEN 'DELIVERY FEE'
        WHEN LTRIM(RTRIM(TEXTDESC)) LIKE 'DISCOUNT%' THEN 'DISCOUNT FEE'
        WHEN LTRIM(RTRIM(TEXTDESC)) LIKE 'PRICING%'  THEN 'PRICING ADJ'
        WHEN LTRIM(RTRIM(TEXTDESC)) LIKE 'PRICE%'    THEN 'PRICING ADJ'
        ELSE 'OTHER'
      END AS fee_type,
      AMTDISTHC AS line_amount
    FROM attributed
    WHERE desc_week = ${targetWeek}
      ${yearClause}
    ORDER BY
      CASE
        WHEN LTRIM(RTRIM(TEXTDESC)) LIKE 'DELIVERY%' THEN 1
        WHEN LTRIM(RTRIM(TEXTDESC)) LIKE 'DISCOUNT%' THEN 2
        WHEN LTRIM(RTRIM(TEXTDESC)) LIKE 'PRICING%'  THEN 3
        ELSE 4
      END,
      CNTBTCH
  `);
  return result.recordset || [];
}

// Per-year/per-week totals from Sage credit notes.
// Year is derived from h.DATEINVC (Sage stores it as INT YYYYMMDD).
// Returns [{ year, week_number, delivery, discount, pricing, total, batch_count }, ...]
export async function querySageWeekTotals() {
  const result = await runSageQuery(`
    ;WITH src AS (
      SELECT
        h.DATEINVC AS doc_date_int,
        CAST(CAST(h.DATEINVC AS VARCHAR(8)) AS DATE) AS doc_date,
        CAST(LTRIM(RTRIM(SUBSTRING(d.TEXTDESC, PATINDEX('%WEEK [0-9]%', d.TEXTDESC) + 5, 2))) AS INT) AS desc_week,
        h.CNTBTCH,
        d.TEXTDESC,
        d.AMTDISTHC
      FROM APIBH h
      INNER JOIN APIBD d ON d.CNTBTCH = h.CNTBTCH AND d.CNTITEM = h.CNTITEM
      WHERE LTRIM(RTRIM(h.IDVEND)) LIKE '%BAT%'
        AND d.TEXTDESC LIKE '%WEEK [0-9]%'
    ),
    attributed AS (
      SELECT
        CASE
          -- desc_week far AHEAD of ISO_WEEK(doc_date) → previous year.
          --
          -- A credit note can't legitimately reference future activity.
          -- So when desc_week sits well past the current ISO week of
          -- doc_date, the only sane interpretation is that desc_week
          -- belongs to the previous calendar year. Examples that this
          -- correctly handles:
          --   - Jan 5 (W1) with desc_week=52 → W52 of previous year
          --   - Feb 10 (W6) with desc_week=49 → W49 of previous year
          --     (cross-year accounting lag: late posting of Dec activity)
          --   - May 4 (W18) with desc_week=24 → W24 of previous year
          --     (data-entry error: operator typo or stale Sage line —
          --     attributing to last year is closer to truth than calling
          --     it future-dated activity in the current year)
          -- The +4 buffer absorbs same-year mid-week posting lag without
          -- triggering the rule (e.g. W10 posted in W12).
          --
          -- This branch is unchanged from the pre-fix shape — the
          -- regression was on the year+1 branch below. Initial fix to
          -- the W10/2027 bug tightened both sides symmetrically, but
          -- that broke legitimate cross-year lag (Codex catch).
          WHEN desc_week > DATEPART(ISO_WEEK, doc_date) + 4
            THEN YEAR(doc_date) - 1
          -- desc_week far BEHIND ISO_WEEK(doc_date) → next year.
          --
          -- Pre-fix this fired for any "behind" desc_week, e.g. May (W19)
          -- with desc_week=10 → year+1 = next year, creating the phantom
          -- W10/2027 row that broke the site dashboard. The interpretation
          -- was wrong: a desc_week in the past of the current ISO week is
          -- usually just a normal in-year late posting (W10 posted in W19
          -- means "10 weeks late posting of W10 activity", year unchanged).
          --
          -- The only legitimate next-year case is the narrow
          -- end-of-year-anticipating-next-year scenario: a "WEEK 1" credit
          -- note pre-posted on Dec 28 (W52/53) so the W1 recon next year
          -- has a Sage line waiting for it. Restrict the rule to that
          -- case alone (doc_date in W49+ AND desc_week in 1-4); everything
          -- else falls through to YEAR(doc_date).
          WHEN DATEPART(ISO_WEEK, doc_date) >= 49 AND desc_week <= 4
            THEN YEAR(doc_date) + 1
          ELSE YEAR(doc_date)
        END AS year,
        desc_week AS week_number,
        TEXTDESC,
        AMTDISTHC,
        CNTBTCH
      FROM src
    )
    SELECT
      year,
      week_number,
      SUM(CASE WHEN UPPER(LTRIM(RTRIM(TEXTDESC))) LIKE 'DELIVERY%' THEN AMTDISTHC ELSE 0 END) AS delivery,
      SUM(CASE WHEN UPPER(LTRIM(RTRIM(TEXTDESC))) LIKE 'DISCOUNT%' THEN AMTDISTHC ELSE 0 END) AS discount,
      SUM(CASE
            WHEN UPPER(LTRIM(RTRIM(TEXTDESC))) LIKE 'PRICING%'
              OR UPPER(LTRIM(RTRIM(TEXTDESC))) LIKE 'PRICE%'
            THEN AMTDISTHC ELSE 0 END) AS pricing,
      SUM(AMTDISTHC) AS total,
      COUNT(DISTINCT CNTBTCH) AS batch_count
    FROM attributed
    GROUP BY year, week_number
    ORDER BY year, week_number
  `);
  return (result.recordset || [])
    .filter(r => r.week_number > 0 && r.week_number <= 53 && r.year > 2000 && r.year < 2100)
    .map(r => ({
      year:        Math.floor(Number(r.year)),
      week_number: Number(r.week_number),
      delivery:    Number(r.delivery) || 0,
      discount:    Number(r.discount) || 0,
      pricing:     Number(r.pricing)  || 0,
      total:       Number(r.total)    || 0,
      batch_count: Number(r.batch_count) || 0,
    }));
}

// ── Sage Week-Totals Cache ───────────────────────────────────────────────────
// We cache per-(year, week) totals locally so the dashboard works even when Sage
// is unreachable. Refreshed every 3h on weekdays 7am–4pm by the scheduler, plus
// on-demand via the Refresh button.

let _refreshInProgress = false;

// In-memory cache of the bat_sage_week_cache table contents. The dashboard /
// week-status endpoints read this on every poll (5–15s); avoid the DB hit
// since the underlying table is only written by refreshSageWeekTotalsCache().
let _sageTotalsMemo = null;
function invalidateSageTotalsMemo() { _sageTotalsMemo = null; }

export function getCachedSageWeekTotals() {
  if (_sageTotalsMemo) return _sageTotalsMemo;
  try {
    _sageTotalsMemo = db.prepare(`
      SELECT year, week_number, delivery, discount, pricing, total, batch_count
      FROM bat_sage_week_cache
      ORDER BY year, week_number
    `).all();
    return _sageTotalsMemo;
  } catch { return []; }
}

// SHARED SOURCE OF TRUTH for "last week paid (Sage)".
//
// IMPORTANT — DO NOT INLINE A PARALLEL VERSION.
//
// The hub displays each site's "last paid week" by mirroring whatever the
// site itself reports. Both the site's own UI (via /api/bat/week-status)
// AND the hub-export endpoint (/api/reporting/bat-summary) MUST return
// the same value for any given (site, moment) pair, or the hub stops
// being a faithful mirror of the site and the operator can no longer
// trust either view.
//
// Pre-fix history: /api/bat/week-status sorted the cache by max(year, week)
// without scoping, while /api/reporting/bat-summary scoped to the current
// ISO year. A late-posted "WEEK 10" credit note dated mid-2026 was being
// misattributed to year 2027 by querySageWeekTotals' year-attribution
// heuristic, so the unscoped path showed W10/2027 (the phantom row beat
// real data) while the year-scoped path showed W44/2026 (the next-most-
// wrong row). Site UI said one thing, hub tile said another, both wrong.
//
// This helper IS that single source. Both endpoints call it. If you find
// yourself writing a SELECT against bat_sage_week_cache to get "the
// latest paid week", call this instead.
//
// Returns null when the cache has no rows for the current ISO year, OR
// when the only candidate rows are clearly impossible (week strictly in
// the future). The future-week guard is defensive — querySageWeekTotals
// also rejects future-dated raw Sage data on the way in, but a Sage
// data-entry typo on a credit note's posting date can still produce a
// real future-week cache row, and the operator-facing tile shouldn't
// lie about it.
export function getLastPaidSageWeek() {
  let currentIsoYear, currentWeek;
  try {
    const cur = currentIsoWeek();
    currentIsoYear = cur.year;
    currentWeek = cur.week;
  } catch {
    // If we can't determine the current ISO year for any reason, refuse
    // to guess — return null so the UI shows '—' rather than surfacing
    // a phantom-future-year row.
    return null;
  }
  try {
    const row = db.prepare(`
      SELECT year, week_number
      FROM bat_sage_week_cache
      WHERE year = ?
        -- Defensive guard: never report a "future" week. The 1-week
        -- buffer (currentWeek + 1) tolerates late-Sunday postings where
        -- Sage stamps a credit note that crosses into the next ISO week.
        AND week_number <= ?
      ORDER BY week_number DESC
      LIMIT 1
    `).get(currentIsoYear, currentWeek + 1);
    if (!row) return null;
    return { year: row.year, week_number: row.week_number };
  } catch {
    return null;
  }
}

// SHARED SOURCE OF TRUTH for "last week the operator uploaded a BAT
// reconciliation". Same architectural rule as getLastPaidSageWeek:
// hub mirrors site, both endpoints route through this helper, never
// inline a parallel SELECT.
//
// opts.allYears (default false):
//   false → current ISO year only. Used by callsites that mean
//           "last upload this year" (year-scoped tile labels).
//   true  → look across every year. Required by the Missing-BAT
//           gap calculation: a site whose last upload was W47/2025
//           and has nothing in 2026 needs the all-time answer so
//           the gap shows the real backlog. Codex review catch on
//           PR #273 — the cross-year branch in the gap calculation
//           never fired against the year-scoped default.
//
// The future-week guard (week_number <= currentWeek + 1) only applies
// when allYears is false. With allYears=true, a recon stamped in a
// PAST year is by definition not "future", so we don't constrain.
export function getLastBatReconciliationWeek(opts = {}) {
  const allYears = !!opts.allYears;
  let currentIsoYear, currentWeek;
  try {
    const cur = currentIsoWeek();
    currentIsoYear = cur.year;
    currentWeek = cur.week;
  } catch {
    return null;
  }
  try {
    let row;
    if (allYears) {
      // No year filter; guard future weeks within the CURRENT year only
      // (a 2025 recon stamped as W47/2025 is fine; a 2026 recon stamped
      // as W99/2026 isn't — keep the same defensive scoping the
      // current-year branch applies).
      row = db.prepare(`
        SELECT year, week_number
        FROM bat_reconciliations
        WHERE NOT (year = ? AND week_number > ?)
        ORDER BY year DESC, week_number DESC
        LIMIT 1
      `).get(currentIsoYear, currentWeek + 1);
    } else {
      row = db.prepare(`
        SELECT year, week_number
        FROM bat_reconciliations
        WHERE year = ?
          AND week_number <= ?
        ORDER BY week_number DESC
        LIMIT 1
      `).get(currentIsoYear, currentWeek + 1);
    }
    if (!row) return null;
    return { year: row.year, week_number: row.week_number };
  } catch {
    return null;
  }
}

export function getSageCacheMeta() {
  try {
    const rows = db.prepare(`SELECT key, value, updated_at FROM bat_sage_cache_meta`).all();
    const meta = {};
    for (const r of rows) meta[r.key] = r.value;
    return meta;
  } catch { return {}; }
}

function setSageCacheMeta(key, value) {
  try {
    db.prepare(`INSERT INTO bat_sage_cache_meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(key, value);
  } catch (e) {
    // Persist as System Log entry rather than just stderr — operator
    // needs to see this when triaging "why is the cache always stale".
    try { logError('bat.sage_cache.meta_write', e, { key }); } catch {}
  }
}

export async function refreshSageWeekTotalsCache() {
  if (_refreshInProgress) {
    return { ok: false, status: 'already_running' };
  }
  _refreshInProgress = true;
  try {
    const live = await querySageWeekTotals();
    const before = getCachedSageWeekTotals();
    const beforeMap = new Map(before.map(r => [`${r.year}/${r.week_number}`, r]));
    const liveMap = new Map(live.map(r => [`${r.year}/${r.week_number}`, r]));

    let added = 0, removed = 0, changed = 0;
    for (const [k, l] of liveMap) {
      const b = beforeMap.get(k);
      if (!b) { added++; continue; }
      if (Math.abs((b.total || 0) - (l.total || 0)) > 0.01) changed++;
    }
    for (const k of beforeMap.keys()) if (!liveMap.has(k)) removed++;

    // Upsert via ON CONFLICT — avoids the brief window between DELETE and INSERT
    // where the cache would be empty. Then sweep any rows no longer present
    // in `live` (so removed weeks don't linger). All inside one transaction.
    const replace = db.transaction((rows) => {
      const upsert = db.prepare(`
        INSERT INTO bat_sage_week_cache (year, week_number, delivery, discount, pricing, total, batch_count, refreshed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(year, week_number) DO UPDATE SET
          delivery = excluded.delivery,
          discount = excluded.discount,
          pricing = excluded.pricing,
          total = excluded.total,
          batch_count = excluded.batch_count,
          refreshed_at = excluded.refreshed_at
      `);
      for (const r of rows) upsert.run(r.year, r.week_number, r.delivery, r.discount, r.pricing, r.total, r.batch_count);
      // Remove any cached rows not in the live result set
      const liveKeys = new Set(rows.map(r => `${r.year}/${r.week_number}`));
      const existing = db.prepare('SELECT year, week_number FROM bat_sage_week_cache').all();
      const del = db.prepare('DELETE FROM bat_sage_week_cache WHERE year = ? AND week_number = ?');
      for (const e of existing) {
        if (!liveKeys.has(`${e.year}/${e.week_number}`)) del.run(e.year, e.week_number);
      }
    });
    replace(live);
    invalidateSageTotalsMemo();

    setSageCacheMeta('last_refreshed_at', new Date().toISOString());
    setSageCacheMeta('last_status', 'ok');
    setSageCacheMeta('last_error', '');
    setSageCacheMeta('last_change_summary', JSON.stringify({ added, removed, changed, total: live.length }));
    console.log(`[bat-sage-cache] Refresh OK: ${live.length} weeks (added=${added}, removed=${removed}, changed=${changed})`);
    return { ok: true, status: 'ok', added, removed, changed, total: live.length };
  } catch (err) {
    setSageCacheMeta('last_status', 'error');
    setSageCacheMeta('last_error', String(err.message).slice(0, 500));
    setSageCacheMeta('last_failed_at', new Date().toISOString());
    logError('bat.sage.cacheRefresh', err);
    return { ok: false, status: 'error', error: err.message };
  } finally {
    _refreshInProgress = false;
  }
}

export async function querySagePaidWeeks() {
  const sagePool = await getSagePool();
  const result = await sagePool.request().query(`
    SELECT DISTINCT
      LTRIM(RTRIM(SUBSTRING(d.TEXTDESC, PATINDEX('%WEEK [0-9]%', d.TEXTDESC) + 5, 2))) AS week_number
    FROM APIBC bc
    INNER JOIN APIBH h ON h.CNTBTCH = bc.CNTBTCH
    INNER JOIN APIBD d ON d.CNTBTCH = h.CNTBTCH AND d.CNTITEM = h.CNTITEM
    WHERE LTRIM(RTRIM(h.IDVEND)) LIKE '%BAT%'
      AND d.TEXTDESC LIKE '%WEEK [0-9]%'
    ORDER BY week_number
  `);
  return (result.recordset || [])
    .map(r => parseInt(r.week_number, 10))
    .filter(n => n > 0 && n <= 53);
}

// ── Reconciliation CRUD ──────────────────────────────────────────────────────

export function createReconciliation({ weekNumber, year, filename, fees, podUrls, userId }) {
  // Check for existing
  const existing = db.prepare('SELECT id FROM bat_reconciliations WHERE week_number = ? AND year = ?').get(weekNumber, year);
  if (existing) {
    // Update existing
    db.prepare(`
      UPDATE bat_reconciliations SET
        upload_filename = ?,
        supplier_discount = ?, supplier_delivery = ?, supplier_pricing = ?,
        supplier_discount_vat = ?, supplier_delivery_vat = ?, supplier_pricing_vat = ?,
        supplier_total = ?, status = 'pending', created_by = ?
      WHERE id = ?
    `).run(
      filename,
      fees.discount.subTotal, fees.delivery.subTotal, fees.pricing.subTotal,
      fees.discount.vat, fees.delivery.vat, fees.pricing.vat,
      fees.total.total, userId,
      existing.id
    );

    // Clear old extractions for this reconciliation (keep cached ones by pdf_url)
    db.prepare('DELETE FROM bat_sage_credit_notes WHERE reconciliation_id = ?').run(existing.id);

    insertPodEntries(existing.id, podUrls);
    // Self-heal supplier_total from the per-row data we just upserted.
    // No-ops gracefully if amounts are still incomplete; see helper docs.
    recomputeSupplierTotalSafe(existing.id);
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO bat_reconciliations (
      week_number, year, upload_filename,
      supplier_discount, supplier_delivery, supplier_pricing,
      supplier_discount_vat, supplier_delivery_vat, supplier_pricing_vat,
      supplier_total, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    weekNumber, year, filename,
    fees.discount.subTotal, fees.delivery.subTotal, fees.pricing.subTotal,
    fees.discount.vat, fees.delivery.vat, fees.pricing.vat,
    fees.total.total, userId
  );

  const reconId = result.lastInsertRowid;
  insertPodEntries(reconId, podUrls);
  recomputeSupplierTotalSafe(reconId);
  return reconId;
}

// Mark a week as zero. Creates a synthetic bat_reconciliations row
// for (year, week_number) with all supplier totals = 0 and the
// marked_zero flag set. Used for genuinely-empty weeks (no deliveries,
// no fees, no charges) — the upload flow rejects an empty Delivery POD
// sheet, so without this mechanism the operator has no way to record
// "this week was zero" and the week stays in the missing-credit-notes
// list forever.
//
// Refuses if there's already a recon for that week (zero-marked or
// not). The UNIQUE(week_number, year) constraint enforces this at the
// DB layer too; we check explicitly so the API can return a useful
// 409 instead of a generic constraint violation.
export function markWeekZero({ weekNumber, year, note, userEmail }) {
  if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 53) {
    throw new Error(`Invalid week_number: ${weekNumber} (must be 1..53)`);
  }
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error(`Invalid year: ${year}`);
  }
  if (!userEmail || typeof userEmail !== 'string') {
    throw new Error('userEmail is required for audit');
  }

  const existing = db.prepare(
    'SELECT id, marked_zero FROM bat_reconciliations WHERE week_number = ? AND year = ?'
  ).get(weekNumber, year);
  if (existing) {
    const err = new Error(
      existing.marked_zero
        ? `Week ${weekNumber} of ${year} is already marked zero (recon ${existing.id}).`
        : `Week ${weekNumber} of ${year} already has a recon (${existing.id}). Cannot mark as zero — delete the existing recon first if it was uploaded by mistake.`
    );
    err.code = 'EXISTS';
    err.existingId = existing.id;
    throw err;
  }

  const result = db.prepare(`
    INSERT INTO bat_reconciliations (
      week_number, year, upload_filename,
      supplier_discount, supplier_delivery, supplier_pricing,
      supplier_discount_vat, supplier_delivery_vat, supplier_pricing_vat,
      supplier_total,
      sage_discount, sage_delivery, sage_pricing, sage_total,
      status, created_by,
      marked_zero, marked_zero_by, marked_zero_at, marked_zero_note
    ) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'zero', NULL, 1, ?, ?, ?)
  `).run(
    weekNumber, year, `(marked zero by ${userEmail})`,
    userEmail, new Date().toISOString(), note ? String(note).slice(0, 500) : null,
  );
  return result.lastInsertRowid;
}

// Reverse a mark-zero. Refuses to touch rows that aren't marked_zero
// (operator can't accidentally delete a real recon via this path).
export function unmarkWeekZero({ id, userEmail }) {
  if (!Number.isInteger(id)) throw new Error(`Invalid id: ${id}`);
  if (!userEmail || typeof userEmail !== 'string') {
    throw new Error('userEmail is required for audit');
  }

  const row = db.prepare(
    'SELECT id, week_number, year, marked_zero FROM bat_reconciliations WHERE id = ?'
  ).get(id);
  if (!row) {
    const err = new Error(`Reconciliation ${id} not found.`);
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (!row.marked_zero) {
    const err = new Error(
      `Reconciliation ${id} is not marked zero — refusing to delete a real recon via the unmark path.`
    );
    err.code = 'NOT_MARKED_ZERO';
    throw err;
  }

  // The synthetic row has no PODs, no extractions, no Sage credit notes.
  // Plain DELETE is safe; the FK CASCADE on the dependent tables would
  // tidy any stragglers anyway.
  db.prepare('DELETE FROM bat_reconciliations WHERE id = ? AND marked_zero = 1').run(id);
  return { week_number: row.week_number, year: row.year };
}

// Self-healing supplier_total. Sets the recon's supplier_total to the
// sum of non-exception order_amounts from its rows — the operator-
// visible BAT TOTAL and the headline number on the recon page. Returns
// true if updated, false if skipped (incomplete amounts).
//
// Why this exists: createReconciliation/insertPodEntries originally
// stamped supplier_total = parsed.fees.total.total (the sum of the
// supplier's three fee-section lines from the spreadsheet's Overview
// tab). That worked when every week had ONE supplier spreadsheet, but
// broke the moment two branch spreadsheets (Welkom + JHB, etc.) landed
// on the same week — the second upload's smaller fees overwrote the
// first's, and the recon's BAT TOTAL silently went wrong with no
// operator-visible signal. The W11 incident on 2026-05-11 burned
// several rounds of debugging, a one-shot SQL fix, a Maintenance-tab
// healer (PR #275), AND a column-not-found warning at upload (PR #274)
// before we got here.
//
// This helper closes the entire class: every successful upload now
// recomputes the headline total from the per-row data that just
// landed. Re-uploads naturally produce the right number; merges of
// branch spreadsheets are summed correctly because order_amount is
// per-row (preserved by the upsert's COALESCE pattern).
//
// Null-safety guard (WHERE NOT EXISTS): we ONLY overwrite when every
// non-exception row has a populated order_amount. Otherwise the SUM
// would treat nulls as zero and the derived total would be artificially
// low — e.g. mid-week uploads where some PODs haven't had their amount
// set yet (filled in later by backfillOrderAmounts when a subsequent
// week's spreadsheet arrives). In that case the UPDATE silently no-ops
// (info.changes === 0) and the existing fees-derived supplier_total
// stays in place. Same guard the Maintenance-tab tool uses (PR #275).
function recomputeSupplierTotalSafe(reconId) {
  const info = db.prepare(`
    UPDATE bat_reconciliations
    SET supplier_total = (
      SELECT COALESCE(SUM(CASE WHEN COALESCE(is_exception, 0) = 0 THEN COALESCE(order_amount, 0) ELSE 0 END), 0)
      FROM bat_invoice_extractions
      WHERE reconciliation_id = bat_reconciliations.id
    )
    WHERE id = ?
      AND NOT EXISTS (
        SELECT 1 FROM bat_invoice_extractions
        WHERE reconciliation_id = bat_reconciliations.id
          AND COALESCE(is_exception, 0) = 0
          AND order_amount IS NULL
      )
  `).run(reconId);
  return info.changes > 0;
}

function insertPodEntries(reconId, podUrls) {
  const upsert = db.prepare(`
    INSERT INTO bat_invoice_extractions (
      reconciliation_id, pdf_url, order_number, branch_name, store_name,
      week, order_day, delivery_day, lead_time, delivery_date, pod_uploaded_date, validate, order_amount, is_exception, target_days, compliance_status, exception_reason, supplier_discount, supplier_del_fee, supplier_pricing
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(reconciliation_id, pdf_url) DO UPDATE SET
      order_number = COALESCE(excluded.order_number, bat_invoice_extractions.order_number),
      branch_name = COALESCE(excluded.branch_name, bat_invoice_extractions.branch_name),
      store_name = COALESCE(excluded.store_name, bat_invoice_extractions.store_name),
      week = COALESCE(excluded.week, bat_invoice_extractions.week),
      order_day = COALESCE(excluded.order_day, bat_invoice_extractions.order_day),
      delivery_day = COALESCE(excluded.delivery_day, bat_invoice_extractions.delivery_day),
      lead_time = COALESCE(excluded.lead_time, bat_invoice_extractions.lead_time),
      delivery_date = COALESCE(excluded.delivery_date, bat_invoice_extractions.delivery_date),
      pod_uploaded_date = COALESCE(excluded.pod_uploaded_date, bat_invoice_extractions.pod_uploaded_date),
      validate = COALESCE(excluded.validate, bat_invoice_extractions.validate),
      order_amount = COALESCE(excluded.order_amount, bat_invoice_extractions.order_amount),
      is_exception = COALESCE(excluded.is_exception, bat_invoice_extractions.is_exception),
      target_days = COALESCE(excluded.target_days, bat_invoice_extractions.target_days),
      compliance_status = COALESCE(excluded.compliance_status, bat_invoice_extractions.compliance_status),
      exception_reason = COALESCE(excluded.exception_reason, bat_invoice_extractions.exception_reason),
      supplier_discount = COALESCE(excluded.supplier_discount, bat_invoice_extractions.supplier_discount),
      supplier_del_fee = COALESCE(excluded.supplier_del_fee, bat_invoice_extractions.supplier_del_fee),
      supplier_pricing = COALESCE(excluded.supplier_pricing, bat_invoice_extractions.supplier_pricing)
  `);
  const tx = db.transaction((urls) => {
    for (const pod of urls) {
      // Use ?? for numeric fields so a legitimate 0 isn't converted to null
      upsert.run(
        reconId, pod.url, pod.orderNumber, pod.branchName || null, pod.storeName,
        pod.week || null, pod.orderDay || null, pod.deliveryDay || null, pod.leadTime ?? null,
        pod.deliveryDate, pod.podUploadedDate || null, pod.validate || null,
        pod.orderAmount ?? null, pod.isException || 0,
        pod.targetDays ?? null, pod.complianceStatus || null, pod.exceptionReason || null,
        pod.supplierDiscount ?? null, pod.supplierDelFee ?? null, pod.supplierPricing ?? null
      );
    }
  });
  tx(podUrls);
}

export function backfillOrderAmounts(orderAmounts) {
  if (!orderAmounts || orderAmounts.size === 0) return 0;

  // Pull reconciliation_id alongside so we can recompute supplier_total
  // on every recon we touched. Without this, backfilling amounts onto
  // a prior week's rows would leave that week's headline BAT TOTAL
  // stale (it'd still reflect the old fees-section snapshot from when
  // the spreadsheet was uploaded — pre-backfill). Self-healing here
  // keeps the headline total consistent with the per-row data without
  // needing the operator to run the Maintenance-tab recompute.
  const rows = db.prepare(
    'SELECT id, order_number, reconciliation_id FROM bat_invoice_extractions WHERE order_amount IS NULL AND order_number IS NOT NULL'
  ).all();

  const update = db.prepare(
    'UPDATE bat_invoice_extractions SET order_amount = ?, is_exception = ? WHERE id = ?'
  );

  let count = 0;
  const touchedRecons = new Set();
  const tx = db.transaction(() => {
    for (const row of rows) {
      const entry = orderAmounts.get(row.order_number);
      if (entry) {
        update.run(entry.amount, entry.isException ? 1 : 0, row.id);
        touchedRecons.add(row.reconciliation_id);
        count++;
      }
    }
  });
  tx();

  // Recompute supplier_total for each touched recon. Safe-recompute
  // helper no-ops if any non-exception row in that recon STILL has
  // a null order_amount (the backfill may have filled some but not
  // all rows). Per recon, not in one txn — better-sqlite3 is
  // synchronous so the inner UPDATEs serialise naturally.
  let recomputedRecons = 0;
  for (const reconId of touchedRecons) {
    if (recomputeSupplierTotalSafe(reconId)) recomputedRecons++;
  }

  if (count > 0) {
    console.log(`[bat] Backfilled ${count} order amounts from new spreadsheet onto previous extractions; recomputed supplier_total on ${recomputedRecons}/${touchedRecons.size} affected recon(s)`);
  }
  return count;
}

// Atomic refresh: DELETE existing rows, INSERT new ones, clear sage_error,
// in one transaction so a read concurrent with a refresh never observes
// the half-applied state. Earlier the routes did
//   db.prepare('DELETE FROM bat_sage_credit_notes ...').run(id);
//   storeSageCreditNotes(id, creditNotes);
//   db.prepare('UPDATE bat_reconciliations SET sage_error = NULL ...').run(id);
// as three separate statements. If storeSageCreditNotes threw mid-way (or
// the totals UPDATE inside it threw), the recon was left with empty
// credit notes plus stale totals. Caught by the BAT-module review.
//
// better-sqlite3 transactions nest correctly via savepoints, so the
// inner txn inside storeSageCreditNotes participates in this outer one.
export function replaceSageCreditNotes(reconId, creditNotes) {
  const txn = db.transaction((id, notes) => {
    db.prepare('DELETE FROM bat_sage_credit_notes WHERE reconciliation_id = ?').run(id);
    storeSageCreditNotes(id, notes);
    db.prepare('UPDATE bat_reconciliations SET sage_error = NULL WHERE id = ?').run(id);
  });
  txn(reconId, creditNotes);
}

export function storeSageCreditNotes(reconId, creditNotes) {
  const insert = db.prepare(`
    INSERT INTO bat_sage_credit_notes (
      reconciliation_id, batch_number, batch_description, batch_status,
      vendor_number, document_number, document_date, line_description,
      week_number, fee_type, line_amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((notes) => {
    for (const n of notes) {
      insert.run(
        reconId, n.batch_number, n.batch_description, n.batch_status,
        n.vendor_number, n.document_number, n.document_date, n.line_description,
        parseInt(n.week_number, 10) || null, n.fee_type, n.line_amount
      );
    }
  });
  tx(creditNotes);

  // Sum Sage amounts by fee type and update reconciliation
  const sageTotals = { 'DELIVERY FEE': 0, 'DISCOUNT FEE': 0, 'PRICING ADJ': 0 };
  for (const n of creditNotes) {
    if (sageTotals[n.fee_type] !== undefined) {
      sageTotals[n.fee_type] += (n.line_amount || 0);
    }
  }
  const sageTotal = sageTotals['DELIVERY FEE'] + sageTotals['DISCOUNT FEE'] + sageTotals['PRICING ADJ'];
  db.prepare(`
    UPDATE bat_reconciliations SET
      sage_delivery = ?, sage_discount = ?, sage_pricing = ?, sage_total = ?
    WHERE id = ?
  `).run(sageTotals['DELIVERY FEE'], sageTotals['DISCOUNT FEE'], sageTotals['PRICING ADJ'], sageTotal, reconId);
}

// Lightweight existence + week/year lookup for endpoints that don't need
// the full extraction/credit-note payload that getReconciliation builds.
// getReconciliation eagerly loads every row in bat_invoice_extractions,
// every bat_sage_credit_notes row, AND computes cross-recon duplicate
// stats — heavy work that the per-recon reset endpoints (which only
// need to verify the recon exists and assemble an audit-log label)
// previously paid on every modal open and every Reset click. On larger
// backlogs that adds noticeable latency to a frequently-invoked UI
// action. Returns null when the row doesn't exist; never throws.
export function getReconciliationMeta(id) {
  if (!Number.isFinite(id) || id <= 0) return null;
  return db.prepare(
    'SELECT id, week_number, year FROM bat_reconciliations WHERE id = ?'
  ).get(id) || null;
}

export function getReconciliation(id) {
  const recon = db.prepare('SELECT * FROM bat_reconciliations WHERE id = ?').get(id);
  if (!recon) return null;
  recon.creditNotes = db.prepare('SELECT * FROM bat_sage_credit_notes WHERE reconciliation_id = ? ORDER BY fee_type, batch_number').all(id);
  recon.extractions = db.prepare('SELECT * FROM bat_invoice_extractions WHERE reconciliation_id = ? ORDER BY id').all(id);

  // Overlay Sage totals from the local cache (refreshed on schedule). The per-recon
  // bat_reconciliations.sage_* fields only get filled when the user clicks "Refresh Sage"
  // on this page; the cache is the up-to-date source of truth for week-level totals.
  try {
    const cached = db.prepare(
      'SELECT delivery, discount, pricing, total FROM bat_sage_week_cache WHERE year = ? AND week_number = ?'
    ).get(recon.year, recon.week_number);
    if (cached) {
      recon.sage_delivery = cached.delivery;
      recon.sage_discount = cached.discount;
      recon.sage_pricing  = cached.pricing;
      recon.sage_total    = cached.total;
    }
  } catch {}

  // Fee comparison
  recon.feeComparison = buildFeeComparison(recon);
  // Build a CROSS-RECON duplicate index before computing this recon's
  // stats. OCR and manual entry can both produce the same invoice
  // number in different weeks (short numeric IDs are particularly
  // prone — "1234" misreads as "1334" in W19, then misreads correctly
  // back to "1234" in W22, and now two different POD rows claim
  // invoice 1234). The previous within-recon duplicate check missed
  // every cross-week dupe — operator only noticed when Sage reconciled
  // and one of the two rows came back unmatched.
  recon.extractionStats = buildExtractionStats(recon.extractions, recon.id, buildGlobalDuplicateIndexService({ db }));

  return recon;
}

export function listReconciliations() {
  // LEFT JOIN the Sage week cache so the per-week tile can show live Sage totals
  // even when the per-recon refresh has never been run.
  //
  // ext_stats: per-recon OCR + amount stats, computed live every call so the
  // per-week tile reflects current state without waiting for the cached
  // supplier_total column to be recomputed. claim_per_fee is the BAT
  // Overview-tab summary (what BAT says they're owed). ocr_sum is the
  // bottom-up sum from extraction rows — the gap between the two surfaces
  // either pending unverified rows or row-vs-summary data mismatches.
  //
  // dup_stats: invoice numbers that OCR returned more than once within the
  // same recon (typical cause: a barcode prefix that mis-reads consistently
  // across unrelated PDFs, or a genuine duplicate POD upload). The
  // inflation value is "extra amount included in ocr_sum because of
  // duplicates" — Σ(amount across dup rows) − Σ(max amount per dup invoice
  // = one representative). Subtracting inflation from ocr_sum gives a
  // dedup'd estimate of the verified value.
  return db.prepare(`
    SELECT r.*,
      COALESCE(ext_stats.pod_count, 0)                    AS pod_count,
      COALESCE(ext_stats.found_count, 0)                  AS found_count,
      COALESCE(ext_stats.ocr_sum, 0)                      AS ocr_sum,
      COALESCE(ext_stats.unverified_amount, 0)            AS unverified_amount,
      COALESCE(ext_stats.unverified_count, 0)             AS unverified_count,
      COALESCE(ext_stats.ocr_missing_amount_count, 0)     AS ocr_missing_amount_count,
      COALESCE(r.supplier_delivery, 0)
        + COALESCE(r.supplier_discount, 0)
        + COALESCE(r.supplier_pricing,  0)                AS claim_per_fee,
      COALESCE(dup_stats.duplicate_invoice_count, 0)      AS duplicate_invoice_count,
      COALESCE(dup_stats.duplicate_inflation, 0)          AS duplicate_inflation,
      COALESCE(c.delivery, r.sage_delivery)               AS sage_delivery,
      COALESCE(c.discount, r.sage_discount)               AS sage_discount,
      COALESCE(c.pricing,  r.sage_pricing)                AS sage_pricing,
      COALESCE(c.total,    r.sage_total)                  AS sage_total,
      CASE WHEN c.year IS NOT NULL THEN 1 ELSE 0 END      AS sage_present
    FROM bat_reconciliations r
    LEFT JOIN (
      SELECT reconciliation_id,
             COUNT(*) AS pod_count,
             SUM(CASE WHEN extraction_status = 'found' THEN 1 ELSE 0 END) AS found_count,
             -- ocr_sum: amount that has actually been verified by OCR.
             -- order_amount is sourced from the supplier spreadsheet at
             -- ingest time, so a row can carry an amount even when its
             -- PDF's OCR failed or didn't match a Cardoso invoice
             -- (extraction_status pending/not_found/failed). Including
             -- such rows here would falsely present unverified deliveries
             -- as "OCR-verified" on the tile — counting only status='found'
             -- ties the figure to OCR success rather than spreadsheet
             -- presence. unverified_amount fills in the other side so the
             -- tile can show how much value is still un-OCR'd.
             SUM(CASE WHEN COALESCE(is_exception,0)=0 AND extraction_status = 'found'
                      THEN COALESCE(order_amount,0) ELSE 0 END) AS ocr_sum,
             SUM(CASE WHEN COALESCE(is_exception,0)=0 AND extraction_status <> 'found'
                      THEN COALESCE(order_amount,0) ELSE 0 END) AS unverified_amount,
             SUM(CASE WHEN COALESCE(is_exception,0)=0 AND extraction_status <> 'found'
                      THEN 1 ELSE 0 END) AS unverified_count,
             SUM(CASE WHEN COALESCE(is_exception,0)=0 AND order_amount IS NULL THEN 1 ELSE 0 END) AS ocr_missing_amount_count
      FROM bat_invoice_extractions
      GROUP BY reconciliation_id
    ) ext_stats ON ext_stats.reconciliation_id = r.id
    LEFT JOIN (
      -- Duplicates restricted to non-exception OCR-verified rows so the
      -- count and inflation use the same predicate. A "duplicate"
      -- between two failed rows is a different pathology (same garbled
      -- OCR output across attempts); a non-exc row + an exception row
      -- on the same invoice adds nothing to ocr_sum because the
      -- exception row is excluded. Including either case here would
      -- flash a "1 dup invoice · +R 0.00" warning that doesn't
      -- correspond to any real inflation in the verified figure.
      SELECT reconciliation_id,
             COUNT(*) AS duplicate_invoice_count,
             SUM(amt_sum - amt_max) AS duplicate_inflation
      FROM (
        SELECT reconciliation_id, extracted_invoice,
               COUNT(*) AS n,
               SUM(COALESCE(order_amount,0)) AS amt_sum,
               MAX(COALESCE(order_amount,0)) AS amt_max
        FROM bat_invoice_extractions
        WHERE extracted_invoice IS NOT NULL
          AND extraction_status = 'found'
          AND COALESCE(is_exception,0) = 0
        GROUP BY reconciliation_id, extracted_invoice
        HAVING n > 1
      )
      GROUP BY reconciliation_id
    ) dup_stats ON dup_stats.reconciliation_id = r.id
    LEFT JOIN bat_sage_week_cache c ON c.year = r.year AND c.week_number = r.week_number
    ORDER BY r.year DESC, r.week_number DESC
  `).all();
}

function buildFeeComparison(recon) {
  // Sage column = actual Sage credit-note totals only (recon.sage_* is overlaid
  // from bat_sage_week_cache in getReconciliation). Don't fall back to
  // Cardoso-invoice sums — those belong in a separate column if needed.
  const sageDelivery = recon.sage_delivery || 0;
  const sageDiscount = recon.sage_discount || 0;
  const sagePricing  = recon.sage_pricing  || 0;

  const compare = (type, supplierAmount, sageAmount) => {
    const diff = (supplierAmount || 0) - (sageAmount || 0);
    const absDiff = Math.abs(diff);
    let status = 'red';
    if (absDiff < 0.01) status = 'green';
    else if (absDiff < 100) status = 'amber';
    return { type, supplier: supplierAmount || 0, sage: sageAmount || 0, difference: diff, status };
  };

  return [
    compare('Delivery Fee', recon.supplier_delivery, sageDelivery),
    compare('Discount Fee', recon.supplier_discount, sageDiscount),
    compare('Pricing Adjustment', recon.supplier_pricing, sagePricing),
  ];
}

// globalDupIndex (optional): Map<upper-trimmed-invoice, { count, occurrences[] }>
// produced by buildGlobalDuplicateIndex. When supplied, duplicate_count
// reflects the GLOBAL count across all reconciliations, not just this one,
// and each duplicate extraction is annotated with `duplicate_other_recons`
// listing the other weeks the same number appears in. Pass an empty Map to
// fall back to within-recon-only behaviour (used by call sites that don't
// need the cross-recon view).
function buildExtractionStats(extractions, reconId, globalDupIndex = new Map()) {
  const total = extractions.length;

  // Single pass: accumulate status counts.
  let found = 0, notFound = 0, failed = 0, pending = 0, exceptions = 0;
  for (const e of extractions) {
    switch (e.extraction_status) {
      case 'found':     found++; break;
      case 'not_found': notFound++; break;
      case 'failed':    failed++; break;
      case 'pending':   pending++; break;
    }
    if (e.is_exception === 1) exceptions++;
  }

  // Duplicate invoice numbers across ALL reconciliations — OCR can output
  // the same number for different PDFs in different weeks (short numeric
  // IDs are particularly prone), and manual edits can produce the same
  // number by typo. Mark every extraction whose invoice number appears
  // more than once anywhere, and attach the OTHER recons it appears in
  // so the UI can give the operator a navigation hint.
  let duplicateExtractions = 0;
  const duplicateKeysSeen = new Set();
  for (const e of extractions) {
    const k = e.extracted_invoice ? String(e.extracted_invoice).trim().toUpperCase() : null;
    const dup = k ? globalDupIndex.get(k) : null;
    if (dup) {
      e.duplicate_count = dup.count;
      // Filter to OTHER reconciliations only, not just other extractions.
      // Same-recon dupes belong to the within-week-fallback wording in the
      // tooltip — including them here would surface "also in W19/2026"
      // when the operator is already viewing W19/2026, which contradicts
      // the message itself. Codex review catch.
      e.duplicate_other_recons = dup.occurrences
        .filter(o => o.reconciliation_id !== reconId)
        .map(o => ({ reconciliation_id: o.reconciliation_id, week: o.week, year: o.year }));
      duplicateExtractions++;
      duplicateKeysSeen.add(k);
    } else {
      e.duplicate_count = 1;
      e.duplicate_other_recons = [];
    }
  }
  // Groups = distinct duplicate invoice numbers that appear in THIS recon.
  // (A dupe key may also have occurrences in other recons; those don't
  // count toward this recon's groups.)
  const duplicateGroups = duplicateKeysSeen.size;

  // Anything that needs the user to look at it: OCR failed/not_found,
  // exceptions, OR duplicate invoice numbers (now globally scoped).
  const needsAttention = notFound + failed + exceptions + duplicateExtractions;

  return { total, found, notFound, failed, pending, exceptions, needsAttention, duplicateGroups, duplicateExtractions };
}

export function manualSetInvoice(extractionId, invoiceNumber) {
  const ext = db.prepare('SELECT * FROM bat_invoice_extractions WHERE id = ?').get(extractionId);
  if (!ext) throw new Error('Extraction not found');

  // Set manual_override=1 so the cross-ref fuzzy auto-correct never overwrites
  // the user's deliberate fix back to the original mis-OCR'd value.
  db.prepare(`
    UPDATE bat_invoice_extractions
    SET extracted_invoice = ?, extraction_status = 'found',
        extraction_attempts = extraction_attempts + 1, manual_override = 1
    WHERE id = ?
  `).run(invoiceNumber, extractionId);

  // NOTE: Do NOT recompute supplier_total here. The recon's BAT TOTAL
  // is the BAT Overview-tab claim summary, stamped at upload time —
  // not a number we re-derive from per-row data after each OCR fix.
  // recomputeSupplierTotalSafe exists only for the multi-branch
  // upload self-heal (Welkom + JHB landing on the same week, second
  // upload's fees overwriting the first), and is called from the
  // upload paths only. Per-row OCR status is surfaced separately on
  // the per-week tile (OCR pending / Missing PODs indicators).

  return ext.reconciliation_id;
}

// ── OCR Invoice Extraction (Queue-based background worker) ──────────────────

let workerRunning = false;
let workerReconId = null;

// Module-level registry of rows currently being processed by the worker pool.
// Keyed by extraction id; value is { id, store_name, started_at_ms }.
// processQueue writes to this; getExtractionProgress reads from it so the
// frontend can show "currently processing X for 1m 30s" instead of just a
// stuck progress bar.
const currentlyProcessing = new Map();

export function getExtractionProgress(reconId) {
  if (!reconId) return null;
  const total = db.prepare('SELECT COUNT(*) as c FROM bat_invoice_extractions WHERE reconciliation_id = ?').get(reconId)?.c || 0;
  const pending = db.prepare("SELECT COUNT(*) as c FROM bat_invoice_extractions WHERE reconciliation_id = ? AND extraction_status = 'pending'").get(reconId)?.c || 0;
  const processed = total - pending;
  const running = workerRunning && workerReconId === reconId;
  // Snapshot in-flight rows for this recon. Filter by reconId in case a
  // future change ever runs cross-recon work simultaneously.
  const now = Date.now();
  const inFlight = [];
  for (const row of currentlyProcessing.values()) {
    if (row.reconciliation_id !== reconId) continue;
    inFlight.push({
      id: row.id,
      store_name: row.store_name,
      elapsed_seconds: Math.floor((now - row.started_at_ms) / 1000),
      // Stage label from the worker's most recent progress message
      // (e.g. "render", "engine:GoogleVision@0", "engine:Tesseract@90").
      // Lets the UI tell "stuck on Tesseract trained-data download" apart
      // from "still chewing through render". See ocrWorker.js emitProgress.
      stage: row.stage || null,
      stage_at_seconds: row.stage_at_ms ? Math.floor((now - row.stage_at_ms) / 1000) : null,
    });
  }
  return { running, processed, total, pending, in_flight: inFlight };
}

// ── OCR Operations Tab support ──────────────────────────────────────────────
// The Operations page's OCR tab needs a single fast snapshot of "what is OCR
// doing right now" — pause state, in-flight rows across all recons, the
// active recon's progress, and any active regex auto-halt. Distinct from
// getExtractionProgress (which is per-recon and used by the BAT page) — this
// is a global view for the operator. Polled every ~2s by the panel.

export function getOcrSnapshot() {
  const now = Date.now();
  const inFlight = [];
  for (const row of currentlyProcessing.values()) {
    inFlight.push({
      id: row.id,
      reconciliation_id: row.reconciliation_id,
      store_name: row.store_name,
      stage: row.stage || null,
      elapsed_seconds: Math.floor((now - row.started_at_ms) / 1000),
      stage_age_seconds: row.stage_at_ms ? Math.floor((now - row.stage_at_ms) / 1000) : null,
      kill_attempted: !!row.kill_attempted,
    });
  }

  let pending = 0;
  let failed = 0;
  let notFound = 0;
  try {
    pending = db.prepare("SELECT COUNT(*) AS c FROM bat_invoice_extractions WHERE extraction_status = 'pending'").get()?.c || 0;
    failed = db.prepare("SELECT COUNT(*) AS c FROM bat_invoice_extractions WHERE extraction_status = 'failed'").get()?.c || 0;
    notFound = db.prepare("SELECT COUNT(*) AS c FROM bat_invoice_extractions WHERE extraction_status = 'not_found'").get()?.c || 0;
  } catch { /* table may not exist on first boot */ }

  // Active recon = the one the worker is currently chewing through.
  // We want week_number / year so the operator sees "currently working
  // week 38 / 2025" instead of a bare id.
  let activeRecon = null;
  if (workerRunning && workerReconId != null) {
    try {
      const r = db.prepare(`
        SELECT id, week_number, year, status, last_error, last_error_at,
          (SELECT COUNT(*) FROM bat_invoice_extractions WHERE reconciliation_id = bat_reconciliations.id) AS rows_total,
          (SELECT COUNT(*) FROM bat_invoice_extractions WHERE reconciliation_id = bat_reconciliations.id AND extraction_status = 'found') AS rows_found,
          (SELECT COUNT(*) FROM bat_invoice_extractions WHERE reconciliation_id = bat_reconciliations.id AND extraction_status = 'pending') AS rows_pending,
          (SELECT COUNT(*) FROM bat_invoice_extractions WHERE reconciliation_id = bat_reconciliations.id AND extraction_status = 'not_found') AS rows_not_found,
          (SELECT COUNT(*) FROM bat_invoice_extractions WHERE reconciliation_id = bat_reconciliations.id AND extraction_status = 'failed') AS rows_failed
        FROM bat_reconciliations WHERE id = ?
      `).get(workerReconId);
      if (r) activeRecon = r;
    } catch { /* table may not exist on first boot */ }
  }

  // Halt detection — most recent recon whose last_error matches the auto-halt
  // signature. We surface this even when worker isn't running because the
  // halt's whole point is "OCR is stopped and the operator needs to know
  // why", not "what's running right now".
  let halt = null;
  try {
    const haltRow = db.prepare(`
      SELECT id, week_number, year, last_error, last_error_at
      FROM bat_reconciliations
      WHERE last_error LIKE 'OCR auto-halted:%'
      ORDER BY last_error_at DESC LIMIT 1
    `).get();
    if (haltRow) {
      halt = {
        reconciliation_id: haltRow.id,
        week_number: haltRow.week_number,
        year: haltRow.year,
        message: haltRow.last_error,
        occurred_at: haltRow.last_error_at,
        // Always clearable — even if ocrPaused is somehow false (stale
        // marker, manual API call, race), the right action is still to
        // clear the marker so the panel doesn't keep showing a halt that
        // isn't in force. The clearOcrHalt path is idempotent: it wipes
        // the marker, sets paused=false, and resumes — safe to invoke
        // regardless of current state.
        can_clear: true,
      };
    }
  } catch { /* not fatal — surface no halt rather than crash */ }

  return {
    paused: ocrPaused,
    worker_running: workerRunning,
    worker_recon_id: workerReconId,
    concurrency: OCR_CONCURRENCY,
    pending_total: pending,
    not_found_total: notFound,
    failed_total: failed,
    in_flight: inFlight,
    active_recon: activeRecon,
    halt,
    timestamp: new Date().toISOString(),
  };
}

// Aggregated counters from error_log over a sliding window. Used by the
// OCR tab's counter strip — "in the last hour: 142 matches, 3 cascade
// exhausted, 12 cooldown skips, 1 halt fire". Topic prefixes covered:
//   bat.ocr.*  — primary OCR observability stream (this batch + earlier)
//   bat-ocr.*  — older worker lifecycle topic (paused/resumed/started)
export function getOcrCounters({ windowHours = 1 } = {}) {
  const window = Math.min(Math.max(parseInt(windowHours, 10) || 1, 1), 24 * 7);
  const since = `-${window} hours`;
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT source, level, COUNT(*) AS n
      FROM error_log
      WHERE (source LIKE 'bat.ocr.%' OR source LIKE 'bat-ocr.%')
        AND occurred_at >= datetime('now', ?)
      GROUP BY source, level
      ORDER BY n DESC
    `).all(since);
  } catch { /* error_log may not exist on a fresh install */ }
  // Flatten to a topic→count map plus a level→count map for the
  // headline strip. Keeping both per-source and per-level lets the UI
  // build its own categorisation without re-querying.
  const by_source = {};
  const by_level = {};
  for (const r of rows) {
    by_source[r.source] = (by_source[r.source] || 0) + r.n;
    by_level[r.level || 'error'] = (by_level[r.level || 'error'] || 0) + r.n;
  }
  return { window_hours: window, by_source, by_level };
}

// Recent reconciliations (any status) with row-count breakdown. Powers the
// "recent runs" table in the OCR tab. NOT scoped by user — admin-only view.
//
// rows_duplicates / duplicate_invoices follow the same definition the
// per-recon reset modal uses (PR #320): a "duplicate" is any row whose
// extracted_invoice value appears on 2+ found rows in the SAME recon.
// rows_duplicates is the total row-count across all such clusters
// (i.e. it includes EVERY row in a cluster of size N, not N-1). The
// inner subquery's HAVING + the outer SUM(c) folds that two-step
// aggregation into one column for the table.
export function getRecentBatReconciliations(limit = 20) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  try {
    return db.prepare(`
      SELECT
        r.id, r.week_number, r.year, r.status,
        r.last_error, r.last_error_at, r.created_at,
        (SELECT COUNT(*) FROM bat_invoice_extractions WHERE reconciliation_id = r.id) AS rows_total,
        (SELECT COUNT(*) FROM bat_invoice_extractions WHERE reconciliation_id = r.id AND extraction_status = 'found') AS rows_found,
        (SELECT COUNT(*) FROM bat_invoice_extractions WHERE reconciliation_id = r.id AND extraction_status = 'pending') AS rows_pending,
        (SELECT COUNT(*) FROM bat_invoice_extractions WHERE reconciliation_id = r.id AND extraction_status = 'not_found') AS rows_not_found,
        (SELECT COUNT(*) FROM bat_invoice_extractions WHERE reconciliation_id = r.id AND extraction_status = 'failed') AS rows_failed,
        -- Filter matches services/bat/duplicates.js — extracted_invoice
        -- must be NOT NULL AND non-empty after trimming. Without the
        -- TRIM check, empty-string clusters (which shouldn't happen but
        -- have been seen in the wild after some pipeline failures) get
        -- counted as a single mega-cluster of "duplicates".
        (SELECT COALESCE(SUM(c), 0) FROM (
          SELECT COUNT(*) AS c
          FROM bat_invoice_extractions
          WHERE reconciliation_id = r.id
            AND extraction_status = 'found'
            AND extracted_invoice IS NOT NULL
            AND TRIM(extracted_invoice) != ''
          GROUP BY extracted_invoice
          HAVING COUNT(*) >= 2
        )) AS rows_duplicates,
        (SELECT COUNT(*) FROM (
          SELECT extracted_invoice
          FROM bat_invoice_extractions
          WHERE reconciliation_id = r.id
            AND extraction_status = 'found'
            AND extracted_invoice IS NOT NULL
            AND TRIM(extracted_invoice) != ''
          GROUP BY extracted_invoice
          HAVING COUNT(*) >= 2
        )) AS duplicate_invoices
      FROM bat_reconciliations r
      ORDER BY r.id DESC
      LIMIT ?
    `).all(lim);
  } catch {
    return [];
  }
}

// "Clear halt + resume" action — called from the OCR tab when the operator
// has investigated the regex_streak_halt and wants to restart OCR. Wipes
// the halt's last_error so the recon doesn't show a stale toast, then
// unpauses and resumes the worker. If reconId is provided, only that
// recon's auto-halt error is cleared (defence — a different recon's
// last_error shouldn't be touched).
export function clearOcrHalt({ reconId = null } = {}) {
  if (reconId != null) {
    try {
      db.prepare(`
        UPDATE bat_reconciliations
        SET last_error = NULL, last_error_at = NULL, status = 'pending'
        WHERE id = ? AND last_error LIKE 'OCR auto-halted:%'
      `).run(reconId);
    } catch { /* best-effort — pause + resume below is the load-bearing part */ }
  }
  setOcrPaused(false);
  let resumed = false;
  try { resumeExtractionWorker(); resumed = true; } catch {}
  try { logError('bat.ocr.halt_cleared', new Error('Operator cleared regex auto-halt'), { reconciliation_id: reconId, resumed }, 'info'); } catch {}
  return { cleared: true, resumed };
}

export async function runInvoiceExtraction(reconId) {
  if (ocrPaused) {
    // Don't silently swallow the request — the UI disables the button when
    // paused, but a stale tab or scripted caller can still hit this endpoint.
    const err = new Error('OCR is paused — resume it in Settings → Reconciliation before extracting.');
    err.code = 'OCR_PAUSED';
    err.status = 409;
    throw err;
  }

  const pending = db.prepare(
    "SELECT COUNT(*) as c FROM bat_invoice_extractions WHERE reconciliation_id = ? AND extraction_status = 'pending'"
  ).get(reconId)?.c || 0;

  if (pending === 0) {
    return { message: 'No pending extractions', processed: 0 };
  }

  // Kick off the background worker if not already running
  startExtractionWorker(reconId);

  return { message: 'Extraction started', total: pending };
}

// Reset every "not_found" or "failed" extraction back to "pending" across all
// reconciliations. Rows that succeeded ("found") are left alone. Used by the
// Settings → Reconciliation "Re-queue failed OCRs" button so an operator can
// re-OCR everything that hasn't yet been matched without re-doing successful
// extractions.
export function resetUnsuccessfulExtractions() {
  // extracted_invoice + manual_override are wiped here too for the same
  // reason as resetUnsuccessfulExtractionsForRecon below — see that
  // comment for the full rationale. Briefly: matchCardosoToSupplier
  // filters by `extracted_invoice IS NOT NULL` rather than by status, so
  // a stale value carried by a not_found/failed row would still match
  // after this "reset" otherwise; manual_override left at 1 would opt
  // the row out of fuzzy auto-correction on the next OCR pass.
  const info = db.prepare(`
    UPDATE bat_invoice_extractions
    SET extraction_status = 'pending',
        extracted_invoice = NULL,
        extraction_error = NULL,
        extraction_attempts = 0,
        manual_override = 0
    WHERE extraction_status IN ('not_found', 'failed')
  `).run();
  return { reset: info.changes };
}

export function countUnsuccessfulExtractions() {
  const row = db.prepare(`
    SELECT COUNT(*) AS c
    FROM bat_invoice_extractions
    WHERE extraction_status IN ('not_found', 'failed')
  `).get();
  return row?.c || 0;
}

// ── Per-recon reset (Settings + recon page Reset buttons) ────────────────────
//
// Three scopes, each with its own UI button. All share the same row-shape
// after the reset (extraction_status='pending', extracted_invoice=NULL,
// extraction_error=NULL, extraction_attempts=0). After a reset the recon
// is re-extracted via the existing OCR queue — the operator clicks Extract
// (or the worker picks it up on next start).
//
// Why three scopes:
//   - 'all'           — wipe every row, including 'found' and any manual
//                       edits. Use when a regression / engine swap
//                       (e.g. PDFium round 6) means the existing data is
//                       likely wrong even where it looks right.
//   - 'unsuccessful'  — only not_found + failed. The cheapest re-OCR; keeps
//                       successful rows alone. Same scope as the existing
//                       /api/bat/reset-pending GLOBAL action, just narrowed
//                       to one recon.
//   - 'duplicates'    — only rows whose extracted_invoice value appears on
//                       N+ found rows in the same recon. The poison-detection
//                       criterion (PR #316) used as a reset criterion. Aimed
//                       at cleaning up the recurring-letterhead artefact
//                       case where the same wrong number lands on multiple
//                       PODs in one recon.
//
// Audit-action shapes are bat_reset_recon_<scope> so the audit table can
// colour them distinctly.

// Note on manual_override: rows whose invoice was manually entered by an
// operator carry manual_override=1, which makes matchCardosoToSupplier
// skip fuzzy auto-correction for that row (see src/services/bat/matching.js
// — `if (!cardoso && !ext.manual_override)`). When we reset and re-OCR,
// we MUST clear that flag too: otherwise the re-extracted invoice number
// is treated as if a human had set it, the fuzzy matcher refuses to
// correct it, and we keep a wrong number that the new pipeline could
// have fixed. Reviewer-flagged on PR #320: "defeats the full wipe and
// reprocess intent and can leave avoidable mismatches." All three reset
// scopes that wipe invoices clear manual_override too. The
// 'unsuccessful' scope clears it as well — defensive, since a row in
// not_found/failed shouldn't really have manual_override=1, but if a
// past edit got into a strange state we don't want to preserve it.

export function resetAllExtractionsForRecon(reconId) {
  const info = db.prepare(`
    UPDATE bat_invoice_extractions
    SET extraction_status = 'pending',
        extracted_invoice = NULL,
        extraction_error = NULL,
        extraction_attempts = 0,
        manual_override = 0
    WHERE reconciliation_id = ?
  `).run(reconId);
  return { reset: info.changes };
}

// extracted_invoice is wiped too even though not_found/failed rows
// "shouldn't" carry a value — reviewer-flagged: matchCardosoToSupplier
// filters by `extracted_invoice IS NOT NULL` rather than by status, so a
// stale value from a legacy migration or a past manual entry that later
// got re-marked failed would still participate in matching after this
// "reset" runs. The modal copy promises the reset wipes invoice values;
// honour that promise on every scope, not just 'all' and 'duplicates'.
export function resetUnsuccessfulExtractionsForRecon(reconId) {
  const info = db.prepare(`
    UPDATE bat_invoice_extractions
    SET extraction_status = 'pending',
        extracted_invoice = NULL,
        extraction_error = NULL,
        extraction_attempts = 0,
        manual_override = 0
    WHERE reconciliation_id = ?
      AND extraction_status IN ('not_found', 'failed')
  `).run(reconId);
  return { reset: info.changes };
}

// Reset rows whose extracted_invoice appears on `threshold` or more rows
// in the same recon. Default threshold=2 (any in-recon dup is suspect for
// a manual re-pass; the PR-#316 dynamic poison detection used 5 because
// it was making an autonomous call mid-extraction — here the operator is
// triggering deliberately so we err on the side of catching more).
//
// Returns { reset, duplicateInvoices } so the toast can say
// "4 duplicate numbers spread across 12 rows".
//
// manual_override is cleared along with the invoice value (see comment
// above this block) — if a manually-edited row's invoice happens to be
// part of a duplicate cluster, the re-OCR'd replacement should NOT
// inherit the manual-override sacred-edit treatment.
//
// SCOPE NOTE (reviewer-flagged): the duplicate KEYS are computed from
// status='found' rows only — that's what the modal preview counts and
// shows the operator. The UPDATE must narrow to the same scope; without
// `extraction_status = 'found'` on the UPDATE, a stale not_found/failed
// row that happened to carry one of those invoice values would also be
// wiped, even though it wasn't in the count the operator approved. The
// duplicates scope is supposed to be "wipe the over-replicated SUCCESS
// rows so re-OCR splits them into distinct invoices" — out-of-scope
// rows belong to one of the OTHER reset buttons.
export function resetDuplicateExtractionsForRecon(reconId, threshold = 2) {
  const dups = db.prepare(`
    SELECT extracted_invoice
      FROM bat_invoice_extractions
     WHERE reconciliation_id = ?
       AND extraction_status = 'found'
       AND extracted_invoice IS NOT NULL
     GROUP BY extracted_invoice
    HAVING COUNT(*) >= ?
  `).all(reconId, threshold).map(r => r.extracted_invoice);
  if (dups.length === 0) return { reset: 0, duplicateInvoices: 0 };
  const placeholders = dups.map(() => '?').join(',');
  const info = db.prepare(`
    UPDATE bat_invoice_extractions
    SET extraction_status = 'pending',
        extracted_invoice = NULL,
        extraction_error = NULL,
        extraction_attempts = 0,
        manual_override = 0
    WHERE reconciliation_id = ?
      AND extraction_status = 'found'
      AND extracted_invoice IN (${placeholders})
  `).run(reconId, ...dups);
  return { reset: info.changes, duplicateInvoices: dups.length };
}

// Counts that drive the per-button confirmation dialogs. Single round-trip
// — the UI renders all three button counts from one call.
export function countExtractionsForRecon(reconId) {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN extraction_status = 'found'                    THEN 1 ELSE 0 END) AS found,
      SUM(CASE WHEN extraction_status IN ('not_found', 'failed')   THEN 1 ELSE 0 END) AS unsuccessful,
      SUM(CASE WHEN extraction_status = 'pending'                  THEN 1 ELSE 0 END) AS pending,
      COUNT(*) AS total
    FROM bat_invoice_extractions
    WHERE reconciliation_id = ?
  `).get(reconId);
  const dupAgg = db.prepare(`
    SELECT extracted_invoice, COUNT(*) AS c
      FROM bat_invoice_extractions
     WHERE reconciliation_id = ?
       AND extraction_status = 'found'
       AND extracted_invoice IS NOT NULL
     GROUP BY extracted_invoice
    HAVING COUNT(*) >= 2
  `).all(reconId);
  const dupRowCount = dupAgg.reduce((s, r) => s + r.c, 0);
  return {
    total:        row?.total || 0,
    found:        row?.found || 0,
    unsuccessful: row?.unsuccessful || 0,
    pending:      row?.pending || 0,
    duplicates:   { invoices: dupAgg.length, rows: dupRowCount },
  };
}

export function retryNotFound(reconId) {
  const rows = db.prepare(
    "SELECT id, pdf_url, store_name FROM bat_invoice_extractions WHERE reconciliation_id = ? AND extraction_status IN ('not_found', 'failed')"
  ).all(reconId);
  if (rows.length === 0) return { message: 'Nothing to retry', requeued: 0 };

  // Run Google Vision-only pass (skip Tesseract/ocr.space)
  runGoogleVisionRetry(reconId, rows);
  return { message: `Retrying ${rows.length} extractions with Google Vision`, requeued: rows.length };
}

async function runGoogleVisionRetry(reconId, rows) {
  if (!getGoogleVisionKey()) {
    const msg = 'Google Vision retry skipped: GOOGLE_VISION_KEY not set';
    // Operator-actionable misconfiguration — persist so it surfaces
    // in System Log, not just stderr.
    try {
      logError(
        'bat.gv_retry.skipped_no_key',
        new Error(msg),
        { reconciliation_id: reconId, row_count: rows?.length || 0 },
        'warn',
      );
    } catch {}
    recordReconciliationError(reconId, msg);
    return;
  }

  // Clear previous error state at the start of a retry pass
  db.prepare("UPDATE bat_reconciliations SET last_error = NULL, last_error_at = NULL WHERE id = ?").run(reconId);

  try {
    await runGoogleVisionRetryInner(reconId, rows);
  } catch (err) {
    // Crash here is a real bug — preserve full stack via logError
    // rather than the truncated console.error message.
    try {
      logError('bat.gv_retry.crashed', err, {
        reconciliation_id: reconId,
        row_count: rows?.length || 0,
      });
    } catch {}
    recordReconciliationError(reconId, `Google Vision retry crashed: ${err.message}`);
  }
}

async function runGoogleVisionRetryInner(reconId, rows) {
  const sharp = (await import('sharp')).default;
  const inDigitLength = getInvoiceInDigitLength();
  // Poison-invoice set for this recon: hard-coded artefacts UNION any
  // number that already shows up on POISON_DUP_THRESHOLD+ found rows.
  // Snapshotted once at retry entry — the primary cascade has already
  // run by this point, so the dup population is stable enough that
  // per-row recompute would just be query churn.
  const poisonSet = new Set(HARDCODED_POISON_INVOICES);
  for (const inv of getDynamicPoisonInvoices(reconId)) poisonSet.add(inv);
  const updateExtraction = db.prepare(`
    UPDATE bat_invoice_extractions
    SET extracted_invoice = ?, extraction_status = ?,
        extraction_attempts = extraction_attempts + 1, extraction_error = ?
    WHERE id = ?
  `);

  // Wipe stale extraction_error on rows being requeued so the per-row toast
  // doesn't keep firing after a successful retry.
  const clearErrorStmt = db.prepare("UPDATE bat_invoice_extractions SET extraction_error = NULL WHERE id = ?");
  for (const r of rows) clearErrorStmt.run(r.id);

  console.log(`[bat-gv] Google Vision retry: ${rows.length} items`);

  for (const row of rows) {
    try {
      console.log(`[bat-gv] Processing id=${row.id} ${row.store_name || ''}`);

      // 30s download cap. Without this, a slow/wedged supplier S3 endpoint can
      // hang the main thread for 60-120s (until socket-level timeout) and
      // block every unrelated HTTP request behind it. The OCR worker has its
      // own fetchWithTimeout helper; this main-thread retry path needs the
      // same protection.
      const dlCtrl = new AbortController();
      const dlTimer = setTimeout(() => dlCtrl.abort(), 30_000);
      let response;
      try {
        response = await fetch(row.pdf_url, { signal: dlCtrl.signal });
      } catch (err) {
        clearTimeout(dlTimer);
        updateExtraction.run(null, 'failed', `PDF download failed: ${err.message}`, row.id);
        continue;
      }
      clearTimeout(dlTimer);
      if (!response.ok) { updateExtraction.run(null, 'failed', `HTTP ${response.status} downloading PDF`, row.id); continue; }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 100 || !buffer.subarray(0, 5).toString().startsWith('%PDF')) {
        updateExtraction.run(null, 'failed', 'Downloaded file is not a valid PDF', row.id); continue;
      }

      // Render PDF to image
      let imageBuffer;
      try {
        const scale = buffer.length > 2 * 1024 * 1024 ? 1.5 : 2.0;
        imageBuffer = await pdfPageToImage(buffer, 1, scale);
      } catch (err) {
        console.error(`[bat-gv] Render failed id=${row.id}: ${err.message}`);
        updateExtraction.run(null, 'failed', `Render failed: ${err.message}`, row.id); continue;
      }

      // Send to Google Vision — try upright first, then rotated
      let invoice = null;
      for (const angle of [0, 90]) {
        const jpeg = await sharp(imageBuffer)
          .rotate(angle)
          .resize({ width: 2400 })
          .jpeg({ quality: 85 })
          .toBuffer();

        const text = await ocrViaGoogleVision(jpeg);
        invoice = findInvoiceNumber(text, inDigitLength, poisonSet);
        if (invoice) {
          console.log(`[bat-gv] id=${row.id} -> ${invoice} (rot ${angle})`);
          break;
        }
      }

      if (invoice) {
        updateExtraction.run(invoice, 'found', null, row.id);
      } else {
        updateExtraction.run(null, 'not_found', null, row.id);
        console.log(`[bat-gv] id=${row.id} — not found`);
      }
    } catch (err) {
      console.error(`[bat-gv] id=${row.id} failed: ${err.message}`);
      updateExtraction.run(null, 'failed', err.message, row.id);
    }
  }

  console.log(`[bat-gv] Google Vision retry complete for reconciliation ${reconId}`);
  normalizeInvoiceNumbers(reconId);
  // NOTE: No recompute here. BAT TOTAL stays the claim summary from
  // the spreadsheet — OCR retry success is reflected in per-row
  // POD-coverage signals on the tile (OCR pending shrinks, found_count
  // grows), not in the headline number.
}

// ── OCR pause switch ───────────────────────────────────────────────────────
// Persisted in bat_settings (key: 'ocr_paused', value: '0' | '1') so restarts
// don't silently reset the operator's choice. Default-paused on a fresh DB
// (no setting row) so a brand-new install doesn't burn OCR credits before
// keys are configured. While paused: no new workers start, auto-resume on
// server boot is skipped, and the in-flight processQueue loop exits cleanly
// after its current invoice finishes (so we don't lose work mid-flight).
function loadInitialOcrPaused() {
  try {
    const row = db.prepare("SELECT value FROM bat_settings WHERE key = 'ocr_paused'").get();
    if (row && row.value != null) return row.value !== '0' && row.value !== 'false';
  } catch { /* table may not exist on first boot */ }
  return true; // default: paused
}
let ocrPaused = loadInitialOcrPaused();
export function isOcrPaused() { return ocrPaused; }
export function setOcrPaused(v) {
  const next = !!v;
  if (next === ocrPaused) return;
  ocrPaused = next;
  try {
    db.prepare(`
      INSERT INTO bat_settings (key, value, updated_at) VALUES ('ocr_paused', ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(next ? '1' : '0');
  } catch (err) {
    // logError persists to System Log; the previous console.error
    // duplicate ran alongside it just to mirror to stderr, which
    // logError already does internally.
    try { logError('bat-ocr.pause', err, { paused: next }); } catch {}
  }
  try {
    logError('bat-ocr.pause', new Error(next ? 'OCR worker paused' : 'OCR worker resumed'), { paused: next }, 'info');
  } catch {}
}

function startExtractionWorker(reconId) {
  if (ocrPaused) {
    console.log('[bat-ocr] Paused — not starting worker');
    return;
  }
  if (workerRunning) {
    console.log('[bat-ocr] Worker already running, skipping');
    return;
  }
  workerRunning = true;
  workerReconId = reconId;
  try { logError('bat-ocr.worker', new Error(`Worker started for reconciliation ${reconId}`), { reconciliation_id: reconId }, 'info'); } catch {}

  processQueue(reconId).catch(err => {
    // logError mirrors to stderr internally so the previous
    // console.error duplicate is unnecessary.
    try { logError('bat-ocr.worker', err, { reconciliation_id: reconId, phase: 'crash' }); } catch {}
    recordReconciliationError(reconId, `Worker crashed: ${err.message}`);
  }).finally(() => {
    // Capture *why* we stopped so an operator looking at the System Log can
    // tell "queue drained" from "operator paused mid-run".
    let stopReason = 'queue drained';
    try {
      if (ocrPaused) {
        stopReason = 'paused mid-run';
      } else {
        const pendingRow = db.prepare(
          "SELECT COUNT(*) AS c FROM bat_invoice_extractions WHERE reconciliation_id = ? AND extraction_status = 'pending'"
        ).get(reconId);
        if (pendingRow?.c > 0) stopReason = `stopped with ${pendingRow.c} pending`;
      }
      logError('bat-ocr.worker', new Error(`Worker stopped (${stopReason}) for reconciliation ${reconId}`), { reconciliation_id: reconId, stop_reason: stopReason }, 'info');
    } catch {}
    workerRunning = false;
    workerReconId = null;

    // Auto-handoff to the next pending reconciliation. Without this,
    // only the recon the operator explicitly triggered would get
    // drained — pending rows on OTHER recons sat idle indefinitely.
    // The OCR tab's "queued — picked up automatically when the current
    // run finishes" affordance promises this chain; backend has to
    // honour it. Codex catch on PR #231.
    //
    // Excludes the just-finished recon: if it still has pending rows
    // (lanes-retired / paused-mid-run / hard failure path), retrying
    // the same recon immediately would just hit the same wall. The
    // operator can manually click Extract on it after diagnosing.
    // Different recons are always worth chaining to.
    //
    // ocrPaused short-circuits the chain so the operator's pause toggle
    // still wins. setImmediate defers to the next tick to avoid any
    // tangle with awaiters that might still be holding on to this
    // promise's resolution.
    if (!ocrPaused) {
      try {
        const nextPending = db.prepare(`
          SELECT DISTINCT reconciliation_id FROM bat_invoice_extractions
          WHERE extraction_status = 'pending' AND reconciliation_id != ?
          ORDER BY reconciliation_id LIMIT 1
        `).get(reconId);
        if (nextPending) {
          try {
            logError(
              'bat-ocr.worker',
              new Error(`Auto-handoff from recon ${reconId} to recon ${nextPending.reconciliation_id} (still pending)`),
              { from: reconId, to: nextPending.reconciliation_id, phase: 'auto_handoff' },
              'info',
            );
          } catch {}
          setImmediate(() => startExtractionWorker(nextPending.reconciliation_id));
        }
      } catch (err) {
        try { logError('bat-ocr.worker', err, { phase: 'auto_handoff', from: reconId }); } catch {}
      }
    }
  });
}

// Auto-resume: call on server start to pick up any pending work.
// Also kicks off a fire-and-forget self-test so a fresh-install site
// surfaces a clear "can OCR even spawn?" answer in the System Log without
// the operator having to trigger an extraction.
export function resumeExtractionWorker() {
  // Run the self-test on every boot regardless of pause state — the goal
  // is to catch broken installs early, not gate on user state.
  runOcrSelfTest().catch(() => { /* runOcrSelfTest logs its own failures */ });

  if (ocrPaused) {
    console.log('[bat-ocr] Paused — skipping auto-resume on startup');
    return;
  }
  const pendingRecon = db.prepare(`
    SELECT DISTINCT reconciliation_id FROM bat_invoice_extractions
    WHERE extraction_status = 'pending' LIMIT 1
  `).get();
  if (pendingRecon) {
    console.log(`[bat-ocr] Auto-resuming extraction for reconciliation ${pendingRecon.reconciliation_id}`);
    startExtractionWorker(pendingRecon.reconciliation_id);
  }
}

// Boot-time OCR pipeline smoke test. Spawns one worker_thread, waits for
// its 'ready' message with a 10s deadline, terminates. The result lands
// in the System Log as bat.ocr.self_test (info on success, error on
// failure with a clear reason). On a fresh-install site where OCR
// silently does nothing, this is the first signal that something is
// structurally broken — usually:
//   - 'Worker spawn failed: …'  → native module (better-sqlite3, sharp,
//     canvas, tesseract.js) couldn't load. Check AV quarantine / VC++
//     redistributable / Node version mismatch.
//   - 'Worker did not signal ready within 10s'  → worker started but is
//     wedged before its first postMessage. Look at worker startup logs.
//
// Fire-and-forget: never blocks server boot.
async function runOcrSelfTest() {
  const startedAt = Date.now();
  let lane;
  try {
    try {
      lane = new OcrLane();
    } catch (err) {
      throw new Error(`Worker spawn failed: ${err.message}`);
    }
    // Wait for the ready message. OcrLane already wires error/exit
    // handlers that flip `dead = true`, so we can also fail fast if the
    // worker dies during init.
    await new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error('Worker did not signal ready within 10s')),
        10_000,
      );
      const onMessage = (msg) => {
        if (msg && msg.type === 'ready') {
          clearTimeout(t);
          lane.worker.off('message', onMessage);
          resolve();
        }
      };
      lane.worker.on('message', onMessage);
      // Catch the case where the worker exits during init.
      lane.worker.once('exit', (code) => {
        if (lane.dead || code === 0) return;
        clearTimeout(t);
        reject(new Error(`Worker exited during init (code=${code})`));
      });
    });
    const elapsedMs = Date.now() - startedAt;
    try {
      logError(
        'bat.ocr.self_test',
        new Error(`OCR worker pipeline OK (ready in ${elapsedMs}ms)`),
        { ready_in_ms: elapsedMs, platform: process.platform, node_version: process.version },
        'info',
      );
    } catch {}
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    try {
      logError(
        'bat.ocr.self_test',
        err,
        {
          ready_in_ms: elapsedMs,
          platform: process.platform,
          node_version: process.version,
          hint: 'OCR worker thread can not spawn or initialise. Native module corrupt, AV-quarantined, or Node version mismatch.',
        },
      );
    } catch {}
  } finally {
    if (lane) {
      try { await lane.terminate(); } catch {}
    }
  }
}

function normalizeInvoiceNumbers(reconId) {
  // Disabled: prefix-based normalization was making OCR errors worse
  // (dominant prefix detection converted correct 578xxx to wrong 579xxx).
  // Fuzzy matching against Cardoso invoices handles single-digit OCR errors instead.
  return;

  const found = db.prepare(
    `SELECT id, extracted_invoice FROM bat_invoice_extractions WHERE reconciliation_id = ? AND extraction_status = 'found'`
  ).all(reconId);

  if (found.length < 3) return;

  // Separate IN-prefix and numeric-only invoices
  const inPrefixed = found.filter(r => r.extracted_invoice.startsWith('IN'));
  const numeric = found.filter(r => !r.extracted_invoice.startsWith('IN'));

  const update = db.prepare('UPDATE bat_invoice_extractions SET extracted_invoice = ? WHERE id = ?');

  // Normalize IN-prefix invoices
  if (inPrefixed.length >= 3) {
    const digits = inPrefixed.map(r => ({ id: r.id, invoice: r.extracted_invoice, nums: r.extracted_invoice.replace(/^IN/i, '') }));
    const lengthCounts = {};
    for (const d of digits) { lengthCounts[d.nums.length] = (lengthCounts[d.nums.length] || 0) + 1; }
    const expectedLen = parseInt(Object.entries(lengthCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '0', 10);
    if (!expectedLen) return;

    const prefixLen = Math.max(1, expectedLen - 3);
    const prefixCounts = {};
    for (const d of digits) {
      if (d.nums.length === expectedLen) {
        const prefix = d.nums.substring(0, prefixLen);
        prefixCounts[prefix] = (prefixCounts[prefix] || 0) + 1;
      }
    }
    const dominantPrefix = Object.entries(prefixCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!dominantPrefix) return;

    console.log(`[bat-ocr-norm] IN pattern: IN${dominantPrefix}xxx (${expectedLen} digits)`);

    const tx = db.transaction(() => {
      for (const d of digits) {
        let corrected = null;
        if (d.nums.length < expectedLen) {
          const missing = expectedLen - d.nums.length;
          const candidate = dominantPrefix.substring(0, missing) + d.nums;
          if (candidate.length === expectedLen) corrected = `IN${candidate}`;
        }
        if (!corrected && d.nums.length === expectedLen && !d.nums.startsWith(dominantPrefix)) {
          let diffCount = 0;
          for (let i = 0; i < prefixLen; i++) { if (d.nums[i] !== dominantPrefix[i]) diffCount++; }
          if (diffCount <= 2) corrected = `IN${dominantPrefix}${d.nums.substring(prefixLen)}`;
        }
        if (corrected && corrected !== d.invoice) {
          console.log(`[bat-ocr-norm] Corrected ${d.invoice} → ${corrected}`);
          update.run(corrected, d.id);
        }
      }
    });
    tx();
  }

  // Normalize long numeric invoices (e.g., 18000422xxx)
  if (numeric.length >= 3) {
    const lengthCounts = {};
    for (const r of numeric) { lengthCounts[r.extracted_invoice.length] = (lengthCounts[r.extracted_invoice.length] || 0) + 1; }
    const expectedLen = parseInt(Object.entries(lengthCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '0', 10);
    if (!expectedLen) return;

    const prefixLen = Math.max(1, expectedLen - 3);
    const prefixCounts = {};
    for (const r of numeric) {
      if (r.extracted_invoice.length === expectedLen) {
        prefixCounts[r.extracted_invoice.substring(0, prefixLen)] = (prefixCounts[r.extracted_invoice.substring(0, prefixLen)] || 0) + 1;
      }
    }
    const dominantPrefix = Object.entries(prefixCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!dominantPrefix) return;

    console.log(`[bat-ocr-norm] Numeric pattern: ${dominantPrefix}xxx (${expectedLen} digits)`);

    const tx = db.transaction(() => {
      for (const r of numeric) {
        let corrected = null;
        if (r.extracted_invoice.length < expectedLen) {
          const missing = expectedLen - r.extracted_invoice.length;
          const candidate = dominantPrefix.substring(0, missing) + r.extracted_invoice;
          if (candidate.length === expectedLen) corrected = candidate;
        }
        if (!corrected && r.extracted_invoice.length === expectedLen && !r.extracted_invoice.startsWith(dominantPrefix)) {
          let diffCount = 0;
          for (let i = 0; i < prefixLen; i++) { if (r.extracted_invoice[i] !== dominantPrefix[i]) diffCount++; }
          if (diffCount <= 2) corrected = dominantPrefix + r.extracted_invoice.substring(prefixLen);
        }
        if (corrected && corrected !== r.extracted_invoice) {
          console.log(`[bat-ocr-norm] Corrected ${r.extracted_invoice} → ${corrected}`);
          update.run(corrected, r.id);
        }
      }
    });
    tx();
  }
}

// 2 min per PDF. Most PDFs OCR in 10-30s; anything past 2 minutes is almost
// always a dead-end (corrupt PDF, network stall, engine quota). Lower timeout
// = "stuck at 97%" turns into "completed with N failed" in 4-5 minutes
// instead of 15-20. Trade-off: a legitimately huge scanned PDF gets cut off,
// but those usually OCR poorly anyway and need a manual override.
const PDF_TIMEOUT = 120000;
// Backstop hard kill: if a row is still in_flight this far past PDF_TIMEOUT,
// the lane's internal setTimeout(reject) has somehow failed to land and the
// whole queue is wedged. The watchdog in processQueue terminates the
// worker_thread directly so the lane can be replaced and the run can
// continue. Without this, observed real-world hangs grew to 15+ minutes per
// row before users noticed and restarted the server.
const HARD_KILL_THRESHOLD_MS = PDF_TIMEOUT + 60_000;
// If a row has been processing for this many seconds, log a System Log entry
// so operators can see "row X has been chewing for too long" without staring
// at the progress bar.
const SLOW_ROW_THRESHOLD_MS = 60_000;

// Concurrency for the OCR worker pool. Default 2 — each lane is a Node
// worker_thread that owns its own Tesseract worker, sharp pipeline and pdfjs
// render. On a constrained Windows site, 4 parallel lanes saturate every CPU
// core and the main API thread starves for context-switch slots even though
// it isn't directly blocked. 2 keeps OCR throughput roughly the same (most
// time is in network calls to Google Vision / ocr.space) while leaving CPU
// headroom for the rest of the app. Override via OCR_CONCURRENCY env var.
const OCR_CONCURRENCY = Math.max(1, parseInt(process.env.OCR_CONCURRENCY || '2', 10));

// ── Worker thread lane ───────────────────────────────────────────────────────
// Each lane = one worker_thread that owns its own Tesseract worker. Extraction
// payloads are dispatched via postMessage and matched by id. The main thread
// stays responsive — pdfjs render, sharp processing, and Tesseract recognition
// all happen off-loop.

const OCR_WORKER_URL = new URL('./ocrWorker.js', import.meta.url);

class OcrLane {
  constructor() {
    this.worker = new Worker(fileURLToPath(OCR_WORKER_URL), {
      workerData: { previewDir: previewDir },
    });
    this.pending = new Map();
    this.nextId = 0;
    this.dead = false;
    this.worker.on('message', (msg) => {
      if (!msg) return;
      // Progress messages carry the current extraction stage (download /
      // pdf_text / render / engine:NAME@ANGLE / done / failed). The lane
      // forwards these to the slot's onProgress callback, which the
      // processQueue loop uses to attach `stage` to the row's entry in
      // `currentlyProcessing`. Out-of-band — does NOT resolve/reject.
      if (msg.type === 'progress') {
        const slot = this.pending.get(msg.id);
        if (slot && slot.onProgress) {
          try { slot.onProgress(msg.stage); } catch {}
        }
        return;
      }
      // Per-engine error from the worker's OCR cascade. The cascade itself
      // catches and moves on to the next engine, but it tells us which
      // engine failed and why so we can log it to the System Log. Without
      // this, a misconfigured Google Vision (key valid but Vision API not
      // enabled, IP-restricted, billing off, etc.) was indistinguishable
      // from "GV ran fine, just no text" — silent fall-through to
      // ocr.space and the operator never saw why.
      if (msg.type === 'engine_error') {
        const slot = this.pending.get(msg.id);
        if (slot && slot.onEngineError) {
          try {
            slot.onEngineError({
              engine: msg.engine,
              angle: msg.angle,
              stage: msg.stage,
              message: msg.message,
              tierError: !!msg.tierError,
              // Cooldown skips are emitted via the same engine_error
              // channel for transport simplicity, but they're not real
              // failures — no OCR call was even attempted. Forward the
              // flag so the parent can log them at info level under a
              // distinct topic instead of poisoning the engine_failed
              // stream with intentional skips.
              cooldown: !!msg.cooldown,
            });
          } catch {}
        }
        return;
      }
      // Engine returned but produced no usable invoice number. Two flavours:
      // 'short_text' (< 20 chars — engine basically gave us nothing) and
      // 'no_regex_match' (engine returned plenty of text but
      // findInvoiceNumber couldn't pull an invoice out of it). The latter
      // is the actual root cause when "everything times out at extract_total
      // and no engine throws" — GV is reading the page fine, the page
      // formatting just doesn't match the regex.
      if (msg.type === 'engine_no_match') {
        const slot = this.pending.get(msg.id);
        if (slot && slot.onEngineNoMatch) {
          try {
            slot.onEngineNoMatch({
              engine: msg.engine,
              angle: msg.angle,
              stage: msg.stage,
              reason: msg.reason,
              textLength: msg.text_length,
              textPreview: msg.text_preview,
            });
          } catch {}
        }
        return;
      }
      if (msg.type !== 'result') return;
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.ok) {
        slot.resolve(msg.result);
      } else {
        const err = new Error(msg.error?.message || 'Unknown OCR worker error');
        if (msg.error?.stack) err.stack = msg.error.stack;
        if (msg.error?.tierError) err.tierError = true;
        // Propagate the structured fields the worker now emits with
        // every error (code='OCR_TIMEOUT' / stage / timeoutMs). Lets
        // downstream callers classify failures without parsing
        // err.message — see the no-regex-on-message contract added
        // alongside the trace artifact.
        if (msg.error?.code) err.code = msg.error.code;
        if (msg.error?.stage) err.stage = msg.error.stage;
        if (msg.error?.timeoutMs) err.timeoutMs = msg.error.timeoutMs;
        slot.reject(err);
      }
    });
    // Reject every pending slot. Idempotent — safe to call multiple times,
    // since after the first call `this.pending` is empty. The previous
    // version returned early when `this.dead` was already true, which left
    // the await in runLane orphaned whenever terminate() was invoked
    // externally (e.g. by the watchdog) before any error/exit fired.
    const failAll = (err) => {
      this.dead = true;
      for (const [, slot] of this.pending) slot.reject(err);
      this.pending.clear();
    };
    this.worker.on('error', (err) => {
      try { logError('bat.ocr.worker_thread', err, { phase: 'error' }); } catch {}
      failAll(err);
    });
    this.worker.on('exit', (code) => {
      // Always wake any pending awaits — even on a clean exit, an external
      // terminate() leaves slots stranded otherwise.
      const err = new Error(`OCR worker exited (code=${code})`);
      if (code !== 0) {
        try { logError('bat.ocr.worker_thread', err, { phase: 'exit', code }); } catch {}
      }
      failAll(err);
    });
  }

  // `onProgress(stage)` is called for every progress message the worker
  // emits between dispatch and the final result. Used by processQueue to
  // expose the current OCR stage in the in-flight UI.
  // `onEngineError({ engine, angle, stage, message, tierError })` is
  // called for every per-engine failure inside the worker's cascade.
  // Used by processQueue to log bat.ocr.engine_failed entries.
  // `onEngineNoMatch({ engine, angle, stage, reason, textLength, textPreview })`
  // is called when an engine returned text but it was either too short
  // OR didn't match the invoice-number regex. Used to log
  // bat.ocr.engine_no_match entries so silent fall-throughs are visible.
  extract(payload, timeoutMs, onProgress, onEngineError, onEngineNoMatch) {
    if (this.dead) return Promise.reject(new Error('OCR lane is dead'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          // Timing out a worker_thread call doesn't kill the worker; the
          // extraction inside may still finish. We mark this lane dead so it
          // gets recreated rather than reused with a stuck call.
          this.dead = true;
          try { this.worker.terminate(); } catch {}
          // Same structured shape as the worker-side timeouts, so
          // classification works identically whether the timeout fired
          // inside the worker (worker.code='OCR_TIMEOUT') or because
          // the lane itself ran out of patience waiting for the worker
          // to respond.
          const e = new Error('PDF timeout');
          e.code = 'OCR_TIMEOUT';
          e.stage = 'lane_timeout';
          e.timeoutMs = timeoutMs;
          reject(e);
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        onProgress,
        onEngineError,
        onEngineNoMatch,
      });
      try {
        this.worker.postMessage({ type: 'extract', id, payload });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async terminate() {
    try { this.worker.postMessage({ type: 'shutdown' }); } catch {}
    // Give the worker a moment to flush its Tesseract handle, then force-kill.
    await new Promise(r => setTimeout(r, 500));
    // Race Node's worker.terminate() against a 3s hard cap.
    //
    // ROOT CAUSE — discovered 2026-05-03 via a remote-site System Log:
    // when the worker thread is wedged in native code (Tesseract, sharp,
    // canvas on a syscall the OS can't preempt), `this.worker.terminate()`
    // returns a Promise that never resolves. The await above used to hang
    // forever on a wedged worker, which meant the catch in
    // processQueue.runLane never returned, the OUTER finally never fired,
    // and `currentlyProcessing.delete(next.id)` never ran.
    //
    // Symptom on the site: PDF_TIMEOUT fired (we saw the log), but the
    // row stayed in `currentlyProcessing` for 13+ minutes climbing from
    // 120s → 810s with no new events. Watchdog couldn't unstick it
    // because the wedge was on the parent main thread, not the worker.
    //
    // The worker is dead either way once we've called `terminate()`; we
    // don't need to wait for the OS-level cleanup. Resolving the race
    // unblocks runLane's finally → the row leaves currentlyProcessing →
    // the queue keeps moving → app stays responsive.
    await Promise.race([
      this.worker.terminate().catch(() => {}),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    this.dead = true;
  }
}

// Dynamic poison-invoice detection.
//
// When the same invoice number appears as the OCR'd extracted_invoice on
// THRESHOLD or more PODs in the same recon, that's overwhelmingly likely
// to be a header/customer-account/footer artefact rather than a genuine
// multi-delivery invoice. Round-6 baseline of recon 18 had IN578457
// appearing 7× across unrelated suppliers' PODs — clear smoking gun.
//
// Real legit dups (same invoice covering multiple delivery lines for one
// supplier order) cluster at 2-4×; THRESHOLD is set high enough that
// 5+ is already suspicious. Tunable via env.
//
// Note the chicken-and-egg: poison numbers extracted before the count
// crosses THRESHOLD won't be caught on this run. Operators can re-run
// affected rows from the UI; a future iteration could automatically
// re-queue rows whose final extracted_invoice ends up over threshold.
const POISON_DUP_THRESHOLD =
  Number.parseInt(process.env.BAT_POISON_INVOICE_THRESHOLD, 10) >= 2
    ? Number.parseInt(process.env.BAT_POISON_INVOICE_THRESHOLD, 10)
    : 5;

function getDynamicPoisonInvoices(reconId) {
  try {
    const rows = db.prepare(
      `SELECT extracted_invoice, COUNT(*) AS c
         FROM bat_invoice_extractions
        WHERE reconciliation_id = ?
          AND extraction_status = 'found'
          AND extracted_invoice IS NOT NULL
        GROUP BY extracted_invoice
       HAVING COUNT(*) >= ?`
    ).all(reconId, POISON_DUP_THRESHOLD);
    return rows.map(r => r.extracted_invoice).filter(Boolean);
  } catch (err) {
    // Don't let a failed query kill the OCR run — fall back to no
    // dynamic blacklist (the hard-coded set still applies inside the
    // worker). Surface so the operator can see if the column or table
    // shape changed unexpectedly.
    try {
      logError('bat.ocr.poison_query_failed', err, { reconciliation_id: reconId });
    } catch {}
    return [];
  }
}

async function processQueue(reconId) {
  const N = OCR_CONCURRENCY;
  console.log(`[bat-ocr] Starting worker_threads pool (concurrency=${N}) for reconciliation ${reconId}`);

  // Bootstrap env summary into the System Log. When a fresh-install site
  // hangs silently, the first question is "is the environment even right
  // for OCR to run?" — Node version mismatch, missing API keys (so the
  // pipeline falls all the way through to Tesseract), wrong OCR_CONCURRENCY,
  // missing previewDir, etc. This single log line gives an operator the
  // answers without RDP'ing into the box.
  try {
    logError(
      'bat.ocr.start',
      new Error(`Worker pool starting for reconciliation ${reconId}`),
      {
        reconciliation_id: reconId,
        concurrency: N,
        platform: process.platform,
        arch: process.arch,
        node_version: process.version,
        google_vision_key_set: !!getGoogleVisionKey(),
        ocr_space_key_set: !!getOcrSpaceKey(),
        preview_dir: previewDir,
      },
      'info',
    );
  } catch { /* never let observability crash a real run */ }

  const updateExtraction = db.prepare(`
    UPDATE bat_invoice_extractions
    SET extracted_invoice = ?, extraction_status = ?, preview_path = COALESCE(?, preview_path),
        extraction_attempts = extraction_attempts + 1, extraction_error = ?
    WHERE id = ?
  `);
  // Pull the next pending row that ISN'T already being processed by another
  // lane. The in-memory `inFlight` Set is the source of truth for "claimed by
  // a lane this run". Backed by idx_bat_extractions_recon_status (migration v50).
  const claimNextStmt = db.prepare(
    "SELECT * FROM bat_invoice_extractions WHERE reconciliation_id = ? AND extraction_status = 'pending' ORDER BY id LIMIT ?"
  );
  const inFlight = new Set();
  // Each row claimed by a lane gets a monotonically-increasing claim
  // sequence so the streak breaker can apply outcomes in queue order
  // (NOT lane-completion order). With OCR_CONCURRENCY > 1, a slow row
  // claimed earlier can finish AFTER a faster row claimed later — if
  // we tallied the streak as completions arrived, a late-arriving
  // success could fail to reset the counter before three later
  // cascade_exhausted completions trip the halt, and vice-versa. The
  // sequence + drain pattern (see recordOutcome below) makes the
  // breaker deterministic regardless of completion timing.
  let nextClaimSeq = 0;
  const claimNext = () => {
    const candidates = claimNextStmt.all(reconId, OCR_CONCURRENCY * 4);
    for (const row of candidates) {
      if (!inFlight.has(row.id)) {
        inFlight.add(row.id);
        row._claimSeq = nextClaimSeq++;
        return row;
      }
    }
    return null;
  };

  db.prepare("UPDATE bat_reconciliations SET last_error = NULL, last_error_at = NULL WHERE id = ?").run(reconId);

  // API keys are read once and passed to the worker per-task — the worker thread
  // has no DB access and shouldn't need any.
  const googleVisionKey = getGoogleVisionKey();
  const ocrSpaceKey = getOcrSpaceKey();
  const inDigitLength = getInvoiceInDigitLength();

  // Each lane carries its own row-count counter so we can recycle the
  // worker thread after a budget of rows. See `recycleLane` below for why.
  const lanes = Array.from({ length: N }, () => ({ worker: new OcrLane(), rowsProcessed: 0 }));

  // ── Periodic worker recycle ────────────────────────────────────────────
  //
  // Why: sharp (libvips), node-canvas (cairo), and pdfjs all allocate
  // native memory outside V8's accounting. V8 has no GC pressure on it,
  // so the buffers accumulate across rows in a single long-lived worker
  // thread. Operator metric `bat.ocr.memory` showed RSS climbing to
  // 17.9 GB at t+420s with only 47 MB on the JS heap and 7 MB tracked
  // as `external` — i.e. ~17.9 GB of unmanaged off-heap allocation.
  // Symptom-side: rows started taking 79+ seconds and PDF timeouts
  // spiked because the OS was swap-thrashing or near it.
  //
  // Fix: recycle the lane after a budget of rows (or when the process
  // RSS crosses a high-water mark). Each recycle is `worker.terminate()`
  // + `new OcrLane()` — the OS reclaims ALL native memory that worker
  // was holding when its process exits. Cost is the lane init time
  // (~1s for sharp/pdfjs/tesseract), which over the course of a 1000-row
  // recon is in the noise (~4% wallclock at recycle-every-25-rows).
  //
  // Two triggers:
  //   - rowsProcessed budget — predictable, bounded leak budget.
  //   - RSS budget — belt-and-braces against pathological PDFs that
  //     leak more per row than usual. Shared across all lanes (RSS is
  //     process-wide), so one lane crossing the threshold causes its
  //     own recycle; the others recycle on their own row count.
  //
  // Tunable via env so an operator can dial them down on a smaller box.
  //
  // NaN guard: `parseInt('abc', 10)` returns NaN, and `Math.max(1, NaN)`
  // returns NaN — not 1. Then every `>= NaN` check downstream is always
  // false, which would silently disable the recycle mechanism if a typo
  // landed in the env. Use a parse-then-validate helper that falls back
  // to the default for any non-finite or sub-floor value.
  const parsePositiveIntEnv = (envVal, defaultVal, floor) => {
    const n = parseInt(envVal, 10);
    if (!Number.isFinite(n) || n < floor) return defaultVal;
    return n;
  };
  const ROW_RECYCLE_BUDGET = parsePositiveIntEnv(
    process.env.OCR_LANE_ROW_BUDGET,
    25, // default
    1,  // floor — anything < 1 makes no sense
  );
  const RSS_RECYCLE_THRESHOLD_BYTES = parsePositiveIntEnv(
    process.env.OCR_LANE_RSS_BUDGET_MB,
    1200, // default 1.2 GB. Was 2 GB pre-2026.5.4 but production traces
          // showed RSS climbing back to 2.4 GB within ~37s of a 2 GB-
          // triggered recycle — the native leak rate (in pdfjs/node-canvas/
          // sharp) consistently outran recycle at 2 GB. Firing earlier
          // gives the recycle a chance to catch the worker BEFORE the
          // wedge, not after.
    256,  // floor 256 MB — anything lower would recycle constantly on a normal box
  ) * 1024 * 1024;
  // Hard process-exit threshold. If RSS climbs past this, the lane recycle
  // mechanism has lost the race against the native leak and the only safe
  // move is to crash the whole process so NSSM restarts us cleanly. Any
  // in-flight rows are left 'pending' for the next run to re-claim — the
  // claim is in-memory, not persisted, so process death automatically
  // releases them.
  const RSS_HARD_EXIT_THRESHOLD_BYTES = parsePositiveIntEnv(
    process.env.OCR_HARD_EXIT_RSS_MB,
    3072, // default 3 GB — well above the 1.2 GB recycle so a single
          // burst doesn't trip exit; only sustained climb does
    1024, // floor 1 GB
  ) * 1024 * 1024;
  // Try to spawn a fresh OcrLane up to maxAttempts times with exponential
  // backoff. Returns true on success, false after exhausting retries.
  // Single-attempt failure was today's "all lanes retired" path: one
  // transient hiccup during `new OcrLane()` was enough to permanently
  // retire a lane, and four consecutive transient hiccups would kill a
  // whole run. Retries with backoff catch the transient cases (file
  // contention, antivirus scan, etc.) without permanently giving up.
  async function tryLaneRecovery(lane, reconId, contextReason) {
    const MAX_ATTEMPTS = 3;
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        lane.worker = new OcrLane();
        lane.rowsProcessed = 0;
        if (attempt > 1) {
          try {
            logError(
              'bat.ocr.lane_recovered',
              new Error(`Lane recovered on attempt ${attempt}/${MAX_ATTEMPTS}`),
              { reconciliation_id: reconId, attempt, max_attempts: MAX_ATTEMPTS, context: contextReason },
              'info',
            );
          } catch {}
        }
        return true;
      } catch (e) {
        lastErr = e;
        if (attempt < MAX_ATTEMPTS) {
          // 1s, 2s, 4s ceiling — gives transient FS / native-binding
          // contention time to clear without making the operator wait
          // forever.
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
          try {
            logError(
              'bat.ocr.lane_recovery_retry',
              e,
              { reconciliation_id: reconId, attempt, max_attempts: MAX_ATTEMPTS, retry_in_ms: backoffMs, context: contextReason },
              'warn',
            );
          } catch {}
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }
    }
    // All attempts exhausted — surface as error and let the lane retire.
    try {
      logError(
        'bat.ocr.lane_recreate',
        lastErr,
        { reconciliation_id: reconId, attempts_exhausted: MAX_ATTEMPTS, context: contextReason },
      );
    } catch {}
    try {
      recordReconciliationError(
        reconId,
        `OCR lane crashed after ${MAX_ATTEMPTS} retries: ${lastErr?.message || 'unknown'}`,
      );
    } catch {}
    return false;
  }

  async function recycleLane(lane, reason) {
    try { await lane.worker.terminate(); } catch {}
    // ONLY the worker recreation goes inside the try/catch that decides
    // whether the lane retires. Observability (`logError`) is wrapped in
    // its own try/catch so a transient error_log write failure can't
    // promote into a worker-capacity failure — otherwise enough
    // observability blips would retire every lane and stall the recon
    // with rows still pending.
    //
    // tryLaneRecovery handles up to 3 attempts with exponential backoff,
    // so a single transient hiccup during `new OcrLane()` no longer
    // permanently retires the lane.
    const rssMbBefore = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const recovered = await tryLaneRecovery(lane, reconId, `recycle: ${reason}`);
    if (!recovered) return false;
    try {
      logError(
        'bat.ocr.lane_recycle',
        new Error(`Lane recycled (${reason}). RSS before recycle: ${rssMbBefore}MB`),
        {
          reconciliation_id: reconId,
          reason,
          rss_mb_before: rssMbBefore,
        },
        'info',
      );
    } catch {}
    return true;
  }

  // Slow-row monitor: every 30s, scan currentlyProcessing and emit a System
  // Log warning for any row past the SLOW_ROW_THRESHOLD. Tracks per-row
  // "warned" timestamps so we don't spam — each row gets at most one warn
  // per 60s of being stuck.
  const lastWarnedAt = new Map();
  const slowMonitor = setInterval(() => {
    const now = Date.now();
    for (const row of currentlyProcessing.values()) {
      if (row.reconciliation_id !== reconId) continue;
      const elapsed = now - row.started_at_ms;
      if (elapsed < SLOW_ROW_THRESHOLD_MS) continue;
      const lastWarn = lastWarnedAt.get(row.id) || 0;
      if (now - lastWarn >= 60_000) {
        lastWarnedAt.set(row.id, now);
        try {
          logError(
            'bat.ocr.row_slow',
            new Error(`Row ${row.id} (${row.store_name || 'unknown'}) processing for ${Math.floor(elapsed / 1000)}s`),
            { reconciliation_id: reconId, extraction_id: row.id, store_name: row.store_name, elapsed_seconds: Math.floor(elapsed / 1000) },
            'info',
          );
        } catch {}
      }

      // Backstop watchdog. The lane's internal PDF_TIMEOUT (120s) should
      // already have rejected this extract — but real-world traces show
      // rows stuck for 9-15+ minutes, meaning that timer's reject path
      // sometimes fails to unblock the await. Force-terminating the
      // worker_thread here triggers the OcrLane's `exit` handler, which
      // calls failAll() to reject every pending slot — that wakes the
      // await in runLane, the catch+finally clean up the row, and the
      // lane is replaced. We only fire once per row so a stuck OS-level
      // terminate doesn't loop.
      if (elapsed >= HARD_KILL_THRESHOLD_MS && !row.kill_attempted) {
        row.kill_attempted = true;
        try {
          logError(
            'bat.ocr.watchdog_kill',
            new Error(`Force-killing lane for row ${row.id} (${row.store_name || 'unknown'}) — stuck in stage '${row.stage || 'unknown'}' for ${Math.floor(elapsed / 1000)}s — internal PDF_TIMEOUT failed to fire`),
            {
              reconciliation_id: reconId,
              extraction_id: row.id,
              store_name: row.store_name,
              elapsed_seconds: Math.floor(elapsed / 1000),
              stuck_stage: row.stage || null,
              stuck_stage_for_seconds: row.stage_at_ms ? Math.floor((now - row.stage_at_ms) / 1000) : null,
              lane_dead_before: !!row.lane?.worker?.dead,
            },
          );
        } catch {}
        try { row.lane?.worker?.terminate(); } catch {}
      }
    }
  }, 30_000);
  if (typeof slowMonitor.unref === 'function') slowMonitor.unref();

  // Memory monitor — logs the Node process's resident-set size every 60s
  // while OCR is running. RSS includes the main thread AND every
  // worker_thread (they share the OS process), so this is the total
  // memory footprint of the OCR pipeline. If RSS climbs steadily and the
  // process then dies with no JS error, that's the OOM signature we've
  // been hunting. Always 'info' level — these aren't errors, they're
  // observability ticks.
  const startedAtMs = Date.now();
  let lastRssMb = 0;
  // Latch for the hard-exit path so a stuck setInterval can't fire
  // process.exit twice while the first scheduled exit is still pending.
  let hardExitFiring = false;

  // Per-run set of PDF URLs that wedged the worker thread. Once a URL has
  // forced a lane to be hard-killed (lane.worker.dead becomes true after
  // an extract that timed out at the parent's PDF_TIMEOUT), every later
  // row in this run with the same URL is failed fast with a verbose
  // explanation instead of being sent into pdfjs/node-canvas to wedge
  // the lane all over again. The set is per-run (not persisted), so
  // restarting OCR resets it — that's deliberate, since fixing the PDF
  // upstream OR raising OCR_MAX_RENDER_PIXELS should give it a fair
  // retry without manual intervention.
  const wedgedUrls = new Set();

  const memoryMonitor = setInterval(() => {
    try {
      const m = process.memoryUsage();
      const rssMb = Math.round(m.rss / 1024 / 1024);
      const heapMb = Math.round(m.heapUsed / 1024 / 1024);
      const heapTotalMb = Math.round(m.heapTotal / 1024 / 1024);
      const externalMb = Math.round(m.external / 1024 / 1024);
      const elapsedSec = Math.floor((Date.now() - startedAtMs) / 1000);

      // Hard exit gate. If we've climbed past the kill threshold, the
      // lane recycle mechanism has lost the race against the native leak.
      // Continuing means swap-thrashing or an OS-level OOM kill — both
      // are worse than a clean process exit + NSSM restart. Fire ONCE
      // (track via a flag so a stuck setInterval doesn't loop into
      // process.exit calls before the first one takes effect).
      if (m.rss >= RSS_HARD_EXIT_THRESHOLD_BYTES && !hardExitFiring) {
        hardExitFiring = true;
        const hardExitMb = Math.round(RSS_HARD_EXIT_THRESHOLD_BYTES / 1024 / 1024);
        const recycleMb  = Math.round(RSS_RECYCLE_THRESHOLD_BYTES / 1024 / 1024);
        try {
          logError(
            'bat.ocr.rss_hard_exit',
            new Error(
              `OCR process RSS reached ${rssMb} MB, above the hard-exit threshold of ${hardExitMb} MB. ` +
              `The lane-recycle mechanism (default ${recycleMb} MB) couldn't keep up with native ` +
              `memory growth — the leak is in pdfjs/node-canvas/sharp/Tesseract native allocators ` +
              `and isn't visible to V8's GC (heap is only ${heapMb} MB right now while RSS is ${rssMb} MB). ` +
              `Exiting the Cardoso process so NSSM restarts it cleanly. In-flight OCR rows will be ` +
              `left 'pending' and re-claimed on the next run; no data is lost. ` +
              `Operator action: if this triggers repeatedly on the same recon, lower ` +
              `OCR_MAX_RENDER_PIXELS or OCR_MAX_RENDER_WIDTH in .env to reduce per-page memory pressure, ` +
              `or raise OCR_HARD_EXIT_RSS_MB if the box has more headroom than the default 3 GB.`
            ),
            {
              reconciliation_id: reconId,
              rss_mb: rssMb,
              heap_mb: heapMb,
              external_mb: externalMb,
              hard_exit_threshold_mb: hardExitMb,
              recycle_threshold_mb: recycleMb,
              in_flight_count: currentlyProcessing.size,
            },
            'error',
          );
        } catch {}
        // Give logError + downstream alert eval a moment to flush. The
        // sync better-sqlite3 INSERT inside logError lands immediately,
        // but we want any async observers (SSE listeners, alert engine)
        // to drain too. 1s is generous — the harm of waiting longer is
        // RSS climbing further; the harm of exiting too fast is a missed
        // alert. 1s is a reasonable middle.
        setTimeout(() => { try { process.exit(1); } catch { /* should never reach */ } }, 1000);
        return; // skip the regular memory-tick log this cycle
      }

      // Suppress when nothing has materially changed (within 5MB) to keep
      // the log signal-to-noise high. Always log the first tick.
      if (lastRssMb && Math.abs(rssMb - lastRssMb) < 5) return;
      lastRssMb = rssMb;
      logError(
        'bat.ocr.memory',
        new Error(`RSS ${rssMb}MB · heap ${heapMb}/${heapTotalMb}MB · native ${externalMb}MB · t+${elapsedSec}s`),
        {
          reconciliation_id: reconId,
          rss_mb: rssMb,
          heap_used_mb: heapMb,
          heap_total_mb: heapTotalMb,
          external_mb: externalMb,
          elapsed_seconds: elapsedSec,
          in_flight_count: currentlyProcessing.size,
          concurrency: N,
        },
        'info',
      );
    } catch { /* never let observability crash a real run */ }
  }, 60_000);
  if (typeof memoryMonitor.unref === 'function') memoryMonitor.unref();

  // Circuit breaker: halt OCR if too many consecutive rows return readable
  // text but no invoice-regex match. The signal that means "the regex
  // doesn't recognise this supplier's invoice format" — exactly the
  // failure mode that took down a production run today (INQ-prefixed
  // numbers that the IN-only regex couldn't parse). Without this,
  // every row in the queue walks the full engine cascade looking for a
  // match it'll never find, blowing extract_total budget, exhausting
  // lanes, and leaving the operator with no signal about what's wrong.
  //
  // Threshold tunable so a small recon doesn't auto-halt on a coincidence
  // (default 5 = "if the first 5 rows all walk the cascade with text but
  // no match, that's a regex problem, not bad luck").
  const REGEX_STREAK_HALT_THRESHOLD = parsePositiveIntEnv(
    process.env.OCR_REGEX_STREAK_HALT_THRESHOLD,
    5,
    2,
  );
  // The streak is shared across ALL lanes for this run — a regex problem
  // would manifest on every lane simultaneously, so per-lane streaks
  // would never trip the threshold individually.
  let cascadeExhaustedStreak = 0;
  // Set when the streak breaker fires, so the post-lanes "stillPending"
  // check can skip the generic "all lanes retired" error message — that
  // message would mask the real auto-halt reason and mislead the operator
  // toward investigating lane recreation rather than the regex.
  let regexHaltTriggered = false;

  // In-order outcome drain. Lanes call recordOutcome(seq, kind, ctx) when
  // a row resolves; outcomes buffer until the next-expected sequence
  // arrives, then drain in queue order applying each to the streak.
  // This is the fix for the concurrency bug where lane-completion order
  // diverged from queue order with OCR_CONCURRENCY > 1.
  //
  // kind values:
  //   'matched'           — invoice found → reset streak
  //   'cascade_exhausted' — text returned, no regex match → +1, may halt
  //   'reset'             — non-cascade not_found (render fail, invalid
  //                          PDF, etc.) → reset; not a regex signal but
  //                          previous behavior reset and we preserve it
  //   'noop'              — exception / pause-during-flight → leave
  //                          streak alone; we have no regex signal from
  //                          this row, but don't punish a prior streak
  //                          either
  let nextResolveSeq = 0;
  const pendingOutcomes = new Map();
  const recordOutcome = (seq, kind, ctx) => {
    pendingOutcomes.set(seq, { kind, ...(ctx || {}) });
    while (pendingOutcomes.has(nextResolveSeq)) {
      const o = pendingOutcomes.get(nextResolveSeq);
      pendingOutcomes.delete(nextResolveSeq);
      nextResolveSeq += 1;
      if (o.kind === 'matched' || o.kind === 'reset') {
        cascadeExhaustedStreak = 0;
      } else if (o.kind === 'cascade_exhausted') {
        cascadeExhaustedStreak += 1;
        if (cascadeExhaustedStreak >= REGEX_STREAK_HALT_THRESHOLD && !regexHaltTriggered) {
          // Halt the queue. setOcrPaused persists the pause flag in
          // bat_settings so the operator-visible Pause toggle stays in
          // sync, and pending rows survive a service restart in their
          // pending state.
          try { setOcrPaused(true); } catch {}
          regexHaltTriggered = true;
          const haltMsg =
            `OCR auto-halted: ${cascadeExhaustedStreak} consecutive rows returned text but no invoice regex match. ` +
            `Likely cause: the supplier's invoice number format isn't recognised by findInvoiceNumber. ` +
            `Inspect a recent bat.ocr.engine_no_match log entry's text_preview field, then update the regex / restart.`;
          try {
            logError(
              'bat.ocr.regex_streak_halt',
              new Error(haltMsg),
              {
                reconciliation_id: reconId,
                streak: cascadeExhaustedStreak,
                threshold: REGEX_STREAK_HALT_THRESHOLD,
                last_extraction_id: o.extraction_id,
                last_store_name: o.store_name,
              },
              'error',
            );
          } catch {}
          try { recordReconciliationError(reconId, haltMsg); } catch {}
          // Reset so a future resume gets a fresh window.
          cascadeExhaustedStreak = 0;
        }
      }
      // 'noop' just advances the pointer.
    }
  };

  const runLane = async (lane) => {
    while (true) {
      if (ocrPaused) {
        console.log('[bat-ocr] Paused — lane exiting after current item');
        return;
      }
      const next = claimNext();
      if (!next) return;

      // Per-URL skip: if a previous row in this run wedged the worker
      // on this exact URL, fail the row fast instead of handing it back
      // to pdfjs/node-canvas to wedge another lane. The error text
      // explains exactly what happened so the operator can act on it
      // (the original wedge already wrote a verbose log entry; this
      // entry just makes the cause visible per row that gets skipped).
      if (next.pdf_url && wedgedUrls.has(next.pdf_url)) {
        const skipMsg =
          `Skipped: this PDF URL wedged the OCR worker earlier in this run, so it has been added ` +
          `to a per-run skip list to stop it grinding the rest of the queue. ` +
          `URL: ${next.pdf_url}. ` +
          `Operator action: download the PDF and inspect it (typical culprits are banner-format ` +
          `documents, multi-page-merged PDFs, or pages with very large embedded images). The skip ` +
          `list resets per OCR run, so restarting OCR will retry this URL automatically once the ` +
          `underlying PDF is fixed or OCR_MAX_RENDER_PIXELS is raised in .env.`;
        try {
          updateExtraction.run(null, 'failed', null, skipMsg.slice(0, 1000), next.id);
        } catch (writeErr) {
          try { logError('bat.ocr.row_update', writeErr, { extraction_id: next.id, original_err: 'wedged-url skip' }); } catch {}
        }
        try {
          logError(
            'bat.ocr.url_skipped',
            new Error(skipMsg),
            { reconciliation_id: reconId, extraction_id: next.id, store_name: next.store_name, pdf_url: next.pdf_url },
            'warn',
          );
        } catch {}
        recordOutcome(next._claimSeq, 'noop');
        inFlight.delete(next.id);
        emitExtractionUpdate(reconId);
        continue;
      }

      // Mark this row as in-flight in the module-level registry so
      // getExtractionProgress can report it back to the UI.
      currentlyProcessing.set(next.id, {
        id: next.id,
        store_name: next.store_name,
        reconciliation_id: reconId,
        started_at_ms: Date.now(),
        lane,                  // ref so the watchdog can terminate the worker
        kill_attempted: false, // ensures we only fire the watchdog once per row
        stage: 'queued',       // updated by the worker's progress messages below
        stage_at_ms: Date.now(),
      });
      console.log(`[bat-ocr] Processing id=${next.id} ${next.store_name || ''}`);
      // Dynamic poison-invoice list, computed PER ROW so each extract
      // call sees the freshest blacklist. The query is a tiny grouped
      // SELECT against bat_invoice_extractions and is cheap enough at
      // this rate. Hard-coded poison list is added inside the worker —
      // we don't ship it across the postMessage boundary.
      const excludeInvoices = getDynamicPoisonInvoices(reconId);
      try {
        try {
          const result = await lane.worker.extract(
            {
              pdfUrl: next.pdf_url,
              extractionId: next.id,
              googleVisionKey,
              ocrSpaceKey,
              inDigitLength,
              excludeInvoices,
            },
            PDF_TIMEOUT,
            // onProgress: worker emits these as it transitions between
            // stages (download → pdf_text → render → engine:NAME@ANGLE).
            // Update the row's entry so the UI's in-flight panel can
            // show the current stage in real time, and we also get a
            // breadcrumb for which stage the watchdog killed (if it
            // does).
            (stage) => {
              const row = currentlyProcessing.get(next.id);
              if (row) {
                row.stage = stage;
                row.stage_at_ms = Date.now();
              }
              // Push an SSE update on every stage transition so the UI's
              // in-flight panel reflects what's happening in real time.
              // Without this, a row that ends in an extract_total timeout
              // looks like 90 seconds of silence — the SSE stream only
              // fires on row completion, so the operator sees nothing
              // while the cascade walks through GV → ocr.space → Tesseract.
              // Cheap (just an EventEmitter emit + the SSE handler reads
              // currentlyProcessing); no throttle needed at this rate.
              emitExtractionUpdate(reconId);
            },
            // Per-engine error logging. Fires once per engine.run() throw
            // inside the worker's cascade. The most common signal here is
            // "Google Vision is in scope but rejecting every call" — e.g.
            // 403 because the Cloud Vision API isn't enabled on the project,
            // or the key is IP-restricted. Without this log the cascade
            // silently fell through to ocr.space → Tesseract and the
            // operator wasted hours wondering why GV "wasn't being used".
            (info) => {
              try {
                // Cooldown skips: no OCR call was attempted, no engine
                // actually failed. Logging these as bat.ocr.engine_failed
                // at error level pollutes the failure signal during
                // rate-limit windows (each cooldown row would emit one
                // engine_failed per cooled engine) and triggers operator
                // alerts pointed at the wrong cause. Route to a distinct
                // topic at info level so the cooldown is still visible
                // in the System Log without masquerading as a failure.
                if (info.cooldown) {
                  logError(
                    'bat.ocr.engine_cooldown_skip',
                    new Error(`${info.stage}: ${info.message}`),
                    {
                      reconciliation_id: reconId,
                      extraction_id: next.id,
                      store_name: next.store_name,
                      engine: info.engine,
                      angle: info.angle,
                    },
                    'info',
                  );
                } else {
                  logError(
                    'bat.ocr.engine_failed',
                    new Error(`${info.stage}: ${info.message}`),
                    {
                      reconciliation_id: reconId,
                      extraction_id: next.id,
                      store_name: next.store_name,
                      engine: info.engine,
                      angle: info.angle,
                      tier_error: info.tierError,
                    },
                  );
                }
              } catch {}
            },
            // Engine returned text but produced no usable invoice. The
            // text_preview field shows the first 200-300 chars so an
            // operator can see WHY the regex didn't match — common cases
            // are an unexpected invoice-number format, a foreign language,
            // a logo-only page, or text that GV reads correctly but in a
            // way findInvoiceNumber doesn't expect.
            (info) => {
              try {
                logError(
                  'bat.ocr.engine_no_match',
                  new Error(`${info.stage}: ${info.reason} (${info.textLength} chars)`),
                  {
                    reconciliation_id: reconId,
                    extraction_id: next.id,
                    store_name: next.store_name,
                    engine: info.engine,
                    angle: info.angle,
                    reason: info.reason,
                    text_length: info.textLength,
                    text_preview: info.textPreview,
                  },
                  'info',
                );
              } catch {}
            },
          );
          const invoiceNumber = result?.invoice ?? null;
          const previewPath = result?.previewPath ?? null;
          const engineError = result?.error ?? null;
          // Trace artifact added in the OCR observability batch — lets
          // an operator answer "which engine produced this number" when
          // a recon row is later disputed. Logged inline for now;
          // persisted alongside bat_extractions in a follow-up migration
          // if/when the audit UI grows a "show source" affordance.
          const traceSource = result?.source || null;
          const traceEngine = result?.engine || null;
          const traceAngle = result?.angle ?? null;

          if (invoiceNumber) {
            updateExtraction.run(invoiceNumber, 'found', previewPath, null, next.id);
            const traceTag = traceEngine ? ` [${traceSource}: ${traceEngine}@${traceAngle}]` : '';
            console.log(`[bat-ocr] id=${next.id} -> ${invoiceNumber}${traceTag}`);
            recordOutcome(next._claimSeq, 'matched');
            try {
              logError(
                'bat.ocr.match',
                new Error(`id=${next.id} matched ${invoiceNumber} via ${traceSource || 'unknown'}${traceEngine ? `:${traceEngine}@${traceAngle}` : ''}`),
                {
                  reconciliation_id: reconId,
                  extraction_id: next.id,
                  store_name: next.store_name,
                  invoice: invoiceNumber,
                  source: traceSource,
                  engine: traceEngine,
                  angle: traceAngle,
                },
                'info',
              );
            } catch {}
          } else {
            updateExtraction.run(null, 'not_found', previewPath, engineError, next.id);
            console.log(`[bat-ocr] id=${next.id} — not found${engineError ? ` (engine issue: ${engineError})` : ''}${traceSource ? ` [reason: ${traceSource}]` : ''}`);
            if (engineError) recordReconciliationError(reconId, engineError);
            // Streak signal selection — see recordOutcome above for
            // semantics. Only 'cascade_exhausted' (engine returned ≥20
            // chars, regex didn't match) feeds the breaker; every other
            // not_found shape resets, because they don't tell us anything
            // about regex health (engine outages, render failures, etc.).
            if (traceSource === 'cascade_exhausted') {
              recordOutcome(next._claimSeq, 'cascade_exhausted', {
                extraction_id: next.id,
                store_name: next.store_name,
              });
            } else {
              recordOutcome(next._claimSeq, 'reset');
            }
          }
          emitExtractionUpdate(reconId);
        } catch (err) {
          console.error(`[bat-ocr] id=${next.id} failed: ${err.message}`);
          // Pull the row's last-known stage breadcrumb before we delete its
          // currentlyProcessing entry in the finally — used to attribute
          // "extract_total timed out — but in WHICH stage" in the row log.
          const stuckStage = currentlyProcessing.get(next.id)?.stage || null;
          // Log everything we know about this failure so a remote operator can
          // diagnose without ssh access. Includes err.code (e.g. SQLITE_RANGE),
          // constructor name (RangeError vs TypeError vs Error), the lane
          // state, and the last stage the worker reported being in.
          try {
            logError('bat.ocr.row', err, {
              reconciliation_id: reconId,
              extraction_id: next.id,
              store_name: next.store_name,
              pdf_url: next.pdf_url,
              err_code: err?.code,
              err_kind: err?.constructor?.name,
              lane_dead: !!lane.worker?.dead,
              last_stage: stuckStage,
            });
          } catch {}
          // Pause-aware row handling. If the operator paused mid-run,
          // in-flight rows whose extract is racing toward an extract_total
          // timeout aren't really "broken" — the user just wanted to stop.
          // Don't mark them 'failed' (they should be retryable on resume),
          // and don't recordReconciliationError (which would toast at the
          // operator who literally just clicked Pause). Just leave the row
          // 'pending' for the next run to pick up.
          if (ocrPaused) {
            console.log(`[bat-ocr] id=${next.id} interrupted by pause — leaving 'pending' for retry on resume`);
            // 'noop' so the in-order drain pointer advances past this
            // seq even though the row will be re-claimed in a later run.
            // Without it, any later cascade_exhausted outcome with a
            // higher seq would buffer forever and the breaker wouldn't
            // see it. (In practice the lane exits right after pause, but
            // marking is cheap and removes the assumption.)
            recordOutcome(next._claimSeq, 'noop');
            emitExtractionUpdate(reconId);
          } else {
            // Even on exception (timeout, worker exit, lane crash), the
            // worker may have already written a preview JPEG to
            // previewDir before the failure — `preview_save` runs
            // BEFORE the engine cascade in extractInvoiceFromPdf. Salvage
            // the path so the operator can manually look at the page
            // and enter the invoice number, instead of seeing "failed"
            // with no way to recover.
            //
            // Naming convention: `<extractionId>.jpg` in previewDir.
            // existsSync is sync but cheap — single fs.stat. The
            // COALESCE in updateExtraction's UPDATE statement preserves
            // any prior preview if the file isn't there now.
            //
            // Stored as the `/api/bat/preview/<file>` URL form (NOT raw
            // filename) to match the success path in ocrWorker.js — the
            // UI uses preview_path verbatim as an <a href>, so a bare
            // filename would render as a broken relative link and defeat
            // the recovery affordance.
            let salvagedPreview = null;
            try {
              const candidate = path.join(previewDir, `${next.id}.jpg`);
              if (fs.existsSync(candidate)) salvagedPreview = `/api/bat/preview/${next.id}.jpg`;
            } catch {}
            try {
              updateExtraction.run(null, 'failed', salvagedPreview, String(err.message || 'Unknown error').slice(0, 1000), next.id);
            } catch (writeErr) {
              // If the row UPDATE itself fails, we MUST surface that — otherwise
              // the lane silently fails to mark the row 'failed' and processQueue
              // never advances.
              try { logError('bat.ocr.row_update', writeErr, { extraction_id: next.id, original_err: err.message }); } catch {}
            }
            recordReconciliationError(reconId, `Extraction id=${next.id}: ${err.message}`);
            // 'noop' so the in-order drain pointer advances. An exception
            // tells us nothing about regex health (the cascade may not
            // have even run), so we don't increment OR reset the streak
            // — just step over this row.
            recordOutcome(next._claimSeq, 'noop');
            emitExtractionUpdate(reconId);
          }

          // Lane is dead (timeout or worker crash) — replace it via the
          // retry helper so a single transient hiccup during
          // `new OcrLane()` doesn't permanently retire the lane.
          if (lane.worker.dead) {
            // Per-URL skip on hard kill — but ONLY when the wedge was in
            // the render stage. A lane is also marked dead for many
            // non-PDF causes:
            //   - extract_total / engine:* timeouts (Google Vision slow,
            //     ocr.space rate-limited, Tesseract crash)
            //   - tesseract_init / canvas init failures
            //   - generic worker crashes during the cascade
            // In all those cases the URL is fine; blacklisting it would
            // incorrectly drain other rows pointing at the same PDF
            // during a transient API/network incident. The wedge we
            // actually want to blacklist is pdfjs+node-canvas blocking
            // the worker thread inside render — that's the case where
            // the same URL will reliably wedge another lane if we hand
            // it back. Gate on the row's last reported stage being
            // 'render' (set by emitProgress just before page.render).
            //
            // Done BEFORE tryLaneRecovery so even a recovery failure
            // still records the bad URL for the next run that picks
            // up where we left off.
            if (next.pdf_url && stuckStage === 'render') {
              wedgedUrls.add(next.pdf_url);
              try {
                logError(
                  'bat.ocr.url_blacklisted',
                  new Error(
                    `PDF URL added to per-run skip list because the OCR worker wedged in the render stage ` +
                    `and required a hard kill (parent-side PDF_TIMEOUT fired after ${PDF_TIMEOUT}ms while the ` +
                    `worker was still inside pdfjs/node-canvas). Future rows in this run with the same URL ` +
                    `will be failed fast without another render attempt. URL: ${next.pdf_url}. ` +
                    `Operator action: this PDF has malformed content, an unusual viewport ` +
                    `(banner format, multi-page-merged), or hits a known pdfjs/node-canvas bug ` +
                    `that blocks the worker thread synchronously inside native code. Download the ` +
                    `URL and inspect it. The skip list resets per OCR run, so restarting OCR will ` +
                    `retry once the underlying PDF is fixed or OCR_MAX_RENDER_PIXELS is raised.`
                  ),
                  { reconciliation_id: reconId, extraction_id: next.id, store_name: next.store_name, pdf_url: next.pdf_url, last_stage: stuckStage },
                  'warn',
                );
              } catch {}
            } else if (next.pdf_url) {
              // Lane died in a non-render stage (or stage attribution
              // was lost). Don't blacklist the URL — but log the lane
              // death with stage attribution so the operator can see
              // WHICH stage failed when triaging. Distinguishes "this
              // PDF is poison" from "OCR provider X is having a moment"
              // or "the worker crashed mid-engine-call".
              try {
                logError(
                  'bat.ocr.lane_died_non_render',
                  new Error(
                    `OCR lane died after extract failure on row ${next.id}, but the failure was NOT in the render ` +
                    `stage — last reported stage was '${stuckStage || 'unknown'}'. The PDF URL is NOT being blacklisted ` +
                    `(non-render lane deaths are usually transient: OCR provider slowness, engine timeouts, network ` +
                    `blips, Tesseract crashes). Other rows pointing at the same URL will retry normally. ` +
                    `URL: ${next.pdf_url}. ` +
                    `Operator action: if you see clusters of these on the same engine name, check that engine's ` +
                    `health (Google Vision quota, ocr.space rate-limit window, etc.).`
                  ),
                  { reconciliation_id: reconId, extraction_id: next.id, store_name: next.store_name, pdf_url: next.pdf_url, last_stage: stuckStage },
                  'info',
                );
              } catch {}
            }
            try { await lane.worker.terminate(); } catch {}
            // tryLaneRecovery does its own retry-with-backoff and
            // already calls logError + recordReconciliationError on
            // exhaustion, so we just check the boolean return.
            const recovered = await tryLaneRecovery(lane, reconId, 'dead-worker recreate');
            if (!recovered) {
              inFlight.delete(next.id);
              return; // lane retires after exhausted retries
            }
          }
        }
      } finally {
        inFlight.delete(next.id);
        currentlyProcessing.delete(next.id);
        lastWarnedAt.delete(next.id);

        // Periodic recycle. Only fires when the lane's worker is still
        // alive — if the dead-worker catch above already replaced it,
        // `lane.rowsProcessed` was reset there and we won't recycle again
        // immediately. We recycle BEFORE the next claimNext() so the
        // next row gets a fresh worker; this avoids running the recycle
        // while a row is in-flight.
        if (!lane.worker.dead) {
          lane.rowsProcessed = (lane.rowsProcessed || 0) + 1;
          const rss = process.memoryUsage().rss;
          if (lane.rowsProcessed >= ROW_RECYCLE_BUDGET) {
            const ok = await recycleLane(lane, `row_budget (processed ${lane.rowsProcessed} rows)`);
            if (!ok) { inFlight.delete(next.id); return; } // lane retires
          } else if (rss >= RSS_RECYCLE_THRESHOLD_BYTES) {
            const ok = await recycleLane(lane, `rss_budget (RSS ${Math.round(rss / 1024 / 1024)}MB ≥ ${Math.round(RSS_RECYCLE_THRESHOLD_BYTES / 1024 / 1024)}MB)`);
            if (!ok) { inFlight.delete(next.id); return; }
          }
        }
      }
    }
  };

  try {
    await Promise.all(lanes.map(runLane));
  } finally {
    clearInterval(slowMonitor);
    clearInterval(memoryMonitor);
    await Promise.all(lanes.map(l => l.worker.terminate()));
    // Defensive: drop any leftover entries from this recon. Shouldn't be
    // needed since each runLane's finally cleans up, but a worker_thread
    // crash mid-process could conceivably skip the finally.
    for (const [id, row] of currentlyProcessing) {
      if (row.reconciliation_id === reconId) currentlyProcessing.delete(id);
    }
  }

  // If every lane retired (recreation failed) while rows are still
  // 'pending', the run effectively died mid-flight. Surface that to the
  // UI as a recon-level error so the operator sees a toast/banner rather
  // than a queue that quietly stalls. This also prevents the next
  // workerRunning check from masking the failure.
  //
  // Exception: if the regex-streak breaker fired, lanes exited cleanly
  // by design and pending rows are intentional (waiting for the operator
  // to resume after fixing the regex). The breaker has already recorded
  // its own descriptive error via recordReconciliationError, so we skip
  // the generic "all lanes retired" message — emitting it here would
  // overwrite the halt reason and point the operator at lane recreation
  // logs that have nothing to do with the actual problem.
  const stillPending = db.prepare(
    "SELECT COUNT(*) AS c FROM bat_invoice_extractions WHERE reconciliation_id = ? AND extraction_status = 'pending'"
  ).get(reconId)?.c || 0;
  if (stillPending > 0 && !regexHaltTriggered) {
    const msg = `OCR run ended with ${stillPending} row${stillPending === 1 ? '' : 's'} still pending — all lanes retired. Check the System Log for bat.ocr.lane_recreate / bat.ocr.watchdog_kill entries.`;
    db.prepare("UPDATE bat_reconciliations SET status = 'error', last_error = ?, last_error_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(msg, reconId);
    try { logError('bat.ocr.run_incomplete', new Error(msg), { reconciliation_id: reconId, pending: stillPending }); } catch {}
    emitExtractionUpdate(reconId);
    return;
  }
  if (regexHaltTriggered) {
    // Halt is its own terminal state — leave status as 'error' (already
    // set by recordReconciliationError's path), don't try to flip to
    // 'completed' below, and don't run normalizeInvoiceNumbers since the
    // run was cut short. Operator resumes by clearing pause + restarting.
    db.prepare("UPDATE bat_reconciliations SET status = 'error' WHERE id = ?").run(reconId);
    emitExtractionUpdate(reconId);
    return;
  }

  normalizeInvoiceNumbers(reconId);
  // The OCR worker has zero Sage involvement by design. There used to be an
  // `await matchExtractedInvoices(reconId)` call here that scanned APOBL —
  // a hung Sage connection would wedge processQueue, leave workerRunning=true
  // forever, and silently block every subsequent reconciliation from starting.
  // That whole code path was wrong: Sage's role in a BAT recon is
  // pulling credit notes via /refresh-sage, not cross-referencing OCR'd
  // invoice numbers. The function is gone, this comment is its tombstone.
  // Clear last_error on successful completion. The recon is now in a 'completed'
  // state so any prior failure has been superseded by this successful run —
  // showing the old toast would be misleading. The original failure is still
  // preserved indefinitely in error_log / System Log, so this is not a
  // silent-failure pattern: history stays, current state reflects reality.
  db.prepare("UPDATE bat_reconciliations SET status = 'completed', last_error = NULL, last_error_at = NULL WHERE id = ?").run(reconId);
  // NOTE: Don't recompute supplier_total here. The recon's BAT TOTAL
  // is the BAT Overview-tab claim summary set at upload time, not a
  // number derived from PODs after OCR. recomputeSupplierTotalSafe
  // exists for the multi-branch self-heal only (upload paths). OCR
  // status is surfaced per-row via the tile's POD-coverage signals,
  // not by overwriting the headline total.
  console.log(`[bat-ocr] Extraction complete for reconciliation ${reconId}`);
  emitExtractionUpdate(reconId);
}

function getBatSetting(key) {
  try {
    const row = db.prepare('SELECT value FROM bat_settings WHERE key = ?').get(key);
    return row?.value || null;
  } catch { return null; }
}

function setBatSetting(key, value) {
  try {
    db.prepare(`INSERT INTO bat_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(key, String(value));
  } catch (e) { console.error('[bat-settings] write failed:', e.message); }
}

function getGoogleVisionKey() {
  return getBatSetting('google_vision_key') || process.env.GOOGLE_VISION_KEY || null;
}

function getOcrSpaceKey() {
  return getBatSetting('ocr_space_key') || process.env.OCR_SPACE_KEY || null;
}

// Per-site BAT invoice number length (digits after "IN"). Sites differ:
// the legacy stores use IN + 9 digits (IN000xxxxxx), the newer onboarded
// sites use IN + 8 digits (IN00xxxxxx). Drives whether findInvoiceNumber
// pads a borderline OCR read or leaves it alone.
function getInvoiceInDigitLength() {
  const v = parseInt(getBatSetting('invoice_in_digit_length') || '', 10);
  return (v === 8 || v === 9) ? v : 9;
}

function recordReconciliationError(reconId, message) {
  if (!reconId || !message) return;
  // Mirror to the global error_log so off-site operators can see it in the
  // System Log page without needing to drill into a specific reconciliation.
  try { logError('bat.recon', new Error(String(message)), { reconciliation_id: reconId }); } catch {}
  try {
    db.prepare(
      "UPDATE bat_reconciliations SET last_error = ?, last_error_at = datetime('now') WHERE id = ?"
    ).run(String(message).slice(0, 500), reconId);
  } catch (err) {
    console.error('[bat] Failed to persist reconciliation error:', err.message);
  }
}

// The full multi-engine OCR pipeline (extractInvoiceFromPdf) lives in
// src/services/ocrWorker.js now and runs off the main thread. The two helpers
// below stay on the main thread because they're only used by the
// "retry not_found with Google Vision" path (operator-triggered, infrequent),
// and moving that path to the worker pool too is a follow-up.

// Preview storage directory — created on the main thread so it's guaranteed
// to exist before any worker tries to write to it.
const previewDir = path.join(process.cwd(), 'uploads', 'bat-previews');
if (!fs.existsSync(previewDir)) fs.mkdirSync(previewDir, { recursive: true });

// pdfjs+node-canvas rendering moved out-of-process to renderPdfChild.js
// — same Phase 1 isolation the hot path now uses. The cold path here
// is the "Retry with Google Vision" button on the recon page, which is
// operator-triggered and infrequent, but the same wedge risk applies
// (node-canvas blocking the main thread synchronously would freeze the
// whole API event loop, not just one worker thread — arguably worse
// than the hot-path failure mode).
//
// Caps default to the same envelope ocrWorker.js uses; this cold path
// doesn't read OCR_MAX_RENDER_* env vars directly because it's
// historically allowed scale up to 3.0 and per-page caps are enforced
// inside the child anyway.
async function pdfPageToImage(buffer, pageNum, scale = 3.0) {
  const { renderPdfInChild } = await import('./ocr/spawnRenderChild.js');
  return renderPdfInChild(buffer, {
    pageNum,
    requestedScale: scale,
    // 60s timeout (vs the hot path's 30s) — the operator is sitting
    // there waiting on the retry button to come back. A genuinely
    // wedged page should fail fast, but a slow render shouldn't kill
    // the retry mid-stream.
    timeoutMs: 60_000,
  });
}

async function ocrViaGoogleVision(imageBuffer) {
  const apiKey = getGoogleVisionKey();
  if (!apiKey) throw new Error('GOOGLE_VISION_KEY not set');
  const base64 = imageBuffer.toString('base64');
  const body = {
    requests: [{
      image: { content: base64 },
      features: [{ type: 'TEXT_DETECTION', maxResults: 1 }],
    }],
  };
  // 30s cap. Hung Google Vision call in this main-thread retry path would
  // otherwise stall the event loop until socket timeout (60-120s), blocking
  // every other request. The worker-thread version of this engine already
  // wraps in fetchWithTimeout — this is the same guard for the retry batch.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  let res;
  try {
    res = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google Vision HTTP ${res.status}: ${err.substring(0, 200)}`);
  }
  const data = await res.json();
  const annotation = data.responses?.[0]?.fullTextAnnotation;
  return annotation?.text || '';
}

// findInvoiceNumber moved to ./bat/findInvoiceNumber.js (also imported
// at the top of this file). Don't re-define here. The shared module
// is the only place to update the regex pipeline.

// matchExtractedInvoices used to live here. It scanned every BAT-vendor
// invoice in Sage's APOBL table, then for each OCR'd invoice on a recon
// it set match_status to 'matched' / 'unmatched' and wrote sage_match_*
// columns. That cross-reference doesn't reflect the actual workflow —
// Sage involvement in a BAT recon is "pull credit notes for the week"
// (see querySageCreditNotes / /api/bat/reconciliation/:id/refresh-sage),
// not "look up every invoice number we OCR'd." Worse: the scan was an
// unbounded MSSQL query that ran inline in the OCR worker, and a hung
// Sage connection would wedge processQueue, leaving workerRunning=true
// indefinitely and blocking every subsequent reconciliation from
// extracting. The function and its callers are gone. The
// sage_match_document / sage_match_amount / match_status columns on
// bat_invoice_extractions are unused; left in place to avoid a
// destructive migration.

// ── Dashboard Aggregates ─────────────────────────────────────────────────────

export function getDashboardData(year) {
  // year may be a number, a numeric string, "all", or undefined. Anything
  // that isn't a valid year falls through to "all-time" (no scoping).
  const yr = Number.parseInt(year, 10);
  const scoped = Number.isFinite(yr) && yr > 1900 && yr < 9999 ? yr : null;
  const yearWhere = scoped ? 'WHERE year = ?' : '';
  const yearArg = scoped ? [scoped] : [];

  const reconciliations = listReconciliations()
    .filter(r => !scoped || r.year === scoped);

  // totalSupplier — per-fee sum (delivery + discount + pricing). The
  // per-week comparison table on the recon page sums these three fee
  // columns to render each week's BAT figure, so by summing the same
  // columns here the tile is mathematically guaranteed to equal the
  // table's sum of per-week BAT — operator's mental model stays
  // consistent.
  //
  // Previously this used the bat_reconciliations.supplier_total column
  // (set by recomputeSupplierTotalSafe, which sums per-invoice
  // order_amount from OCR extractions). That can drift from the per-
  // fee Overview-tab claim when some rows haven't fully OCR'd or when
  // branch-merge upsert edge cases left the column stale — the tile
  // then disagreed with the per-week table by exactly that drift, and
  // the operator had no way to reconcile the two numbers.
  let totalSupplier = 0;
  try {
    const row = db.prepare(`
      SELECT COALESCE(SUM(supplier_delivery), 0)
           + COALESCE(SUM(supplier_discount), 0)
           + COALESCE(SUM(supplier_pricing), 0) AS s
      FROM bat_reconciliations ${yearWhere}
    `).get(...yearArg);
    totalSupplier = row?.s || 0;
  } catch {}
  // totalSage = sum of all Sage credit notes for the chosen year (or all-time
  // if "All" picked). Bypasses bat_reconciliations entirely so weeks without
  // an uploaded supplier sheet still count. Uses per-fee summing to mirror
  // the per-week table's sage column construction (same reason as
  // totalSupplier above).
  let totalSage = 0;
  try {
    const sql = scoped
      ? `SELECT COALESCE(SUM(delivery), 0)
              + COALESCE(SUM(discount), 0)
              + COALESCE(SUM(pricing), 0) AS s
         FROM bat_sage_week_cache WHERE year = ?`
      : `SELECT COALESCE(SUM(delivery), 0)
              + COALESCE(SUM(discount), 0)
              + COALESCE(SUM(pricing), 0) AS s
         FROM bat_sage_week_cache`;
    const row = db.prepare(sql).get(...yearArg);
    totalSage = row?.s || 0;
  } catch {}
  const totalVariance = totalSupplier - totalSage;

  let totalExceptionsCount = 0, totalExceptionsAmount = 0;
  let exceptionsByReason = [];
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS c, COALESCE(SUM(order_amount), 0) AS a
      FROM bat_invoice_extractions
      WHERE is_exception = 1
      ${scoped ? `AND EXISTS (SELECT 1 FROM bat_reconciliations r WHERE r.id = bat_invoice_extractions.reconciliation_id AND r.year = ?)` : ''}
    `).get(...yearArg);
    totalExceptionsCount = row?.c || 0;
    totalExceptionsAmount = row?.a || 0;
    const rawRows = db.prepare(`
      SELECT exception_reason, order_amount
      FROM bat_invoice_extractions
      WHERE is_exception = 1
      ${scoped ? `AND EXISTS (SELECT 1 FROM bat_reconciliations r WHERE r.id = bat_invoice_extractions.reconciliation_id AND r.year = ?)` : ''}
    `).all(...yearArg);
    // Normalize: lowercase, strip punctuation, collapse whitespace, drop duplicate words.
    // Lets "Incorrect delivery status/quantity" and "Incorrect delivery status/Incorrect quantity"
    // collapse to the same key.
    const normalize = (s) => {
      const lower = (s || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!lower) return '';
      const seen = new Set();
      const out = [];
      for (const w of lower.split(' ')) {
        if (!seen.has(w)) { seen.add(w); out.push(w); }
      }
      return out.join(' ');
    };
    const grouped = new Map();
    for (const r of rawRows) {
      const raw = (r.exception_reason || '').trim() || 'Unspecified';
      const key = normalize(raw) || 'unspecified';
      let g = grouped.get(key);
      if (!g) { g = { reason: raw, count: 0, amount: 0 }; grouped.set(key, g); }
      g.count++;
      g.amount += r.order_amount || 0;
      // Pick the shortest (canonical) phrasing for display
      if (raw.length < g.reason.length) g.reason = raw;
    }
    exceptionsByReason = [...grouped.values()].sort((a, b) => b.amount - a.amount);
  } catch {}

  return {
    summary: { totalSupplier, totalSage, totalVariance, totalReconciliations: reconciliations.length, totalExceptionsCount, totalExceptionsAmount, exceptionsByReason },
    reconciliations,
    weekTrend: reconciliations.map(r => ({
      week: `W${r.week_number}`,
      supplier: r.supplier_total || 0,
      sage: r.sage_total || 0,
      variance: (r.supplier_total || 0) - (r.sage_total || 0),
    })).reverse(),
  };
}

// ── Cardoso Invoice Generation (from Sage, replaces the Crystal+Excel pipeline) ──

// In-flight generation tracking so the user can abort via the Cancel button.
let _activeGenerate = null; // { request, cancelled, startedAt }

export function cancelCardosoInvoiceGeneration() {
  if (!_activeGenerate) return { ok: true, status: 'not_running' };
  const prev = _activeGenerate;
  prev.cancelled = true;
  try { prev.request?.cancel(); } catch {}
  // Release the lock immediately so a new Generate can start. Any in-flight
  // SQL/aggregation from the old call still runs to completion in the background
  // but its cleanup paths short-circuit on cancelled=true.
  _activeGenerate = null;
  return { ok: true, status: 'cancelled' };
}

export function getCardosoGenerateStatus() {
  return _activeGenerate
    ? { running: true, startedAt: _activeGenerate.startedAt, cancelling: !!_activeGenerate.cancelled }
    : { running: false };
}

// Mirrors the Excel macro: pulls OEINVH+OEINVD line items, joins ICPRICP for the
// Cardoso standard price on the invoice's price list, computes per-line totals,
// then aggregates per invoice for storage in bat_cardoso_invoices.
//
// TG1/TG2 rates default to the macro's 0.0009 / 0.0001 but can be overridden
// per call OR globally via bat_settings.tg1_rate / tg2_rate (per-site).
export async function generateCardosoInvoicesFromSage({ fromDate, toDate, mode = 'overwrite', tg1Rate, tg2Rate } = {}) {
  if (!fromDate || !toDate) throw new Error('fromDate and toDate required (YYYY-MM-DD)');
  const intDate = (d) => parseInt(String(d).replace(/-/g, ''), 10);
  const from = intDate(fromDate);
  const to   = intDate(toDate);
  if (!from || !to) throw new Error('Invalid date range');

  // Resolve TG rates: explicit param > bat_settings > macro default
  const tg1 = Number(tg1Rate ?? getBatSetting('tg1_rate') ?? 0.0009);
  const tg2 = Number(tg2Rate ?? getBatSetting('tg2_rate') ?? 0.0001);
  if (!Number.isFinite(tg1) || !Number.isFinite(tg2)) {
    throw new Error('Invalid TG1/TG2 rate');
  }
  // If explicit rates were passed in, persist them so the next run uses the same defaults
  if (tg1Rate != null) setBatSetting('tg1_rate', String(tg1));
  if (tg2Rate != null) setBatSetting('tg2_rate', String(tg2));

  if (_activeGenerate) throw new Error('Generation already in progress');

  // Pull line items joined with the Cardoso price-list price for the same item
  // and the same price list as the invoice line. Suppress zero-priced ICPRICP rows.
  // Use an explicit request so we can call request.cancel() from the cancel endpoint.
  const pool = await getSagePool();
  const request = pool.request();
  _activeGenerate = { request, cancelled: false, startedAt: new Date().toISOString() };
  let lines;
  try {
    const result = await request.query(`
      SELECT
        LTRIM(RTRIM(d.ITEM))      AS item,
        LTRIM(RTRIM(d."DESC"))    AS description,
        d.QTYORDERED              AS qty,
        LTRIM(RTRIM(d.PRICELIST)) AS pricelist,
        LTRIM(RTRIM(h.INVNUMBER)) AS invoice_number,
        d.UNITPRICE               AS unit_price,
        d.INVDISC                 AS discount,
        h.INVDATE                 AS invoice_date,
        LTRIM(RTRIM(h.PONUMBER))  AS po_number,
        LTRIM(RTRIM(h.REFERENCE)) AS reference,
        icp.UNITPRICE             AS cardoso_price
      FROM CARDAT.dbo.OEINVH h
      INNER JOIN CARDAT.dbo.OEINVD d ON d.INVUNIQ = h.INVUNIQ
      LEFT JOIN  CARDAT.dbo.ICPRICP icp
        ON icp.ITEMNO    = d.ITEM
       AND icp.PRICELIST = d.PRICELIST
      WHERE d.PRICELIST IN ('BF', 'OC')
        AND h.INVDATE BETWEEN ${from} AND ${to}
        AND COALESCE(icp.UNITPRICE, 0) > 0
      ORDER BY h.INVNUMBER
    `);
    if (_activeGenerate?.cancelled) {
      _activeGenerate = null;
      return { ok: false, status: 'cancelled' };
    }
    lines = result.recordset || [];
  } catch (err) {
    const wasCancelled = _activeGenerate?.cancelled;
    _activeGenerate = null;
    if (wasCancelled || /cancel/i.test(err.message || '')) {
      return { ok: false, status: 'cancelled' };
    }
    throw err;
  }

  // Cancel check before the post-SQL work
  if (_activeGenerate?.cancelled) {
    _activeGenerate = null;
    return { ok: false, status: 'cancelled' };
  }

  // Aggregate per invoice (matches the macro's per-sheet subtotal output)
  const byInvoice = new Map();
  for (const ln of lines) {
    const qty   = Number(ln.qty)           || 0;
    const unit  = Number(ln.unit_price)    || 0;
    const card  = Number(ln.cardoso_price) || 0;
    const disc  = Number(ln.discount)      || 0;
    const batx  = unit * qty;
    const ccdx  = card * qty;
    const diff  = ccdx - batx;
    const tg1Amt = batx * tg1;
    const tg2Amt = batx * tg2;
    const del   = tg1Amt + tg2Amt;
    const total = del + disc + diff;
    const inv = ln.invoice_number;
    if (!byInvoice.has(inv)) {
      byInvoice.set(inv, {
        invoice_number: inv,
        invoice_date:   ln.invoice_date,
        po_number:      stripOrdPrefix(ln.po_number),
        reference:      ln.reference,
        pricelist:      ln.pricelist,
        batx: 0, ccdx: 0, price_diff: 0, discount: 0, del_fee: 0, total: 0,
        line_count: 0,
      });
    }
    const agg = byInvoice.get(inv);
    agg.batx       += batx;
    agg.ccdx       += ccdx;
    agg.price_diff += diff;
    agg.discount   += disc;
    agg.del_fee    += del;
    agg.total      += total;
    agg.line_count += 1;
    // Capture the first non-blank PONUMBER (matches macro behaviour)
    if (!agg.po_number && ln.po_number) agg.po_number = stripOrdPrefix(ln.po_number);
  }

  const invoices = [...byInvoice.values()];

  // Persist to bat_cardoso_invoices using the same shape parseCardosoSpreadsheet produces
  // (camelCase keys — storeCardosoInvoices expects invoiceNumber/priceDiff/delFee/rawData)
  const storeShape = invoices
    .filter(i => i.invoice_number)
    .map(i => ({
      invoiceNumber: String(i.invoice_number),
      amount:        i.total,
      priceDiff:     i.price_diff,
      discount:      i.discount,
      delFee:        i.del_fee,
      rawData:       JSON.stringify({
        source: 'sage_generated',
        generated_at: new Date().toISOString(),
        fromDate, toDate,
        pricelist: i.pricelist,
        po_number: i.po_number,
        reference: i.reference,
        invoice_date: i.invoice_date,
        line_count: i.line_count,
        batx: i.batx,
        ccdx: i.ccdx,
      }),
    }));

  const sourceLabel = `sage:${fromDate}..${toDate}`;
  const storeResult = storeCardosoInvoices(null, storeShape, sourceLabel, mode);
  // Auto-rerun the supplier match so the dashboard reflects the new invoices
  let matching = null;
  try { matching = matchCardosoToSupplierService({ db, reconId: null }); } catch {}

  _activeGenerate = null;
  return {
    ok: true,
    fromDate, toDate,
    sageLines: lines.length,
    invoices: invoices.length,
    inserted: storeResult?.inserted ?? 0,
    updated:  storeResult?.updated  ?? 0,
    skipped:  storeResult?.skipped  ?? 0,
    matching: matching ? matching.stats : null,
  };
}

// Overwrites bat_cardoso_invoices.{price_diff, discount} with the matching
// supplier extraction's values for every row that hasn't been overwritten yet.
// del_fee is LEFT ALONE — that comes from the per-line TG1/TG2 calc on the
// Cardoso side and shouldn't be replaced with the supplier figure.
// Idempotent: rows with c_overwritten=1 are skipped on subsequent calls.
export function replicateSupplierIntoCardoso() {
  const rows = db.prepare(`
    SELECT ci.id AS cardoso_id, ci.invoice_number, ci.del_fee AS existing_del_fee,
           e.supplier_pricing, e.supplier_discount
    FROM bat_cardoso_invoices ci
    INNER JOIN bat_invoice_extractions e
      ON UPPER(REPLACE(e.extracted_invoice, ' ', '')) = UPPER(REPLACE(ci.invoice_number, ' ', ''))
    WHERE COALESCE(ci.c_overwritten, 0) = 0
      AND (e.supplier_pricing IS NOT NULL OR e.supplier_discount IS NOT NULL)
  `).all();

  // A single cardoso invoice may match multiple extractions (e.g. duplicates) —
  // collapse to the FIRST extraction's values per cardoso_id (insertion order).
  const seen = new Map();
  for (const r of rows) {
    if (!seen.has(r.cardoso_id)) seen.set(r.cardoso_id, r);
  }

  // Recompute amount = price_diff + discount + (existing cardoso del_fee).
  const update = db.prepare(`
    UPDATE bat_cardoso_invoices
    SET price_diff = ?, discount = ?, amount = ?, c_overwritten = 1
    WHERE id = ?
  `);
  let updated = 0;
  const tx = db.transaction(() => {
    for (const r of seen.values()) {
      const newAmount = (r.supplier_pricing || 0) + (r.supplier_discount || 0) + (r.existing_del_fee || 0);
      update.run(r.supplier_pricing, r.supplier_discount, newAmount, r.cardoso_id);
      updated += 1;
    }
  });
  tx();

  const totalNotOverwritten = db.prepare("SELECT COUNT(*) c FROM bat_cardoso_invoices WHERE COALESCE(c_overwritten, 0) = 0").get().c;
  const totalOverwritten   = db.prepare("SELECT COUNT(*) c FROM bat_cardoso_invoices WHERE c_overwritten = 1").get().c;
  return { ok: true, updated, totalOverwritten, remainingNotOverwritten: totalNotOverwritten };
}

function stripOrdPrefix(value) {
  if (!value) return null;
  return String(value).replace(/ORD/gi, '').trim() || null;
}

// ── Cardoso Invoice Upload & Matching ────────────────────────────────────────

export function storeCardosoInvoices(reconId, invoices, filename, duplicateMode = 'skip') {
  // duplicateMode: 'skip' = keep existing, 'overwrite' = update existing with new amount
  const existing = db.prepare('SELECT id, invoice_number FROM bat_cardoso_invoices').all();
  const existingMap = new Map(existing.map(r => [r.invoice_number.toUpperCase(), r.id]));

  const insert = db.prepare(`
    INSERT INTO bat_cardoso_invoices (reconciliation_id, invoice_number, amount, price_diff, discount, del_fee, upload_filename, raw_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE bat_cardoso_invoices SET amount = ?, price_diff = ?, discount = ?, del_fee = ?, upload_filename = ?, raw_data = ? WHERE id = ?
  `);
  let inserted = 0, updated = 0, skipped = 0;
  const tx = db.transaction(() => {
    for (const inv of invoices) {
      const key = inv.invoiceNumber.toUpperCase();
      const existingId = existingMap.get(key);
      if (existingId) {
        if (duplicateMode === 'overwrite') {
          update.run(inv.amount, inv.priceDiff, inv.discount, inv.delFee, filename, inv.rawData, existingId);
          updated++;
        } else {
          skipped++;
        }
      } else {
        insert.run(reconId, inv.invoiceNumber, inv.amount, inv.priceDiff, inv.discount, inv.delFee, filename, inv.rawData);
        inserted++;
      }
    }
  });
  tx();
  console.log(`[bat] Cardoso invoices: ${inserted} new, ${updated} updated, ${skipped} skipped (mode=${duplicateMode})`);
  return { inserted, updated, skipped, duplicatesFound: updated + skipped };
}

export function getCardosoInvoices(reconId) {
  if (reconId) return db.prepare('SELECT * FROM bat_cardoso_invoices WHERE reconciliation_id = ? ORDER BY id').all(reconId);
  return db.prepare('SELECT * FROM bat_cardoso_invoices ORDER BY id').all();
}

