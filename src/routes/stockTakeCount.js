import { Router } from 'express';
import {
  openSession,
  closeSession,
  getSession,
  listSessions,
  listLocationZones,
  addLocationZone,
  setLocationZoneActive,
  claimZone,
  releaseZone,
  listZones,
  submitZone,
  reopenZone,
  resolveForCount,
  recordScans,
  listZoneScans,
  voidScan,
  getVariance,
  listRecountItems,
  listUnresolvedScans,
  listCategories,
  listCommodities,
  searchItemsForCount,
  getZoneSummary,
  getZoneItems,
  getItemZoneSplit,
  resolveScan,
} from '../services/stockTakeCount.js';
import { logAudit } from '../lib/audit.js';

// Stock take — counting.
//
// Site-only, like the barcode map: counting happens on a branch floor.
//
// Sage is never opened here at all. Expected quantities come from the local
// on-hand table. A count ends in a variance report; a person keys any
// correction in Sage.
function isHub() { return process.env.HUB_MODE === 'true'; }

const HUB_MESSAGE = 'Stock take runs at the branch, not on the hub. Open it on the site that is counting.';

/** Supervisors see expected quantities, cost and variance. Counters never do. */
function isSupervisor(req) {
  return req.currentUser?.role === 'admin' || Boolean(req.currentUser?.can_supervise_stock_take);
}

