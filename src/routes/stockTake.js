import { Router } from 'express';
import {
  syncItemsFromSage,
  getStockTakeMeta,
  getItemUnits,
  lookupBarcode,
  saveBarcode,
  deleteBarcode,
  listBarcodes,
  searchItems,
} from '../services/stockTake.js';
import { logAudit } from '../lib/audit.js';

// Stock take — barcode map.
//
// Site-only. Counting happens on a branch floor against that branch's own Sage
// company, so the hub has nothing to scan; hub requests get a plain explanation
// rather than an empty screen.
//
// Sage is READ-ONLY for this module. The only Sage call in here is the item
// master refresh, which is a SELECT.
function isHub() { return process.env.HUB_MODE === 'true'; }

const HUB_MESSAGE = 'Stock take runs at the branch, not on the hub. Open it on the site that is counting.';

/** Supervisors see expected quantities and cost. Counters deliberately do not. */
function isSupervisor(req) {
  return req.currentUser?.role === 'admin' || Boolean(req.currentUser?.can_supervise_stock_take);
}

export function createStockTakeRouter({ requireAuth, requirePermission }) {
  const router = Router();
  const guard = [requireAuth, requirePermission('can_access_stock_take')];

  router.get('/api/stock-take/meta', ...guard, (_req, res) => {
    if (isHub()) return res.json({ hub: true, message: HUB_MESSAGE });
    try {
      res.json({ hub: false, ...getStockTakeMeta() });
    } catch (err) {
      res.status(500).json({ error: `Could not read the stock take summary: ${err.message}` });
    }
  });

  // Refresh the item/unit cache from Sage. SELECT only — this never writes to Sage.
  router.post('/api/stock-take/sync-items', ...guard, async (_req, res) => {
    if (isHub()) return res.status(400).json({ error: HUB_MESSAGE });
    try {
      const result = await syncItemsFromSage();
      res.json({ ok: true, ...result });
    } catch (err) {
      const sageDown = /no sage|not configured|ECONNREFUSED|ETIMEOUT|ETIMEDOUT|login failed/i.test(err.message);
      res.status(sageDown ? 503 : 500).json({
        error: sageDown
          ? `The item list could not be refreshed because Sage did not answer: ${err.message}. The barcode map is unaffected — try again once Sage is reachable.`
          : `The item list could not be refreshed: ${err.message}`,
      });
    }
  });

  router.get('/api/stock-take/lookup', ...guard, (req, res) => {
    if (isHub()) return res.status(400).json({ error: HUB_MESSAGE });
    const barcode = String(req.query.barcode || '').trim();
    if (!barcode) return res.status(400).json({ error: 'No barcode was sent to look up.' });
    try {
      const result = lookupBarcode({ barcode, location: String(req.query.location || '') });
      // Blind counting, enforced here rather than only on the screen: anyone
      // without the supervisor permission never receives the expected quantity
      // or the cost. A counter who can see "expected 340" hands back 340.
      if (!isSupervisor(req) && result.found) {
        return res.json({
          ...result,
          qty_on_hand: null,
          qty_on_hand_in_unit: null,
          average_cost: null,
          quantities_hidden: true,
          quantities_hidden_reason: 'Counts are blind: expected quantities and cost are only shown to a stock take supervisor.',
        });
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: `Could not look up barcode ${barcode}: ${err.message}` });
    }
  });

  router.get('/api/stock-take/items', ...guard, (req, res) => {
    if (isHub()) return res.status(400).json({ error: HUB_MESSAGE });
    try {
      res.json({
        items: searchItems({
          q: String(req.query.q || ''),
          location: String(req.query.location || ''),
          limit: parseInt(String(req.query.limit), 10) || 30,
        }),
      });
    } catch (err) {
      res.status(500).json({ error: `Item search failed: ${err.message}` });
    }
  });

  router.get('/api/stock-take/items/:itemNumber/units', ...guard, (req, res) => {
    if (isHub()) return res.status(400).json({ error: HUB_MESSAGE });
    try {
      const units = getItemUnits(req.params.itemNumber);
      if (!units.length) {
        return res.status(404).json({ error: `Item ${req.params.itemNumber} has no units in the local item list. Refresh the item list from Sage, then try again.` });
      }
      res.json({ units });
    } catch (err) {
      res.status(500).json({ error: `Could not read the units for item ${req.params.itemNumber}: ${err.message}` });
    }
  });

  router.get('/api/stock-take/barcodes', ...guard, (req, res) => {
    if (isHub()) return res.status(400).json({ error: HUB_MESSAGE });
    try {
      const records = listBarcodes({
        search: String(req.query.search || ''),
        limit: parseInt(String(req.query.limit), 10) || 200,
      });
      res.json({ count: records.length, records });
    } catch (err) {
      res.status(500).json({ error: `Could not list the barcode map: ${err.message}` });
    }
  });

  router.post('/api/stock-take/barcodes', ...guard, (req, res) => {
    if (isHub()) return res.status(400).json({ error: HUB_MESSAGE });
    const user = req.currentUser?.email || req.currentUser?.full_name || 'unknown';
    try {
      const result = saveBarcode({
        barcode: req.body?.barcode,
        itemNumber: req.body?.item_number,
        unit: req.body?.unit,
        user,
        allowRemap: req.body?.allow_remap === true,
      });
      if (result.changed) {
        logAudit({
          req,
          action: result.remapped ? 'update' : 'create',
          resourceType: 'item_barcode',
          resourceId: String(result.id),
          resourceName: `${result.barcode} → ${result.item_number} (${result.unit})`,
          details: result.remapped
            ? `Re-pointed barcode ${result.barcode} from item ${result.previous?.item_number} (${result.previous?.unit}) to item ${result.item_number} (${result.unit}).`
            : `Mapped barcode ${result.barcode} to item ${result.item_number}, unit ${result.unit}.`,
        });
      }
      res.status(result.changed && !result.remapped ? 201 : 200).json(result);
    } catch (err) {
      if (/** @type {any} */ (err).code === 'BARCODE_IN_USE') {
        return res.status(409).json({ error: err.message, code: 'BARCODE_IN_USE', existing: /** @type {any} */ (err).existing });
      }
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/api/stock-take/barcodes/:id', ...guard, (req, res) => {
    if (isHub()) return res.status(400).json({ error: HUB_MESSAGE });
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid barcode id.' });
    try {
      const removed = deleteBarcode(id);
      if (!removed) return res.status(404).json({ error: 'That barcode mapping no longer exists — someone may have removed it already.' });
      logAudit({
        req,
        action: 'delete',
        resourceType: 'item_barcode',
        resourceId: String(removed.id),
        resourceName: `${removed.barcode} → ${removed.item_number} (${removed.unit})`,
        details: `Removed the mapping of barcode ${removed.barcode} from item ${removed.item_number}, unit ${removed.unit}.`,
      });
      res.json({ ok: true, removed });
    } catch (err) {
      res.status(500).json({ error: `Could not remove the barcode mapping: ${err.message}` });
    }
  });

  return router;
}
