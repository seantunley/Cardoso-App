// JTI export routes.
//
// Three endpoints, all gated by `can_access_jti` (admins always pass
// per the requirePermission middleware contract):
//
//   GET  /api/jti/settings   — read defaults + the effective SQL +
//                              pool-status info for the UI
//   PUT  /api/jti/settings   — update one or more settings (the
//                              query_override field is admin-only)
//   POST /api/jti/export     — run the live Accpac query + return .xlsx
//
// Sage pool: this module uses its OWN role-pinned pool
// (services/jti/jtiPool.js — getJtiSagePool). It does NOT fall back
// to the BAT pool. If the operator hasn't assigned a connection to
// the 'jti_export' role, the export endpoint surfaces a 503 with the
// "configure Settings → Connections → Module routing" hint.
//
// Architecture: heavy handler logic lives in standalone functions
// that take their dependencies explicitly (db, pool getter, audit).
// The router wires them up; tests target the handlers directly with
// mock deps. Avoids needing supertest in the dep tree.

import { Router } from 'express';
import db from '../db/index.js';
import { logAudit } from '../lib/audit.js';
import { getJtiSagePool, getJtiPoolStatus, resetJtiSagePool } from '../services/jti/jtiPool.js';
import {
  queryJtiSales,
  validateOverrideSql,
  DEFAULT_JTI_SQL,
} from '../services/jti/jtiQuery.js';
import { buildJtiWorkbook } from '../services/jti/jtiSpreadsheet.js';
import { buildJtiFilename } from '../services/jti/jtiFilename.js';
import { getJtiSettings, setJtiSettings } from '../services/jti/jtiSettings.js';
import { archiveJtiExport, periodFromExactMonth } from '../services/jti/jtiArchive.js';

/**
 * Read the install's saved JTI defaults plus the effective SQL +
 * connection-pool configuration status. The UI uses everything but
 * `queryOverride` directly for form pre-fill; `effectiveSql` drives
 * the read-only "currently running" view; `poolStatus` warns the
 * operator when JTI isn't yet routable.
 */
export function handleGetSettings({ db, getPoolStatus, req, res }) {
  try {
    const settings = getJtiSettings({ db });
    const effectiveSql = (settings.queryOverride || '').trim().length > 0
      ? settings.queryOverride
      : DEFAULT_JTI_SQL;
    const poolStatus = getPoolStatus();
    res.json({
      ok: true,
      settings,
      effectiveSql,
      defaultSql: DEFAULT_JTI_SQL,
      poolStatus,
    });
  } catch (err) {
    console.error('[jti] read settings failed:', err.message);
    res.status(500).json({ error: 'Failed to read JTI settings' });
  }
}

/**
 * Partial update of saved settings. Address fields are open to anyone
 * with can_access_jti; queryOverride is ADMIN-ONLY because changing
 * the SQL has direct impact on what data flows into the consumer
 * pipeline.
 */
export function handlePutSettings({ db, audit, resetPool, req, res }) {
  const body = req.body || {};
  const { townCity, region, country, siteLabel, queryOverride } = body;
  const isAdmin = req.currentUser?.role === 'admin';

  // Admin gate for queryOverride. Operators with can_access_jti can
  // still edit their address defaults from this same endpoint without
  // being blocked.
  if (queryOverride !== undefined && !isAdmin) {
    return res.status(403).json({
      error: 'Editing the JTI query is restricted to admin users.',
    });
  }

  // Validate the SQL override before we try to persist it. validate
  // returns { errors, warnings } — errors block the save; warnings
  // are surfaced in the response so the UI can show them.
  let validation = { errors: [], warnings: [] };
  if (queryOverride !== undefined) {
    validation = validateOverrideSql(queryOverride);
    if (validation.errors.length > 0) {
      return res.status(400).json({
        error: 'Override SQL has issues',
        issues: validation.errors,
        warnings: validation.warnings,
      });
    }
  }

  try {
    const before = getJtiSettings({ db });
    const after = setJtiSettings({ db, townCity, region, country, siteLabel, queryOverride });

    // Compose audit details — log SQL changes loudly because they
    // change what data leaves the building.
    const sqlChanged = queryOverride !== undefined && before.queryOverride !== after.queryOverride;
    audit({
      req,
      action: sqlChanged ? 'jti_settings_query_update' : 'jti_settings_update',
      resourceType: 'system',
      resourceName: sqlChanged ? 'JTI export query' : 'JTI export defaults',
      details: sqlChanged
        ? `JTI SQL ${after.queryOverride ? 'overridden' : 'reset to default'}`
        : 'Updated JTI defaults',
      changes: { before, after },
    });

    // If the connection assignment didn't move but SQL changed, no
    // pool reset is needed — pool is keyed by connection, not by SQL.
    // Kept here as a hook for future code that might cache prepared
    // statements per-config.
    if (sqlChanged && resetPool) { /* no-op today */ }

    res.json({
      ok: true,
      settings: after,
      warnings: validation.warnings,
    });
  } catch (err) {
    console.error('[jti] update settings failed:', err.message);
    res.status(500).json({ error: 'Failed to update JTI settings' });
  }
}

