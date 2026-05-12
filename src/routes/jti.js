// JTI export routes.
//
// Three endpoints, all gated by `can_access_jti` (admins always pass
// per the requirePermission middleware contract):
//
//   GET  /api/jti/settings   — read the install's saved defaults
//   PUT  /api/jti/settings   — update one or more defaults
//   POST /api/jti/export     — run the live Accpac query + return .xlsx
//
// The export endpoint takes the date range + (optional per-export)
// overrides for TownCity/Region/Country. If overrides aren't sent it
// falls back to the saved defaults — that's the "pre-fill from a
// setting" UX the operator asked for.
//
// Architecture: heavy handler logic lives in standalone functions
// that take their dependencies explicitly (db, getSagePool, audit).
// The router wires them up; tests target the handlers directly with
// mock deps. Sage pool comes from services/batReconciliation.js so
// the JTI module doesn't have to maintain its own pool config.

import { Router } from 'express';
import db from '../db/index.js';
import { logAudit } from '../lib/audit.js';
import { getSagePool } from '../services/batReconciliation.js';
import { queryJtiSales } from '../services/jti/jtiQuery.js';
import { buildJtiWorkbook } from '../services/jti/jtiSpreadsheet.js';
import { buildJtiFilename } from '../services/jti/jtiFilename.js';
import { getJtiSettings, setJtiSettings } from '../services/jti/jtiSettings.js';

/**
 * Read the install's saved JTI defaults.
 *
 * @param {{ db, req, res }} ctx
 */
export function handleGetSettings({ db, req, res }) {
  try {
    const settings = getJtiSettings({ db });
    res.json({ ok: true, settings });
  } catch (err) {
    console.error('[jti] read settings failed:', err.message);
    res.status(500).json({ error: 'Failed to read JTI settings' });
  }
}

/**
 * Partial update of the saved JTI defaults. Audited.
 *
 * @param {{ db, audit, req, res }} ctx
 */
export function handlePutSettings({ db, audit, req, res }) {
  const { townCity, region, country, siteLabel } = req.body || {};
  try {
    const before = getJtiSettings({ db });
    const after = setJtiSettings({ db, townCity, region, country, siteLabel });
    audit({
      req,
      action: 'jti_settings_update',
      resourceType: 'system',
      resourceName: 'JTI export defaults',
      details: 'Updated JTI defaults',
      changes: { before, after },
    });
    res.json({ ok: true, settings: after });
  } catch (err) {
    console.error('[jti] update settings failed:', err.message);
    res.status(500).json({ error: 'Failed to update JTI settings' });
  }
}

/**
 * Run the live Accpac query + return the .xlsx download.
 *
 * @param {{ db, getSagePool, audit, req, res }} ctx
 */
export async function handleExport({ db, getSagePool, audit, req, res }) {
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

  let pool;
  try {
    pool = await getSagePool();
  } catch (err) {
    console.error('[jti] Sage pool unavailable:', err.message);
    return res.status(503).json({ error: `Sage 300 unavailable: ${err.message}` });
  }

  let rows;
  try {
    rows = await queryJtiSales({ pool, fromDate: from, toDate: to });
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
    buffer = buildJtiWorkbook({ rows, manual });
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

  audit({
    req,
    action: 'jti_export',
    resourceType: 'system',
    resourceName: filename,
    details: `Generated JTI export (${from} → ${to}); ${rows.length} row(s)`,
    changes: { from, to, rowCount: rows.length, manual },
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(buffer.length));
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

  router.get('/api/jti/settings', ...gate, (req, res) => handleGetSettings({ db, req, res }));
  router.put('/api/jti/settings', ...gate, (req, res) => handlePutSettings({ db, audit: logAudit, req, res }));
  router.post('/api/jti/export', ...gate, (req, res) => handleExport({ db, getSagePool, audit: logAudit, req, res }));

  return router;
}