function whoami(req) {
  return req.currentUser?.email || req.currentUser?.full_name || 'unknown';
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function createStockTakeCountRouter({ requireAuth, requirePermission }) {
  const router = Router();
  const guard = [requireAuth, requirePermission('can_access_stock_take', 'can_supervise_stock_take')];
  // Supervisor-only endpoints still run the counter guard first so an
  // unauthenticated caller gets 401, not 403.
  const supervisorGuard = [requireAuth, requirePermission('can_supervise_stock_take')];

  function hubBlocked(_req, res, next) {
    if (isHub()) return res.status(400).json({ error: HUB_MESSAGE });
    next();
  }
  router.use('/api/stock-take/sessions', hubBlocked);
  router.use('/api/stock-take/zones', hubBlocked);
  router.use('/api/stock-take/location-zones', hubBlocked);
  router.use('/api/stock-take/scans', hubBlocked);
  router.use('/api/stock-take/count-lookup', hubBlocked);
  router.use('/api/stock-take/count-items', hubBlocked);
  router.use('/api/stock-take/categories', hubBlocked);
  router.use('/api/stock-take/commodities', hubBlocked);

  // The product groups a branch holds, so a count can cover cigarettes only
  // rather than shutting the place down for everything at once.
  router.get('/api/stock-take/categories', ...guard, (req, res) => {
    try {
      res.json({ categories: listCategories(String(req.query.location || '')) });
    } catch (err) {
      res.status(500).json({ error: `Could not read the product groups: ${err.message}` });
    }
  });

  router.get('/api/stock-take/commodities', ...guard, (req, res) => {
    try {
      res.json({ commodities: listCommodities(String(req.query.location || '')) });
    } catch (err) {
      res.status(500).json({ error: `Could not read the commodities: ${err.message}` });
    }
  });

  // ── Sessions ──────────────────────────────────────────────────────────────

  router.get('/api/stock-take/sessions', ...guard, (req, res) => {
    try {
      res.json({
        can_supervise: isSupervisor(req),
        // Who this browser is, so the zone list can say which aisle is yours.
        me: whoami(req),
        sessions: listSessions({
          status: String(req.query.status || ''),
          location: String(req.query.location || ''),
          limit: parseInt(String(req.query.limit), 10) || 50,
        }),
      });
    } catch (err) {
      res.status(500).json({ error: `Could not list the counts: ${err.message}` });
    }
  });

  router.post('/api/stock-take/sessions', ...supervisorGuard, (req, res) => {
    try {
      const session = openSession({
        name: req.body?.name,
        location: req.body?.location,
        categories: req.body?.categories,
        commodities: req.body?.commodities,
        thresholdQty: req.body?.threshold_qty,
        thresholdValue: req.body?.threshold_value,
        notes: req.body?.notes,
        user: whoami(req),
      });
      logAudit({
        req,
        action: 'create',
        resourceType: 'stocktake_session',
        resourceId: String(session.id),
        resourceName: session.name,
        details: `Opened stock count "${session.name}" at ${session.location}${session.category_list?.length || session.commodity_list?.length ? `, covering ${[...(session.category_list || []), ...(session.commodity_list || []).map((c) => `commodity ${c}`)].join(', ')} only` : ''}. Recount threshold ${session.threshold_qty} units or R${session.threshold_value}. Snapshotted ${session.snapshot_rows} item(s) of expected stock.`,
      });
      res.status(201).json(session);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/api/stock-take/sessions/:id', ...guard, (req, res) => {
    const session = getSession(parseInt(req.params.id, 10));
    if (!session) return res.status(404).json({ error: `Count #${req.params.id} does not exist.` });
    res.json({ ...session, can_supervise: isSupervisor(req) });
  });

  router.post('/api/stock-take/sessions/:id/close', ...supervisorGuard, (req, res) => {
    try {
      const session = closeSession({ id: parseInt(req.params.id, 10), user: whoami(req), force: req.body?.force === true });
      logAudit({
        req,
        action: 'update',
        resourceType: 'stocktake_session',
        resourceId: String(session.id),
        resourceName: session.name,
        details: `Closed stock count "${session.name}"${session.closed_with_outstanding_recounts ? ` with ${session.closed_with_outstanding_recounts} item(s) still awaiting recount` : ''}${session.closed_with_open_zones ? ` and ${session.closed_with_open_zones} zone(s) not submitted` : ''}.`,
      });
      res.json(session);
    } catch (err) {
      if (/** @type {any} */ (err).code === 'COUNT_NOT_FINISHED') {
        return res.status(409).json({
          error: err.message,
          code: 'COUNT_NOT_FINISHED',
          open_zones: /** @type {any} */ (err).openZones,
          outstanding_recounts: /** @type {any} */ (err).outstandingRecounts,
        });
      }
      res.status(400).json({ error: err.message });
    }
  });

  // ── Zones ─────────────────────────────────────────────────────────────────

  router.get('/api/stock-take/sessions/:id/zones', ...guard, (req, res) => {
    try {
      res.json({ zones: listZones(parseInt(req.params.id, 10)) });
    } catch (err) {
      res.status(500).json({ error: `Could not list the zones: ${err.message}` });
    }
  });

  // Counters claim an aisle from the branch's list. There is deliberately no
  // way to invent a zone here — free text turned into "Aisle 3", "aisle3" and
  // "asile 3" for the same rack, and then nothing compares month to month.
  router.post('/api/stock-take/zones/:zoneId/claim', ...guard, (req, res) => {
    try {
      const zone = claimZone({
        zoneId: parseInt(req.params.zoneId, 10),
        user: whoami(req),
        assignTo: req.body?.assigned_to,
        isSupervisor: isSupervisor(req),
      });
      res.json(zone);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/stock-take/zones/:zoneId/release', ...guard, (req, res) => {
    try {
      const zone = releaseZone({
        zoneId: parseInt(req.params.zoneId, 10),
        user: whoami(req),
        isSupervisor: isSupervisor(req),
      });
      res.json(zone);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── The branch's standing zone list — supervisors own it ──────────────────

  router.get('/api/stock-take/location-zones', ...guard, (req, res) => {
    try {
      res.json({
        zones: listLocationZones(String(req.query.location || ''), {
          includeInactive: req.query.include_inactive === 'true' && isSupervisor(req),
        }),
      });
    } catch (err) {
      res.status(500).json({ error: `Could not read the zone list: ${err.message}` });
    }
  });

  router.post('/api/stock-take/location-zones', ...supervisorGuard, (req, res) => {
    try {
      const zone = addLocationZone({ location: req.body?.location, name: req.body?.name, user: whoami(req) });
      logAudit({
        req,
        action: zone.reactivated ? 'update' : 'create',
        resourceType: 'stocktake_location_zone',
        resourceId: String(zone.id),
        resourceName: `${zone.location} — ${zone.name}`,
        details: zone.reactivated
          ? `Brought the retired zone "${zone.name}" at ${zone.location} back into use.`
          : `Added zone "${zone.name}" to ${zone.location}${zone.added_to_open_count ? ', and to the count that is open there' : ''}.`,
      });
      res.status(201).json(zone);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/stock-take/location-zones/:id/active', ...supervisorGuard, (req, res) => {
    try {
      const active = req.body?.active === true;
      const zone = setLocationZoneActive({ id: parseInt(req.params.id, 10), active, user: whoami(req) });
      logAudit({
        req,
        action: 'update',
        resourceType: 'stocktake_location_zone',
        resourceId: String(zone.id),
        resourceName: `${zone.location} — ${zone.name}`,
        details: `${active ? 'Brought back' : 'Retired'} zone "${zone.name}" at ${zone.location}. Counts already done keep naming it.`,
      });
      res.json(zone);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/stock-take/zones/:zoneId/submit', ...guard, (req, res) => {
    try {
      const zone = submitZone({ zoneId: parseInt(req.params.zoneId, 10), user: whoami(req) });
      logAudit({
        req,
        action: 'update',
        resourceType: 'stocktake_zone',
        resourceId: String(zone.id),
        resourceName: zone.name,
        details: `Submitted zone "${zone.name}" in count #${zone.session_id}.`,
      });
      res.json(zone);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/stock-take/zones/:zoneId/reopen', ...supervisorGuard, (req, res) => {
    try {
      const zone = reopenZone({ zoneId: parseInt(req.params.zoneId, 10), user: whoami(req) });
      logAudit({
        req,
        action: 'update',
        resourceType: 'stocktake_zone',
        resourceId: String(zone.id),
        resourceName: zone.name,
        details: `Reopened zone "${zone.name}" in count #${zone.session_id} so more scans can be added.`,
      });
      res.json(zone);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/api/stock-take/zones/:zoneId/scans', ...guard, (req, res) => {
    try {
      res.json({ scans: listZoneScans({ zoneId: parseInt(req.params.zoneId, 10), limit: parseInt(String(req.query.limit), 10) || 200 }) });
    } catch (err) {
      res.status(500).json({ error: `Could not list the scans: ${err.message}` });
    }
  });

  // ── Scanning ──────────────────────────────────────────────────────────────

  // Deliberately NOT the same endpoint as the barcode map's lookup: this one
  // never returns an expected quantity or a cost, so a counter cannot see the
  // number they are supposed to be checking.
  router.get('/api/stock-take/count-lookup', ...guard, (req, res) => {
    const barcode = String(req.query.barcode || '').trim();
    if (!barcode) return res.status(400).json({ error: 'No barcode was sent to look up.' });
    try {
      res.json(resolveForCount({ barcode }));
    } catch (err) {
      res.status(500).json({ error: `Could not look up barcode ${barcode}: ${err.message}` });
    }
  });

  // For when a label will not scan: find the item by number or name. Blind,
  // like the barcode lookup — no quantity, no cost.
  router.get('/api/stock-take/count-items', ...guard, (req, res) => {
    try {
      res.json({
        items: searchItemsForCount({
          q: String(req.query.q || ''),
          sessionId: parseInt(String(req.query.session_id), 10) || undefined,
          limit: parseInt(String(req.query.limit), 10) || 25,
        }),
      });
    } catch (err) {
      res.status(500).json({ error: `Item search failed: ${err.message}` });
    }
  });

  // ── What each zone found — supervisors only ───────────────────────────────

  router.get('/api/stock-take/sessions/:id/zone-summary', ...supervisorGuard, (req, res) => {
    try {
      res.json({ zones: getZoneSummary(parseInt(req.params.id, 10)) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/api/stock-take/sessions/:id/zones/:zoneId/items', ...supervisorGuard, (req, res) => {
    try {
      res.json({
        items: getZoneItems({
          sessionId: parseInt(req.params.id, 10),
          zoneId: parseInt(req.params.zoneId, 10),
        }),
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/api/stock-take/sessions/:id/items/:itemNumber/zones', ...supervisorGuard, (req, res) => {
    try {
      res.json({
        zones: getItemZoneSplit({
          sessionId: parseInt(req.params.id, 10),
          itemNumber: req.params.itemNumber,
        }),
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/stock-take/sessions/:id/scans', ...guard, (req, res) => {
    try {
      const result = recordScans({
        sessionId: parseInt(req.params.id, 10),
        zoneId: parseInt(String(req.body?.zone_id), 10),
        scans: req.body?.scans,
        user: whoami(req),
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/stock-take/scans/:scanId/void', ...guard, (req, res) => {
    try {
      const scan = voidScan({ scanId: parseInt(req.params.scanId, 10), user: whoami(req) });
      res.json({ ok: true, scan });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Recount list (blind: no quantities) ───────────────────────────────────

  router.get('/api/stock-take/sessions/:id/recounts', ...guard, (req, res) => {
    try {
      res.json({ items: listRecountItems(parseInt(req.params.id, 10)) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Variance — supervisors only ───────────────────────────────────────────

  router.get('/api/stock-take/sessions/:id/variance', ...supervisorGuard, (req, res) => {
    try {
      res.json(getVariance(parseInt(req.params.id, 10), { filter: String(req.query.filter || 'all') }));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/api/stock-take/sessions/:id/variance.csv', ...supervisorGuard, (req, res) => {
    try {
      const { session, rows } = getVariance(parseInt(req.params.id, 10), { filter: String(req.query.filter || 'all') });
      const header = ['Item', 'Description', 'Unit', 'Counted', 'Expected', 'Difference', 'Unit cost', 'Difference value', 'First count', 'Recount', 'Zones', 'Recount required', 'Recount done', 'Never counted'];
      const body = rows.map((r) => [
        r.item_number, r.item_description, r.stock_unit,
        r.counted_qty, r.expected_qty, r.diff_qty,
        r.unit_cost.toFixed(2), r.diff_value.toFixed(2),
        r.pass1_qty, r.pass2_scans ? r.pass2_qty : '',
        r.zone_count, r.recount_required ? 'yes' : '', r.recount_done ? 'yes' : '', r.never_counted ? 'yes' : '',
      ]);
      const csv = [header, ...body].map((line) => line.map(csvCell).join(',')).join('\r\n');
      const safeName = String(session?.name || `count-${req.params.id}`).replace(/[^A-Za-z0-9 _-]/g, '').trim() || `count-${req.params.id}`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName} variance.csv"`);
      res.send(csv);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/api/stock-take/sessions/:id/unresolved', ...supervisorGuard, (req, res) => {
    try {
      res.json({ scans: listUnresolvedScans(parseInt(req.params.id, 10)) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/stock-take/scans/:scanId/resolve', ...supervisorGuard, (req, res) => {
    try {
      const scan = resolveScan({
        scanId: parseInt(req.params.scanId, 10),
        itemNumber: req.body?.item_number,
        unit: req.body?.unit,
        user: whoami(req),
      });
      logAudit({
        req,
        action: 'update',
        resourceType: 'stocktake_scan',
        resourceId: String(scan.id),
        resourceName: scan.barcode || String(scan.id),
        details: `Attached an unmapped scan of ${scan.barcode} to item ${scan.item_number} (${scan.unit}) in count #${scan.session_id}.`,
      });
      res.json({ ok: true, scan });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