/**
 * Run the live Accpac query + return the .xlsx download.
 *
 * Body shape:
 *   {
 *     from: 'YYYY-MM-DD' | 'YYYYMMDD' | <Date-string>,
 *     to:   <same shapes>,
 *     townCity?, region?, country?  // override saved defaults
 *   }
 */
export async function handleExport({ db, getSagePool, audit, archiveRoot, req, res }) {
  const { from, to } = req.body || {};
  if (!from || !to) {
    return res.status(400).json({ error: 'Date range required: provide both `from` and `to`' });
  }

  // Resolve manual fields: per-export overrides win, fall back to
  // saved settings, ultimately to empty strings.
  const settings = getJtiSettings({ db });
  const manual = {
    townCity: pickFirst(req.body?.townCity, settings.townCity),
    region:   pickFirst(req.body?.region,   settings.region),
    country:  pickFirst(req.body?.country,  settings.country),
  };
  const siteLabel = pickFirst(req.body?.siteLabel, settings.siteLabel);
  const sqlOverride = settings.queryOverride || undefined;

  let pool;
  try {
    pool = await getSagePool();
  } catch (err) {
    console.error('[jti] Sage pool unavailable:', err.message);
    return res.status(503).json({ error: err.message });
  }

  let rows;
  try {
    rows = await queryJtiSales({ pool, fromDate: from, toDate: to, sqlOverride });
  } catch (err) {
    if (err instanceof RangeError || err.message?.includes('must not be after')) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[jti] query failed:', err.message);
    audit({
      req,
      action: 'jti_export',
      resourceType: 'system',
      resourceName: `JTI export (${from} → ${to})`,
      details: err.message,
      status: 'failure',
    });
    return res.status(500).json({ error: `JTI query failed: ${err.message}` });
  }

  let buffer;
  try {
    buffer = await buildJtiWorkbook({ rows, manual });
  } catch (err) {
    console.error('[jti] workbook build failed:', err.message);
    audit({
      req,
      action: 'jti_export',
      resourceType: 'system',
      resourceName: `JTI export (${from} → ${to})`,
      details: `Workbook build failed: ${err.message}`,
      status: 'failure',
    });
    return res.status(500).json({ error: `Failed to build JTI workbook: ${err.message}` });
  }

  const filename = buildJtiFilename({ site: siteLabel, endDate: to });

  // Archive when the manual range is exactly one calendar month
  // (e.g. 2026-04-01 → 2026-04-30). Partial-month exports remain
  // download-only — they're ad-hoc operator queries, not canonical
  // monthly artefacts.
  const period = periodFromExactMonth(from, to);
  let archivedId = null;
  let archiveError = null;
  if (period) {
    try {
      const row = archiveJtiExport({
        db,
        archiveRoot,
        archive: {
          buffer,
          filename,
          periodYear: period.periodYear,
          periodMonth: period.periodMonth,
          source: 'manual',
          generatedBy: req.currentUser?.email || 'unknown',
          rowCount: rows.length,
          townCity: manual.townCity,
          region: manual.region,
          country: manual.country,
          siteLabel,
        },
      });
      archivedId = row.id;
    } catch (err) {
      // Archive failure must not block the download — operator still
      // gets their file. We surface the error in the audit trail and
      // log loudly so it shows up in System Log.
      archiveError = err.message;
      console.error(`[jti] archive write failed for ${period.periodYear}-${period.periodMonth} (${filename}): ${err.message}`);
    }
  }

  audit({
    req,
    action: 'jti_export',
    resourceType: 'system',
    resourceName: filename,
    details: `Generated JTI export (${from} → ${to}); ${rows.length} row(s)`
      + (period ? ` — full month ${period.periodYear}-${String(period.periodMonth).padStart(2, '0')}` : '')
      + (archivedId ? `; archived as #${archivedId}` : '')
      + (archiveError ? `; ARCHIVE FAILED: ${archiveError}` : ''),
    changes: {
      from, to, rowCount: rows.length, manual, usedOverride: Boolean(sqlOverride),
      archivedId, archiveError,
    },
    status: archiveError ? 'partial' : 'success',
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(buffer.length));
  if (archivedId) res.setHeader('X-JTI-Archive-Id', String(archivedId));
  res.end(buffer);
}

/**
 * Return the first non-empty value from the args. "Empty" = null,
 * undefined, or "" (after trim). Used by handleExport to layer per-
 * request overrides over saved defaults.
 *
 * Exported for tests; internal API.
 */
export function pickFirst(...values) {
  for (const v of values) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s.length > 0) return s;
  }
  return '';
}

export function createJtiRouter({ requireAuth, requirePermission }) {
  const router = Router();
  const gate = [requireAuth, requirePermission('can_access_jti')];

  router.get('/api/jti/settings', ...gate, (req, res) =>
    handleGetSettings({ db, getPoolStatus: getJtiPoolStatus, req, res }));
  router.put('/api/jti/settings', ...gate, (req, res) =>
    handlePutSettings({ db, audit: logAudit, resetPool: resetJtiSagePool, req, res }));
  router.post('/api/jti/export', ...gate, (req, res) =>
    handleExport({ db, getSagePool: getJtiSagePool, audit: logAudit, req, res }));

  return router;
}
